// Installs the runner on Windows as a Task Scheduler task that starts at
// logon (INSTALL.md, section 7). Everything it does is listed by
// --dry-run first, and docs/on-your-mac.md says what it leaves behind.
//
//   node scripts/install-windows.mjs --dry-run     say what it would do
//   node scripts/install-windows.mjs               install and start it
//   node scripts/install-windows.mjs --status      is the task there and running
//   node scripts/install-windows.mjs --installed   exit 0 if the task is there, 1 if not
//   node scripts/install-windows.mjs --start       start the task if it is there and not running
//   node scripts/install-windows.mjs --stop        end the task if it is running (it stays registered)
//   node scripts/install-windows.mjs --uninstall   end and remove the task and `tb`
//
// It leaves: the task "Threadbear Runner (<your user name>)" (this user, no
// admin rights), and `tb.cmd` in %LOCALAPPDATA%\Threadbear\bin, which goes on
// this user's PATH. The data folder (%APPDATA%\Threadbear) is the runner's own
// and stays.
//
// The task has this user's name in it because task names are shared by every
// user of the PC: two people installing, or an installer running elevated,
// must not find each other's. Earlier versions called it plain "Threadbear
// Runner"; one of those that belongs to this user is still found, ended and
// replaced or removed, and one that belongs to someone else is left alone.
//
// --start is for the desktop app when it opens and for installers after an
// upgrade, so the runner comes back. It starts the task only if it is there and
// not running, says in one line which it did, and exits 0 unless something
// really went wrong.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LEGACY_TASK = 'Threadbear Runner';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// This user's task name. Task Scheduler refuses \ / : * ? " < > | in a name;
// [ and ] are only trouble to PowerShell, which reads them as wildcards.
export function taskNameFor(username) {
  const clean = String(username).replace(/[\\/:*?"<>|[\]\r\n\t]/g, '_').trim();
  return clean ? `${LEGACY_TASK} (${clean})` : LEGACY_TASK;
}

const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// conhost --headless gives node a console with no window, which its children
// share, so nothing flashes up. The runner also hides its own children.
export function taskXml({ node, script, cwd, user }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Threadbear runner: starts at logon and is kept running.</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xmlEscape(user)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xmlEscape(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Hidden>true</Hidden>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec>
    <Command>conhost.exe</Command>
    <Arguments>--headless "${xmlEscape(node)}" "${xmlEscape(script)}"</Arguments>
    <WorkingDirectory>${xmlEscape(cwd)}</WorkingDirectory>
  </Exec></Actions>
</Task>
`;
}

// ---------------------------------------------------------------- tb.cmd

const NON_ASCII = /[^\x00-\x7f]/;
// Folders cmd.exe can name by variable, so a path under one needs no text of
// its own. The longest match wins (%LOCALAPPDATA% is under %USERPROFILE%).
const PATH_VARIABLES = ['LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'ProgramFiles', 'ProgramData'];

function fromEnv(env, name) {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

// A path as it goes into a batch file: a % there would start a variable.
const batchLiteral = (s) => s.replace(/%/g, '%%');

// A path with letters outside ASCII (a profile folder called Zoë or José)
// written as %VARIABLE%\rest where one of the variables covers it. cmd expands
// those when it runs, so none of that text ends up in the file. Paths that are
// plain ASCII come back as they were.
function viaVariable(p, env) {
  if (!NON_ASCII.test(p)) return batchLiteral(p);
  let best;
  for (const name of PATH_VARIABLES) {
    const value = fromEnv(env, name);
    if (!value) continue;
    const base = value.replace(/[\\/]+$/, '');
    const covers = p.length >= base.length && p.slice(0, base.length).toLowerCase() === base.toLowerCase() && (p.length === base.length || /[\\/]/.test(p[base.length]));
    if (covers && (!best || base.length > best.base.length)) best = { name, base };
  }
  return best ? `%${best.name}%${batchLiteral(p.slice(best.base.length))}` : batchLiteral(p);
}

// The text of tb.cmd. cmd.exe reads a batch file in the console's code page
// (OEM), not UTF-8, so a path with letters outside ASCII is named by variable
// where it can be. Whatever is left switches the console to UTF-8 for the
// run, and back after, which is the one way to have cmd read those letters
// right (a profile folder called Zoë gave "The system cannot find the path
// specified", 6 Nov).
export function tbCmdText({ node, tbScript }, env = process.env) {
  const n = viaVariable(node, env);
  const s = viaVariable(tbScript, env);
  if (!NON_ASCII.test(n + s)) return `@echo off\r\n"${n}" "${s}" %*\r\n`;
  return [
    '@echo off',
    'setlocal',
    'for /f "tokens=2 delims=:" %%c in (\'chcp\') do for /f %%n in ("%%c") do set "TB_CP=%%n"',
    'chcp 65001 >nul',
    `"${n}" "${s}" %*`,
    'set "TB_EXIT=%ERRORLEVEL%"',
    'if defined TB_CP chcp %TB_CP% >nul',
    'exit /b %TB_EXIT%',
    '',
  ].join('\r\n');
}

// ------------------------------------------------------------ PowerShell

// A PowerShell expression for any text, whatever is in it: quotes (the curly
// ones too, which PowerShell reads as quotes), $, backticks, letters outside ASCII.
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
export const psString = (s) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(s)}'))`;

// What `script` outputs, as text. powershell.exe writes to a pipe in the
// OEM code page, which node would read as UTF-8 and turn José into Jos?, so
// the text comes back as Base64 of its UTF-8 bytes.
export function psText(ps, script) {
  const encoded = ps(`[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((@(& { ${script} }) -join [Environment]::NewLine)))`);
  return Buffer.from(encoded, 'base64').toString('utf8');
}

// This user's PATH as the registry holds it, %VARIABLES% unexpanded.
// [Environment]::GetEnvironmentVariable would expand them, and writing that
// back with SetEnvironmentVariable would store the expanded text as a plain
// string: it would quietly rewrite everything else on the person's PATH. The
// key is 'Environment' except in the test that points it at a throwaway one.
export function readUserPath(ps, key) {
  return psText(ps, `$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${psString(key)}); if ($k) { $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames') }`);
}

// Written as the kind it had (an expandable string, as Windows' own PATH
// is, if there was none). Changing a variable through .NET is what tells
// running programs to re-read it, so a throwaway one is set and removed
// afterwards, for the real key only.
export function writeUserPath(ps, key, value) {
  ps(
    `$v = ${psString(value)}; $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(${psString(key)}); ` +
      `$kind = [Microsoft.Win32.RegistryValueKind]::ExpandString; ` +
      `if ($k.GetValueNames() -contains 'Path') { $was = $k.GetValueKind('Path'); if ($was -eq 'String') { $kind = $was } }; ` +
      `$k.SetValue('Path', $v, $kind); ` +
      (key === 'Environment' ? `[Environment]::SetEnvironmentVariable('THREADBEAR_PATH_CHANGED','1','User'); [Environment]::SetEnvironmentVariable('THREADBEAR_PATH_CHANGED',$null,'User')` : ''),
  );
}

const sameDir = (a, b) => a.replace(/\\$/, '').toLowerCase() === b.toLowerCase();
const onPath = (d, dir) => readUserPath(d.ps, d.envKey).split(';').some((p) => sameDir(p, dir));

// ------------------------------------------------------------------ tasks

function taskExists(d, name) {
  try {
    d.schtasks('/Query', '/TN', name);
    return true;
  } catch {
    return false;
  }
}

// Whether the task with the plain name earlier versions used is this user's:
// 'mine', 'other', 'none', or 'unknown' if PowerShell wouldn't say.
function legacyOwner(d) {
  try {
    const answer = d.ps(
      `$t = Get-ScheduledTask -TaskPath '\\' -TaskName ${psString(LEGACY_TASK)} -ErrorAction SilentlyContinue; ` +
        `if (-not $t) { 'none' } else { $id = [string]$t.Principal.UserId; $w = [Security.Principal.WindowsIdentity]::GetCurrent(); ` +
        `if ($id -ieq $w.Name -or $id -ieq $w.User.Value -or $id.EndsWith('\\' + $env:USERNAME, [StringComparison]::OrdinalIgnoreCase)) { 'mine' } else { 'other' } }`,
    );
    return /^(mine|other|none)$/.test(answer) ? answer : 'unknown';
  } catch {
    return 'unknown';
  }
}

// The tasks that are this user's: theirs by name, and a plain-named one of an
// earlier version if it is theirs. Someone else's is not listed.
function ownTasks(d) {
  const names = [];
  if (taskExists(d, d.task)) names.push(d.task);
  if (d.task !== LEGACY_TASK && taskExists(d, LEGACY_TASK) && legacyOwner(d) === 'mine') names.push(LEGACY_TASK);
  return names;
}

function endTask(d, name) {
  try {
    d.schtasks('/End', '/TN', name);
  } catch {
    // not running
  }
}

// 'Running', 'Ready', 'Disabled' and so on: PowerShell's own names for it,
// which don't change with the language Windows is in. Undefined if it can't be told.
function taskState(d, name) {
  try {
    return d.ps(`(Get-ScheduledTask -TaskPath '\\' -TaskName ${psString(name)} -ErrorAction Stop | Select-Object -First 1).State`) || undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ main

// Does what `argv` asks and gives the exit code. `d` is everything it touches
// outside its own process (Task Scheduler, PowerShell, folders and the
// registry key), so a test can hand it stand-ins.
export function runInstaller(argv, d) {
  const args = new Set(argv);
  const dry = args.has('--dry-run');
  const out = d.out;
  const tbCmdFile = path.join(d.binDir, 'tb.cmd');

  if (args.has('--status')) {
    const names = ownTasks(d);
    if (!names.length) {
      out(`The task "${d.task}" is not installed.`);
      return 0;
    }
    for (const name of names) {
      const q = d.schtasks('/Query', '/TN', name, '/FO', 'LIST', '/V');
      out([`Task: ${name}`, ...q.split(/\r?\n/).filter((l) => /^(Status|Last Run Time|Last Result|Next Run Time)/i.test(l))].join('\n'));
    }
    return 0;
  }

  // Exit 0 if the task is there, 1 if not: for the desktop app's first run.
  if (args.has('--installed')) return ownTasks(d).length ? 0 : 1;

  // For the desktop app when it opens and an installer after an upgrade: the
  // runner comes back if its task is there and has stopped.
  if (args.has('--start')) {
    if (dry) {
      out(`Start the task "${d.task}" if it is there and not running`);
      return 0;
    }
    const names = ownTasks(d);
    if (!names.length) {
      out('The runner task is not installed, so nothing was started.');
      return 0;
    }
    const name = names[0];
    const state = taskState(d, name);
    if (state === 'Running') {
      out('The runner is already running.');
      return 0;
    }
    if (state === 'Disabled') {
      out('The runner task is turned off in Task Scheduler, so it was not started.');
      return 0;
    }
    try {
      d.schtasks('/Run', '/TN', name);
    } catch (e) {
      d.err(`Could not start the runner task: ${oneLine(e)}`);
      return 1;
    }
    out('Started the runner.');
    return 0;
  }

  // End the task if it is running, so an installer can replace the files it
  // holds open. Leaves the task registered, so the next logon starts it again.
  if (args.has('--stop')) {
    out(`End the task "${d.task}" (and an older one named "${LEGACY_TASK}" if it is yours) if it is running`);
    if (dry) return 0;
    for (const name of ownTasks(d)) endTask(d, name);
    return 0;
  }

  if (args.has('--uninstall')) {
    out([`End and delete the task "${d.task}" (and an older one named "${LEGACY_TASK}" if it is yours)`, `Delete ${tbCmdFile} and take ${d.binDir} off this user's PATH`].join('\n'));
    if (dry) return 0;
    for (const name of ownTasks(d)) {
      endTask(d, name);
      d.schtasks('/Delete', '/TN', name, '/F');
    }
    fs.rmSync(tbCmdFile, { force: true });
    const before = readUserPath(d.ps, d.envKey);
    const kept = before.split(';').filter((p) => p && !sameDir(p, d.binDir));
    // Touch the PATH only if our folder is on it.
    if (kept.join(';') !== before.split(';').filter(Boolean).join(';')) writeUserPath(d.ps, d.envKey, kept.join(';'));
    out('Removed. The data folder is untouched.');
    return 0;
  }

  const script = path.join(d.root, 'scripts', 'windows-run.mjs');
  const tbText = tbCmdText({ node: d.node, tbScript: path.join(d.root, 'bin', 'tb') }, d.env);
  const older = ownTasks(d).includes(LEGACY_TASK);
  out(
    [
      `Register the task "${d.task}" for ${d.me}: at logon, hidden, no admin rights, restarted if it fails.`,
      `  runs: conhost.exe --headless "${d.node}" "${script}"`,
      ...(older ? [`End and delete the older task "${LEGACY_TASK}" of yours, which this replaces.`] : []),
      `Write ${tbCmdFile} and add ${d.binDir} to this user's PATH${onPath(d, d.binDir) ? ' (already there)' : ''}.`,
      `Start the task now.`,
    ].join('\n'),
  );
  if (dry) return 0;

  if (older) {
    endTask(d, LEGACY_TASK);
    d.schtasks('/Delete', '/TN', LEGACY_TASK, '/F');
  }
  const xmlFile = path.join(d.tmp, `threadbear-task-${process.pid}.xml`);
  fs.writeFileSync(xmlFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml({ node: d.node, script, cwd: d.root, user: d.me }), 'utf16le')]));
  try {
    d.schtasks('/Create', '/TN', d.task, '/XML', xmlFile, '/F');
  } finally {
    fs.rmSync(xmlFile, { force: true });
  }
  fs.mkdirSync(d.binDir, { recursive: true });
  fs.writeFileSync(tbCmdFile, tbText);
  if (!onPath(d, d.binDir)) writeUserPath(d.ps, d.envKey, [readUserPath(d.ps, d.envKey), d.binDir].filter(Boolean).join(';'));
  d.schtasks('/Run', '/TN', d.task);
  out('Installed and started. Open a new terminal to use `tb`. Check with: node scripts/install-windows.mjs --status');
  return 0;
}

// What a failed schtasks or PowerShell said, on one line.
function oneLine(e) {
  const text = String(e?.stderr || e?.stdout || e?.message || e).trim();
  return text.split(/\r?\n/).filter(Boolean).join(' ');
}

function realDeps() {
  const env = process.env;
  const username = os.userInfo().username;
  const run = (file, a) => execFileSync(file, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return {
    task: taskNameFor(username),
    me: `${env.USERDOMAIN || os.hostname()}\\${username}`,
    node: process.execPath,
    root,
    env,
    binDir: path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Threadbear', 'bin'),
    // 'Environment' except in the test that points it at a throwaway key.
    envKey: env.THREADBEAR_TEST_ENV_KEY || 'Environment',
    tmp: os.tmpdir(),
    out: (s) => console.log(s),
    err: (s) => console.error(s),
    schtasks: (...a) => run('schtasks', a),
    ps: (command) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]).trim(),
  };
}

// A test that wants only the functions above sets this.
if (!process.env.THREADBEAR_INSTALL_NO_RUN) {
  if (process.platform !== 'win32') {
    console.error('This installs the Windows task. On a Mac use scripts/install-runner.sh; on Linux see INSTALL.md.');
    process.exitCode = 2;
  } else {
    try {
      process.exitCode = runInstaller(process.argv.slice(2), realDeps());
    } catch (e) {
      console.error(oneLine(e));
      process.exitCode = 1;
    }
  }
}
