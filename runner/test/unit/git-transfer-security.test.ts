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
import { untrustedGit, untrustedGitRunSync, moduleHistoryBlobs, repoProofConfig, fileUrlPath } from '../../src/safe-git.ts';

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
  g(dest, 'config', 'branch.main.remote', 'old');
  await refusedBoth(dest, ['fetch', '-q'], "the branch's remote");
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

// A push to a repository on this machine writes into it as receive-pack
// decides, by that repository's config: receive.denyCurrentBranch
// updateInstead checks the pushed tree out (through git-lfs's filter and the
// target's own lfs.* programs) into its work tree, which core.worktree can
// put anywhere. So a local push target has to be a bare repository with
// nothing beyond the plainest settings (Gemini's second break-it review,
// 28 Nov 2026).
test('a local push target must be a plain bare repository', { skip: IS_WINDOWS }, async () => {
  const { root, dest } = fixture();
  const nonBare = repoAt(path.join(root, 'checkout'));
  g(nonBare, 'checkout', '-q', '-b', 'other');
  await refusedBoth(dest, ['push', '-q', nonBare, 'HEAD:refs/heads/main'], 'a repository with a work tree');
  for (const [key, value] of [['receive.denyCurrentBranch', 'updateInstead'], ['lfs.extension.x.smudge', 'true'], ['lfs.customtransfer.x.path', '/bin/true'], ['core.worktree', root], ['transfer.fsckObjects', 'true'], ['uploadpack.allowFilter', 'true']] as const) {
    const bare = repoAt(path.join(root, `${key.replace(/\W/g, '-')}.git`), { bare: true });
    g(bare, 'config', key, value);
    await refusedBoth(dest, ['push', '-q', bare, 'HEAD:refs/heads/main'], key);
  }
  const flipped = repoAt(path.join(root, 'flipped.git'), { bare: true });
  g(flipped, 'config', 'core.bare', 'false');
  await refusedBoth(dest, ['push', '-q', flipped, 'HEAD:refs/heads/main'], 'core.bare false');
});

