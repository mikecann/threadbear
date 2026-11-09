// scripts/install-windows.mjs and windows-run.mjs. Task Scheduler is never touched: the
// installer is handed stand-ins for schtasks, and PowerShell is real only for the
// registry key, which is a throwaway one (never HKCU\Environment).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpDir } from '../helpers/fakes.ts';
import { IS_WINDOWS, onlyOnWindows } from '../helpers/platform.ts';

const RUNNER_DIR = path.join(import.meta.dirname, '..', '..');
const SCRIPTS = path.join(RUNNER_DIR, 'scripts');

process.env.THREADBEAR_INSTALL_NO_RUN = '1';
process.env.THREADBEAR_SUPERVISE_NO_RUN = '1';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const inst: any = await import(pathToFileURL(path.join(SCRIPTS, 'install-windows.mjs')).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sup: any = await import(pathToFileURL(path.join(SCRIPTS, 'windows-run.mjs')).href);

const WINDOWS_ONLY = onlyOnWindows('Only Windows has Task Scheduler, PowerShell and cmd.exe');

const realPs = (command: string): string =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }).trim();

// A registry key to stand in for HKCU\Environment, removed afterwards.
async function withKey<T>(fn: (key: string) => Promise<T> | T): Promise<T> {
  const key = `Software\\tb-test-${crypto.randomBytes(4).toString('hex')}`;
  try {
    return await fn(key);
  } finally {
    realPs(`Remove-Item -Path 'HKCU:\\${key}' -Recurse -ErrorAction SilentlyContinue; exit 0`);
  }
}

// Writes the PATH value by code points and kind, with nothing of the installer's in it.
function seed(key: string, value: string, kind: 'ExpandString' | 'String'): void {
  const codes = [...value].map((c) => c.codePointAt(0)).join(',');
  realPs(`$s = -join ((${codes}) | ForEach-Object { [char]$_ }); $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${key}'); $k.SetValue('Path', $s, '${kind}')`);
}
function stored(key: string): { value: string; kind: string } {
  const codes = realPs(`$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${key}'); ($k.GetValue('Path', '', 'DoNotExpandEnvironmentNames').ToCharArray() | ForEach-Object { [int]$_ }) -join ','`);
  const kind = realPs(`[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${key}').GetValueKind('Path')`);
  return { value: String.fromCharCode(...codes.split(',').filter(Boolean).map(Number)), kind };
}

const PATH_WITH_LETTERS = 'C:\\Users\\Jos\u00e9\\bin;%USERPROFILE%\\x;C:\\Users\\M\u00fcller\\npm';

// ---------------------------------------------------------------- names

test('the task is named for the user, with the characters Task Scheduler refuses taken out', () => {
  assert.equal(inst.taskNameFor('Owner'), 'Threadbear Runner (Owner)');
  assert.equal(inst.taskNameFor('Jos\u00e9'), 'Threadbear Runner (Jos\u00e9)');
  assert.equal(inst.taskNameFor('a\\b/c:d*e?f"g<h>i|j[k]l'), 'Threadbear Runner (a_b_c_d_e_f_g_h_i_j_k_l)');
  assert.equal(inst.taskNameFor(''), inst.LEGACY_TASK);
  assert.notEqual(inst.taskNameFor('Ann'), inst.taskNameFor('Bob'));
});

// ---------------------------------------------------------------- tb.cmd

test('tb.cmd is the one line it always was when the paths are plain', () => {
  assert.equal(inst.tbCmdText({ node: 'C:\\Program Files\\nodejs\\node.exe', tbScript: 'D:\\x\\runner\\bin\\tb' }, {}), '@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" "D:\\x\\runner\\bin\\tb" %*\r\n');
});

