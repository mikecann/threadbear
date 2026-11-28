import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { deflateSync, inflateSync } from 'node:zlib';
import { tmpDir } from '../helpers/fakes.ts';
import { IS_WINDOWS } from '../../src/platform.ts';
import { copyCheckGitFiles } from '../helpers/check-git-files.ts';
import { setup as setupRemote } from '../helpers/check-remote-harness.ts';
// @ts-expect-error built-ins-only setup script.
import { treeOf, releaseIn } from '../../../scripts/check-cache.mjs';
// @ts-expect-error built-ins-only deploy helper.
import { remoteChecks } from '../../scripts/deploy-steps.mjs';

function fixture() {
  const root = tmpDir();
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false', ...args], { encoding: 'utf8' });
  git('init', '-qb', 'main');
  fs.writeFileSync(path.join(root, 'a'), 'original\n');
  fs.writeFileSync(path.join(root, '.gitattributes'), 'a filter=trap diff=trap\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const marker = path.join(root, 'ran');
  const trap = path.join(root, 'trap.sh');
  fs.writeFileSync(trap, `#!/bin/sh\nprintf ran >> '${marker}'\ncat\n`, { mode: 0o755 });
  return { root, git, marker, trap };
}

test('check cache reads source files and release refs without executing source fsmonitor or clean filters', { skip: IS_WINDOWS }, () => {
  const f = fixture();
  f.git('config', 'core.fsmonitor', f.trap);
  f.git('config', 'filter.trap.clean', f.trap);
  f.git('remote', 'add', 'origin', 'https://example.test/fork.git');
  f.git('update-ref', 'refs/threadbear/upstream/2026-11-25', 'HEAD');
  fs.writeFileSync(path.join(f.root, 'a'), 'changed\n');
  const tree = treeOf(f.root) as Map<string, string>;
  assert.ok(tree.has('a'));
  const rel = releaseIn(f.root) as { name: string } | undefined;
  assert.equal(rel?.name, '2026-11-25');
  assert.equal(fs.existsSync(f.marker), false);
});

test('check cache releaseIn rejects replacement refs and substituted objects', () => {
  const f = fixture();
  f.git('remote', 'add', 'origin', 'https://example.test/fork.git');
  const head = f.git('rev-parse', 'HEAD').trim();
  f.git('update-ref', 'refs/threadbear/upstream/2026-11-25', head);
  assert.ok(releaseIn(f.root));
  f.git('replace', head, head);
  assert.equal(releaseIn(f.root), undefined);
  f.git('replace', '-d', head);
  const blob = f.git('rev-parse', 'HEAD:a').trim();
  const obj = path.join(f.root, '.git/objects', blob.slice(0, 2), blob.slice(2));
  const raw = inflateSync(fs.readFileSync(obj));
  raw[raw.indexOf(0) + 1] ^= 1;
  fs.chmodSync(obj, 0o644);
  fs.writeFileSync(obj, deflateSync(raw));
  assert.equal(releaseIn(f.root), undefined);
});

test('remoteChecks disables upstream release test-skipping during deployment', () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'check.sh'), '#!/bin/bash\n');
  let gotEnv: Record<string, string> | undefined;
  const ran = remoteChecks(['build-box'], root, { env: {} }, {
    say: () => {},
    node: process.execPath,
    spawn: (_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
      gotEnv = opts.env;
      return { status: 0, output: '' };
    },
  });
  assert.equal(ran, true);
  assert.equal(gotEnv?.THREADBEAR_CHECK_TRUST_RELEASE, 'off');
});

for (const file of ['check.sh', 'scripts/check-remote.sh']) {
  test(`${file} source Git never executes repository programs`, { skip: IS_WINDOWS }, () => {
    const f = fixture(); copyCheckGitFiles(f.root);
    f.git('config', 'core.fsmonitor', f.trap);
    f.git('config', 'filter.trap.clean', f.trap);
    f.git('config', 'diff.trap.textconv', f.trap);
    fs.writeFileSync(path.join(f.root, 'a'), 'changed\n');
    const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../..', file), 'utf8');
    const fn = /^source_git\(\) \{[\s\S]*?^\}/m.exec(source)?.[0];
    assert.ok(fn, 'source operations must use the hardened Git wrapper');
    execFileSync('/bin/bash', ['-c', `${fn}\nsource_git ls-files -co --exclude-standard -z >/dev/null\nsource_git diff --name-only HEAD >/dev/null`, 'test'], { env: { ...process.env, ROOT: f.root, NODE: process.execPath }, stdio: 'pipe' });
    assert.equal(fs.existsSync(f.marker), false);
  });
}

test('check-remote.sh full upload flow never executes repository fsmonitor or filters', { skip: IS_WINDOWS }, () => {
  const s = setupRemote({ h1: { state: 'free' } });
  const marker = path.join(s.fake, 'hostile-ran');
  const trap = path.join(s.fake, 'trap.sh');
  fs.writeFileSync(trap, `#!/bin/sh\nprintf ran >> '${marker}'\ncat\n`, { mode: 0o755 });
  const g = (...args: string[]) => execFileSync('git', ['-C', s.repo, ...args], { stdio: 'ignore' });
  g('config', 'core.fsmonitor', trap);
  g('config', 'filter.trap.clean', trap);
  g('config', 'diff.trap.textconv', trap);
  fs.writeFileSync(path.join(s.repo, '.gitattributes'), 'a.txt filter=trap diff=trap\n');
  fs.writeFileSync(path.join(s.repo, 'a.txt'), 'edited\n');
  const r = s.run('h1', 3600);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(marker), false, 'planted git helper must never run during check-remote.sh');
});
