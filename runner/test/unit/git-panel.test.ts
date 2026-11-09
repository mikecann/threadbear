import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';
import { checkAction, checkPanel } from '../helpers/protocol-check.ts';
import { applyLive, loadPatchSet, projectPanels } from '../../src/patches.ts';
import { configureGitPanel, gitPanelKey, gitPanelSettings, handleGitPanel, parseRemote, parseStatus, pushAllowed, type GitPanelHost } from '../../src/git-panel.ts';

const TOKEN = 'test-token';
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

function repo(home: string, rel: string): string {
  const dir = path.join(home, rel);
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@example.com');
  sh(dir, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  sh(dir, 'add', 'a.txt');
  sh(dir, 'commit', '-q', '-m', 'First');
  return dir;
}

function setUp(extra: Partial<GitPanelHost> = {}): GitPanelHost {
  const h: GitPanelHost = { port: 9999, token: TOKEN, on: () => true, settings: () => ({}), githubLogin: async () => 'me', ...extra };
  configureGitPanel(h);
  return h;
}

afterEach(() => configureGitPanel(undefined));

const ctx = (cwd: string) => ({ cwd, threadId: 't1', run: async () => ({ ok: true, text: '', truncated: false, durationMs: 0 }) });

test('a thread in a git repo gets the Git panel, with chips only when there is something to do', async () => {
  const home = tmpDir();
  const dir = repo(home, 'dev/app');
  setUp();
  const base = await loadPatchSet(path.join(dir), home);
  const panel = base.panels.find((p) => p.patch === 'git')!;
  assert.deepEqual(checkPanel(panel as never), []);
  assert.equal(panel.title, 'Git');
  assert.equal(panel.url, `http://127.0.0.1:9999/git/?repo=${encodeURIComponent(dir)}&k=${gitPanelKey(TOKEN, dir)}`);
  assert.deepEqual(base.patches.find((p) => p.id === 'git'), { id: 'git', source: 'builtin', folder: dir });
  // Nothing staged, no remote: no chips, no badge.
  let set = await applyLive(base, ctx(dir));
  assert.deepEqual(set.actions.filter((a) => a.patch === 'git'), []);
  // A file staged: Commit 1 staged & push, and the panel's badge counts it.
  fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
  sh(dir, 'add', 'b.txt');
  setUp(); // forgets the counts it had
  set = await applyLive(base, ctx(dir));
  const chips = set.actions.filter((a) => a.patch === 'git');
  assert.deepEqual(chips.map((a) => a.title), ['Commit 1 staged & push']);
  for (const a of chips) assert.deepEqual(checkAction(a as never), []);
  assert.equal(chips[0].kind, 'prompt');
  assert.match(chips[0].prompt!, /Never force-push, never use --no-verify/);
  assert.match(chips[0].prompt!, /GitHub login/);
  assert.doesNotMatch(chips[0].prompt!, /waynesutton|mikecann/);
  assert.equal(set.panels.find((p) => p.patch === 'git')!.badge, 1);
  // With a remote, the commit no remote has is one to publish.
  sh(dir, 'remote', 'add', 'origin', 'https://github.com/me/app.git');
  setUp();
  set = await applyLive(base, ctx(dir));
  assert.deepEqual(set.actions.filter((a) => a.patch === 'git').map((a) => a.title), ['Commit 1 staged & push', 'Publish branch']);
  assert.equal(set.panels.find((p) => p.patch === 'git')!.badge, 2);
});

test('the Git panel is off until the runner configures it, and when its experiment is off', async () => {
  const home = tmpDir();
  const dir = repo(home, 'dev/app');
  assert.deepEqual(projectPanels(dir, home), []);
  setUp({ on: () => false });
  assert.deepEqual(projectPanels(dir, home), []);
  setUp({ settings: () => ({ chips: 'off' }) });
  const set = await loadPatchSet(dir, home);
  assert.equal(set.panels.length, 1);
  assert.equal(set.actions.length, 0);
});

test("a thread outside any repo gets its project folder's repo, and the chips say which", async () => {
  const home = tmpDir();
  const dir = repo(home, 'dev/site');
  const elsewhere = path.join(home, 'notes');
  fs.mkdirSync(elsewhere);
  setUp({ settings: () => ({ chips: 'always', pushOwners: ['acme'] }) });
  const base = await loadPatchSet(elsewhere, home, new Map(), [{ folder: dir, projectId: 'p1' }]);
  const panel = base.panels.find((p) => p.patch === 'git')!;
  assert.equal(panel.projectId, 'p1');
  const set = await applyLive(base, ctx(elsewhere));
  assert.deepEqual(set.actions.map((a) => a.title), ['Commit staged & push · site', 'Publish branch · site']);
  assert.match(set.actions[0].prompt!, /owned by acme/);
});

// ------------------------------------------------------------ the page and API

async function serve(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    void handleGitPanel(req, res).then((answered) => {
      if (!answered) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise((r) => server.close(() => r())) };
}

function call(port: number, op: string, top: string, body?: Record<string, unknown>, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  return fetch(`http://127.0.0.1:${port}/git/api/${op}${body ? '' : `?repo=${encodeURIComponent(top)}`}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Threadbear-Git': gitPanelKey(TOKEN, top), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify({ repo: top, ...body }) : undefined,
  }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> }));
}

test('the page and its API serve only a thread\'s repo, with its key, on the loopback address', async () => {
  const home = tmpDir();
  const dir = repo(home, 'dev/app');
  const other = repo(home, 'dev/other');
  const s = await serve();
  try {
    setUp({ port: s.port });
    projectPanels(dir, home); // a thread has had its panel
    const page = await fetch(`http://127.0.0.1:${s.port}/git/?repo=${encodeURIComponent(dir)}&k=${gitPanelKey(TOKEN, dir)}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /connect-src 'self'/);
    assert.match(await page.text(), /X-Threadbear-Git/);
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/git/?repo=${encodeURIComponent(dir)}&k=wrong`)).status, 403);
    assert.equal((await call(s.port, 'state', dir, undefined, { 'X-Threadbear-Git': 'wrong' })).status, 403);
    // A repo no thread has, even with the right key, isn't served.
    assert.equal((await call(s.port, 'state', other)).status, 404);
    // Another Host (DNS rebinding) is refused.
    const rebound = await new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port: s.port, path: `/git/api/state?repo=${encodeURIComponent(dir)}`, headers: { Host: `evil.example:${s.port}`, 'X-Threadbear-Git': gitPanelKey(TOKEN, dir) } }, (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      });
    });
    assert.equal(rebound, 421);
    // A form post (not JSON) is refused.
    const form = await fetch(`http://127.0.0.1:${s.port}/git/api/commit`, { method: 'POST', headers: { 'X-Threadbear-Git': gitPanelKey(TOKEN, dir), 'Content-Type': 'text/plain' }, body: JSON.stringify({ repo: dir, message: 'x' }) });
    assert.equal(form.status, 415);
    // Not this runner's path at all: left to the caller.
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/other`)).status, 404);
  } finally {
    await s.close();
  }
});

test('stage, commit, generate and a guarded push through the API', async () => {
  const home = tmpDir();
  const dir = repo(home, 'dev/app');
  const bare = path.join(home, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  sh(dir, 'remote', 'add', 'origin', bare);
  const s = await serve();
  let asked = '';
  let owners: string[] | undefined;
  try {
    setUp({
      port: s.port,
      settings: () => (owners ? { pushOwners: owners } : {}),
      generate: async (p) => {
        asked = p.prompt;
        return { ok: true, value: '```\nAdd b\n```' };
      },
    });
    projectPanels(dir, home);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    let st = (await call(s.port, 'state', dir)).json;
    assert.deepEqual((st.changes as { file: string }[]).map((f) => f.file).sort(), ['a.txt', 'b.txt']);
    assert.equal(st.generate, true);
    assert.deepEqual(st.push, { ok: false, why: `origin belongs to someone else, not me. Ask the agent if you mean to push there, or add the owner to runner.json's gitPanel.pushOwners.` });
    // A path out of the repo, or an option, is dropped.
    assert.equal((await call(s.port, 'stage', dir, { files: ['../x', '/etc/passwd'] })).status, 400);
    assert.deepEqual((await call(s.port, 'stage', dir, { files: ['b.txt'] })).json, { ok: true });
    st = (await call(s.port, 'state', dir)).json;
    assert.deepEqual((st.staged as { file: string }[]).map((f) => f.file), ['b.txt']);
    const gen = (await call(s.port, 'generate', dir, {})).json;
    assert.deepEqual(gen, { ok: true, text: 'Add b' });
    assert.match(asked, /b\.txt/);
    assert.match(asked, /First/);
    assert.equal((await call(s.port, 'commit', dir, { message: '  ' })).json.ok, false);
    const done = (await call(s.port, 'commit', dir, { message: 'Add b' })).json;
    assert.equal(done.ok, true);
    assert.equal(sh(dir, 'log', '-1', '--format=%s').trim(), 'Add b');
    assert.equal(sh(dir, 'status', '--porcelain').trim(), 'M a.txt');
    // The push rule: refused, then allowed by pushOwners.
    assert.equal((await call(s.port, 'push', dir, {})).json.ok, false);
    owners = ['*'];
    const pushed = (await call(s.port, 'push', dir, {})).json;
    assert.deepEqual(pushed, { ok: true, message: 'Published main to origin.' });
    assert.equal(execFileSync('git', ['-C', bare, 'log', '-1', '--format=%s', 'main']).toString().trim(), 'Add b');
    st = (await call(s.port, 'state', dir)).json;
    assert.equal(st.upstream, 'origin/main');
    assert.equal(st.ahead, 0);
  } finally {
    await s.close();
  }
});

test("the panel won't read a repo whose own config sets a filter", async () => {
  const home = tmpDir();
  const dir = repo(home, 'dev/app');
  sh(dir, 'config', 'filter.x.clean', 'touch pwned');
  const s = await serve();
  try {
    setUp({ port: s.port, settings: () => ({ chips: 'when-needed' }) });
    const base = await loadPatchSet(dir, home);
    const st = (await call(s.port, 'state', dir)).json;
    assert.match(String(st.problem), /filter\.x\.clean/);
    assert.equal(fs.existsSync(path.join(dir, 'pwned')), false);
    const set = await applyLive(base, ctx(dir));
    assert.deepEqual(set.actions, []);
  } finally {
    await s.close();
  }
});

// ------------------------------------------------------------ the pieces

test('pushAllowed: pushOwners, else your GitHub login on github.com', async () => {
  const me = async () => 'Wayne';
  const gh = (owner: string, host = 'github.com') => ({ remote: 'origin', host, owner });
  assert.deepEqual(await pushAllowed(gh('wayne'), undefined, me), { ok: true });
  assert.equal((await pushAllowed(gh('mikecann'), undefined, me)).ok, false);
  assert.equal((await pushAllowed(gh('wayne', 'gitlab.com'), undefined, me)).ok, false);
  assert.deepEqual(await pushAllowed(gh('acme', 'gitlab.com'), ['ACME'], me), { ok: true });
  assert.equal((await pushAllowed(gh('wayne'), ['acme'], me)).ok, false);
  assert.deepEqual(await pushAllowed(gh('anyone'), ['*'], me), { ok: true });
  assert.match((await pushAllowed(gh('wayne'), undefined, async () => undefined) as { why: string }).why, /pushOwners/);
  assert.deepEqual(await pushAllowed({ remote: null, host: null, owner: null }, ['*'], me), { ok: false, why: 'This repo has no remote to push to.' });
});

test('parseRemote, parseStatus and gitPanelSettings', () => {
  assert.deepEqual(parseRemote('git@github.com:waynesutton/threadbear.git'), { host: 'github.com', owner: 'waynesutton', repo: 'threadbear' });
  assert.deepEqual(parseRemote('https://github.com/mikecann/threadbear'), { host: 'github.com', owner: 'mikecann', repo: 'threadbear' });
  assert.deepEqual(parseRemote('ssh://git@gitlab.com:2222/acme/site.git'), { host: 'gitlab.com', owner: 'acme', repo: 'site' });
  assert.equal(parseRemote('/tmp/remote.git'), undefined);
  const s = parseStatus('M  a.txt\0 M b.txt\0?? c.txt\0R  new.txt\0old.txt\0UU d.txt\0MM e.txt\0');
  assert.deepEqual(s.staged.map((f) => f.file + f.code), ['a.txtM', 'new.txtR', 'e.txtM']);
  assert.deepEqual(s.changes.map((f) => f.file + f.code), ['b.txtM', 'c.txtU', 'e.txtM']);
  assert.deepEqual(s.conflicts.map((f) => f.file), ['d.txt']);
  assert.deepEqual(gitPanelSettings({ pushOwners: ['me', 'bad owner', 3, '*'], chips: 'loud' }), { pushOwners: ['me', '*'] });
  assert.deepEqual(gitPanelSettings('x'), {});
});
