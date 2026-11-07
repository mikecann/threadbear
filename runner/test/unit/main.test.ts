// Starts the real runner entry point (no CLI is ever spawned: claudePath
// points nowhere) to check what happens when two start at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';
import { IS_WINDOWS, onlyOnWindows, withoutPowerShell } from '../helpers/platform.ts';
import { approxStartTime, groupAlive, killGroup, processInfo } from '../../src/proc.ts';

const RUNNER_DIR = path.join(import.meta.dirname, '..', '..');

// Every runner started here, so a test that fails halfway doesn't leave one running.
const started: ChildProcess[] = [];

function startRunner(home: string, port = 0, env: NodeJS.ProcessEnv = process.env): { proc: ChildProcess; out: () => string; listening: Promise<number>; exited: Promise<number | null> } {
  let out = '';
  const proc = spawn(process.execPath, ['src/main.ts'], {
    cwd: RUNNER_DIR,
    env: {
      ...env,
      THREADBEAR_HOME: home,
      THREADBEAR_PORT: String(port),
      THREADBEAR_LOG: path.join(home, 'runner.log'),
      THREADBEAR_CLAUDE_PATH: '/nonexistent/claude',
      THREADBEAR_ACCOUNTS_DIR: path.join(home, 'no-accounts'),
      THREADBEAR_CLAUDE_MAIN_DIR: path.join(home, 'no-main'),
      THREADBEAR_CLAUDE_MAIN_JSON: path.join(home, 'no-main.json'),
      // Never the real ~/.codex (its config.toml) or Token Stats' limits.json.
      THREADBEAR_CODEX_MAIN_DIR: path.join(home, 'no-codex-main'),
      THREADBEAR_TOKEN_STATS_LIMITS: path.join(home, 'no-limits.json'),
      THREADBEAR_CLI_UPDATES: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  started.push(proc);
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (out += d));
  const exited = new Promise<number | null>((r) => proc.once('exit', (code) => r(code)));
  const listening = new Promise<number>((resolve, reject) => {
    proc.stdout!.on('data', () => {
      const m = /listening on (\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    void exited.then((code) => reject(new Error(`exited ${code}: ${out}`)));
  });
  listening.catch(() => {});
  return { proc, out: () => out, listening, exited };
}

// This starts three whole runners. A quiet machine does it in 3 s, but a busy
// one (CI runs several test files at once) takes over 40, so the limit is its
// own and not the run's.
const THREE_RUNNERS = { timeout: 120_000 };

test('a second runner on the same data dir refuses to start and touches nothing', THREE_RUNNERS, async () => {
  const home = tmpDir();
  const a = startRunner(home);
  const port = await a.listening;
  // A process group the first runner owns, as children.json would list it.
  // (A node child that waits: it is ours, so its pid is ours to stop.)
  const owned = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: !IS_WINDOWS, stdio: 'ignore' });
  owned.unref();
  try {
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(
      path.join(home, 'run', 'children.json'),
      JSON.stringify([{ pid: owned.pid, command: process.execPath, startedAt: new Date().toISOString(), lstart: processInfo(owned.pid!)?.lstart ?? approxStartTime(Date.now()), groups: [] }]),
    );
    const b = startRunner(home);
    assert.equal(await b.exited, 1);
    assert.match(b.out(), /Another runner \(pid \d+\) is already using/);
    assert.equal(groupAlive(owned.pid!), true, "the first runner's CLI was not swept");

    // A runner on another data dir but the same port says so and exits.
    const c = startRunner(tmpDir(), port);
    assert.equal(await c.exited, 1);
    assert.match(c.out(), /port \d+ is already in use/);
    assert.doesNotMatch(c.out(), /Unhandled 'error' event/);

    // Run from a checkout on a temp data dir: no Sentry (sentry.ts).
    assert.match(fs.readFileSync(path.join(home, 'runner.log'), 'utf8'), /runner starting .*"sentry":false/);

    // Windows ends a process outright rather than delivering SIGTERM, so there
    // is no clean stop to check there.
    if (!IS_WINDOWS) {
      a.proc.kill('SIGTERM');
      assert.equal(await a.exited, 0);
      assert.equal(fs.existsSync(path.join(home, 'run', 'runner.pid')), false, 'the lock is released on a clean stop');
    }
  } finally {
    killGroup(owned.pid!, 'SIGKILL');
    for (const p of started.splice(0)) p.kill('SIGKILL');
  }
});

// Policy, AppLocker or a PowerShell that is too slow under load leave the
// runner unable to read start times. It must still see the first runner's lock
// as held (6 Nov: the second one started beside it, and the test above waited
// for it to exit until the clock ran out).
test("a second runner still refuses to start when PowerShell can't be run", { ...THREE_RUNNERS, ...onlyOnWindows('Only Windows reads start times through PowerShell') }, async () => {
  const home = tmpDir();
  const env = withoutPowerShell();
  const a = startRunner(home, 0, env);
  try {
    await a.listening;
    const b = startRunner(home, 0, env);
    assert.equal(await b.exited, 1);
    assert.match(b.out(), /Another runner \(pid \d+\) is already using/);
  } finally {
    for (const p of started.splice(0)) p.kill('SIGKILL');
  }
});