test('tb.cmd names a path with letters outside ASCII by variable, so none of them are in the file', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\Zo\u00eb\\AppData\\Local', USERPROFILE: 'C:\\Users\\Zo\u00eb', ProgramFiles: 'C:\\Program Files' };
  const text = inst.tbCmdText({ node: 'C:\\Users\\Zo\u00eb\\AppData\\Local\\Programs\\Threadbear\\node\\node.exe', tbScript: 'C:\\Users\\Zo\u00eb\\tools\\runner\\bin\\tb' }, env);
  assert.equal(text, '@echo off\r\n"%LOCALAPPDATA%\\Programs\\Threadbear\\node\\node.exe" "%USERPROFILE%\\tools\\runner\\bin\\tb" %*\r\n');
  assert.doesNotMatch(text, /[^\x00-\x7f]/);
  // Variable names are case-insensitive on Windows, and a folder that only starts with the same letters isn't under it.
  assert.match(inst.tbCmdText({ node: 'c:\\users\\zo\u00eb\\n.exe', tbScript: 'x' }, { UserProfile: 'C:\\Users\\Zo\u00eb' }), /^@echo off\r\n"%USERPROFILE%\\n\.exe"/);
  assert.match(inst.tbCmdText({ node: 'C:\\Users\\Zo\u00ebx\\n.exe', tbScript: 'x' }, { USERPROFILE: 'C:\\Users\\Zo\u00eb' }), /chcp 65001/, 'not under it, so the code page is switched');
});

test('tb.cmd switches the console to UTF-8 and back when letters outside ASCII are left', () => {
  const text: string = inst.tbCmdText({ node: 'D:\\Tools\\n\u00f6de\\node.exe', tbScript: 'D:\\Repos\\\u00c9tude\\runner\\bin\\tb' }, {});
  const lines = text.split('\r\n');
  assert.equal(lines[0], '@echo off');
  assert.ok(lines.indexOf('chcp 65001 >nul') > 0 && lines.indexOf('chcp 65001 >nul') < lines.findIndex((l) => l.includes('n\u00f6de')), 'UTF-8 first, then the path');
  assert.ok(lines.some((l) => /^if defined TB_CP chcp %TB_CP% >nul$/.test(l)), 'and the old one back');
  assert.match(text, /exit \/b %TB_EXIT%/);
  assert.equal(inst.tbCmdText({ node: 'D:\\100%\\node.exe', tbScript: 'x' }, {}), '@echo off\r\n"D:\\100%%\\node.exe" "x" %*\r\n', 'a % in a batch file is doubled');
});

test('tb.cmd run from a folder with letters outside ASCII in its name finds its script, passes the arguments, and leaves the code page as it was', WINDOWS_ONLY, () => {
  const dir = path.join(tmpDir(), 'Zo\u00eb Jos\u00e9');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  const script = path.join(dir, 'bin', 'tb.mjs');
  fs.writeFileSync(script, "console.log('ARGS ' + process.argv.slice(2).join(' '));\n");
  const tbCmd = path.join(dir, 'tb.cmd');
  fs.writeFileSync(tbCmd, inst.tbCmdText({ node: process.execPath, tbScript: script }, {}));
  const cmd = process.env.ComSpec || 'cmd.exe';
  const run = (line: string) => spawnSync(cmd, ['/d', '/s', '/c', `"${line}"`], { encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true }).stdout;
  const page = (out: string) => /(\d{3,5})\s*$/.exec(out.trim())?.[1];
  const before = page(run('chcp'));
  const out = run(`"${tbCmd}" one two & chcp`);
  assert.match(out, /ARGS one two/);
  assert.equal(page(out), before, 'the console is back on the code page it started with');
});

// ---------------------------------------------------------------- the user PATH

