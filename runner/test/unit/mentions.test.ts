// Mentions (mentions.ts): routing a message to a bear, the access cap, the
// 3-bear limit, the away line, bear-to-bear only through a shared table or
// from the head bear, the table's turn cap, and the reply coming back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Bears } from '../../src/bears.ts';
import { BEAR_REPLY_PREFIX, findMentions, Mentions, type MentionHost } from '../../src/mentions.ts';
import type { PermissionMode } from '../../src/protocol.ts';
import { tmpDir } from '../helpers/fakes.ts';

type T = { id: string; title: string; cwd: string; permissionMode: PermissionMode; status: string; projects?: { id: string }[]; reply?: string };

async function setup() {
  const home = tmpDir();
  const bears = new Bears({ root: path.join(tmpDir(), 'Bears'), home, git: false, now: () => Date.parse('2026-11-13T12:00:00Z') });
  const r = await bears.create({ name: 'Researcher', tidy: false });
  const w = await bears.create({ name: 'Writer', tidy: false });
  const threads = new Map<string, T>();
  const sent: { id: string; text: string }[] = [];
  const made: Parameters<MentionHost['create']>[0][] = [];
  const host: MentionHost = {
    has: (id) => threads.has(id),
    get: (id) => threads.get(id)!,
    create: (p) => {
      made.push(p);
      const id = `b${made.length}`;
      threads.set(id, { id, title: p.title ?? '', cwd: p.cwd, permissionMode: p.permissionMode, status: 'running' });
      return { thread: { id } };
    },
    send: (id, text) => void sent.push({ id, text }),
    lastReply: (id) => threads.get(id)?.reply ?? '',
  };
  let table: { id: string; title: string; bears: string[]; maxTurns: number } | undefined;
  const m = new Mentions({ home, bears, host, tableOf: (cwd) => (cwd === '/table' ? table : undefined) });
  threads.set('w1', { id: 'w1', title: 'Launch plan', cwd: '/work', permissionMode: 'full', status: 'idle', projects: [{ id: 'p1' }] });
  return { bears, r, w, threads, sent, made, m, setTable: (t: typeof table) => (table = t) };
}

test('findMentions: @Name in any case and @bear:<id>, not emails or longer words', async () => {
  const bears = [{ id: 'researcher-1a2b', name: 'Researcher' }, { id: 'mom-1', name: 'Head Bear' }, { id: 'mo-1', name: 'Mo' }];
  assert.deepEqual(findMentions('hey @researcher, look', bears), ['researcher-1a2b']);
  assert.deepEqual(findMentions('ask @bear:researcher-1a2b please', bears), ['researcher-1a2b']);
  assert.deepEqual(findMentions('mail me@researcher.com or @Researchers', bears), []);
  assert.deepEqual(findMentions('(@Head Bear) and @Mo', bears), ['mom-1', 'mo-1']);
});

