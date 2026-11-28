// A fetch, clone or ls-remote from a folder on this machine starts
// git-upload-pack there, and a push starts git-receive-pack, each reading
// that folder's own config and (for a push) running its hooks. -c settings
// don't reach them (git drops them for a local transport), so untrustedGit
// reads every repository the transfer could open first, found the way git
// finds it, and refuses one that could run something. On git before 2.44 a
// source that says it's a partial clone lazily fetches through its own
// core.sshCommand (review of findings 187/188, 27 Nov 2026), so these use
// that as the planted hostile source: refusing it is what's checked here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';
import { untrustedGit, untrustedGitRunSync, moduleHistoryBlobs } from '../../src/safe-git.ts';

const IS_WINDOWS = process.platform === 'win32';
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const g = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgSign=false', ...args], { stdio: 'pipe', env: ENV }).toString().trim();

function repoAt(dir: string, opts: { bare?: boolean } = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  if (opts.bare) { g(dir, 'init', '-q', '--bare', '-b', 'main'); return dir; }
  g(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a'), `${path.basename(dir)}\n`);
  g(dir, 'add', 'a'); g(dir, 'commit', '-qm', 'a');
  return dir;
}

// What a lower-trust folder's source could say: it's a partial clone whose
// promisor is reached through a program it names.
function makeHostile(gitDir: string): void {
  g(gitDir, 'config', 'remote.lazy.url', 'ssh://example.invalid/x');
  g(gitDir, 'config', 'remote.lazy.promisor', 'true');
  g(gitDir, 'config', 'extensions.partialClone', 'lazy');
  g(gitDir, 'config', 'core.sshCommand', '/bin/false');
}

function fixture() {
  const root = tmpDir();
  const dest = repoAt(path.join(root, 'dest'));
  return { root, dest };
}

const REFUSED = /refused|must move|can't be read|cannot inspect|transfer/i;

async function refusedBoth(dir: string, args: string[], why: string): Promise<void> {
  const r = await untrustedGit(dir, args, { network: 'remote', env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(r.ok, false, `${why}: untrustedGit ran git ${args.join(' ')}`);
  assert.match(r.stderr, REFUSED, why);
  const s = untrustedGitRunSync(dir, args, { network: 'remote', env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(s.ok, false, `${why}: untrustedGitRunSync ran git ${args.join(' ')}`);
  assert.match(s.stderr, REFUSED, why);
}

test('a clean local source still fetches, so the refusals below are about the source', async () => {
  const { root, dest } = fixture();
  const src = repoAt(path.join(root, 'src'));
  const r = await untrustedGit(dest, ['fetch', '-q', src, 'main'], { network: 'remote' });
  assert.ok(r.ok, r.stderr);
  makeHostile(src);
  await refusedBoth(dest, ['fetch', '-q', src, 'main'], 'a plain path to a hostile source');
});

test('a ~/ source is read where git expands it, not as a folder named ~', { skip: IS_WINDOWS }, async () => {
  const { root, dest } = fixture();
  const home = path.join(root, 'home');
  const payload = repoAt(path.join(home, 'payload'));
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    execFileSync('git', ['-C', dest, 'ls-remote', '~/payload'], { stdio: 'pipe', env: { ...ENV, HOME: home } }); // git expands it
    assert.ok((await untrustedGit(dest, ['fetch', '-q', '~/payload', 'main'], { network: 'remote' })).ok, 'a clean one still works');
    makeHostile(payload);
    await refusedBoth(dest, ['fetch', '-q', '~/payload', 'main'], '~/ source');
    g(dest, 'remote', 'add', 'home', '~/payload');
    await refusedBoth(dest, ['fetch', '-q', 'home'], 'a remote whose url is ~/');
    await refusedBoth(dest, ['fetch', '-q', '~someone-else/payload', 'main'], "another user's ~ can't be checked, so it isn't run");
  } finally {
    if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
  }
});

test("a linked worktree's .git file, or its folder, is followed to the repository it names", { skip: IS_WINDOWS }, async () => {
  const { root, dest } = fixture();
  const main = repoAt(path.join(root, 'main'));
  const wt = path.join(root, 'wt');
  g(main, 'worktree', 'add', '-q', wt, '-b', 'side');
  makeHostile(main);
  await refusedBoth(dest, ['fetch', '-q', path.join(wt, '.git'), 'side'], 'the .git file itself');
  await refusedBoth(dest, ['fetch', '-q', wt, 'side'], 'the worktree folder');
  // A gitfile anywhere, by any name, is a repository to git.
  const elsewhere = path.join(root, 'pointer');
  fs.writeFileSync(elsewhere, `gitdir: ${path.join(main, '.git')}\n`);
  await refusedBoth(dest, ['fetch', '-q', elsewhere, 'main'], 'a gitfile under another name');
});

test('a folder that is not a repository does not hide the .git-suffixed one upload-pack opens', { skip: IS_WINDOWS }, async () => {
  const { root, dest } = fixture();
  const x = path.join(root, 'x');
  fs.mkdirSync(path.join(x, 'src'), { recursive: true });
  const bare = repoAt(path.join(x, 'src.git'), { bare: true });
  g(repoAt(path.join(root, 'filler')), 'push', '-q', bare, 'HEAD:refs/heads/main');
  assert.match(execFileSync('git', ['-C', dest, 'ls-remote', path.join(x, 'src')], { env: ENV }).toString(), /refs\/heads\/main/, 'git opens src.git for src');
  makeHostile(bare);
  await refusedBoth(dest, ['fetch', '-q', path.join(x, 'src'), 'main'], 'src beside src.git');
  await refusedBoth(dest, ['ls-remote', path.join(x, 'src')], 'ls-remote of src beside src.git');
});

test("a push to a local repository never runs that repository's hooks", { skip: IS_WINDOWS }, async () => {
  const { root, dest } = fixture();
  const target = repoAt(path.join(root, 'target.git'), { bare: true });
  const marker = path.join(root, 'hook-ran');
  fs.writeFileSync(path.join(target, 'hooks', 'pre-receive'), `#!/bin/sh\necho ran >> '${marker}'\n`, { mode: 0o755 });
  execFileSync('git', ['-C', dest, '-c', 'core.hooksPath=/dev/null', 'push', '-q', target, 'HEAD:refs/heads/probe'], { env: ENV, stdio: 'pipe' });
  assert.ok(fs.existsSync(marker), "plain git runs the target's hook, so the checks below mean something");
  fs.rmSync(marker);
  await refusedBoth(dest, ['push', '-q', target, 'HEAD:refs/heads/main'], 'a target with a hook file');
  g(dest, 'remote', 'add', 'pub', 'https://example.invalid/pub.git');
  g(dest, 'remote', 'set-url', '--push', 'pub', target);
  await refusedBoth(dest, ['push', '-q', 'pub', 'HEAD:refs/heads/main'], "a remote's pushurl to a target with a hook file");
  assert.equal(fs.existsSync(marker), false, 'the hook never ran');
  // A target with no hook file but one named in its config is refused too.
  const named = repoAt(path.join(root, 'named.git'), { bare: true });
  g(named, 'config', 'hook.audit.command', `echo ran >> '${marker}'`);
  g(named, 'config', 'hook.audit.event', 'pre-receive');
  await refusedBoth(dest, ['push', '-q', named, 'HEAD:refs/heads/main'], 'a target naming a hook in config');
  const hooked = repoAt(path.join(root, 'hooked.git'), { bare: true });
  g(hooked, 'config', 'core.hooksPath', path.join(root, 'elsewhere'));
  await refusedBoth(dest, ['push', '-q', hooked, 'HEAD:refs/heads/main'], 'a target with its own hooks path');
  assert.equal(fs.existsSync(marker), false, 'no hook ran');
  // A clean local target still takes a push (once no remote of the repo
  // could reach a hooked one: every remote is checked, whichever is named).
  g(dest, 'remote', 'remove', 'pub');
  const clean = repoAt(path.join(root, 'clean.git'), { bare: true });
  const ok = await untrustedGit(dest, ['push', '-q', clean, 'HEAD:refs/heads/main'], { network: 'remote' });
  assert.ok(ok.ok, ok.stderr);
});

test("a clone's source and --reference are paths, never remote names, and no option hides a source", { skip: IS_WINDOWS }, async () => {
  const { root, dest } = fixture();
  g(dest, 'remote', 'add', 'origin', 'https://example.invalid/clean.git');
  makeHostile(repoAt(path.join(dest, 'origin')));
  fs.appendFileSync(path.join(dest, '.git', 'info', 'exclude'), 'origin/\n');
  await refusedBoth(dest, ['clone', '-q', 'origin', path.join(root, 'out')], 'clone of ./origin');
  await refusedBoth(dest, ['clone', '-q', '--reference', 'origin', 'https://example.invalid/clean.git', path.join(root, 'out2')], 'clone --reference ./origin');
  const hostile = repoAt(path.join(root, 'hostile'));
  makeHostile(hostile);
  await refusedBoth(dest, ['fetch', '--submodule-prefix', 'x', hostile, 'main'], 'a value-taking option the parser did not know');
  await refusedBoth(dest, ['fetch', '--multiple', 'origin', hostile], 'fetch --multiple');
});

test('a remote defined in .git/remotes or .git/branches is checked like a configured one', { skip: IS_WINDOWS }, async () => {
  const { root, dest } = fixture();
  const hostile = repoAt(path.join(root, 'hostile'));
  makeHostile(hostile);
  fs.mkdirSync(path.join(dest, '.git', 'remotes'), { recursive: true });
  fs.writeFileSync(path.join(dest, '.git', 'remotes', 'legacy'), `URL: ${hostile}\nPull: refs/heads/main:refs/heads/legacy\n`);
  await refusedBoth(dest, ['fetch', '-q', 'legacy'], 'a .git/remotes remote');
  fs.rmSync(path.join(dest, '.git', 'remotes'), { recursive: true });
  fs.mkdirSync(path.join(dest, '.git', 'branches'), { recursive: true });
  fs.writeFileSync(path.join(dest, '.git', 'branches', 'old'), `${hostile}\n`);
  await refusedBoth(dest, ['fetch', '-q', 'old'], 'a .git/branches remote');
  await refusedBoth(dest, ['fetch', '-q'], 'the default remote');
});

// Submodule names come from every .gitmodules blob in reach, a version
// added or removed by a type change (a link becoming the file) included:
// git log --raw shows those with one side's mode 120000 or 160000.
test('a .gitmodules version brought in or taken out by a type change is still read', { skip: IS_WINDOWS }, () => {
  const root = tmpDir();
  const repo = repoAt(path.join(root, 'r'));
  // git add refuses a linked .gitmodules, but a tree can still carry one.
  const blobOf = (text: string) => execFileSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], { input: text, env: ENV }).toString().trim();
  const a = g(repo, 'rev-parse', 'HEAD:a');
  const tree = (mode: string, id: string) => execFileSync('git', ['-C', repo, 'mktree'], { input: `100644 blob ${a}\ta\n${mode} blob ${id}\t.gitmodules\n`, env: ENV }).toString().trim();
  let head = g(repo, 'rev-parse', 'HEAD');
  const commit = (t: string, m: string) => { head = g(repo, 'commit-tree', t, '-p', head, '-m', m); };
  const link = blobOf('a');
  const blob = blobOf('[submodule "evil"]\n\tpath = evil\n\turl = ./evil\n\tignore = none\n');
  commit(tree('120000', link), 'link');
  commit(tree('100644', blob), 'file');
  commit(tree('120000', link), 'link again');
  g(repo, 'update-ref', 'refs/heads/main', head);
  const raw = g(repo, 'log', '-m', '--raw', '--no-abbrev', '--format=', '--all', '--', '.gitmodules');
  assert.ok(moduleHistoryBlobs(raw).includes(blob), raw);
  assert.equal(moduleHistoryBlobs(raw).length, 1, 'only the regular-file version, never a link target');
});

// Git strips trailing slashes before trying its suffixes, keeps a file://
// address's ? and # as part of the path, and lets the OS resolve `..`
// through a link (Gemini's break-it review of 187/188, 28 Nov 2026).
test('a trailing slash, a file:// address with ?, # or % and a .. through a link are read as git reads them', { skip: IS_WINDOWS }, async () => {
  const { root, dest } = fixture();
  const home = path.join(root, 'home');
  const bare = repoAt(path.join(root, 'evil.git'), { bare: true });
  const homeBare = repoAt(path.join(home, 'hevil.git'), { bare: true });
  makeHostile(bare); makeHostile(homeBare);
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    for (const word of [`${root}/evil/`, `${root}/evil//`, `file://${root}/evil/`, '~/hevil/']) await refusedBoth(dest, ['fetch', '-q', word, 'main'], word);
  } finally {
    if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
  }
  for (const word of [`file://${root}/odd#x`, `file://${root}/odd?x`, `file://${root}/odd%41`]) await refusedBoth(dest, ['fetch', '-q', word, 'main'], word);
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
  fs.symlinkSync(path.join(root, 'a', 'b'), path.join(root, 'link'));
  makeHostile(repoAt(path.join(root, 'a', 'sym.git'), { bare: true }));
  await refusedBoth(dest, ['fetch', '-q', `${root}/link/../sym`, 'main'], '.. through a link');
});

// Fetching from a named path doesn't use the repo's remotes, so a remote
// that couldn't be fetched from doesn't stop it (merge-prepared.mjs fetches
// its own temporary repo, the update clone its checkout).
test('a fetch from a named repository is not stopped by an unrelated remote', { skip: IS_WINDOWS }, async () => {
  const { root, dest } = fixture();
  const src = repoAt(path.join(root, 'src'));
  const other = repoAt(path.join(root, 'other'));
  makeHostile(other);
  g(dest, 'remote', 'add', 'other', other);
  const r = await untrustedGit(dest, ['fetch', '-q', '--no-tags', src, 'main'], { network: 'bundle' });
  assert.ok(r.ok, r.stderr);
  await refusedBoth(dest, ['fetch', '-q', 'other'], 'fetching the hostile remote itself');
  await refusedBoth(dest, ['fetch', '-q', '--some-option-it-does-not-know', src, 'main'], 'an option it does not know still checks every remote');
});
