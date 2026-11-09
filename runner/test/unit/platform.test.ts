// What differs by platform (src/platform.ts), called directly. The Probe
// parameter stands in for another platform, so the macOS and Linux answers are
// pinned on every machine that runs the tests, and the Windows ones too: a
// change that moves what a Mac or a Linux box does shows here first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
import { ensureHome } from '../../src/config.ts';
import { asBashPath } from '../../src/script-trust.ts';
import { chmodSafe, claudeBinaryFor, codexOnPath, dataDirFor, dataDirWarning, IS_WINDOWS, isLocalPath, linkDir, logFileFor, readLinkDir, slashes, tildePath, tokenStatsDirFor } from '../../src/platform.ts';

const ONLY_POSIX = { skip: IS_WINDOWS ? 'File modes mean nothing on NTFS' : false } as const;

test('the data dir, log file, claude program and Token Stats folder: Mac and Linux keep their places, Windows has its own', () => {
  const home = path.join(path.sep, 'Users', 'ann');
  for (const platform of ['darwin', 'linux'] as const) {
    assert.equal(dataDirFor({ platform, home }), path.join(home, 'Library', 'Application Support', 'Threadbear'), platform);
    assert.equal(dataDirFor({ platform, home, env: { APPDATA: 'C:\\Elsewhere' } }), path.join(home, 'Library', 'Application Support', 'Threadbear'), `${platform} ignores APPDATA`);
    assert.equal(logFileFor({ platform, home }), path.join(home, 'Library', 'Logs', 'threadbear-runner.log'), platform);
    assert.equal(claudeBinaryFor({ platform, home }), path.join(home, '.local', 'bin', 'claude'), platform);
    assert.equal(tokenStatsDirFor({ platform, home }), path.join(home, 'Library', 'Application Support', 'Token Stats'), platform);
  }
  // Literally, where the separator is a slash.
  if (!IS_WINDOWS) {
    assert.equal(dataDirFor({ platform: 'darwin', home: '/Users/ann' }), '/Users/ann/Library/Application Support/Threadbear');
    assert.equal(dataDirFor({ platform: 'linux', home: '/home/ann' }), '/home/ann/Library/Application Support/Threadbear');
    assert.equal(logFileFor({ platform: 'darwin', home: '/Users/ann' }), '/Users/ann/Library/Logs/threadbear-runner.log');
    assert.equal(claudeBinaryFor({ platform: 'linux', home: '/home/ann' }), '/home/ann/.local/bin/claude');
    assert.equal(tokenStatsDirFor({ platform: 'darwin', home: '/Users/ann' }), '/Users/ann/Library/Application Support/Token Stats');
  }
  const win = { platform: 'win32' as const, home: 'C:\\Users\\ann' };
  assert.equal(dataDirFor({ ...win, env: { APPDATA: 'C:\\Users\\ann\\AppData\\Roaming' } }), 'C:\\Users\\ann\\AppData\\Roaming\\Threadbear');
  assert.equal(dataDirFor({ ...win, env: {} }), 'C:\\Users\\ann\\AppData\\Roaming\\Threadbear', 'without APPDATA, under the profile');
  assert.equal(dataDirFor({ ...win, env: { APPDATA: 'D:\\Roam' } }), 'D:\\Roam\\Threadbear');
  assert.equal(logFileFor({ ...win, env: { LOCALAPPDATA: 'D:\\Local' } }), 'D:\\Local\\Threadbear\\Logs\\threadbear-runner.log');
  assert.equal(logFileFor({ ...win, env: {} }), 'C:\\Users\\ann\\AppData\\Local\\Threadbear\\Logs\\threadbear-runner.log');
  assert.equal(claudeBinaryFor(win), 'C:\\Users\\ann\\.local\\bin\\claude.exe');
  assert.equal(tokenStatsDirFor({ ...win, env: { APPDATA: 'D:\\Roam' } }), 'D:\\Roam\\Token Stats');
});

