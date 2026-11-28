// Apply the config-free preview, including settled files, as one exact tree.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, gitResult, refuseSubstitutes, isolatedGit, verifyRepositoryObjects } from '../runner/scripts/deploy-git.mjs';

function apply(dir, msg) {
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8').trim();
  const base = read('base'), commit = read('commit');
  if (![base, commit].every((s) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s))) throw new Error('base or commit is not a commit id: run the preview again.');
  const top = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  refuseSubstitutes(top);
  verifyRepositoryObjects(top, [base, commit], true);
  if (git(top, ['status', '--porcelain', '--untracked-files=no'])) throw new Error('The worktree has uncommitted changes: commit or drop them first.');
  const main = gitResult(top, ['rev-parse', '-q', '--verify', 'refs/heads/main']);
  if (main.ok && !gitResult(top, ['merge-base', '--is-ancestor', main.stdout.trim(), base]).ok) throw new Error('main has moved on since the preview: run the preview again.');
  const head = git(top, ['rev-parse', 'HEAD']);
  if (!gitResult(top, ['merge-base', '--is-ancestor', head, base]).ok) throw new Error("This branch is not where the preview had main: run the preview again.");
  const clashes = fs.existsSync(path.join(dir, 'clashes.json')) ? JSON.parse(read('clashes.json')) : read('clashes').split('\n').filter(Boolean);
  if (!Array.isArray(clashes) || clashes.some((f) => typeof f !== 'string')) throw new Error('Invalid preview clashes.');
  for (const f of clashes) {
    if (path.isAbsolute(f) || f.includes('\\') || f.split('/').some((p) => !p || p === '.' || p === '..')) throw new Error(`Unsafe clashing path: ${f}`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-prepared-'));
  try {
    const bare = path.join(tmp, 'repo');
    const env = {};
    const run = (args, input, allowed = [0]) => {
      const r = isolatedGit(tmp, args, input, env);
      if (!allowed.includes(r.status)) throw new Error(String(r.stderr || r.error || 'git failed'));
      return r.stdout;
    };
    run(['init', '-q', '--bare', '--template=', `--object-format=${git(top, ['rev-parse', '--show-object-format'])}`, bare]);
    fs.writeFileSync(path.join(bare, 'objects/info/alternates'), git(top, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']) + '\n');
    const b = (args, input, allowed) => run(['-C', bare, '-c', 'core.attributesFile=/dev/null', '-c', 'merge.default=text', '-c', 'core.commitGraph=false', ...args], input, allowed);
    const empty = b(['hash-object', '-w', '-t', 'tree', '--stdin'], '').toString().trim();
    const merged = b([`--attr-source=${empty}`, 'merge-tree', '--write-tree', '--name-only', '-z', base, commit], undefined, [0, 1]).toString('utf8').split('\0');
    const tree = merged.shift().trim();
    if (!fs.existsSync(path.join(dir, 'tree')) || read('tree') !== tree) throw new Error('The isolated tree differs from the preview: run the preview again.');
    const actual = [];
    for (const f of merged) { if (!f) break; actual.push(f); }
    if (JSON.stringify([...actual].sort()) !== JSON.stringify([...clashes].sort())) throw new Error('The isolated merge has different clashes: run the preview again.');
    b(['read-tree', tree]);
    const walkPrepared = (rel, expectKind) => {
      let cur = path.join(dir, 'files');
      const rootSt = fs.lstatSync(cur);
      if (rootSt.isSymbolicLink() || !rootSt.isDirectory()) throw new Error(`The settled copy must be in real directories: ${rel}`);
      const parts = rel.split('/');
      for (let i = 0; i < parts.length; i++) {
        cur = path.join(cur, parts[i]);
        let st;
        try { st = fs.lstatSync(cur); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
        if (st.isSymbolicLink()) throw new Error(`The settled copy must not use symlinks: ${rel}`);
        if (i < parts.length - 1) {
          if (!st.isDirectory()) throw new Error(`The settled copy must be in real directories: ${rel}`);
        } else if (expectKind === 'file' && !st.isFile()) {
          throw new Error(`The settled copy must be a regular file in real directories: ${rel}`);
        } else if (expectKind === 'dir' && !st.isDirectory()) {
          throw new Error(`The settled directory clash must not be a file: ${rel}`);
        }
      }
      return cur;
    };
    for (const f of clashes) {
      const entry = b(['--literal-pathspecs', 'ls-tree', '-z', tree, '--', f]).toString('utf8');
      if (!entry) {
        if (fs.existsSync(path.join(dir, 'files')) && walkPrepared(f, 'any')) {
          throw new Error(`Cannot settle absent clash ${f} from ${dir}/files; merge it by hand.`);
        }
        continue;
      }
      if (/^040000 tree /.test(entry)) {
        if (fs.existsSync(path.join(dir, 'files'))) walkPrepared(f, 'dir');
        continue;
      }
      const mode = /^(100644|100755) blob /.exec(entry)?.[1];
      if (!mode) throw new Error(`Settle ${f} by hand; prepared merge does not settle symlink or submodule conflicts.`);
      const file = walkPrepared(f, 'file');
      if (!file) {
        b(['--literal-pathspecs', 'update-index', '--force-remove', '--', f]);
        continue;
      }
      const data = fs.readFileSync(file);
      if (/^(<<<<<<<|>>>>>>>)( |$)/m.test(data.toString('utf8'))) throw new Error(`Still has conflict markers under ${dir}/files: ${f}`);
      const id = b(['hash-object', '-w', '--stdin'], data).toString().trim();
      b(['update-index', '--add', '--cacheinfo', `${mode},${id},${f}`]);
    }
    const wanted = b(['write-tree']).toString().trim();
    const identityEnv = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => /^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$/.test(k) && v !== undefined));
    for (const role of ['AUTHOR', 'COMMITTER']) {
      const name = git(top, ['var', `GIT_${role}_IDENT`], { env: identityEnv }).replace(/ \d+ [+-]\d+$/, '');
      const identity = /^(.*) <([^<>]+)>$/.exec(name);
      if (!identity) throw new Error('Set your git author name and email before merging.');
      env[`GIT_${role}_NAME`] = identity[1]; env[`GIT_${role}_EMAIL`] = identity[2];
    }
    const made = b(['commit-tree', wanted, '-p', base, '-p', commit, '-m', msg]).toString().trim();
    b(['update-ref', 'refs/heads/prepared', made]);
    git(top, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', bare, 'refs/heads/prepared'], { network: 'bundle' });
    verifyRepositoryObjects(top, [made]);
    if (git(top, ['rev-parse', 'HEAD']) !== head) throw new Error('The branch moved while preparing the merge; retry.');
    git(top, ['merge', '--ff-only', '--no-edit', made]);
    if (git(top, ['rev-parse', 'HEAD^{tree}']) !== wanted) throw new Error('The final merge differs from the isolated preview tree.');
    console.log(`Merged ${commit} with the settled clashes: ${made.slice(0, 10)}.`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

try {
  const [dir, flag, msg] = process.argv.slice(2);
  if (!dir || flag !== '-m' || !msg) throw new Error('usage: scripts/merge-prepared.sh <dir> -m "<merge message>"');
  apply(fs.realpathSync(dir), msg);
} catch (e) { console.error(e.message); process.exitCode = 1; }