test('the user PATH is read and written without losing letters outside ASCII or %VARIABLES%, and keeps its kind', WINDOWS_ONLY, async () => {
  await withKey((key) => {
    seed(key, PATH_WITH_LETTERS, 'ExpandString');
    assert.equal(inst.readUserPath(realPs, key), PATH_WITH_LETTERS);
    inst.writeUserPath(realPs, key, `${inst.readUserPath(realPs, key)};D:\\add\\bin`);
    assert.deepEqual(stored(key), { value: `${PATH_WITH_LETTERS};D:\\add\\bin`, kind: 'ExpandString' });

    // A PATH that was a plain string stays one.
    seed(key, 'C:\\Users\\M\u00fcller\\bin', 'String');
    inst.writeUserPath(realPs, key, 'C:\\Users\\M\u00fcller\\bin;D:\\add\\bin');
    assert.deepEqual(stored(key), { value: 'C:\\Users\\M\u00fcller\\bin;D:\\add\\bin', kind: 'String' });
  });
});

test('a PATH with quotes, curly quotes, dollar signs and backticks goes through PowerShell as it is', WINDOWS_ONLY, async () => {
  await withKey((key) => {
    const odd = "C:\\O'Brien\\bin;C:\\O\u2019Brien\\bin;C:\\a$b\\`c;C:\\q\"x";
    inst.writeUserPath(realPs, key, odd);
    assert.equal(stored(key).value, odd);
    assert.equal(inst.readUserPath(realPs, key), odd);
    assert.equal(stored(key).kind, 'ExpandString', 'a PATH that did not exist is written as an expandable string');
    assert.equal(inst.readUserPath(realPs, `${key}-missing`), '', 'no key, no PATH');
  });
});

// ------------------------------------------------------------ with stand-ins

type Fake = {
  d: { tmp: string; [k: string]: unknown };
  lines: string[];
  errors: string[];
  calls: string[][];
  tasks: Set<string>;
  xml: string[];
  set(o: { state?: string; legacyOwner?: string; failRun?: boolean }): void;
  binDir: string;
};

function fake(key: string, tasks: string[] = []): Fake {
  const lines: string[] = [];
  const errors: string[] = [];
  const calls: string[][] = [];
  const xml: string[] = [];
  const have = new Set(tasks);
  const opts: { state?: string; legacyOwner?: string; failRun?: boolean } = { state: 'Ready', legacyOwner: 'mine' };
  const binDir = path.join(tmpDir(), 'Threadbear', 'bin');
  const d = {
    task: 'Threadbear Runner (Test)',
    me: 'PC\\Test',
    node: process.execPath,
    root: RUNNER_DIR,
    env: {},
    binDir,
    envKey: key,
    tmp: tmpDir(),
    out: (s: string) => lines.push(s),
    err: (s: string) => errors.push(s),
    schtasks: (...a: string[]) => {
      calls.push(a);
      if (a[0] === '/Query') {
        if (!have.has(a[2])) throw new Error('ERROR: The system cannot find the file specified.');
        return 'Status: Ready\r\nLast Run Time: never\r\nOther: x\r\n';
      }
      if (a[0] === '/Delete') have.delete(a[2]);
      if (a[0] === '/Create') {
        const buf = fs.readFileSync(a[4]);
        xml.push(buf.subarray(2).toString('utf16le'));
        have.add(a[2]);
      }
      if (a[0] === '/Run' && opts.failRun) throw Object.assign(new Error('failed'), { stderr: 'ERROR: Access is denied.\r\n' });
      return '';
    },
    ps: (command: string) => {
      if (/Principal\.UserId/.test(command)) return opts.legacyOwner ?? 'none';
      if (/\)\.State/.test(command)) return opts.state ?? '';
      return realPs(command);
    },
  };
  return { d, lines, errors, calls, tasks: have, xml, set: (o) => Object.assign(opts, o), binDir };
}

const verbs = (f: Fake) => f.calls.map((c) => `${c[0]} ${c[2] ?? ''}`.trim());

test('--start starts the task when it is there and stopped, and says so in one line', WINDOWS_ONLY, async () => {
  await withKey((key) => {
    const f = fake(key, ['Threadbear Runner (Test)']);
    assert.equal(inst.runInstaller(['--start'], f.d), 0);
    assert.deepEqual(f.lines, ['Started the runner.']);
    assert.ok(verbs(f).includes('/Run Threadbear Runner (Test)'));
  });
});