test('slashes and tildePath: forward slashes on every platform for text a person or a prompt reads, unchanged where the separator already is one', () => {
  const p = path.join('tools', 'x.sh');
  assert.equal(slashes(p), 'tools/x.sh');
  assert.equal(slashes('plain'), 'plain');
  assert.equal(slashes(''), '');
  const home = path.join(path.sep, 'Users', 'ann');
  assert.equal(tildePath(home, home), '~');
  assert.equal(tildePath(path.join(home, 'dev', 'x'), home), '~/dev/x');
  assert.equal(tildePath(path.join(home, 'x'), home), '~/x');
  assert.equal(tildePath(home + 'ny', home), home + 'ny', 'a folder that only starts with the same letters is not under it');
  assert.equal(tildePath(path.join(path.sep, 'elsewhere', 'x'), home), path.join(path.sep, 'elsewhere', 'x'));
  if (!IS_WINDOWS) {
    // Nothing is rewritten on a Mac or Linux, backslash or not.
    assert.equal(slashes('a\\b/c'), 'a\\b/c');
    assert.equal(tildePath('/Users/ann/dev/x', '/Users/ann'), '~/dev/x');
  }
});

test('asBashPath: a Windows path the way Git Bash names it, so /dev/stdin spelt on Windows is still caught', () => {
  assert.equal(asBashPath('/dev/stdin'), '/dev/stdin');
  assert.equal(asBashPath('\\dev\\stdin'), '/dev/stdin');
  assert.equal(asBashPath('C:\\dev\\stdin'), '/dev/stdin', 'the drive goes: a real C:\\dev\\stdin is refused too');
  assert.equal(asBashPath('C:/dev/fd/3'), '/dev/fd/3');
  assert.equal(asBashPath('/proc/self/../self/fd/0'), '/proc/self/fd/0');
  assert.equal(asBashPath('D:\\x\\..\\y'), '/y');
});

test('codexOnPath: the first directory with a codex.exe, as a shell finds it; none is undefined', () => {
  const exists = (...files: string[]) => (f: string) => files.includes(f);
  assert.equal(codexOnPath({ env: { PATH: 'C:\\a;C:\\b;C:\\c' }, exists: exists('C:\\b\\codex.exe', 'C:\\c\\codex.exe') }), 'C:\\b\\codex.exe');
  assert.equal(codexOnPath({ env: { Path: 'C:\\a;"C:\\Program Files\\codex"' }, exists: exists('C:\\Program Files\\codex\\codex.exe') }), 'C:\\Program Files\\codex\\codex.exe', 'quotes and the Path spelling');
  assert.equal(codexOnPath({ env: { PATH: ';;C:\\a; ' }, exists: exists() }), undefined);
  assert.equal(codexOnPath({ env: {}, exists: () => true }), undefined);
});

test('isLocalPath: any path off Windows; on Windows not a network or device name', () => {
  for (const p of ['/etc/a.png', '//host/share/a.png', '\\\\host\\share\\a.png', '', 'relative/a.png', 'C:/a.png', '/tmp/CON.png']) assert.equal(isLocalPath(p, false), true, `off Windows: ${p}`);
  for (const p of ['C:\\Users\\a.png', 'c:/Users/a.png', 'D:\\a.png', 'Z:/x', '/etc/a.png', '/w/a.png', '\\w\\a.png', 'relative/a.png', 'C:\\x\\console.png', 'C:\\x\\com10.png', 'C:\\x\\nullable.png', 'C:\\x\\a.png', '', '/']) {
    assert.equal(isLocalPath(p, true), true, p);
  }
  for (const p of ['//attacker.example/s/a.png', '\\\\attacker.example\\s\\a.png', '\\\\?\\UNC\\attacker.example\\s\\a.png', '//?/UNC/attacker.example/s/a.png', '\\\\?\\C:\\a.png', '//./C:/a.png', '/\\attacker.example/s/a.png', '\\/attacker.example/s/a.png', '//x', 'C:\\x\\CON.png', 'C:\\x\\con', 'D:/y/nul.txt', 'C:\\x\\Aux.png', 'C:\\x\\com1.png', 'C:\\x\\LPT9', 'C:\\x\\conin$', '/w/prn.png']) {
    assert.equal(isLocalPath(p, false), true, `off Windows: ${p}`);
    assert.equal(isLocalPath(p, true), false, p);
  }
});

