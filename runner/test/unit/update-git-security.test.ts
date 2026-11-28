import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';
import { IS_WINDOWS } from '../../src/platform.ts';
import { followOrigin } from '../../src/follow-origin.ts';
import { releaseTreeAt, syncClone } from '../../src/update.ts';

function fixture() {
  const root = tmpDir();
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false', ...args], { encoding: 'utf8' }).trim();
  git(source, 'init', '-qb', 'main');
  fs.mkdirSync(path.join(source, 'runner/src'), { recursive: true });
  fs.writeFileSync(path.join(source, '.gitattributes'), '*.ts filter=trap\n');
  fs.writeFileSync(path.join(source, 'runner/src/main.ts'), 'original\n');
  git(source, 'add', '.'); git(source, 'commit', '-qm', 'original');
  const first = git(source, 'rev-parse', 'HEAD');
  const marker = path.join(root, 'ran');
  const poison = (repo: string) => {
    const hook = path.join(root, 'trap.sh');
    fs.writeFileSync(hook, `#!/bin/sh\nprintf ran >> '${marker}'\ncat\n`, { mode: 0o755 });
    const hooks = path.join(root, 'hooks'); fs.mkdirSync(hooks, { recursive: true });
    for (const name of ['post-checkout', 'post-merge', 'reference-transaction']) fs.copyFileSync(hook, path.join(hooks, name));
    git(repo, 'config', 'core.hooksPath', hooks);
    git(repo, 'config', 'filter.trap.clean', hook);
    git(repo, 'config', 'filter.trap.smudge', hook);
  };
  const advance = () => {
    fs.writeFileSync(path.join(source, 'runner/src/main.ts'), 'new\n');
    git(source, 'add', '.'); git(source, 'commit', '-qm', 'new');
  };
  return { root, source, git, first, marker, poison, advance };
}

test('following origin ignores repository hooks and filters while advancing main', { skip: IS_WINDOWS }, async () => {
  const f = fixture();
  const checkout = path.join(f.root, 'checkout');
  f.git(f.root, 'clone', '-q', f.source, checkout);
  f.advance(); f.poison(checkout);
  const result = await followOrigin(checkout);
  assert.equal(result.problem, undefined);
  assert.equal(fs.readFileSync(path.join(checkout, 'runner/src/main.ts'), 'utf8'), 'new\n');
  assert.equal(fs.existsSync(f.marker), false);
});

test('an existing update clone cannot run programs added to its Git metadata', { skip: IS_WINDOWS }, async () => {
  const f = fixture();
  const clone = path.join(f.root, 'clone');
  await syncClone(f.source, 'runner/', clone);
  f.advance(); f.poison(clone);
  const result = await syncClone(f.source, 'runner/', clone);
  assert.equal(result.subject, 'new');
  assert.equal(fs.readFileSync(path.join(clone, 'runner/src/main.ts'), 'utf8'), 'new\n');
  assert.equal(fs.existsSync(f.marker), false);
});

test('update identity refuses replacement refs and grafts before materializing a clone', async () => {
  const f = fixture(); f.advance();
  f.git(f.source, 'replace', f.first, 'HEAD');
  assert.equal(releaseTreeAt(f.source, 'runner/', f.first), undefined);
  const clone = path.join(f.root, 'clone');
  await assert.rejects(syncClone(f.source, 'runner/', clone), /replacement|graft/);
  assert.equal(fs.existsSync(clone), false);
  f.git(f.source, 'replace', '-d', f.first);
  fs.writeFileSync(path.join(f.source, '.git/info/grafts'), `${f.first}\n`);
  await assert.rejects(syncClone(f.source, 'runner/', clone), /replacement|graft/);
  assert.equal(fs.existsSync(clone), false);
});

for (const key of ['uploadpack', 'rewrite']) {
  test(`an existing update clone rejects a local-fetch ${key} override`, { skip: IS_WINDOWS }, async () => {
    const f = fixture(); const clone = path.join(f.root, 'clone');
    await syncClone(f.source, 'runner/', clone); f.advance();
    const trap = path.join(f.root, 'uploadpack.sh');
    fs.writeFileSync(trap, `#!/bin/sh\nprintf ran >> '${f.marker}'\n`, { mode: 0o755 });
    if (key === 'uploadpack') { f.git(clone, 'config', `remote.${f.source}.url`, f.source); f.git(clone, 'config', `remote.${f.source}.uploadpack`, trap); }
    else f.git(clone, 'config', `url.${f.source}.insteadOf`, f.source);
    await assert.rejects(syncClone(f.source, 'runner/', clone), /transport config|global git config/);
    assert.equal(fs.existsSync(f.marker), false);
  });
}


test('a reused update clone discards tracked script edits before automatic execution', async () => {
  const f = fixture(); const clone = path.join(f.root, 'clone');
  fs.mkdirSync(path.join(f.source, 'runner/scripts')); fs.writeFileSync(path.join(f.source, 'runner/scripts/deploy-backend.mjs'), 'export const original = true;\n');
  f.git(f.source, 'add', '.'); f.git(f.source, 'commit', '-qm', 'deployment helper');
  await syncClone(f.source, 'runner/', clone);
  fs.writeFileSync(path.join(clone, 'runner/scripts/deploy-backend.mjs'), 'throw new Error("unverified working file");\n');
  f.git(clone, 'config', 'core.longpaths', 'true'); // The Windows clone's own persistent setting.
  f.advance(); await syncClone(f.source, 'runner/', clone);
  assert.equal(fs.readFileSync(path.join(clone, 'runner/scripts/deploy-backend.mjs'), 'utf8'), 'export const original = true;\n');
});


test('internal update checkout ignores tracked CRLF conversion attributes', async () => {
  const f = fixture();
  fs.appendFileSync(path.join(f.source, '.gitattributes'), '*.cmd text eol=crlf\n');
  fs.writeFileSync(path.join(f.source, 'runner/start.cmd'), '@echo off\nexit /b 0\n');
  f.git(f.source, 'add', '.'); f.git(f.source, 'commit', '-qm', 'Windows command');
  const clone = path.join(f.root, 'clone'); await syncClone(f.source, 'runner/', clone);
  assert.equal(fs.readFileSync(path.join(clone, 'runner/start.cmd'), 'utf8'), '@echo off\nexit /b 0\n');
});
