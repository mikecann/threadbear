import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addProfile, findProfile, freePort, installProfile, listProfiles, profileId, removeProfile, registryFile, LABEL_PREFIX } from '../../src/profiles.ts';
import { loadConfig, profileLine, readRunnerJson, writeRunnerJson, DEFAULT_PORT } from '../../src/config.ts';
import { ConvexKeys } from '../../src/convex-keys.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tb-profiles-'));

function setup() {
  const base = tmp();
  writeRunnerJson(base, { port: DEFAULT_PORT });
  const root = tmp();
  return { base, root };
}

test('Personal is always first, and a new profile gets its own folder, port and label', () => {
  const { base, root } = setup();
  assert.deepEqual(listProfiles(base).map((p) => [p.id, p.name, p.port]), [['personal', 'Personal', DEFAULT_PORT]]);
  const work = addProfile('Work', { base, root, defaultCwd: '/tmp/work-threads' });
  assert.equal(work.id, 'work');
  assert.equal(work.home, path.join(root, 'work'));
  assert.equal(work.port, DEFAULT_PORT + 1);
  assert.equal(work.label, `${LABEL_PREFIX}.work`);
  // Its runner.json names the profile, its port and its own threads folder, and no backend yet.
  const json = readRunnerJson(work.home);
  assert.deepEqual(json.profile, { id: 'work', name: 'Work' });
  assert.equal(json.port, DEFAULT_PORT + 1);
  assert.equal(json.defaults?.cwd, '/tmp/work-threads');
  assert.equal((json as Record<string, unknown>).sync, undefined);
  const second = addProfile('Side Projects', { base, root });
  assert.equal(second.id, 'side-projects');
  assert.equal(second.port, DEFAULT_PORT + 2);
  assert.deepEqual(listProfiles(base).map((p) => p.id), ['personal', 'work', 'side-projects']);
  assert.equal(findProfile('side projects', base)?.id, 'side-projects');
  assert.equal(findProfile('WORK', base)?.id, 'work');
});

test('the list holds no secrets and is only readable by you', () => {
  const { base, root } = setup();
  addProfile('Work', { base, root });
  const text = fs.readFileSync(registryFile(base), 'utf8');
  assert.doesNotMatch(text, /key|token|secret/i);
  assert.equal(fs.statSync(registryFile(base)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(root, 'work')).mode & 0o777, 0o700);
});

test("names must differ, Personal can't be removed, and remove keeps the folder unless asked", () => {
  const { base, root } = setup();
  addProfile('Work', { base, root });
  assert.throws(() => addProfile(' work ', { base, root }), /already/);
  assert.throws(() => addProfile('   ', { base, root }), /needs a name/);
  assert.throws(() => removeProfile('personal', { base }), /can't be removed/);
  const kept = addProfile('Kept', { base, root });
  removeProfile('kept', { base });
  assert.ok(fs.existsSync(kept.home), 'the folder stays');
  removeProfile('work', { base, deleteFiles: true });
  assert.ok(!fs.existsSync(path.join(root, 'work')));
  assert.deepEqual(listProfiles(base).map((p) => p.id), ['personal']);
});

test('ids and ports skip the ones taken', () => {
  assert.equal(profileId('Personal', ['personal']), 'personal-2');
  assert.equal(profileId('Work!!', ['personal', 'work']), 'work-2');
  assert.equal(profileId('***', []), 'profile');
  assert.equal(freePort([DEFAULT_PORT, DEFAULT_PORT + 1]), DEFAULT_PORT + 2);
});

test("a profile's runner keeps its own Claude, Codex and Convex logins, never the Mac's", () => {
  const { base, root } = setup();
  const work = addProfile('Work', { base, root });
  const cfg = loadConfig({ THREADBEAR_HOME: work.home } as NodeJS.ProcessEnv);
  assert.deepEqual(cfg.profile, { id: 'work', name: 'Work' });
  assert.equal(cfg.port, work.port);
  for (const dir of [cfg.claudeMainDir, cfg.claudeMainJson, cfg.codexMainDir, cfg.tokenStatsAccountsDir, cfg.convexCliHome!]) {
    assert.ok(dir.startsWith(work.home), `${dir} is inside the profile`);
  }
  // Personal (no profile) is as it always was.
  const personal = loadConfig({ THREADBEAR_HOME: base } as NodeJS.ProcessEnv);
  assert.equal(personal.profile, undefined);
  assert.equal(personal.convexCliHome, undefined);
  assert.equal(personal.claudeMainDir, path.join(os.homedir(), '.claude'));
});

test('agents on a profile are told which one, and Personal says nothing', () => {
  assert.equal(profileLine(undefined), '');
  assert.match(profileLine({ id: 'work', name: 'Work' }), /^\[Threadbear profile\] This runner is the "Work" profile/);
});

test("the Convex CLI's login is the profile's own file", () => {
  const home = tmp();
  const keys = new ConvexKeys(tmp(), async () => ({ ok: true, text: '' } as never), 'mac', { cliHome: home });
  assert.equal(keys.signedIn(), false);
  fs.mkdirSync(path.join(home, '.convex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.convex', 'config.json'), JSON.stringify({ accessToken: 'x' }));
  assert.equal(keys.signedIn(), true);
});

test('installing a profile runs install-runner.sh with its folder, label and port', () => {
  const { base, root } = setup();
  const work = addProfile('Work', { base, root });
  const calls: { cmd: string; args: string[] }[] = [];
  const run = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return { status: 0, stdout: 'ok', stderr: '' };
  }) as never;
  assert.equal(installProfile(work, { checkout: '/repo', run }).ok, true);
  installProfile(work, { checkout: '/repo', run, uninstall: true });
  assert.equal(calls[0].cmd, '/repo/runner/scripts/install-runner.sh');
  assert.deepEqual(calls[0].args, ['--home', work.home, '--label', work.label, '--port', String(work.port)]);
  assert.equal(calls[1].args.at(-1), '--uninstall');
});