test('dataDirWarning: nothing off Windows or inside the profile; a data dir elsewhere is named, with why', () => {
  const real = (x: string) => x;
  const win = { platform: 'win32' as const, home: 'C:\\Users\\me', env: { USERPROFILE: 'C:\\Users\\me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, real };
  for (const platform of ['darwin', 'linux'] as const) assert.equal(dataDirWarning('D:\\Threadbear', { ...win, platform }), undefined, platform);
  for (const inside of ['C:\\Users\\me\\AppData\\Roaming\\Threadbear', 'C:\\Users\\me', 'C:\\Users\\me\\Threadbear-home', 'c:\\users\\ME\\appdata\\roaming\\Threadbear', 'C:\\Users\\me\\AppData\\Local\\Temp\\tb-test-1']) {
    assert.equal(dataDirWarning(inside, win), undefined, inside);
  }
  // A roaming profile whose AppData is on a server is still the user's.
  assert.equal(dataDirWarning('\\\\fs\\profiles\\me\\AppData\\Roaming\\Threadbear', { ...win, env: { ...win.env, APPDATA: '\\\\fs\\profiles\\me\\AppData\\Roaming' } }), undefined);
  for (const outside of ['D:\\Threadbear', 'D:\\', 'C:\\Threadbear', 'C:\\Users\\mellow\\Threadbear', 'C:\\Users\\me\\..\\other\\Threadbear', 'C:\\Users\\Public\\Threadbear']) {
    const warning = dataDirWarning(outside, win);
    assert.match(warning ?? '', /is outside your user profile folder \(C:\\Users\\me\), so other people who use this PC may be able to read the runner's token and secrets/, outside);
    assert.ok(warning!.includes(path.win32.resolve(outside)), `names the folder: ${outside}`);
    assert.match(warning!, /%APPDATA%\\Threadbear/);
  }
  // A data dir that is a link into the profile counts by where it really is.
  assert.equal(dataDirWarning('D:\\Link\\Threadbear', { ...win, real: (x) => x.replace('D:\\Link', 'C:\\Users\\me\\AppData\\Roaming') }), undefined);
  assert.match(dataDirWarning('C:\\Users\\me\\Link', { ...win, real: (x) => x.replace('C:\\Users\\me\\Link', 'D:\\Elsewhere') }) ?? '', /D:\\Elsewhere/);
});

test('ensureHome hands back the data dir warning, and makes the folders and the token as before', () => {
  const home = path.join(tmpDir(), 'data');
  const warning = ensureHome(home);
  assert.equal(warning, dataDirWarning(home));
  if (!IS_WINDOWS) assert.equal(warning, undefined);
  for (const sub of ['threads', 'inbox', 'run', 'secrets']) assert.ok(fs.statSync(path.join(home, sub)).isDirectory(), sub);
  assert.match(fs.readFileSync(path.join(home, 'secrets', 'runner-token'), 'utf8'), /^[A-Za-z0-9_-]{43}\n$/);
  assert.equal(ensureHome(home), warning, 'and again with the token there');
});

test('chmodSafe sets the mode on macOS and Linux, and leaves NTFS alone', ONLY_POSIX, () => {
  const f = path.join(tmpDir(), 'secret');
  fs.writeFileSync(f, 'x', { mode: 0o644 });
  chmodSafe(f, 0o600);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  const d = path.join(tmpDir(), 'dir');
  fs.mkdirSync(d, { mode: 0o755 });
  chmodSafe(d, 0o700);
  assert.equal(fs.statSync(d).mode & 0o777, 0o700);
  assert.throws(() => chmodSafe(path.join(tmpDir(), 'missing'), 0o600), /ENOENT/, 'and a missing file is still an error');
});

test('chmodSafe on Windows does nothing, not even for a missing file', { skip: IS_WINDOWS ? false : 'Needs Windows' }, () => {
  const f = path.join(tmpDir(), 'secret');
  fs.writeFileSync(f, 'x');
  const before = fs.statSync(f).mode;
  chmodSafe(f, 0o600);
  assert.equal(fs.statSync(f).mode, before);
  chmodSafe(path.join(tmpDir(), 'missing'), 0o600);
});

test('linkDir makes a folder link that reads back to its target: a symlink on macOS and Linux, a junction on Windows', () => {
  const root = tmpDir();
  const target = path.join(root, 'target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'f.txt'), 'hi');
  const link = path.join(root, 'link');
  linkDir(target, link);
  assert.equal(fs.readFileSync(path.join(link, 'f.txt'), 'utf8'), 'hi');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.realpathSync(readLinkDir(link)), fs.realpathSync(target));
  // A relative target, as `node_modules` is linked on a Mac: relative to the link.
  const rel = path.join(root, 'sub', 'rel');
  fs.mkdirSync(path.dirname(rel));
  linkDir(path.join('..', 'target'), rel);
  assert.equal(fs.readFileSync(path.join(rel, 'f.txt'), 'utf8'), 'hi');
  if (!IS_WINDOWS) assert.equal(readLinkDir(rel), path.join('..', 'target'), 'kept relative where the link can be');
});
