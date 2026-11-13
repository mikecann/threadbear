// Bears (bears.ts): the folder model, bears.json, Head Bear, faces, quiet
// hours, and the defaults a bear's new thread starts with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { avatarPresets, Bears, bearsMethods, checkAvatar, DEFAULT_BEAR, lowerMode, HEAD_TEXT, newBearId, renderFaces, shiftOutOfQuiet, type BearSchedules } from '../../src/bears.ts';
import { CallerGate } from '../../src/rpc-gate.ts';
import { autoNote } from '../../src/cli-bears.ts';
import type { Schedule } from '../../src/protocol.ts';
import { makeHarness, tmpDir } from '../helpers/fakes.ts';

function fakeSchedules(): BearSchedules & { rows: Schedule[] } {
  const rows: Schedule[] = [];
  return {
    rows,
    list: () => rows,
    create: async (p) => {
      const s = { id: `s${rows.length + 1}`, title: p.title ?? p.text, text: p.text, cron: p.cron, cwd: p.cwd, permissionMode: p.permissionMode, whenText: 'daily', paused: false, createdAt: '', updatedAt: '', runs: 0 } as Schedule;
      rows.push(s);
      return s;
    },
    update: async (p) => {
      const s = rows.find((r) => r.id === p.scheduleId)!;
      if (p.paused !== undefined) s.paused = p.paused;
      return s;
    },
    delete: async (id) => {
      rows.splice(rows.findIndex((r) => r.id === id), 1);
      return {};
    },
  };
}

function setup(now = () => Date.parse('2026-11-13T12:00:00Z')) {
  const home = tmpDir();
  const root = path.join(tmpDir(), 'Bears');
  const schedules = fakeSchedules();
  const archived: string[] = [];
  const threads = [{ id: 't1', cwd: '' }];
  const bears = new Bears({ root, home, now, git: false, schedules: () => schedules, threads: () => ({ list: () => threads, archive: (id) => void archived.push(id) }) });
  return { home, root, bears, schedules, archived, threads };
}

