// Git reads for setup/deployment use the same hostile-repository boundary
// as the runner. Node 24 strips these modules' types; no packages are needed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { untrustedGitRunSync, untrustedGitEnv, gitProgram, verifyGitObjectsSync } from '../src/safe-git.ts';

export function isolatedGit(home, args, input, extraEnv = {}) {
  const env = { ...untrustedGitEnv(), HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_GRAFT_FILE: os.devNull, NoDefaultCurrentDirectoryInExePath: '1', ...extraEnv };
  return spawnSync(gitProgram(), args, { env, input, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer', timeout: 60_000 });
}

export const verifyRepositoryObjects = verifyGitObjectsSync;

export function gitResult(cwd, args, opts = {}) {
  return untrustedGitRunSync(cwd, args, { timeoutMs: 30_000, ...opts });
}

export function git(cwd, args, opts = {}) {
  const r = gitResult(cwd, args, { ...opts, bytes: opts.encoding === 'buffer' });
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return opts.encoding === 'buffer' ? r.bytes : r.stdout.trim();
}

export function refuseSubstitutes(cwd) {
  const replaced = git(cwd, ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/replace/']);
  const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (replaced || fs.existsSync(path.join(common, 'info', 'grafts'))) throw new Error('This checkout has git replacement refs or grafts; remove them before setup/deployment.');
}

function entries(root) {
  const result = [];
  const walk = (rel) => {
    const file = path.join(root, rel);
    const st = fs.lstatSync(file);
    if (st.isDirectory()) for (const name of fs.readdirSync(file).sort()) walk(path.join(rel, name));
    else if (st.isFile()) result.push([rel.split(path.sep).join('/'), (st.mode & 0o111) ? '100755' : '100644', fs.readFileSync(file)]);
    else if (st.isSymbolicLink()) result.push([rel.split(path.sep).join('/'), '120000', Buffer.from(fs.readlinkSync(file))]);
    else throw new Error(`The release contains a special file: ${rel}`);
  };
  return { result, walk };
}

export function snapshotDigest(dest, releasePaths) {
  const { result, walk } = entries(dest);
  for (const p of releasePaths) { try { fs.lstatSync(path.join(dest, p)); } catch (e) { if (e.code === 'ENOENT') continue; throw e; } walk(p); }
  return digest(result);
}

function digest(rows) {
  const hash = crypto.createHash('sha256');
  for (const [name, mode, bytes] of rows.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])))) hash.update(`${process.platform === 'win32' && mode !== '120000' ? '100644' : mode}\0${name}\0${bytes.length}\0`).update(bytes);
  return hash.digest('hex');
}

// An object pathname is not evidence of its contents: loose objects and
// packs can have been supplied with the checkout. Verify every traversed
// object against its own ID before interpreting it.
function object(root, type, id) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id)) throw new Error('Invalid object ID in the release.');
  const data = git(root, ['cat-file', type, id], { encoding: 'buffer' });
  const got = crypto.createHash(id.length === 40 ? 'sha1' : 'sha256').update(`${type} ${data.length}\0`).update(data).digest('hex');
  if (got !== id) throw new Error(`The release's ${type} object ${id} does not hash to its ID.`);
  return data;
}

function sourceEntries(root, prefix, commit, releasePaths) {
  refuseSubstitutes(root);
  const data = object(root, 'commit', commit);
  const tree = /^tree ([0-9a-f]+)\n/.exec(data.toString('utf8'))?.[1];
  if (!tree) throw new Error('The release commit has no tree.');
  const wanted = releasePaths.map((p) => prefix + p);
  const rows = [];
  const walk = (id, at) => {
    const raw = object(root, 'tree', id);
    let pos = 0;
    while (pos < raw.length) {
      const space = raw.indexOf(32, pos), nul = raw.indexOf(0, space + 1);
      const end = nul + 1 + id.length / 2;
      if (space < pos || nul < space || end > raw.length) throw new Error('Malformed release tree.');
      const mode = raw.subarray(pos, space).toString();
      const name = new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(space + 1, nul));
      if (!name || name === '.' || name === '..' || /[\/\\]/.test(name)) throw new Error('Unsafe release path.');
      const child = raw.subarray(nul + 1, end).toString('hex'); pos = end;
      const full = at + name;
      if (!wanted.some((w) => full === w || full.startsWith(w + '/') || w.startsWith(full + '/'))) continue;
      if (mode === '40000' || mode === '040000') walk(child, full + '/');
      else {
        if (!['100644', '100755', '120000'].includes(mode)) throw new Error(`Unsupported release entry: ${full}`);
        const rel = full.slice(prefix.length);
        if (!full.startsWith(prefix) || !rel) throw new Error('Unsafe release prefix.');
        rows.push([rel, mode, object(root, 'blob', child)]);
      }
    }
  };
  walk(tree, '');
  return rows;
}