test('--start does nothing, and exits 0, when the task is running, not installed, or turned off', WINDOWS_ONLY, async () => {
  await withKey((key) => {
    const running = fake(key, ['Threadbear Runner (Test)']);
    running.set({ state: 'Running' });
    assert.equal(inst.runInstaller(['--start'], running.d), 0);
    assert.deepEqual(running.lines, ['The runner is already running.']);
    assert.ok(!verbs(running).some((v) => v.startsWith('/Run')));

    const none = fake(key, []);
    assert.equal(inst.runInstaller(['--start'], none.d), 0);
    assert.deepEqual(none.lines, ['The runner task is not installed, so nothing was started.']);
    assert.ok(!verbs(none).some((v) => v.startsWith('/Run')));

    const off = fake(key, ['Threadbear Runner (Test)']);
    off.set({ state: 'Disabled' });
    assert.equal(inst.runInstaller(['--start'], off.d), 0);
    assert.equal(off.lines.length, 1);
    assert.ok(!verbs(off).some((v) => v.startsWith('/Run')));

    // A task that can't be told running from stopped is started: a second start is ignored (IgnoreNew).
    const unknown = fake(key, ['Threadbear Runner (Test)']);
    unknown.set({ state: '' });
    assert.equal(inst.runInstaller(['--start'], unknown.d), 0);
    assert.ok(verbs(unknown).includes('/Run Threadbear Runner (Test)'));
  });
});

test('--start exits non-zero only when the start itself fails, and --start --dry-run touches nothing', WINDOWS_ONLY, async () => {
  await withKey((key) => {
    const f = fake(key, ['Threadbear Runner (Test)']);
    f.set({ failRun: true });
    assert.equal(inst.runInstaller(['--start'], f.d), 1);
    assert.match(f.errors.join('\n'), /Could not start the runner task: ERROR: Access is denied\./);

    const dry = fake(key, ['Threadbear Runner (Test)']);
    assert.equal(inst.runInstaller(['--start', '--dry-run'], dry.d), 0);
    assert.deepEqual(dry.calls, []);
  });
});

test('an earlier install under the plain name is found by --installed, --start and --stop when it is this user\'s, and left alone when it is not', WINDOWS_ONLY, async () => {
  await withKey((key) => {
    const mine = fake(key, ['Threadbear Runner']);
    assert.equal(inst.runInstaller(['--installed'], mine.d), 0);
    assert.equal(inst.runInstaller(['--start'], mine.d), 0);
    assert.ok(verbs(mine).includes('/Run Threadbear Runner'));
    assert.equal(inst.runInstaller(['--stop'], mine.d), 0);
    assert.ok(verbs(mine).includes('/End Threadbear Runner'));

    const theirs = fake(key, ['Threadbear Runner']);
    theirs.set({ legacyOwner: 'other' });
    assert.equal(inst.runInstaller(['--installed'], theirs.d), 1, "someone else's task is not this user's install");
    assert.equal(inst.runInstaller(['--stop'], theirs.d), 0);
    assert.equal(inst.runInstaller(['--uninstall'], theirs.d), 0);
    assert.ok(!verbs(theirs).some((v) => /^\/(End|Delete|Run)/.test(v)), `left alone: ${verbs(theirs)}`);

    const unsure = fake(key, ['Threadbear Runner']);
    unsure.set({ legacyOwner: 'unknown' });
    assert.equal(inst.runInstaller(['--stop'], unsure.d), 0);
    assert.ok(!verbs(unsure).some((v) => v.startsWith('/End')), 'when PowerShell would not say whose it is, it is left alone');
  });
});

