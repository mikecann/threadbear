// The core.hooksPath git runs with when it must run no hook (platform.ts,
// noHooksPath): safe-git's listings and repo checks, and live patch
// commands (shell-allowlist.ts).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { noHooksPath } from '../../src/platform.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-nohooks-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('/dev/null off Windows, a file of Windows\' own on it', () => {
  assert.equal(noHooksPath({ platform: 'darwin' }), '/dev/null');
  assert.equal(noHooksPath({ platform: 'linux' }), '/dev/null');
  assert.equal(noHooksPath({ platform: 'win32', env: { SystemRoot: 'D:\\WIN' } }), 'D:\\WIN\\System32\\ntdll.dll');
  assert.equal(noHooksPath({ platform: 'win32', env: {} }), 'C:\\Windows\\System32\\ntdll.dll');
});

// A repo whose own hooks folder has a post-commit that leaves a mark.
function repo(name: string): { dir: string; mark: string } {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe', windowsHide: true });
  git('init', '-q');
  const mark = path.join(dir, 'hook-ran');
  writeHook(path.join(dir, '.git', 'hooks'), mark);
  return { dir, mark };
}

function writeHook(hooks: string, mark: string): void {
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'post-commit'), `#!/bin/sh\necho ran > '${mark.replace(/\\/g, '/')}'\n`, { mode: 0o755 });
}

function commit(dir: string, hooksPath: string) {
  return spawnSync('git', ['-c', `core.hooksPath=${hooksPath}`, '-c', 'user.name=t', '-c', 'user.email=t@t', '-C', dir, 'commit', '-q', '--allow-empty', '-m', 'x'], { encoding: 'utf8', windowsHide: true });
}

test('git commits with it, says nothing about hooks, and runs none', () => {
  const { dir, mark } = repo('plain');
  // The hook does run without it, so the test can see one.
  assert.equal(commit(dir, path.join(dir, '.git', 'hooks')).status, 0);
  assert.ok(fs.existsSync(mark), 'the repo\'s hook ran without it');
  fs.rmSync(mark);
  const r = commit(dir, noHooksPath());
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /hook/i);
  assert.ok(!fs.existsSync(mark), 'no hook ran');
});

// What it's for: on GitHub's Windows machines only, as it makes \dev\null
// on the drive. Git for Windows runs a hook planted there under
// core.hooksPath=/dev/null, and not under noHooksPath().
const planted = process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true';
test('on Windows, /dev/null is a folder anyone can plant a hook in', { skip: !planted && 'GitHub\'s Windows machines only' }, (t) => {
  const { dir, mark } = repo('planted');
  const devNull = path.join(path.parse(dir).root, 'dev', 'null');
  const made = !fs.existsSync(path.dirname(devNull));
  writeHook(devNull, mark);
  t.after(() => fs.rmSync(made ? path.dirname(devNull) : devNull, { recursive: true, force: true }));
  assert.equal(commit(dir, '/dev/null').status, 0);
  assert.ok(fs.existsSync(mark), `a hook in ${devNull} ran under /dev/null`);
  fs.rmSync(mark);
  const r = commit(dir, noHooksPath());
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(mark), 'no hook ran');
});
