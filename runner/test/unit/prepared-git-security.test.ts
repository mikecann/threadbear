import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';
import { SHELL, shPath } from '../helpers/platform.ts';
import { IS_WINDOWS } from '../../src/platform.ts';
const preview = path.resolve(import.meta.dirname, '../../../scripts/merge-preview.sh');
const prepared = path.resolve(import.meta.dirname, '../../../scripts/merge-prepared.sh');
const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };

test('prepared merge installs exactly the isolated preview despite malicious filters, hooks, and merge attributes', { skip: IS_WINDOWS }, () => {
  const root = tmpDir(); const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const g = (...args: string[]) => { const r = spawnSync('git', ['-C', repo, '-c', 'commit.gpgSign=false', ...args], { env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const sh = (file: string, ...args: string[]) => spawnSync(SHELL[0], [shPath(file), ...args], { cwd: repo, env, encoding: 'utf8' });
  g('init', '-qb', 'main');
  fs.writeFileSync(path.join(repo, 'a'), 'one\ntwo\nthree\nfour\nfive\n');
  fs.writeFileSync(path.join(repo, '.gitattributes'), 'a merge=evil filter=evil\n');
  g('add', '.'); g('commit', '-qm', 'base'); g('branch', 'release');
  fs.writeFileSync(path.join(repo, 'a'), 'main\ntwo\nthree\nfour\nfive\n'); g('commit', '-qam', 'main');
  g('checkout', '-q', 'release'); fs.writeFileSync(path.join(repo, 'a'), 'one\ntwo\nthree\nfour\nrelease\n'); g('commit', '-qam', 'release');
  const release = g('rev-parse', 'HEAD'); g('checkout', '-q', 'main'); g('checkout', '-qb', 'thread');
  const marker = path.join(root, 'ran'); const hook = path.join(root, 'evil.sh');
  fs.writeFileSync(hook, `#!/bin/sh\necho ran >> '${marker}'\nexit 0\n`, { mode: 0o755 });
  const hooks = path.join(root, 'hooks'); fs.mkdirSync(hooks);
  for (const n of ['post-checkout', 'post-merge', 'pre-commit', 'commit-msg']) fs.copyFileSync(hook, path.join(hooks, n));
  g('config', 'core.hooksPath', hooks); g('config', 'merge.evil.driver', hook);
  g('config', 'filter.evil.clean', `${hook}; cat`); g('config', 'filter.evil.smudge', `${hook}; cat`);
  const dir = path.join(root, 'prepared'); const p = sh(preview, '--prepare', shPath(dir), release);
  assert.equal(p.status, 0, p.stderr); const tree = p.stdout.split('\n')[0];
  const before = g('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'tree'), '0'.repeat(40) + '\n');
  const changed = sh(prepared, shPath(dir), '-m', 'Bring it in');
  assert.notEqual(changed.status, 0); assert.match(changed.stderr, /differs from the preview/); assert.equal(g('rev-parse', 'HEAD'), before);
  fs.writeFileSync(path.join(dir, 'tree'), tree + '\n');
  const done = sh(prepared, shPath(dir), '-m', 'Bring it in');
  assert.equal(done.status, 0, done.stderr + done.stdout);
  assert.equal(g('rev-parse', 'HEAD^{tree}'), tree);
  assert.equal(fs.readFileSync(path.join(repo, 'a'), 'utf8'), 'main\ntwo\nthree\nfour\nrelease\n');
  assert.equal(fs.existsSync(marker), false);
});

import { deflateSync } from 'node:zlib';

test('prepared merge verifies a newly merged output blob before changing HEAD', () => {
  const root = tmpDir(), repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const g = (...args: string[]) => { const r = spawnSync('git', ['-C', repo, '-c', 'commit.gpgSign=false', ...args], { env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const sh = (file: string, ...args: string[]) => spawnSync(SHELL[0], [shPath(file), ...args], { cwd: repo, env, encoding: 'utf8' });
  g('init', '-qb', 'main'); fs.writeFileSync(path.join(repo, 'a'), 'one\ntwo\nthree\nfour\nfive\n');
  g('add', '.'); g('commit', '-qm', 'base'); g('branch', 'release');
  fs.writeFileSync(path.join(repo, 'a'), 'main\ntwo\nthree\nfour\nfive\n'); g('commit', '-qam', 'main');
  const before = g('rev-parse', 'HEAD'); g('checkout', '-q', 'release');
  fs.writeFileSync(path.join(repo, 'a'), 'one\ntwo\nthree\nfour\nrelease\n'); g('commit', '-qam', 'release');
  const release = g('rev-parse', 'HEAD'); g('checkout', '-q', 'main');
  const dir = path.join(root, 'preview'); const p = sh(preview, '--prepare', shPath(dir), release); assert.equal(p.status, 0, p.stderr);
  const id = spawnSync('git', ['-C', repo, 'hash-object', '--stdin'], { env, input: 'main\ntwo\nthree\nfour\nrelease\n', encoding: 'utf8' }).stdout.trim();
  const poison = path.join(repo, '.git/objects', id.slice(0, 2), id.slice(2)); fs.mkdirSync(path.dirname(poison), { recursive: true });
  const payload = Buffer.from('substituted\n');
  fs.writeFileSync(poison, deflateSync(Buffer.concat([Buffer.from(`blob ${payload.length}\0`), payload])));
  const applied = sh(prepared, shPath(dir), '-m', 'Bring it in');
  assert.notEqual(applied.status, 0); assert.match(applied.stderr, /does not hash to its ID/);
  assert.equal(g('rev-parse', 'HEAD'), before); assert.equal(fs.readFileSync(path.join(repo, 'a'), 'utf8'), 'main\ntwo\nthree\nfour\nfive\n');
});

test('preparing delete/modify conflicts records the surviving blob without aborting', () => {
  const root = tmpDir(), repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const g = (...args: string[]) => { const r = spawnSync('git', ['-C', repo, '-c', 'commit.gpgSign=false', ...args], { env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  g('init', '-qb', 'main'); fs.writeFileSync(path.join(repo, 'a'), 'base\n'); g('add', '.'); g('commit', '-qm', 'base'); g('branch', 'release');
  g('rm', 'a'); g('commit', '-qm', 'delete'); const before = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'release'); fs.writeFileSync(path.join(repo, 'a'), 'modified\n'); g('commit', '-qam', 'modify');
  const release = g('rev-parse', 'HEAD'); g('checkout', '-q', 'main');
  const dir = path.join(root, 'preview');
  const p = spawnSync(SHELL[0], [shPath(preview), '--prepare', shPath(dir), release], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'clashes.json'), 'utf8')), ['a']);
  assert.equal(fs.readFileSync(path.join(dir, 'files/a'), 'utf8'), 'modified\n'); assert.equal(g('rev-parse', 'HEAD'), before);
});
