// launch.mjs taking in a Threadbear Runner.app that install-runner.sh
// --stage built beside the running one. Building over the running app
// made macOS refuse every privacy grant under it (Screen Recording in
// agents' shells) until the job restarted (16 Nov 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
// @ts-expect-error launch.mjs is plain JS with no types
import { stagedAppPath, takeStagedApp } from '../../launch.mjs';
import { stagedAppPath as stagedAppPathTs } from '../../src/reinstall.ts';

const darwin = process.platform === 'darwin';

function apps() {
  const dir = tmpDir('tb-staged-app-');
  const app = path.join(dir, 'Threadbear Runner.app');
  const mk = (p: string, v: string) => {
    fs.mkdirSync(path.join(p, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(p, 'Contents', 'v'), v);
  };
  mk(app, 'old');
  const read = (p: string) => fs.readFileSync(path.join(p, 'Contents', 'v'), 'utf8');
  return { dir, app, mk, read, staged: stagedAppPath(app) };
}

test('the runner and launch.mjs agree on where the staged app goes', () => {
  assert.equal(stagedAppPath('/a/Threadbear Runner.app'), '/a/.Threadbear Runner.app.staged');
  assert.equal(stagedAppPathTs('/a/Threadbear Runner.app'), stagedAppPath('/a/Threadbear Runner.app'));
});

test('nothing staged, no app named, or one that does not verify: the running app stays', { skip: !darwin }, () => {
  const t = apps();
  const quiet = () => {};
  assert.equal(takeStagedApp(t.app, () => true, quiet), false);
  assert.equal(takeStagedApp(undefined, () => true, quiet), false);
  t.mk(t.staged, 'new');
  const helper = path.join(t.staged, 'Contents', 'Helpers', 'replace-app');
  fs.mkdirSync(path.dirname(helper));
  fs.writeFileSync(helper, 'the verifier refuses this bundle');
  const verified: string[] = [];
  assert.equal(takeStagedApp(t.app, (candidate: string) => {
    verified.push(candidate);
    return false;
  }, quiet), false);
  assert.deepEqual(verified, [t.staged]);
  assert.equal(t.read(t.app), 'old');
  assert.equal(t.read(t.staged), 'new');
});