test("The user's mention starts the bear in its folder, in the lower mode, in the same projects", async () => {
  const s = await setup();
  const said = s.m.fromUser('w1', '@Researcher what changed in Convex 1.49?');
  assert.match(said ?? '', /^\[Threadbear: Asked Researcher in thread:b1\./);
  assert.equal(s.made[0].cwd, s.r.folder);
  assert.equal(s.made[0].permissionMode, 'ask', 'the bear is Ask, the thread Full: Ask');
  assert.deepEqual(s.made[0].projectIds, ['p1']);
  assert.equal(s.made[0].startedBy.label, 'Mentioned by Launch plan');
  assert.match(s.made[0].text, /thread:w1/);
  assert.equal(s.m.fromUser('w1', 'no mentions here'), undefined);
});

test('access never widens: a bear raised to Auto, asked from an Ask thread, runs in Ask', async () => {
  const s = await setup();
  s.bears.setAccess(s.r.id, { permissionMode: 'auto' });
  s.threads.set('w2', { id: 'w2', title: 'x', cwd: '/work', permissionMode: 'ask', status: 'idle' });
  s.m.ask({ fromThreadId: 'w2', bear: 'Researcher', text: 'hi', byUser: true });
  assert.equal(s.made[0].permissionMode, 'ask');
  s.threads.set('w3', { id: 'w3', title: 'y', cwd: '/work', permissionMode: 'full', status: 'idle' });
  s.m.ask({ fromThreadId: 'w3', bear: 'Writer', text: 'hi', byUser: true });
  s.bears.setAccess(s.w.id, { permissionMode: 'full' });
  assert.equal(s.made[1].permissionMode, 'ask');
});

test('at most three bears a message', async () => {
  const s = await setup();
  await s.bears.create({ name: 'Third', tidy: false });
  await s.bears.create({ name: 'Fourth', tidy: false });
  const said = s.m.fromUser('w1', '@Researcher @Writer @Third @Fourth go');
  assert.equal(s.made.length, 3);
  assert.match(said ?? '', /Only 3 bears are asked per message/);
});

test('an away bear gets the away line and no thread', async () => {
  const s = await setup();
  await s.bears.hibernate(s.r.id, '2026-11-16T09:00:00Z');
  const r = s.m.ask({ fromThreadId: 'w1', bear: 'Researcher', text: 'hi', byUser: true });
  assert.match(r.note ?? '', /Researcher is away until .* wakes it/);
  assert.equal(s.made.length, 0);
});

test("a bear's own thread can't mention itself, or another bear outside a table, unless it's the head bear", async () => {
  const s = await setup();
  s.threads.set('rt', { id: 'rt', title: 'R', cwd: s.r.folder, permissionMode: 'ask', status: 'idle' });
  assert.throws(() => s.m.ask({ fromThreadId: 'rt', bear: 'Researcher', text: 'hi' }), /doesn't mention itself/);
  assert.throws(() => s.m.ask({ fromThreadId: 'rt', bear: 'Writer', text: 'hi' }), /only through a table/);
  s.bears.setHead(s.r.id);
  assert.equal(s.m.ask({ fromThreadId: 'rt', bear: 'Writer', text: 'hi' }).bear, 'Writer');
});

test('at a table: only its bears, and at most maxTurns replies per message from the user', async () => {
  const s = await setup();
  s.threads.set('tt', { id: 'tt', title: 'Launch crew', cwd: '/table', permissionMode: 'auto', status: 'idle' });
  s.setTable({ id: 'pt', title: 'Launch crew', bears: [s.r.id, s.w.id], maxTurns: 2 });
  const outsider = await s.bears.create({ name: 'Outsider', tidy: false });
  assert.throws(() => s.m.ask({ fromThreadId: 'tt', bear: outsider.id, text: 'x' }), /isn't at the table/);
  s.m.ask({ fromThreadId: 'tt', bear: 'Researcher', text: 'one' });
  s.threads.get('b1')!.status = 'idle';
  s.m.ask({ fromThreadId: 'tt', bear: 'Writer', text: 'two' });
  assert.throws(() => s.m.ask({ fromThreadId: 'tt', bear: 'Writer', text: 'three' }), /2 bear replies since the user last wrote/);
  s.m.fromUser('tt', 'carry on');
  assert.doesNotThrow(() => s.m.ask({ fromThreadId: 'tt', bear: 'Researcher', text: 'four' }));
});

test("the bear's reply comes back quoted when its turn ends; a busy bear folds new asks into its thread", async () => {
  const s = await setup();
  s.m.ask({ fromThreadId: 'w1', bear: 'Researcher', text: 'first', byUser: true });
  s.threads.set('w4', { id: 'w4', title: 'Other', cwd: '/work', permissionMode: 'full', status: 'idle' });
  s.m.ask({ fromThreadId: 'w4', bear: 'Researcher', text: 'second', byUser: true });
  assert.equal(s.made.length, 1, 'one job at a time');
  assert.equal(s.sent[0].id, 'b1');
  s.threads.get('b1')!.reply = 'Convex 1.49 added X.\nAnd Y.';
  assert.equal(s.m.turnEnded('b1'), 2);
  const back = s.sent.filter((x) => x.id === 'w1' || x.id === 'w4');
  assert.equal(back.length, 2);
  assert.ok(back[0].text.startsWith(`${BEAR_REPLY_PREFIX}Researcher replied in thread:b1.`));
  assert.match(back[0].text, /> Convex 1.49 added X.\n> And Y./);
  assert.equal(s.m.turnEnded('b1'), 0, 'only once');
  assert.equal(s.m.turnEnded('w1'), 0, 'not a mention thread');
});
