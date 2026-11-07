// What differs on Windows, in one place (docs/on-your-mac.md, "On Windows"). The
// rest of src/ asks this file rather than testing process.platform itself,
// so the Windows branches are easy to find and to test.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Probe = { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string };

export const IS_WINDOWS = process.platform === 'win32';

// The data dir. macOS and Linux keep ~/Library/Application Support/Threadbear
// (docs/protocol.md); Windows uses %APPDATA%\Threadbear.
export function dataDirFor(p: Probe = {}): string {
  const platform = p.platform ?? process.platform;
  const home = p.home ?? os.homedir();
  if (platform === 'win32') {
    const env = p.env ?? process.env;
    return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), 'Threadbear');
  }
  return path.join(home, 'Library', 'Application Support', 'Threadbear');
}

// Where the runner writes its log.
export function logFileFor(p: Probe = {}): string {
  const platform = p.platform ?? process.platform;
  const home = p.home ?? os.homedir();
  if (platform === 'win32') {
    const env = p.env ?? process.env;
    return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'Threadbear', 'Logs', 'threadbear-runner.log');
  }
  return path.join(home, 'Library', 'Logs', 'threadbear-runner.log');
}

// Where Claude Code's native install puts its program.
export function claudeBinaryFor(p: Probe = {}): string {
  const platform = p.platform ?? process.platform;
  const home = p.home ?? os.homedir();
  return platform === 'win32' ? path.win32.join(home, '.local', 'bin', 'claude.exe') : path.join(home, '.local', 'bin', 'claude');
}

// Token Stats is a Mac app; its folders only exist there, and these are what
// the config says when nothing else does. Windows gets a place that never
// exists, so nothing is discovered there.
export function tokenStatsDirFor(p: Probe = {}): string {
  const platform = p.platform ?? process.platform;
  const home = p.home ?? os.homedir();
  if (platform === 'win32') {
    const env = p.env ?? process.env;
    return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), 'Token Stats');
  }
  return path.join(home, 'Library', 'Application Support', 'Token Stats');
}

// A path's real form, the one to compare two paths by. On macOS and Linux
// that is fs.realpathSync, exactly as before. On Windows it is the native
// one (GetFinalPathNameByHandle): the JS one resolves links but leaves the
// 8.3 short names (C:\Users\RUNNER~1, which is how GitHub's runners spell
// TEMP, and how any profile folder longer than eight characters can turn
// up in a cwd) and the case as they were given, while git and the files
// Windows hands back use the long form, so two spellings of one folder
// compared as two. Throws when the path isn't there, as realpathSync does.
type RealProbe = { platform?: NodeJS.Platform; native?: (p: string) => string; plain?: (p: string) => string };

export function realPathSync(p: string, q: RealProbe = {}): string {
  if ((q.platform ?? process.platform) === 'win32') return (q.native ?? fs.realpathSync.native)(p);
  return (q.plain ?? fs.realpathSync)(p);
}

// The same, without throwing. When the path isn't there, macOS and Linux
// give it back as it was; Windows makes its nearest folder that is there
// real and keeps the rest, so a path to a file about to be made still
// compares with the folder it will be in.
export function realPath(p: string, q: RealProbe = {}): string {
  try {
    return realPathSync(p, q);
  } catch {
    // not there, or not readable
  }
  const platform = q.platform ?? process.platform;
  if (platform !== 'win32') return p;
  const P = path.win32;
  let rest = '';
  for (let d = p; ; ) {
    const up = P.dirname(d);
    if (up === d) return p;
    rest = rest ? P.join(P.basename(d), rest) : P.basename(d);
    d = up;
    try {
      return P.join(realPathSync(d, q), rest);
    } catch {
      // one folder up
    }
  }
}

// File modes mean nothing on NTFS: a file in the user's profile already
// belongs to that user (and Administrators and SYSTEM) by inheritance, which
// is what 0600 and 0700 are for. So these do nothing there. That only holds
// inside the profile, which is why dataDirWarning exists: a data dir put
// elsewhere inherits what its parent says (on D:\ or at a drive's root,
// usually "Authenticated Users: modify"), and nothing here changes that.
export function chmodSafe(file: string, mode: number): void {
  if (IS_WINDOWS) return;
  fs.chmodSync(file, mode);
}