test('installing registers this user\'s task, writes tb.cmd, adds its folder to the PATH keeping the rest, replaces an earlier plain-named task of this user\'s, and starts it', WINDOWS_ONLY, async () => {
  await withKey((key) => {
    seed(key, PATH_WITH_LETTERS, 'ExpandString');
    const f = fake(key, ['Threadbear Runner']);
    assert.equal(inst.runInstaller([], f.d), 0);
    const v = verbs(f);
    assert.ok(v.indexOf('/Delete Threadbear Runner') > -1 && v.indexOf('/Delete Threadbear Runner') < v.indexOf('/Create Threadbear Runner (Test)'), 'the old one goes before the new one is made');
    assert.ok(v.indexOf('/Run Threadbear Runner (Test)') > v.indexOf('/Create Threadbear Runner (Test)'));
    assert.equal(f.xml.length, 1);
    assert.match(f.xml[0], /<UserId>PC\\Test<\/UserId>/);
    assert.match(f.xml[0], new RegExp(`<Arguments>--headless "[^"]+" "[^"]*windows-run\\.mjs"</Arguments>`));
    assert.ok(fs.existsSync(path.join(f.binDir, 'tb.cmd')));
    assert.deepEqual(stored(key), { value: `${PATH_WITH_LETTERS};${f.binDir}`, kind: 'ExpandString' });
    // The temp XML is gone.
    assert.deepEqual(fs.readdirSync(f.d.tmp).filter((n) => n.endsWith('.xml')), []);
    // Installing again leaves the PATH as it is.
    assert.equal(inst.runInstaller([], f.d), 0);
    assert.equal(stored(key).value, `${PATH_WITH_LETTERS};${f.binDir}`);
  });
});

test('uninstalling takes out the task, tb.cmd and the PATH entry and keeps every other entry as it was', WINDOWS_ONLY, async () => {
  await withKey((key) => {
    const f = fake(key, ['Threadbear Runner (Test)']);
    fs.mkdirSync(f.binDir, { recursive: true });
    fs.writeFileSync(path.join(f.binDir, 'tb.cmd'), 'x');
    seed(key, `${PATH_WITH_LETTERS};${f.binDir}`, 'ExpandString');
    assert.equal(inst.runInstaller(['--uninstall'], f.d), 0);
    assert.deepEqual(verbs(f).filter((c) => /^\/(End|Delete)/.test(c)), ['/End Threadbear Runner (Test)', '/Delete Threadbear Runner (Test)']);
    assert.ok(!fs.existsSync(path.join(f.binDir, 'tb.cmd')));
    assert.deepEqual(stored(key), { value: PATH_WITH_LETTERS, kind: 'ExpandString' });
  });
});

test('--dry-run says what each does and changes nothing', WINDOWS_ONLY, async () => {
  await withKey((key) => {
    seed(key, PATH_WITH_LETTERS, 'ExpandString');
    for (const flag of [[], ['--stop'], ['--uninstall'], ['--start']]) {
      const f = fake(key, ['Threadbear Runner (Test)']);
      assert.equal(inst.runInstaller([...flag, '--dry-run'], f.d), 0);
      assert.ok(f.lines.length > 0);
      assert.ok(!verbs(f).some((c) => /^\/(End|Delete|Run|Create)/.test(c)), `${flag}: ${verbs(f)}`);
      assert.ok(!fs.existsSync(path.join(f.binDir, 'tb.cmd')));
    }
    assert.equal(stored(key).value, PATH_WITH_LETTERS);
  });
});

