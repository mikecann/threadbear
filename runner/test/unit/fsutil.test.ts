import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { atomicWriteFileSync, removeTempFiles } from '../../src/fsutil.ts';
import { tmpDir } from '../helpers/fakes.ts';
import { onlyOnWindows } from '../helpers/platform.ts';

const temps = (dir: string) => fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));

// Opens a file the way many Windows programs do (antivirus, the indexer, a
// backup, a viewer): readable by others, but nobody may delete or rename it
// while it is open. node can't open a file that way, so PowerShell does, and
// lets go after `ms`. Resolves once the file is held.
async function holdOpen(file: string, ms: number): Promise<ChildProcess> {
  const q = file.replace(/'/g, "''");
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$s = [IO.File]::Open('${q}', 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep -Milliseconds ${ms}; $s.Close()`], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await new Promise<void>((resolve, reject) => {
    holder.stdout!.once('data', () => resolve());
    holder.once('exit', () => reject(new Error('the holder ended before it held the file')));
  });
  return holder;
}

test('atomicWriteFileSync writes a file, replaces it, and leaves no temp file', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'thread.json');
  atomicWriteFileSync(file, '{"v":1}\n');
  atomicWriteFileSync(file, '{"v":2}\n');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"v":2}\n');
  assert.deepEqual(temps(dir), []);
  assert.equal(removeTempFiles(dir), 0);
});

test('a file another program has open without allowing renames is replaced once it lets go, not reported as an error', onlyOnWindows('Only Windows refuses to replace a file that is open elsewhere'), async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'trust.json');
  fs.writeFileSync(file, '{"v":1}\n');
  // The retries wait about 3.2 s in all (10, 25, 50, 100, 200, 400, 800, 1600 ms).
  // The hold is short: 250 ms still makes the first four tries fail, so the
  // retry is what is tested. The write still gave up now and then on GitHub's
  // runner when the rest of the suite was busy, with the holder long gone, so
  // something else (antivirus, scanning the new file) had it busy too; the
  // budget was 1.6 s then.
  const holder = await holdOpen(file, 250);
  try {
    atomicWriteFileSync(file, '{"v":2}\n');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"v":2}\n');
    assert.deepEqual(temps(dir), []);
  } finally {
    await new Promise((r) => (holder.exitCode !== null ? r(null) : holder.once('exit', r)));
  }
});

test('a write that finally fails on Windows leaves no temp file behind', onlyOnWindows('Only Windows retries, and cleans up after, a rename it cannot do'), () => {
  const dir = tmpDir();
  // Windows refuses to rename a file over a folder, however long it waits.
  const file = path.join(dir, 'children.json');
  fs.mkdirSync(file);
  assert.throws(() => atomicWriteFileSync(file, '{}\n'), /EPERM|EACCES|EEXIST|EISDIR|EBUSY/);
  assert.deepEqual(temps(dir), []);
});
