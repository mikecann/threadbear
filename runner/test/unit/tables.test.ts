// Tables (tables.ts): a project with a `table` marker. The field survives
// create, update and a reload; a table that's a Part gets both briefs and a
// Bears: line; the mirror never sees it; the librarian never files a stray
// thread into one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, tmpDir } from '../helpers/fakes.ts';
import { Projects } from '../../src/projects.ts';
import { Librarian } from '../../src/librarian.ts';
import { Bears } from '../../src/bears.ts';
import { checkTable, hostInstructions, Tables, tablesMethods, tablesRoot } from '../../src/tables.ts';
import { toProjectDoc } from '../../src/sync.ts';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';

async function setup() {
  const home = tmpDir();
  const projects = new Projects({ home, clock: new FakeClock(), log: nullLogger });
  const h = makeHarness(home, {}, { projects });
  projects.start(h.runner);
  const bears = new Bears({ root: path.join(tmpDir(), 'Bears'), home, git: false });
  const r = await bears.create({ name: 'Researcher', tidy: false });
  const w = await bears.create({ name: 'Writer', tidy: false });
  projects.describeBears = (ids) => ids.map((id) => bears.get(id).name).join(', ');
  const tables = new Tables({ root: tablesRoot(bears.root), projects, bears });
  return { home, h, projects, bears, tables, r, w };
}

test('a table is a project with a marker and a host folder', async () => {
  const s = await setup();
  const t = s.tables.create({ title: 'Launch crew', goal: 'Ship the launch post', bears: ['Researcher', 'writer'] });
  assert.deepEqual(t.table, { bears: [s.r.id, s.w.id] });
  const folder = t.folders[0].replace(/^~/, process.env.HOME ?? '');
  assert.ok(folder.includes(`${path.sep}Tables${path.sep}launch-crew-`));
  assert.equal(fs.readFileSync(path.join(folder, 'CLAUDE.md'), 'utf8'), hostInstructions('Launch crew'));
  assert.equal(s.tables.tableOf(path.join(folder, 'sub'))?.id, t.id);
  assert.equal(s.tables.tableOf(folder)?.maxTurns, 6);
  assert.equal(s.tables.tableOf('/elsewhere'), undefined);
  assert.equal(s.tables.list().length, 1);
});

test('the table field survives update and a reload, and stays out of the mirror', async () => {
  const s = await setup();
  const t = s.tables.create({ title: 'Crew', bears: ['Researcher'], maxTurns: 3 });
  s.projects.update(t.id, { goals: 'new goal' });
  assert.deepEqual(s.projects.get(t.id).project.table, { bears: [s.r.id], maxTurns: 3 });
  const again = new Projects({ home: s.home, clock: new FakeClock(), log: nullLogger });
  again.start(s.h.runner);
  assert.deepEqual(again.get(t.id).project.table, { bears: [s.r.id], maxTurns: 3 });
  assert.equal('table' in toProjectDoc(s.projects.get(t.id).project), false);
  const seated = s.tables.seat(t.id, { add: ['Writer'], remove: ['Researcher'], maxTurns: 4 });
  assert.deepEqual(seated.table, { bears: [s.w.id], maxTurns: 4 });
  assert.equal(s.tables.unseatEverywhere(s.w.id), 1);
  assert.deepEqual(s.projects.get(t.id).project.table?.bears, []);
  s.projects.update(t.id, { table: null });
  assert.equal(s.projects.get(t.id).project.table, undefined);
});

test("a table inside a project is a Part: its thread's brief has both goals and the Bears line", async () => {
  const s = await setup();
  const launch = s.projects.create({ title: 'Launch', goals: 'Launch Threadbear bears', by: 'mike' });
  const t = s.tables.create({ title: 'Launch crew', goal: 'Plan the post', bears: ['Researcher', 'Writer'], parent: launch.id });
  assert.equal(t.parentId, launch.id);
  const folder = t.folders[0].replace(/^~/, process.env.HOME ?? '');
  const { thread } = s.h.runner.create({ text: 'plan the launch post', cwd: folder, projectIds: [t.id] });
  const rec = s.h.store.load(thread.id)!;
  const brief = s.projects.brief(rec) ?? '';
  assert.match(brief, /Launch's goals: Launch Threadbear bears/);
  assert.match(brief, /Goals: Plan the post/);
  assert.match(brief, /Bears: Researcher, Writer/);
});

test('checkTable: ids only, at most 8 bears, maxTurns 1 to 20', () => {
  assert.deepEqual(checkTable({ bears: ['a-1', 'a-1', 'Bad Id', 3] }), { bears: ['a-1'] });
  assert.throws(() => checkTable({ bears: Array.from({ length: 9 }, (_, i) => `b-${i}`) }), /at most 8/);
  assert.throws(() => checkTable({ bears: [], maxTurns: 0 }), /maxTurns/);
  assert.throws(() => checkTable(null), /table is/);
});

test('tables RPCs are off until both experiments are on', async () => {
  const s = await setup();
  let on = false;
  const m = tablesMethods({ tables: () => s.tables, on: () => on });
  assert.deepEqual(m['tables.list']({}), { on: false, tables: [] });
  assert.throws(() => m['tables.create']({ title: 'x' }), /Tables are off/);
  on = true;
  assert.equal((m['tables.create']({ title: 'x', bears: ['Writer'] }) as { table: { title: string } }).table.title, 'x');
});

test('the librarian is never shown a table for a thread not already at it', async () => {
  const s = await setup();
  s.tables.create({ title: 'Secret crew', bears: ['Researcher'] });
  const plain = s.projects.create({ title: 'Plain project', by: 'mike' });
  const lib = new Librarian({ host: s.h.runner as never, projects: s.projects, clock: new FakeClock(), log: nullLogger, home: s.home });
  const { thread } = s.h.runner.create({ text: 'hello', cwd: tmpDir() });
  const rec = s.h.store.load(thread.id)!;
  const prompt = (lib as unknown as { prompt: (r: unknown, j: unknown) => string }).prompt(rec, { threadId: rec.id, reason: 'turn-end', why: '', dueAtMs: 0 });
  assert.ok(prompt.includes('Plain project'));
  assert.ok(!prompt.includes('Secret crew'));
  void plain;
});