// With no repository named, git takes it from branch.<name>.pushRemote,
// remote.pushDefault or branch.<name>.remote, each a remote's name or a path.
test("a push or fetch with no repository named checks the one git would take from the branch's settings", { skip: IS_WINDOWS }, async () => {
  const { root, dest } = fixture();
  const target = repoAt(path.join(root, 'hooked.git'), { bare: true });
  fs.writeFileSync(path.join(target, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  g(dest, 'config', 'branch.main.pushRemote', target);
  await refusedBoth(dest, ['push', '-q'], 'branch.main.pushRemote');
  g(dest, 'config', '--unset', 'branch.main.pushRemote');
  g(dest, 'config', 'remote.pushDefault', target);
  await refusedBoth(dest, ['push', '-q'], 'remote.pushDefault');
  g(dest, 'config', '--unset', 'remote.pushDefault');
  const hostile = repoAt(path.join(root, 'promisor'));
  makeHostile(hostile);
  g(dest, 'config', 'branch.main.remote', hostile);
  await refusedBoth(dest, ['fetch', '-q'], 'branch.main.remote');
});

// Naming a remote checks that remote, as git uses only it: a branch that
// tracks a local one (branch.<name>.remote ".") doesn't stop a landing's
// push to origin.
test('a push to a named remote checks that remote, not the rest of the settings', { skip: IS_WINDOWS }, async () => {
  const { root, dest } = fixture();
  const origin = repoAt(path.join(root, 'origin.git'), { bare: true });
  g(dest, 'remote', 'add', 'origin', origin);
  g(dest, 'branch', '-q', '--track', 'feature', 'main');
  const r = await untrustedGit(dest, ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { network: 'remote' });
  assert.ok(r.ok, r.stderr);
  fs.writeFileSync(path.join(origin, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await refusedBoth(dest, ['push', '-q', 'origin', 'HEAD:refs/heads/main'], 'the named remote itself');
});

// The history read takes every commit's .gitmodules, the first commit's too
// and from any folder, whatever log.showRoot or diff.relative the repo sets.
test("the submodule history read isn't narrowed by the repo's log or diff settings", { skip: IS_WINDOWS }, async () => {
  const root = tmpDir();
  const repo = path.join(root, 'r');
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
  g(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, '.gitmodules'), '[submodule "evilroot"]\n\tpath = evil\n\turl = ./evil\n');
  fs.writeFileSync(path.join(repo, 'sub', 'k'), 'k\n');
  g(repo, 'add', '.'); g(repo, 'commit', '-qm', 'root');
  g(repo, 'rm', '-q', '.gitmodules'); g(repo, 'commit', '-qm', 'gone');
  g(repo, 'config', 'log.showRoot', 'false');
  g(repo, 'config', 'diff.relative', 'true');
  const trace = path.join(root, 'trace');
  // Trace2's events carry each git's whole command line, its -c settings too.
  const r = await untrustedGit(path.join(repo, 'sub'), ['merge', '--ff-only', 'HEAD'], { env: { GIT_TRACE2_EVENT: trace } });
  assert.ok(r.ok, r.stderr);
  assert.match(fs.readFileSync(trace, 'utf8'), /submodule\.evilroot\.ignore=all/);
});

// git hands a local transport's server (upload-pack, receive-pack) none of
// the -c settings, so it reads the repository's own config. untrustedGit
// starts that server itself, as a fixed command with its own settings, so
// nothing a source or target names runs whatever the checks above miss
// (Gemini's third break-it review, 28 Nov 2026). Trace2's events show each
// git's whole command line, the server's too.
test("a local transfer's server runs with Threadbear's settings, not the repository's", { skip: IS_WINDOWS }, async () => {
  const { root, dest } = fixture();
  const src = repoAt(path.join(root, 'src'));
  const target = repoAt(path.join(root, 'target.git'), { bare: true });
  const trace = path.join(root, 'trace');
  for (const args of [['fetch', '-q', src, 'main'], ['ls-remote', src], ['push', '-q', target, 'HEAD:refs/heads/main'], ['clone', '-q', '--no-checkout', src, path.join(root, 'copy')]]) {
    fs.rmSync(trace, { force: true });
    const r = await untrustedGit(args[0] === 'clone' ? root : dest, args, { network: 'remote', env: { GIT_TRACE2_EVENT: trace } });
    assert.ok(r.ok, `${args[0]}: ${r.stderr}`);
    const server = fs.readFileSync(trace, 'utf8').split('\n').filter((l) => /"event":"start"/.test(l) && /"(upload|receive)-pack"/.test(l));
    assert.ok(server.length > 0, `${args[0]}: no server start in the trace`);
    for (const l of server) assert.match(l, /core\.alternateRefsCommand=true[\s\S]*core\.hooksPath=/, `${args[0]}: ${l}`);
  }
  // And, as a second layer, a source naming the program its alternates run is refused.
  g(src, 'config', 'core.alternateRefsCommand', 'true');
  await refusedBoth(dest, ['fetch', '-q', src, 'main'], 'a source with core.alternateRefsCommand');
});

// git takes a file:// path as written; a URL parser collapses `..` and, on
// a Mac or Linux, turns a backslash into a slash. Such an address isn't
// followed. A relative remote address is read against the repository's top
// folder (as git chdirs there) as well as the folder the command runs in.
test('a file:// address a URL parser would change, and a relative remote, are read as git reads them', { skip: IS_WINDOWS }, async () => {
  const { root, dest } = fixture();
  for (const word of [`file://${root}/link/../evil`, `file://${root}/a\\b`, `file://${root}/./x`]) await refusedBoth(dest, ['fetch', '-q', word, 'main'], word);
  makeHostile(repoAt(path.join(dest, 'evil')));
  fs.appendFileSync(path.join(dest, '.git', 'info', 'exclude'), 'evil/\n');
  fs.mkdirSync(path.join(dest, 'sub'));
  g(dest, 'remote', 'add', 'origin', './evil');
  await refusedBoth(path.join(dest, 'sub'), ['fetch', '-q', 'origin'], 'a relative remote read from a subfolder');
});

// A name git writes a checkout into is checked against .git's other
// spellings on every system (core.protectNTFS, core.protectHFS), whatever
// the repo says, and a repo that switches that off is refused.
test("protectNTFS and protectHFS are on for every command, and a repo can't switch them off", () => {
  const local = (key: string, value: string) => ({ scope: 'local', key, value });
  const out = repoProofConfig([]).join(' ');
  assert.match(out, /core\.protectNTFS=true/); assert.match(out, /core\.protectHFS=true/);
  for (const key of ['core.protectntfs', 'core.protecthfs']) assert.throws(() => repoProofConfig([local(key, 'false')]), /must move|protect/, key);
});

// The history read takes a .gitmodules a rename brought in, whatever
// log.follow says.
test('a .gitmodules brought in by a rename is still read with log.follow on', { skip: IS_WINDOWS }, async () => {
  const root = tmpDir();
  const repo = path.join(root, 'r');
  fs.mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'template'), '[submodule "renamed"]\n\tpath = evil\n\turl = ./evil\n');
  g(repo, 'add', '.'); g(repo, 'commit', '-qm', 'template');
  g(repo, 'mv', 'template', '.gitmodules'); g(repo, 'commit', '-qm', 'rename');
  g(repo, 'rm', '-q', '.gitmodules'); fs.writeFileSync(path.join(repo, 'k'), 'k\n'); g(repo, 'add', 'k'); g(repo, 'commit', '-qm', 'gone');
  g(repo, 'config', 'log.follow', 'true');
  const trace = path.join(root, 'trace');
  const r = await untrustedGit(repo, ['merge', '--ff-only', 'HEAD'], { env: { GIT_TRACE2_EVENT: trace } });
  assert.ok(r.ok, r.stderr);
  assert.match(fs.readFileSync(trace, 'utf8'), /submodule\.renamed\.ignore=all/);
});

// An ordinary clone's transfers go through, whatever form they take: a
// branch's remote is a remote's name when there is one (Gemini's fourth
// break-it review, 28 Nov 2026: "origin" read as a path made every fetch
// with no repository named look half local, half network, and refused).
test("an ordinary clone's fetches and pushes go through in every form", { skip: IS_WINDOWS }, async () => {
  const { root, dest } = fixture();
  const origin = repoAt(path.join(root, 'origin.git'), { bare: true });
  g(dest, 'remote', 'add', 'origin', origin);
  g(dest, 'push', '-q', '-u', 'origin', 'main');
  g(dest, 'branch', '-q', '--track', 'local-follow', 'main');
  g(dest, 'checkout', '-q', '-b', 'feat');
  fs.writeFileSync(path.join(dest, 'f'), 'f\n'); g(dest, 'add', 'f'); g(dest, 'commit', '-qm', 'f');
  g(dest, 'checkout', '-q', 'main');
  for (const args of [['fetch', '-q'], ['push', '-q'], ['fetch', '-q', '--all'], ['fetch', '--depth', '1', 'origin'], ['push', '-q', '-u', 'origin', 'feat'], ['push', '-q', '--force-with-lease', 'origin', 'main'], ['ls-remote', '-h'], ['ls-remote', '--heads', 'origin']]) {
    const r = await untrustedGit(dest, args, { network: 'remote' });
    assert.ok(r.ok, `${args.join(' ')}: ${r.stderr}`);
  }
  // With origin across the network, nothing is refused before git runs.
  g(dest, 'remote', 'set-url', 'origin', 'https://example.invalid/owner/repo.git');
  for (const args of [['fetch', '-q'], ['push', '-q'], ['fetch', '-q', '--all'], ['push', '-q', '-u', 'origin', 'feat'], ['push', '-q', '--force-with-lease', 'origin', 'main']]) {
    const r = await untrustedGit(dest, args, { network: 'remote', timeoutMs: 20_000 });
    assert.doesNotMatch(r.stderr, /Threadbear refused/, args.join(' '));
  }
});

// The caller never picks the server program: every way to name one is
// refused, rather than taken out (which a second spelling got past).
test('a caller-named server program is refused in every spelling', async () => {
  const { root, dest } = fixture();
  const src = repoAt(path.join(root, 'src'));
  for (const args of [
    ['fetch', '--upload-pack=x', src], ['fetch', '--upload-pack', 'x', src], ['ls-remote', '--upload-pack', 'x', src],
    ['push', '--receive-pack=x', src], ['push', '--receive-pack', 'x', src], ['push', '--exec=x', src], ['push', '--exec', 'x', src],
    ['clone', '-u', 'x', src, path.join(root, 'c1')], ['clone', '-ux', src, path.join(root, 'c2')], ['clone', '-qu', 'x', src, path.join(root, 'c3')],
  ]) await refusedBoth(args[0] === 'clone' ? root : dest, args, args.join(' '));
});

// An option that takes a value never hides the repository, and a local one
// named after it still gets Threadbear's server.
test('a local repository after an option with a value still gets the hardened server', { skip: IS_WINDOWS }, async () => {
  const { root, dest } = fixture();
  const src = repoAt(path.join(root, 'src'));
  const trace = path.join(root, 'trace');
  const r = await untrustedGit(dest, ['fetch', '--depth', '1', src, 'main'], { network: 'remote', env: { GIT_TRACE2_EVENT: trace } });
  assert.ok(r.ok, r.stderr);
  const server = fs.readFileSync(trace, 'utf8').split('\n').filter((l) => /"event":"start"/.test(l) && /"upload-pack"/.test(l));
  assert.ok(server.length > 0 && server.every((l) => /core\.alternateRefsCommand=true/.test(l)), server.join('\n'));
});

// A repo's own include.path names a file the operation itself can rewrite
// (a checkout), read again by a git started mid-way (rebase's am), after
// the settings were read and switched off: refused, as includeIf is.
test('a repo-local include is refused; rebase, rerere settings are pinned', async () => {
  const { root, dest } = fixture();
  g(dest, 'config', 'include.path', '../evil.gitconfig');
  for (const args of [['status'], ['rebase', 'main'], ['merge', '--ff-only', 'HEAD']]) {
    const r = await untrustedGit(dest, args);
    assert.equal(r.ok, false, args.join(' ')); assert.match(r.stderr, /includes another file/);
  }
  const global = path.join(root, 'global.gitconfig');
  fs.writeFileSync(global, `[include]\n\tpath = ${path.join(root, 'more.gitconfig')}\n`);
  g(dest, 'config', '--unset', 'include.path');
  assert.ok((await untrustedGit(dest, ['status'], { env: { GIT_CONFIG_GLOBAL: global } })).ok, "the owner's own includes stay");
  const out = repoProofConfig([]).join(' ');
  for (const pin of ['rebase.backend=merge', 'rerere.enabled=false', 'rerere.autoUpdate=false']) assert.ok(out.includes(pin), pin);
});

// Windows file:// addresses (file:///C:/...) are paths too.
test('a file:// address reads the same on Windows, and is refused where a parser would change it', () => {
  assert.equal(fileUrlPath('file:///C:/Users/x/repo', true), 'C:\\Users\\x\\repo');
  assert.equal(fileUrlPath('file://localhost/C:/r', true), 'C:\\r');
  assert.throws(() => fileUrlPath('file:///C:/x/../y', true), /refused/);
  assert.equal(fileUrlPath('file:///tmp/r', false), '/tmp/r');
  assert.throws(() => fileUrlPath('file:///tmp/a\\b', false), /refused/);
});

// A remote's own server program (remote.<name>.uploadpack, .receivepack)
// is never the repo's to name, and a promisor remote on this machine is
// refused whatever repository a command names: on a git that ignores
// GIT_NO_LAZY_FETCH, a missing object made git fetch from it with its own
// settings (Gemini's fifth break-it review, 28 Nov 2026). A promisor across
// the network (a partial clone from GitHub) still works.
test("a repo can't name a remote's server program or keep a promisor on this machine", async () => {
  const { root, dest } = fixture();
  for (const key of ['remote.origin.uploadpack', 'remote.origin.receivepack']) {
    g(dest, 'config', key, 'git-upload-pack');
    for (const args of [['status'], ['fetch', '-q', 'origin']]) await refusedBoth(dest, args, `${key}: ${args[0]}`);
    g(dest, 'config', '--unset', key);
  }
  g(dest, 'remote', 'add', 'origin', 'https://example.invalid/owner/repo.git');
  g(dest, 'config', 'remote.origin.promisor', 'true');
  g(dest, 'config', 'extensions.partialClone', 'origin');
  assert.ok((await untrustedGit(dest, ['status'])).ok, 'a promisor across the network is fine');
  const other = repoAt(path.join(root, 'other.git'), { bare: true });
  g(dest, 'remote', 'add', 'evil', other);
  g(dest, 'config', 'remote.evil.promisor', 'true');
  for (const args of [['status'], ['fetch', '-q', 'origin']]) await refusedBoth(dest, args, `a local promisor: ${args[0]}`);
});

test('merges are always ort or octopus, and push never takes --repo', async () => {
  const out = repoProofConfig([]).join(' ');
  for (const pin of ['pull.twohead=ort', 'pull.octopus=octopus']) assert.ok(out.includes(pin), pin);
  const { root, dest } = fixture();
  const target = repoAt(path.join(root, 't.git'), { bare: true });
  for (const args of [['push', '--repo=https://example.invalid/a', target, 'HEAD:refs/heads/x'], ['push', '--repo', 'x', target], ['push', '--rep=x', target]]) await refusedBoth(dest, args, args.join(' '));
});
