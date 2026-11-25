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
  const clashes = read('clashes').split('\n').filter(Boolean);
  const settled = new Map();
  for (const f of clashes) {
    if (path.isAbsolute(f) || f.includes('\\') || f.split('/').some((p) => !p || p === '.' || p === '..')) throw new Error(`Unsafe clashing path: ${f}`);
    const file = path.join(dir, 'files', f);
    let parent = dir;
    for (const part of ['files', ...f.split('/')]) { parent = path.join(parent, part); const st = fs.lstatSync(parent); if (st.isSymbolicLink() || (parent === file ? !st.isFile() : !st.isDirectory())) throw new Error(`The settled copy must be a regular file in real directories: ${f}`); }
    const data = fs.readFileSync(file);
    if (/^(<<<<<<<|>>>>>>>)( |$)/m.test(data.toString('utf8'))) throw new Error(`Still has conflict markers under ${dir}/files: ${f}`);
    settled.set(f, data);
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
    const b = (args, input, allowed) => run(['-C', bare, '-c', `core.attributesFile=${os.devNull}`, '-c', 'merge.default=text', '-c', 'core.commitGraph=false', ...args], input, allowed);
    const empty = b(['hash-object', '-w', '-t', 'tree', '--stdin'], '').toString().trim();
    const merged = b([`--attr-source=${empty}`, 'merge-tree', '--write-tree', '--name-only', '-z', base, commit], undefined, [0, 1]).toString('utf8').split('\0');
    const tree = merged.shift().trim();
    if (fs.existsSync(path.join(dir, 'tree')) && read('tree') !== tree) throw new Error('The isolated tree differs from the preview: run the preview again.');
    const actual = [];
    for (const f of merged) { if (!f) break; actual.push(f); }
    if (JSON.stringify([...actual].sort()) !== JSON.stringify([...clashes].sort())) throw new Error('The isolated merge has different clashes: run the preview again.');
    b(['read-tree', tree]);
    for (const [f, data] of settled) {
      const entry = b(['--literal-pathspecs', 'ls-tree', '-z', tree, '--', f]).toString('utf8');
      const mode = /^(100644|100755) blob /.exec(entry)?.[1];
      if (!mode) throw new Error(`Settle ${f} after a fresh preview; its merged entry is not a regular file.`);
      const id = b(['hash-object', '-w', '--stdin'], data).toString().trim();
      b(['update-index', '--add', '--cacheinfo', `${mode},${id},${f}`]);
    }
    const wanted = b(['write-tree']).toString().trim();
    const identityEnv = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => /^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$/.test(k) && v !== undefined));
    const name = git(top, ['var', 'GIT_AUTHOR_IDENT'], { env: identityEnv }).replace(/ \d+ [+-]\d+$/, '');
    const identity = /^(.*) <([^<>]+)>$/.exec(name);
    if (!identity) throw new Error('Set your git author name and email before merging.');
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = identity[1];
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = identity[2];
    const made = b(['commit-tree', wanted, '-p', base, '-p', commit, '-m', msg]).toString().trim();
    b(['update-ref', 'refs/heads/prepared', made]);
    git(top, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', bare, 'refs/heads/prepared'], { network: 'bundle' });
    verifyRepositoryObjects(top);
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
