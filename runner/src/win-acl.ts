// The secrets folder made private on Windows, as chmod 700 makes it on a Mac
// (docs/gpui-port/runner-windows-plan.md, slice 5). There, chmod only sets
// or clears read-only, so the folder keeps what it inherits from
// %LOCALAPPDATA%. That's already this user's, SYSTEM's and the
// Administrators' only, as Windows makes a profile, but a profile whose
// folders someone has opened up (a shared PC, a backup tool, a folder
// moved to another drive) would pass that on to the runner's keys. So the
// folder stops inheriting, and only this user and SYSTEM (backups, the
// antivirus) can open it; files written into it from then on get the same.
//
// It keeps nothing out that runs as this user, threads included: the
// secrets guard and the RPC's check of the caller are for that.

import { execFile } from 'node:child_process';
import path from 'node:path';

type Run = (file: string, args: string[]) => Promise<string>;

const run: Run = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: 20_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(file)} failed: ${(stderr || stdout || err.message).trim()}`));
      else resolve(stdout);
    });
  });

// By full path: started by name, Windows looks in the runner's own folder
// first.
const system32 = (exe: string, env: NodeJS.ProcessEnv) => path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', exe);

const SYSTEM = 'S-1-5-18';

// This user's SID, from `whoami /user /fo csv /nh`: "pc\me","S-1-5-21-...".
export function sidFrom(text: string): string | undefined {
  return /"(S-1-5-[\d-]+)"/.exec(text)?.[1];
}

// icacls' arguments: inherit nothing, and full control for this user and
// SYSTEM, passed on to everything in the folder ((OI) files, (CI) folders).
// By SID, as a name can be ambiguous (a domain's user and a local one).
export function aclArgs(dir: string, sid: string): string[] {
  return [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, `*${SYSTEM}:(OI)(CI)F`, '/q'];
}

// Undefined when it's done (or there's nothing to do off Windows), and why
// not otherwise.
export async function makePrivate(dir: string, deps: { run?: Run; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}): Promise<string | undefined> {
  if ((deps.platform ?? process.platform) !== 'win32') return undefined;
  const env = deps.env ?? process.env;
  const exec = deps.run ?? run;
  try {
    const sid = sidFrom(await exec(system32('whoami.exe', env), ['/user', '/fo', 'csv', '/nh']));
    if (!sid) return "whoami didn't give this user's SID";
    await exec(system32('icacls.exe', env), aclArgs(dir, sid));
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}
