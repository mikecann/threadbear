import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tmpDir } from '../helpers/fakes.ts';
import { IS_WINDOWS } from '../../src/platform.ts';
const api = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../scripts/deploy-git.mjs')).href);
// @ts-expect-error: setup is a built-ins-only mjs.
import { checkedUpstream } from '../../../scripts/checked-upstream.mjs';

function fixture() {
  const root = tmpDir(); const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false', ...args], { encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main'); fs.mkdirSync(path.join(repo, 'runner/src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'runner/src/main.ts'), 'export const value = "original";\n');
  fs.writeFileSync(path.join(repo, 'runner/.gitattributes'), 'src/main.ts export-ignore\n');
  g('add', '.'); g('commit', '-qm', 'original');
  return { root, repo, g, commit: g('rev-parse', 'HEAD') };
}

test('deploy installs commit blobs despite archive attributes, and its digest binds the installed bytes', () => {
  const { root, repo, commit } = fixture(); const dest = path.join(root, 'snapshot'); fs.mkdirSync(dest);
  const digest = api.snapshotCommit(repo, 'runner/', commit, dest, ['src']);
  assert.match(fs.readFileSync(path.join(dest, 'src/main.ts'), 'utf8'), /original/);
  assert.equal(api.snapshotDigest(dest, ['src']), digest);
  fs.writeFileSync(path.join(dest, 'src/main.ts'), 'changed');
  assert.notEqual(api.snapshotDigest(dest, ['src']), digest);
});

test('deploy refuses replacement refs and grafts before a snapshot is installed', () => {
  const { root, repo, g, commit } = fixture();
  fs.writeFileSync(path.join(repo, 'runner/src/main.ts'), 'substitute\n'); g('add', '.'); g('commit', '-qm', 'substitute');
  const later = g('rev-parse', 'HEAD'); g('replace', commit, later);
  assert.throws(() => api.snapshotCommit(repo, 'runner/', commit, path.join(root, 'dest'), ['src']), /replacement refs or grafts/);
  g('replace', '-d', commit); fs.writeFileSync(path.join(repo, '.git/info/grafts'), `${later}\n`);
  assert.throws(() => api.snapshotCommit(repo, 'runner/', commit, path.join(root, 'dest'), ['src']), /replacement refs or grafts/);
});

test('setup/deploy suppress fsmonitor, hooks and local transport commands', { skip: IS_WINDOWS }, () => {
  const { root, repo, g } = fixture();
  const marker = path.join(root, 'ran'); const hook = path.join(root, 'evil');
  fs.writeFileSync(hook, `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`, { mode: 0o755 });
  fs.copyFileSync(hook, path.join(root, 'reference-transaction'));
  g('config', 'core.fsmonitor', hook); g('config', 'core.hooksPath', root);
  assert.ok(api.gitResult(repo, ['status', '--porcelain']).ok);
  g('remote', 'add', 'origin', 'https://github.com/mikecann/threadbear.git');
  g('config', 'credential.helper', `!${hook}`); g('config', 'core.sshCommand', hook);
  g('config', 'url.ext::evil.insteadOf', 'https://github.com/');
  assert.ok(api.gitResult(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']).ok);
  const renamed = api.gitResult(repo, ['remote', 'rename', 'origin', 'upstream']);
  assert.ok(renamed.ok, renamed.stderr);
  assert.equal(checkedUpstream({ repo, mikesRepo: 'https://github.com/mikecann/threadbear.git' }).checked, false);
  assert.equal(fs.existsSync(marker), false);
});

import { deflateSync, inflateSync } from 'node:zlib';

for (const kind of ['blob', 'tree', 'commit'] as const) {
  test(`deploy verifies the ${kind} object's ID before trusting its contents`, () => {
    const { root, repo, g, commit } = fixture();
    const id = kind === 'commit' ? commit : g('rev-parse', kind === 'tree' ? `${commit}^{tree}` : `${commit}:runner/src/main.ts`);
    const file = path.join(repo, '.git/objects', id.slice(0, 2), id.slice(2));
    const raw = inflateSync(fs.readFileSync(file)); const changed = Buffer.from(raw);
    // Keep the object syntactically valid, but store different bytes under
    // its old ID. Plain cat-file accepts this loose-object substitution.
    const nul = raw.indexOf(0);
    const at = kind === 'tree' ? raw.indexOf(32, nul + 1) + 1 : kind === 'commit' ? raw.indexOf(Buffer.from('author Test')) + 7 : nul + 1;
    changed[at] ^= 1;
    fs.chmodSync(file, 0o644); fs.writeFileSync(file, deflateSync(changed));
    assert.throws(() => api.snapshotCommit(repo, 'runner/', commit, path.join(root, 'dest'), ['src']), /does not hash to its ID/);
  });
}

test('installer reuse requires clean metadata and a digest matching the original commit and installed bytes', () => {
  const { root, repo, commit } = fixture(); const dest = path.join(root, 'release'); fs.mkdirSync(dest);
  const paths = api.RELEASE_PATHS; const snapshotSha256 = api.snapshotCommit(repo, 'runner/', commit, dest, paths);
  const write = (extra: object) => fs.writeFileSync(path.join(dest, 'release.json'), JSON.stringify({ commit, dirty: false, snapshotSha256, ...extra }));
  write({}); assert.equal(api.releaseMatches(path.join(repo, 'runner'), dest, commit), true);
  write({ dirty: true }); assert.equal(api.releaseMatches(path.join(repo, 'runner'), dest, commit), false);
  write({ snapshotSha256: undefined }); assert.equal(api.releaseMatches(path.join(repo, 'runner'), dest, commit), false);
  write({}); fs.writeFileSync(path.join(dest, 'src/main.ts'), 'changed');
  assert.equal(api.releaseMatches(path.join(repo, 'runner'), dest, commit), false);
});

test('snapshot validation refuses a case alias of a symlink before any destination writes', () => {
  const { root, repo, g } = fixture(); const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  const blob = (text: string) => execFileSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], { input: text, encoding: 'utf8' }).trim();
  const tree = (text: string) => execFileSync('git', ['-C', repo, 'mktree'], { input: text, encoding: 'utf8' }).trim();
  const payload = blob('payload\n'), link = blob(outside);
  const nested = tree(`100644 blob ${payload}\tmarker\n`);
  const src = tree(`120000 blob ${link}\tA\n040000 tree ${nested}\ta\n`);
  const runner = tree(`040000 tree ${src}\tsrc\n`), top = tree(`040000 tree ${runner}\trunner\n`);
  const commit = g('commit-tree', top, '-m', 'case collision'); const dest = path.join(root, 'snapshot'); fs.mkdirSync(dest);
  assert.throws(() => api.snapshotCommit(repo, 'runner/', commit, dest, ['src']), /Colliding release paths/);
  assert.deepEqual(fs.readdirSync(dest), []); assert.deepEqual(fs.readdirSync(outside), []);
});

test('installers copy the launch module from verified commit blobs rather than dirty files', () => {
  const { root, repo, g } = fixture();
  fs.writeFileSync(path.join(repo, 'runner/launch.mjs'), 'export const original = true;\n'); g('add', '.'); g('commit', '-qm', 'launcher');
  fs.writeFileSync(path.join(repo, 'runner/launch.mjs'), 'throw new Error("dirty");\n');
  const to = path.join(root, 'installed.mjs'); api.copyVerifiedLauncher(path.join(repo, 'runner'), to);
  assert.equal(fs.readFileSync(to, 'utf8'), 'export const original = true;\n');
});
