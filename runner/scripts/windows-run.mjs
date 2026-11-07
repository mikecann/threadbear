// Keeps the runner up on Windows: what launchd's KeepAlive does on a Mac.
// The logon task (install-windows.mjs) runs this; it runs the runner from
// the checkout it sits in, and starts it again after it exits, whether it
// crashed or restarted itself (runner.restart exits 0 and expects a
// supervisor). Ending the task ends this, the runner and the CLIs, as Task
// Scheduler runs a task's processes in one job.
//
// A runner that keeps failing is tried again after longer and longer waits (5 s,
// 10 s, 20 s, up to 5 minutes), and a runner that ran for a minute starts the
// waits again. A runner that finds another one already using the data folder
// ends this supervisor instead, with exit code 0 so Task Scheduler doesn't
// start it again: whoever is running that one (a terminal, say) is in charge.
//
// A runner run this way is a runner from source: no releases, no follow main,
// no handover (docs/on-your-mac.md, "On Windows"). Update it with `git pull`.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// What main.ts writes before it exits 1 because another runner holds the lock.
export const ALREADY_RUNNING = /Another runner \(pid \d+\) is already using/;
export const FIRST_WAIT_MS = 5000;
export const MAX_WAIT_MS = 300_000;
export const HEALTHY_MS = 60_000;

// The wait before the next start: the first wait after a runner that ran long
// enough to count as healthy, twice the last one after one that didn't.
export function nextWait(lastWaitMs, ranMs, { first = FIRST_WAIT_MS, max = MAX_WAIT_MS, healthy = HEALTHY_MS } = {}) {
  if (!lastWaitMs || ranMs >= healthy) return first;
  return Math.min(lastWaitMs * 2, max);
}

// Roughly 2 MB is plenty of "the runner started" lines.
const LOG_LIMIT_BYTES = 2 * 1024 * 1024;

function run() {
  const logDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Threadbear', 'Logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'runner-supervisor.log');
  // Only for tests: a stand-in for the runner, and a shorter first wait.
  const entry = process.env.THREADBEAR_SUPERVISE_ENTRY || path.join(root, 'src', 'main.ts');
  const waits = { first: Number(process.env.THREADBEAR_SUPERVISE_FIRST_WAIT_MS) || FIRST_WAIT_MS };
  waits.max = waits.first * (MAX_WAIT_MS / FIRST_WAIT_MS);

  const note = (text) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`);

  // The log is cut to a second file when it gets big, between runs, when
  // nothing has it open.
  function rotateLog() {
    try {
      if (fs.statSync(logFile).size > LOG_LIMIT_BYTES) fs.renameSync(logFile, `${logFile}.1`);
    } catch {
      // no log yet, or one that can't be moved: carry on appending
    }
  }

  let wait = 0;
  function start() {
    rotateLog();
    const startedAt = Date.now();
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      env: { ...process.env, THREADBEAR_FOLLOW_MAIN: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    note(`started the runner, pid ${child.pid}`);
    // The runner's own words go to the log, and are watched for the one that
    // says another runner has the data folder.
    let said = '';
    const take = (d) => {
      fs.appendFileSync(logFile, d);
      if (said.length < 16_384) said += d;
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    let ended = false;
    const after = (what) => {
      if (ended) return;
      ended = true;
      if (ALREADY_RUNNING.test(said)) {
        note('another runner is already using the data folder, so this one stops');
        process.exit(0);
      }
      wait = nextWait(wait, Date.now() - startedAt, waits);
      note(`${what}; starting it again in ${wait / 1000} s`);
      setTimeout(start, wait);
    };
    child.on('error', (e) => after(`could not start the runner: ${e.message}`));
    // 'close' comes once the output has been read. A program the runner left
    // behind can hold the pipes open, so it isn't waited for long.
    child.on('close', (code, signal) => after(`the runner exited (${signal ?? code})`));
    child.on('exit', (code, signal) => setTimeout(() => after(`the runner exited (${signal ?? code})`), 500));
  }

  start();
}

// A test that wants only the functions above sets this.
if (!process.env.THREADBEAR_SUPERVISE_NO_RUN) run();
