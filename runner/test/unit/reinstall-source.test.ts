import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import { Reinstaller, type JobSpec } from '../../src/reinstall.ts';
import { execFileSync } from 'node:child_process';
import { stageVerifiedSource } from '../../src/reinstall-source.ts';
import { IS_WINDOWS } from '../../src/platform.ts';

test('automatic restaging starts trusted release code before touching the original installer', () => {
  const jobs: JobSpec[] = [];
  const r = new Reinstaller({ home: tmpDir(), checkout: '/untrusted-working-tree', clock: new FakeClock(), log: nullLogger,
    behind: () => ({ key: 'new', reason: 'launcher changed' }), platform: 'darwin', env: {},
    spawnJob: (job) => { jobs.push(job); return undefined; }, jobAlive: () => true });
  r.consider();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].program, 'node');
  assert.match(jobs[0].args[0], /reinstall-source\.ts$/);
  assert.ok(!jobs[0].args[0].startsWith('/untrusted-working-tree'));
  assert.equal(jobs[0].args.at(-1), '--stage');
  r.stop();
});

test('automatic restaging executes the committed installer and launcher despite dirty originals', { skip: IS_WINDOWS }, async () => {
  const root = tmpDir();
  const source = path.join(root, 'source');
  const dest = path.join(root, 'verified');
  const marker = path.join(root, 'ran');
  fs.mkdirSync(path.join(source, 'runner/scripts'), { recursive: true });
  fs.mkdirSync(path.join(source, 'runner/src'));
  fs.writeFileSync(path.join(source, 'runner/src/main.ts'), 'export {};\n');
  const installer = path.join(source, 'runner/scripts/install-runner.sh');
  const launch = path.join(source, 'runner/launch.mjs');
  fs.writeFileSync(launch, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(marker)}, 'clean launcher\\n');\n`);
  fs.writeFileSync(installer, `#!/bin/bash\nnode "$(dirname "$0")/../launch.mjs"\nprintf 'clean installer\\n' >> '${marker}'\n`, { mode: 0o755 });
  const git = (...args: string[]) => execFileSync('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false', ...args], { encoding: 'utf8' });
  git('init', '-qb', 'main'); git('add', '.'); git('commit', '-qm', 'committed source');
  fs.writeFileSync(installer, `#!/bin/bash\nprintf dirty-installer >> '${marker}'\nexit 2\n`);
  fs.writeFileSync(launch, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(marker)}, 'dirty launcher');\n`);
  assert.equal(await stageVerifiedSource(source, dest, ['--stage']), 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'clean launcher\nclean installer\n');
  assert.match(fs.readFileSync(installer, 'utf8'), /dirty-installer/);
  assert.match(fs.readFileSync(launch, 'utf8'), /dirty launcher/);
});

test('automatic source helper refuses operations that could stop the live runner', async () => {
  for (const args of [[], ['--uninstall', '--stage'], ['--force', '--stage'], ['--from-source', '--stage']]) {
    await assert.rejects(stageVerifiedSource('/unused', '/unused', args), /cannot stop or uninstall/);
  }
});