// Validate the entire path namespace before writing. Case aliases, device
// names and symlink ancestors cannot become writes outside the snapshot.
function validatePaths(rows) {
  const seen = new Map();
  for (const [rel] of rows) {
    const parts = rel.split('/');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i], prefix = parts.slice(0, i + 1).join('/');
      if (/[\x00-\x1f:]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)) throw new Error(`Unsafe release path: ${rel}`);
      const key = prefix.normalize('NFD').toLowerCase(), dir = i < parts.length - 1;
      const old = seen.get(key);
      if (old && (old.name !== prefix || !old.dir || !dir)) throw new Error(`Colliding release paths: ${old.name} and ${prefix}`);
      seen.set(key, { name: prefix, dir });
    }
  }
}

function parents(dest, rel) {
  let dir = dest;
  for (const part of rel.split('/').slice(0, -1)) {
    dir = path.join(dir, part);
    try { fs.mkdirSync(dir, { mode: 0o700 }); fs.chmodSync(dir, 0o700); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`A snapshot parent is not a real directory: ${rel}`);
  }
}

// Materialize original blobs; archive's export attributes do not apply.
export function snapshotCommit(root, prefix, commit, dest, releasePaths) {
  const rows = sourceEntries(root, prefix, commit, releasePaths);
  validatePaths(rows);
  for (const [rel, mode, data] of rows) {
    parents(dest, rel);
    const to = path.join(dest, rel);
    if (mode === '120000') fs.symlinkSync(data.toString('utf8'), to);
    else {
      const fd = fs.openSync(to, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      try { fs.writeFileSync(fd, data); if (process.platform !== 'win32') fs.fchmodSync(fd, mode === '100755' ? 0o755 : 0o644); } finally { fs.closeSync(fd); }
    }
  }
  const wanted = digest(rows);
  if (snapshotDigest(dest, releasePaths) !== wanted) throw new Error('The installed snapshot differs from the verified commit blobs.');
  return wanted;
}

export const RELEASE_PATHS = ['src', 'bin', 'package.json', 'package-lock.json', '.npmrc'];

export function releaseMatches(runner, release, commit) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(release, 'release.json'), 'utf8'));
    if (meta.commit !== commit || meta.dirty || !meta.snapshotSha256) return false;
    const root = git(runner, ['rev-parse', '--show-toplevel']);
    const prefix = git(runner, ['rev-parse', '--show-prefix']);
    const expected = digest(sourceEntries(root, prefix, commit, RELEASE_PATHS));
    return expected === meta.snapshotSha256 && snapshotDigest(release, RELEASE_PATHS) === expected;
  } catch { return false; }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === '--verify-objects') { try { verifyRepositoryObjects(process.argv[3], process.argv.slice(4).length ? process.argv.slice(4) : ['HEAD'], process.argv.slice(4).length > 1); process.exit(0); } catch (e) { console.error(e.message); process.exit(1); } }
  if (process.argv[2] === '--isolated') { const r = isolatedGit(process.argv[3], process.argv.slice(4)); process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? ''); process.exit(r.status ?? 1); }
  if (process.argv[2] === '--matches-release') process.exit(releaseMatches(process.argv[3], process.argv[4], process.argv[5]) ? 0 : 1);
  const r = gitResult(process.argv[2], process.argv.slice(3));
  process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exitCode = r.code < 0 ? 1 : r.code;
}
