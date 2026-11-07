import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { IS_WINDOWS } from './platform.ts';

// Windows won't rename over a file another program has open without allowing
// that (antivirus, the indexer, a backup, a viewer): the rename fails with
// EPERM, EBUSY or EACCES until it lets go, which is usually a moment. These
// are the waits between tries, a little over three seconds in all (a loaded
// GitHub runner kept a file busy for longer than half of that).
const RENAME_RETRY_MS = [10, 25, 50, 100, 200, 400, 800, 1600];
const RENAME_BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

// A pause that holds this thread, as the writes it serves are synchronous.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function renameWithRetry(from: string, to: string, retryMs: number[] = RENAME_RETRY_MS): void {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (i >= retryMs.length || !RENAME_BUSY.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      sleepSync(retryMs[i]);
    }
  }
}

// Write to a temp file in the same folder, fsync, then rename, so a crash
// never leaves a half-written thread.json behind. On Windows the rename is
// tried again if another program has the file open, and a write that still
// fails takes its temp file with it.
export function atomicWriteFileSync(file: string, data: string | Buffer, mode?: number): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    const fd = fs.openSync(tmp, 'w', mode ?? 0o644);
    try {
      if (typeof data === 'string') fs.writeSync(fd, data);
      else fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (IS_WINDOWS) renameWithRetry(tmp, file);
    else fs.renameSync(tmp, file);
  } catch (e) {
    if (IS_WINDOWS) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // removeTempFiles finds it at the next start
      }
    }
    throw e;
  }
}

export function readJsonSync<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Removes the `.<name>.<pid>.<hex>.tmp` files atomicWriteFileSync leaves if
// the process dies between writing and renaming. dirs are scanned one
// level down as well (the thread folders). Only safe while holding the
// runner lock, when nothing else is writing.
export function removeTempFiles(...dirs: string[]): number {
  let removed = 0;
  const clean = (dir: string, depth: number) => {
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      const p = path.join(dir, d.name);
      if (d.isFile() && /^\..+\.\d+\.[0-9a-f]{8}\.tmp$/.test(d.name)) {
        try {
          fs.unlinkSync(p);
          removed++;
        } catch {
          // gone already
        }
      } else if (d.isDirectory() && depth > 0) clean(p, depth - 1);
    }
  };
  for (const d of dirs) clean(d, 1);
  return removed;
}