test('run as a program, --stop --dry-run prints its plan and exits 0, and a non-Windows host is told where to look', () => {
  const run = (...a: string[]) => {
    const r = spawn(process.execPath, [path.join(SCRIPTS, 'install-windows.mjs'), ...a], { env: { ...process.env, THREADBEAR_INSTALL_NO_RUN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    r.stdout.on('data', (c) => (out += c));
    r.stderr.on('data', (c) => (out += c));
    return new Promise<{ code: number | null; out: string }>((resolve) => r.once('close', (code) => resolve({ code, out })));
  };
  return run('--stop', '--dry-run').then((r) => {
    if (IS_WINDOWS) {
      assert.equal(r.code, 0);
      assert.match(r.out, /^End the task "Threadbear Runner \(.+\)"/);
    } else {
      assert.equal(r.code, 2);
      assert.match(r.out, /install-runner\.sh/);
    }
  });
});

// ------------------------------------------------------------ the supervisor

test('the supervisor waits longer after each quick failure, and starts again at the first wait after a runner that ran a minute', () => {
  const { nextWait, FIRST_WAIT_MS, MAX_WAIT_MS, HEALTHY_MS } = sup;
  assert.equal(nextWait(0, 1000), FIRST_WAIT_MS);
  let wait = 0;
  const seen: number[] = [];
  for (let i = 0; i < 12; i++) {
    wait = nextWait(wait, 500);
    seen.push(wait);
  }
  assert.deepEqual(seen.slice(0, 4), [5000, 10_000, 20_000, 40_000]);
  assert.equal(seen[seen.length - 1], MAX_WAIT_MS, 'and stops at the cap');
  assert.ok(seen.every((w, i) => i === 0 || w >= seen[i - 1]));
  assert.equal(nextWait(MAX_WAIT_MS, HEALTHY_MS), FIRST_WAIT_MS);
  assert.equal(nextWait(MAX_WAIT_MS, HEALTHY_MS - 1), MAX_WAIT_MS);
  assert.match('Another runner (pid 4242) is already using C:\\x; not starting.', sup.ALREADY_RUNNING);
  assert.doesNotMatch('could not listen', sup.ALREADY_RUNNING);
});

// Runs the supervisor against a stand-in for the runner. Resolves when it ends, or
// `ms` later with what it logged so far, ending it itself in that case.
function supervise(entryBody: string, ms: number): Promise<{ code: number | null; log: string; ended: boolean }> {
  const dir = tmpDir();
  const entry = path.join(dir, 'fake-main.mjs');
  fs.writeFileSync(entry, entryBody);
  const sv = spawn(process.execPath, [path.join(SCRIPTS, 'windows-run.mjs')], {
    env: { ...process.env, THREADBEAR_SUPERVISE_NO_RUN: '', LOCALAPPDATA: dir, THREADBEAR_SUPERVISE_ENTRY: entry, THREADBEAR_SUPERVISE_FIRST_WAIT_MS: '100' },
    stdio: 'ignore',
  });
  const logFile = path.join(dir, 'Threadbear', 'Logs', 'runner-supervisor.log');
  return new Promise((resolve) => {
    let ended = true;
    const timer = setTimeout(() => {
      ended = false;
      sv.kill(); // the supervisor started here, by this test
    }, ms);
    sv.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, log: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '', ended });
    });
  });
}

test('a runner that finds the data folder in use ends the supervisor with exit code 0, once, without starting it again', async () => {
  const r = await supervise(`process.stderr.write('Another runner (pid 4242) is already using C:\\\\data; not starting.\\n'); process.exit(1);\n`, 20_000);
  assert.equal(r.ended, true, 'the supervisor stopped itself');
  assert.equal(r.code, 0);
  assert.equal((r.log.match(/started the runner/g) ?? []).length, 1);
  assert.match(r.log, /another runner is already using the data folder/);
  assert.match(r.log, /Another runner \(pid 4242\)/, 'what the runner said is in the log');
});

test('a runner that keeps failing is started again after longer and longer waits', async () => {
  const r = await supervise(`process.exit(3);\n`, 2500);
  assert.equal(r.ended, false, 'a failing runner does not end the supervisor');
  const waits = [...r.log.matchAll(/starting it again in ([\d.]+) s/g)].map((m) => Number(m[1]));
  assert.deepEqual(waits.slice(0, 3), [0.1, 0.2, 0.4]);
  assert.match(r.log, /the runner exited \(3\)/);
});
