import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { deflateSync, inflateSync } from 'node:zlib';
import { tmpDir } from '../helpers/fakes.ts';
import { verifyGitObjects, verifyGitObjectsSync } from '../../src/safe-git.ts';

function repo() {
  const dir = tmpDir();
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false', ...args], { encoding: 'utf8' }).trim();
  git('init', '-qb', 'main'); fs.writeFileSync(path.join(dir, 'a'), 'original\n'); git('add', '.'); git('commit', '-qm', 'base');
  return { dir, git };
}

test('bounded object verification accepts snapshots and merge history with their original IDs', async () => {
  const { dir, git } = repo(); const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'a'), 'later\n'); git('add', '.'); git('commit', '-qm', 'later');
  await verifyGitObjects(dir); verifyGitObjectsSync(dir, [base, 'HEAD'], true);
});

for (const kind of ['blob', 'tree', 'commit']) {
  test(`bounded object verification rejects a substituted ${kind} under its original filename`, async () => {
    const { dir, git } = repo();
    const id = git('rev-parse', kind === 'commit' ? 'HEAD' : kind === 'tree' ? 'HEAD^{tree}' : 'HEAD:a');
    const file = path.join(dir, '.git/objects', id.slice(0, 2), id.slice(2));
    const data = inflateSync(fs.readFileSync(file)); const nul = data.indexOf(0);
    const at = kind === 'tree' ? data.indexOf(32, nul + 1) + 1 : kind === 'commit' ? data.indexOf(Buffer.from('author Test')) + 7 : nul + 1;
    data[at] ^= 1; fs.chmodSync(file, 0o644); fs.writeFileSync(file, deflateSync(data));
    await assert.rejects(verifyGitObjects(dir), /verification|hash|release|resolve/i);
    assert.throws(() => verifyGitObjectsSync(dir), /verification|hash|release|resolve/i);
  });
}