test('a new bear is a folder with its persona, memory, bear.json and a tidy routine', async () => {
  const { bears, root, schedules } = setup();
  const b = await bears.create({ name: 'Researcher', does: 'Finds sources', personality: 'dry and calm', preset: 'snout' });
  assert.match(b.id, /^researcher-[0-9a-f]{4}$/);
  assert.equal(b.folder, path.join(root, b.id));
  for (const f of ['CLAUDE.md', 'AGENTS.md', 'bear.json', 'memory/summary.md', 'memory/people/.gitkeep', 'memory/facts/.gitkeep', 'memory/projects/.gitkeep']) assert.ok(fs.existsSync(path.join(b.folder, f)), f);
  assert.ok(fs.existsSync(path.join(root, 'memory', 'summary.md')), 'shared memory');
  const claude = fs.readFileSync(path.join(b.folder, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /@memory\/summary\.md/);
  assert.match(claude, /@\.\.\/memory\/summary\.md/);
  assert.match(claude, /dry and calm/);
  assert.match(claude, /"Forget this" means delete it/);
  assert.ok(!claude.includes('Chief of staff'));
  const file = JSON.parse(fs.readFileSync(path.join(b.folder, 'bear.json'), 'utf8'));
  assert.equal(file.name, 'Researcher');
  assert.equal(file.quietHours, '19:30-08:30');
  assert.equal(file.permissionMode, undefined, 'no access fields in the folder');
  assert.equal(schedules.rows.length, 1);
  assert.equal(schedules.rows[0].cwd, b.folder);
  assert.equal(schedules.rows[0].permissionMode, 'ask');
  assert.equal(b.routines.length, 1);
  assert.ok(b.faces?.idle.startsWith('<svg'));
  await assert.rejects(bears.create({ name: 'researcher' }), /already a bear called/);
});

test("CLAUDE.md is the user's after it's made: never overwritten", async () => {
  const { bears } = setup();
  const b = await bears.create({ name: 'Writer', tidy: false });
  fs.writeFileSync(path.join(b.folder, 'CLAUDE.md'), 'mine');
  bears.update(b.id, { does: 'Drafts posts' });
  assert.equal(fs.readFileSync(path.join(b.folder, 'CLAUDE.md'), 'utf8'), 'mine');
});

test('rename keeps the id and folder; access fields are refused from bears.update', async () => {
  const { bears } = setup();
  const b = await bears.create({ name: 'Researcher', tidy: false });
  const r = bears.update(b.id, { name: 'Scout' });
  assert.equal(r.id, b.id);
  assert.equal(r.folder, b.folder);
  assert.equal(bears.get('scout').id, b.id);
  assert.equal(bears.get(`@bear:${b.id}`).name, 'Scout');
  assert.throws(() => bears.update(b.id, { permissionMode: 'full' }), /bears\.setAccess/);
  assert.throws(() => bears.update(b.id, { bogus: 1 }), /no field bogus/);
  assert.throws(() => bears.update(b.id, { avatar: { version: 1 } }), /valid Open Bot Avatar/);
});

test("a bear's thread can't change what any bear may do, the head bear's included", async () => {
  const { bears } = setup();
  const a = await bears.create({ name: 'A', tidy: false });
  const b = await bears.create({ name: 'B', tidy: false });
  assert.throws(() => bears.setAccess(a.id, { permissionMode: 'full' }, a.folder), /own thread can't change/);
  assert.throws(() => bears.setAccess(a.id, { permissionMode: 'full' }, path.join(b.folder, 'sub')), /A bear's thread \(B\)/);
  const ok = bears.setAccess(a.id, { permissionMode: 'auto', poolId: 'p1' }, '/somewhere/else');
  assert.equal(ok.state.permissionMode, 'auto');
  assert.equal(ok.state.poolId, 'p1');
  assert.equal(bears.setAccess(a.id, { permissionMode: 'auto' }).state.permissionMode, 'auto');
  // Kept out of the bear's own folder.
  assert.ok(!fs.readFileSync(path.join(a.folder, 'bear.json'), 'utf8').includes('auto'));
});

test('new thread defaults: the bear model and effort, Ask for unattended runs unless raised', async () => {
  const { bears } = setup();
  const b = await bears.create({ name: 'R', model: 'sonnet', effort: 'high', tidy: false });
  assert.deepEqual(bears.newThreadDefaults(b.folder, false), { model: 'sonnet', effort: 'high' });
  assert.deepEqual(bears.newThreadDefaults(b.folder, true), { model: 'sonnet', effort: 'high', permissionMode: 'ask' });
  bears.setAccess(b.id, { permissionMode: 'auto' });
  assert.equal(bears.newThreadDefaults(path.join(b.folder, 'notes'), true)?.permissionMode, 'auto');
  assert.equal(bears.newThreadDefaults('/elsewhere', true), undefined);
  assert.equal(bears.newThreadDefaults(path.join(bears.root, 'memory'), true), undefined);
});

test("a Runner thread in a bear's folder starts with its defaults; elsewhere nothing changes", async () => {
  const h = makeHarness();
  const { bears } = setup();
  const b = await bears.create({ name: 'R', model: 'sonnet', tidy: false });
  h.runner.bearDefaults = (cwd, unattended) => bears.newThreadDefaults(cwd, unattended);
  const mine = h.runner.create({ text: 'hi', cwd: b.folder });
  assert.equal(mine.thread.model, 'sonnet');
  assert.notEqual(mine.thread.permissionMode, 'ask');
  const routine = h.runner.create({ text: 'hi', cwd: b.folder, startedBy: { kind: 'tool', label: 'Webhook' } });
  assert.equal(routine.thread.permissionMode, 'ask');
  const told = h.runner.create({ text: 'hi', cwd: b.folder, model: 'opus' });
  assert.equal(told.thread.model, 'opus');
  const other = h.runner.create({ text: 'hi', cwd: tmpDir() });
  assert.notEqual(other.thread.model, 'sonnet');
});

test('away and archived hold its routines; archive pauses them and they stay paused', async () => {
  const { bears, schedules } = setup();
  const b = await bears.create({ name: 'R' });
  assert.equal(bears.holdReason(b.folder), undefined);
  await bears.hibernate(b.id, '2026-11-16T09:00:00Z');
  assert.match(bears.holdReason(b.folder) ?? '', /R is away until/);
  await assert.rejects(bears.hibernate(b.id, '2020-01-01T00:00:00Z'), /in the future/);
  await bears.hibernate(b.id, null);
  assert.equal(bears.holdReason(b.folder), undefined);
  await bears.archive(b.id, true);
  assert.match(bears.holdReason(b.folder) ?? '', /archived/);
  assert.equal(schedules.rows[0].paused, true);
  assert.equal(bears.list().length, 0);
  assert.equal(bears.list({ archived: true }).length, 1);
  await bears.archive(b.id, false);
  assert.equal(schedules.rows[0].paused, true, 'routines stay paused until resumed');
});

test('pin and order: the head bear first, then pinned in pin order, then manual order, then name', async () => {
  const { bears } = setup();
  const a = await bears.create({ name: 'Alpha', tidy: false });
  const b = await bears.create({ name: 'Bravo', tidy: false });
  const c = await bears.create({ name: 'Charlie', tidy: false });
  assert.deepEqual(bears.list().map((x) => x.name), ['Alpha', 'Bravo', 'Charlie']);
  bears.move(c.id, 0);
  assert.deepEqual(bears.list().map((x) => x.name), ['Charlie', 'Alpha', 'Bravo']);
  bears.pin(b.id, true);
  assert.deepEqual(bears.list().map((x) => x.name), ['Bravo', 'Charlie', 'Alpha']);
  bears.setHead(a.id);
  assert.deepEqual(bears.list().map((x) => x.name), ['Alpha', 'Bravo', 'Charlie']);
  bears.pin(b.id, false);
  assert.equal(bears.get(b.id).state.pinned, undefined);
});

test('Head Bear: made once as the default, and the chief of staff block follows the job', async () => {
  const { bears } = setup();
  await bears.ensureDefault();
  const m = bears.headBear();
  assert.equal(m?.name, DEFAULT_BEAR.name);
  assert.ok(m?.avatar, 'a face');
  assert.ok(fs.readFileSync(path.join(m!.folder, 'CLAUDE.md'), 'utf8').includes('## Chief of staff'));
  const w = await bears.create({ name: 'Writer', tidy: false });
  bears.setHead(w.id);
  assert.ok(!fs.readFileSync(path.join(m!.folder, 'CLAUDE.md'), 'utf8').includes('## Chief of staff'), 'taken off the old one');
  const text = fs.readFileSync(path.join(w.folder, 'CLAUDE.md'), 'utf8');
  assert.equal(text.split('## Chief of staff').length, 2);
  bears.setHead(w.id);
  assert.equal(fs.readFileSync(path.join(w.folder, 'CLAUDE.md'), 'utf8').split('## Chief of staff').length, 2, 'not added twice');
  assert.ok(HEAD_TEXT.includes('tb bears ask'));
  await bears.delete(m!.id);
  await bears.ensureDefault();
  assert.equal(bears.list().filter((x) => x.name === DEFAULT_BEAR.name).length, 0, 'once only');
  bears.setHead(null);
  assert.equal(bears.headBear(), undefined);
});

test('delete moves the folder to the runner trash, deletes routines and archives its threads', async () => {
  const { bears, home, schedules, archived, threads } = setup();
  const b = await bears.create({ name: 'R' });
  threads[0].cwd = b.folder;
  bears.setHead(b.id);
  const r = await bears.delete(b.id);
  assert.ok(r.trashed.startsWith(path.join(home, 'trash')));
  assert.ok(fs.existsSync(path.join(r.trashed, 'CLAUDE.md')));
  assert.ok(!fs.existsSync(b.folder));
  assert.equal(schedules.rows.length, 0);
  assert.deepEqual(archived, ['t1']);
  assert.equal(bears.headBear(), undefined);
  assert.throws(() => bears.get(b.id), /No bear/);
});

test('quiet hours move a time to the end of them, across midnight too', () => {
  const at = (h: number, m = 0) => new Date(2026, 10, 13, h, m).getTime();
  assert.equal(shiftOutOfQuiet(at(12)), at(12));
  assert.equal(shiftOutOfQuiet(at(22)), new Date(2026, 10, 14, 8, 30).getTime());
  assert.equal(shiftOutOfQuiet(at(3)), at(8, 30));
  assert.equal(shiftOutOfQuiet(at(8, 30)), at(8, 30));
  assert.equal(shiftOutOfQuiet(at(13), '12:00-14:00'), at(14));
  assert.equal(shiftOutOfQuiet(at(13), 'nonsense'), at(13));
});

test('faces: every preset is a valid avatar and renders three moods; bad ones are refused', () => {
  const presets = avatarPresets();
  assert.ok(presets.length >= 6);
  for (const p of presets) {
    const f = renderFaces(p.avatar, p.color);
    for (const mood of ['idle', 'thinking', 'happy'] as const) assert.ok(f[mood].startsWith('<svg'), `${p.id} ${mood}`);
  }
  assert.throws(() => checkAvatar({ version: 1, id: 'x', name: 'x', body: { path: 'M0 0' }, eyes: { x: 0, y: 0, spacing: 1, scale: 1 } }), /valid Open Bot Avatar/);
  assert.match(newBearId('Ünïcode  Name!'), /^unicode-name-[0-9a-f]{4}$/);
  assert.equal(lowerMode('full', 'ask'), 'ask');
  assert.equal(lowerMode('auto', 'full'), 'auto');
});

test('RPCs: off by default, Head Bear made on the first list, setHead refused from a bear thread', async () => {
  const { bears } = setup();
  let on = false;
  const cwds: Record<string, string> = {};
  const m = bearsMethods({ bears, on: () => on, cwdOf: (id) => cwds[id] });
  assert.deepEqual(await m['bears.list']({}), { on: false, bears: [] });
  await assert.rejects(async () => m['bears.create']({ name: 'X' }), /Bears are off/);
  on = true;
  const r = (await m['bears.list']({ faces: false })) as { bears: { name: string; folder: string; head: boolean }[] };
  assert.equal(r.bears[0].name, 'Head Bear');
  assert.equal(r.bears[0].head, true);
  cwds.t = r.bears[0].folder;
  assert.throws(() => m['bears.setHead']({ bear: null, _caller: 't' }), /can't pick the chief of staff/);
  assert.throws(() => m['bears.setAccess']({ bear: 'Head Bear', permissionMode: 'full', _caller: 't' }), /own thread/);
});

test('the RPC gate: a thread below Full access reads bears and edits harmless fields, never access', () => {
  const gate = new CallerGate({
    runner: { has: () => true, get: () => ({ permissionMode: 'ask', title: 'T' }), accessOf: () => 'ask', confinedOf: () => false },
  });
  assert.equal(gate.check('t1', 'bears.list', {})._caller, 't1');
  assert.equal(gate.check('t1', 'bears.update', { bear: 'x', does: 'y' })._caller, 't1');
  assert.throws(() => gate.check('t1', 'bears.setAccess', { bear: 'x', permissionMode: 'full' }), /needs the user's OK/);
  assert.throws(() => gate.check('t1', 'bears.delete', { bear: 'x' }), /needs the user's OK/);
  const full = new CallerGate({ runner: { has: () => true, get: () => ({ permissionMode: 'full', title: 'T' }), accessOf: () => 'full', confinedOf: () => false } });
  assert.equal(full.check('t2', 'bears.setAccess', { bear: 'x', _caller: 'spoofed' })._caller, 't2', "the caller can't name someone else");
});

test("a thread's sidebar tile: the bear's name, icon and colour, and whether it's the head bear", async () => {
  const { bears } = setup();
  const b = await bears.create({ name: 'Writer', icon: 'pencil', color: '#3E8ED0', tidy: false });
  assert.deepEqual(bears.tile(path.join(b.folder, 'drafts')), { id: b.id, name: 'Writer', icon: 'pencil', color: '#3E8ED0' });
  bears.setHead(b.id);
  assert.equal(bears.tile(b.folder)?.head, true);
  assert.equal(bears.tile('/elsewhere'), undefined);
  bears.update(b.id, { color: null });
  assert.equal(bears.tile(b.folder)?.color, undefined);
});

test('a Runner summary carries the bear only when bearOf says so', async () => {
  const h = makeHarness();
  const { bears } = setup();
  const b = await bears.create({ name: 'Writer', tidy: false });
  const t = h.runner.create({ text: 'hi', cwd: b.folder }).thread;
  assert.equal(t.bear, undefined);
  h.runner.bearOf = (cwd) => bears.tile(cwd);
  assert.equal(h.runner.list().find((x) => x.id === t.id)?.bear?.name, 'Writer');
});

test("tb bears access says Auto works like Ask on a Codex bear, and nothing otherwise", () => {
  assert.match(autoNote({ name: 'Designer', model: 'gpt-6-astra', state: { permissionMode: 'auto' } }) ?? '', /Designer runs on Codex, where Auto works like Ask/);
  assert.match(autoNote({ name: 'D', state: { permissionMode: 'auto', poolId: 'codex-pool' } }) ?? '', /Codex/);
  assert.equal(autoNote({ name: 'Writer', model: 'sonnet', state: { permissionMode: 'auto' } }), undefined);
  assert.equal(autoNote({ name: 'Designer', model: 'gpt-6-astra', state: { permissionMode: 'ask' } }), undefined);
});