// A warning when, on Windows, the data folder (the runner's token and its
// secrets) is outside the user's profile folder, where other people who use
// the PC may be able to read it; undefined otherwise, and always off Windows.
// The profile folder, and the AppData folders (which a roaming profile can
// put elsewhere), count as inside. No permissions are changed. `real` makes
// a path real (tests).
export function dataDirWarning(home: string, p: Probe & { real?: (p: string) => string } = {}): string | undefined {
  const platform = p.platform ?? process.platform;
  if (platform !== 'win32') return undefined;
  const env = p.env ?? process.env;
  const win = path.win32;
  const real = p.real ?? ((x: string) => realPath(x));
  const profiles = [p.home ?? os.homedir(), env.USERPROFILE, env.APPDATA, env.LOCALAPPDATA].filter((d): d is string => Boolean(d));
  const mine = win.resolve(real(win.resolve(home)));
  const inside = (root: string) => {
    const rel = win.relative(win.resolve(real(win.resolve(root))), mine);
    return rel === '' || (!rel.startsWith('..') && !win.isAbsolute(rel));
  };
  if (profiles.some(inside)) return undefined;
  return `The data folder ${mine} is outside your user profile folder (${win.resolve(profiles[0] ?? home)}), so other people who use this PC may be able to read the runner's token and secrets there. Keep it under your profile (the default is %APPDATA%\\Threadbear), or restrict who can open it.`;
}

// A directory link: a symlink on macOS and Linux, a junction on Windows,
// which needs no privilege (a file symlink does) but must point at an
// absolute path.
export function linkDir(target: string, link: string): void {
  if (IS_WINDOWS) fs.symlinkSync(path.resolve(path.dirname(link), target), link, 'junction');
  else fs.symlinkSync(target, link);
}

// Where a directory link points, as given (relative links stay relative on
// macOS; a junction always reads back as an absolute path).
export function readLinkDir(link: string): string {
  return fs.readlinkSync(link);
}

// A path with forward slashes whatever the platform, for text a person reads
// (messages name files as ./tools/x.sh) and for words a shell takes. It
// changes nothing on macOS and Linux, where path.sep is already /.
export function slashes(p: string): string {
  return path.sep === '/' ? p : p.split(path.sep).join('/');
}

// Whether the runner may open a path that an agent's text or tool call
// named (a Markdown picture, a pinned file). Off Windows any path may be. On
// Windows not one that starts with two separators: `//host/share/x.png`,
// `\\host\share\x.png`, `\\?\UNC\host\share\x.png` and
// `file:////host/share/x.png` all make Windows open a connection to a host
// the text picked, and send the user's NTLM sign-in to it (`\\?\C:\x.png` and
// `\\.\pipe\x` are device names, which aren't a picture's either). Nor one
// that names a device in a folder (`C:\x\CON.png` opens the console, and a
// read of it waits for ever). A drive letter's path, and one rooted on the
// current drive (`\x\a.png`), are the user's own.
export function isLocalPath(p: string, windows: boolean = IS_WINDOWS): boolean {
  if (!windows) return true;
  if (/^[\\/]{2}/.test(p)) return false;
  return !p.split(/[\\/]/).some((part) => /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(\.|:|$)/i.test(part));
}

// A path under the home folder as ~/rest, with forward slashes on every
// platform: the form the librarian's prompts and replies use, which the
// reading side expands from ~/ (a Windows path would come back as ~\rest,
// which nothing expands).
export function tildePath(p: string, home: string): string {
  if (p === home) return '~';
  return p.startsWith(home + path.sep) ? '~' + p.slice(home.length).split(path.sep).join('/') : p;
}

// The native Codex install puts codex.exe on the PATH (npm's copy is a
// codex.cmd, which can't be started without a shell). Windows only: found
// the way a shell would, first directory first, and undefined if it isn't
// there, in which case the runner leaves Codex alone as before.
export function codexOnPath(p: { env?: NodeJS.ProcessEnv; exists?: (file: string) => boolean } = {}): string | undefined {
  const env = p.env ?? process.env;
  const exists = p.exists ?? ((file: string) => fs.existsSync(file));
  for (const entry of (env.PATH ?? env.Path ?? '').split(';')) {
    const dir = entry.trim().replace(/^"|"$/g, '');
    if (!dir) continue;
    const file = path.win32.join(dir, 'codex.exe');
    if (exists(file)) return file;
  }
  return undefined;
}
