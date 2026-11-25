import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { deflateSync, inflateSync } from 'node:zlib';
import { tmpDir } from '../helpers/fakes.ts';
import { TreeFormatter } from '../../src/format-replay.ts';
import { verifyGitObjects, verifyGitObjectsSync, verifyGitCheckout, untrustedGit } from '../../src/safe-git.ts';

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

test('Git resolution does not execute a planted current-directory git.exe', async () => {
  const { dir } = repo();
  fs.writeFileSync(path.join(dir, 'git.exe'), 'invalid executable\n');
  const result = await untrustedGit(dir, ['rev-parse', '--show-toplevel']);
  assert.ok(result.ok, result.stderr); assert.equal(fs.realpathSync(result.stdout.trim()), fs.realpathSync(dir));
});

test('format replay refuses a forged formatter script blob before executing it', async () => {
  const { dir, git } = repo();
  fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src/a.ts'), 'original\n');
  fs.writeFileSync(path.join(dir, 'format.mjs'), 'export const original = true;\n');
  git('add', '.'); git('commit', '-qm', 'formatter');
  const commit = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}'), id = git('rev-parse', 'HEAD:format.mjs');
  const marker = path.join(dir, 'ran');
  const payload = Buffer.from(`import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'ran');`);
  const object = Buffer.concat([Buffer.from(`blob ${payload.length}\0`), payload]);
  const file = path.join(dir, '.git/objects', id.slice(0, 2), id.slice(2));
  fs.chmodSync(file, 0o644); fs.writeFileSync(file, deflateSync(object));
  const formatter = new TreeFormatter(dir, [{ commit, entry: { subject: 'Format', command: 'node format.mjs', paths: ['src'], config: ['format.mjs'] } }]);
  await assert.rejects(formatter.format(tree), /does not hash to its ID/);
  assert.equal(fs.existsSync(marker), false);
});

test('recursive merge verification hashes the older base used to synthesize a virtual base', async () => {
  const { dir, git } = repo();
  const a = git('rev-parse', 'HEAD'), blob = git('rev-parse', 'HEAD:a');
  const commit = (text: string, parents: string[]) => {
    fs.writeFileSync(path.join(dir, 'a'), text); git('add', 'a');
    return git('commit-tree', git('write-tree'), ...parents.flatMap((p) => ['-p', p]), '-m', text);
  };
  const b = commit('left\n', [a]), c = commit('right\n', [a]);
  const d = commit('left result\n', [b, c]), e = commit('right result\n', [c, b]);
  assert.deepEqual(new Set(git('merge-base', '--all', d, e).split('\n')), new Set([b, c]));
  await verifyGitObjects(dir, [d, e], true);
  const file = path.join(dir, '.git/objects', blob.slice(0, 2), blob.slice(2));
  const data = inflateSync(fs.readFileSync(file)); data[data.indexOf(0) + 1] ^= 1;
  fs.chmodSync(file, 0o644); fs.writeFileSync(file, deflateSync(data));
  await assert.rejects(verifyGitObjects(dir, [d, e], true), /does not hash/);
  assert.throws(() => verifyGitObjectsSync(dir, [d, e], true), /does not hash/);
});


test('materialized checkout verification rejects stale skipped files and symlink parents', async () => {
  const { dir, git } = repo(); fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src/script.mjs'), 'original');
  git('add', '.'); git('commit', '-qm', 'script'); await verifyGitObjects(dir); await verifyGitCheckout(dir, 'HEAD');
  git('update-index', '--skip-worktree', 'src/script.mjs'); fs.writeFileSync(path.join(dir, 'src/script.mjs'), 'stale executable');
  await assert.rejects(verifyGitCheckout(dir, 'HEAD'), /differs from the verified snapshot/);
  if (process.platform !== 'win32') {
    const outside = tmpDir(); fs.writeFileSync(path.join(outside, 'script.mjs'), 'original');
    fs.rmSync(path.join(dir, 'src'), { recursive: true }); fs.symlinkSync(outside, path.join(dir, 'src'));
    await assert.rejects(verifyGitCheckout(dir, 'HEAD'), /parent is not a real directory/);
  }
});
