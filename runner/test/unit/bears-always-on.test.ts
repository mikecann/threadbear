// Real runner lifecycle with fake model sessions: arrivals from all three
// sources share one worker, but each mention receives its own turn's reply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeHarness } from '../helpers/fakes.ts';
import { Bears, bearsMethods } from '../../src/bears.ts';
import { CallerGate } from '../../src/rpc-gate.ts';
import { Mentions } from '../../src/mentions.ts';
import { Scheduler } from '../../src/schedules.ts';
import { HookRegistry, webhookCommands } from '../../src/webhooks.ts';
import { nullLogger } from '../../src/log.ts';

test('a sandboxed caller cannot fold a mention into an unconfined unattended worker', async () => {
  const h = makeHarness();
  const bears = new Bears({ root: path.join(h.home, 'Bears'), home: h.home, git: false, threads: () => ({ list: () => h.runner.list(), archive: () => {} }) });
  const b = await bears.create({ name: 'Worker', tidy: false });
  const caller = h.runner.create({ text: 'Ask', permissionMode: 'ask' }).thread;
  h.runner.threads.get(caller.id)!.rec.confined = true;
  const worker = h.runner.create({ text: 'Routine', permissionMode: 'ask', cwd: b.folder, origin: 'schedule', scheduleId: 'routine' }).thread;
  const mentions = new Mentions({ home: h.home, bears, host: {
    authorityOf: (id) => h.runner.authorityNow(id), has: (id) => h.runner.has(id), get: (id) => h.runner.get(id), create: (p) => h.runner.create(p),
    send: (id, text) => h.runner.send(id, text, [], { origin: 'runner', queue: true }), lastReply: () => '',
  } });
  const gate = new CallerGate({ runner: h.runner });
  assert.throws(() => gate.check(caller.id, 'threads.send', { threadId: worker.id, text: 'Escape' }), /needs the user's OK/);
  const methods = bearsMethods({ bears, on: () => true, cwdOf: (id) => h.runner.get(id).cwd, mention: (p) => mentions.ask(p) });
  const params = gate.check(caller.id, 'bears.mention', { bear: b.id, text: 'Escape' });
  assert.throws(() => methods['bears.mention'](params), /sandbox|access/);
  assert.equal(h.runner.threads.get(worker.id)!.rec.queue.length, 0);
  assert.equal(h.runner.list().length, 2);
});

test('routine, webhook and mentions share a worker and replies match their queued turns', async () => {
  const h = makeHarness();
  const bears = new Bears({ root: path.join(h.home, 'Bears'), home: h.home, git: false, threads: () => ({ list: () => h.runner.list().map((t) => ({ ...t, queued: Boolean(h.runner.threads.get(t.id)?.rec.queue.length) })), archive: () => {} }) });
  const b = await bears.create({ name: 'Worker', tidy: false });
  const scheduler = new Scheduler({ runner: h.runner, home: h.home, clock: h.clock, log: nullLogger });
  scheduler.foldInto = () => bears.busyUnattended(b.id)?.id;
  const asker = h.runner.create({ text: 'Ask', permissionMode: 'ask' }).thread;
  h.adapter.last.init();
  h.adapter.last.result('completed');
  const replies: string[] = [];
  const mentions = new Mentions({ home: h.home, bears, host: {
    authorityOf: (id) => h.runner.authorityNow(id), has: (id) => h.runner.has(id), get: (id) => h.runner.get(id), create: (p) => h.runner.create(p),
    send: (id, text) => {
      if (id === asker.id) { replies.push(text); return; }
      return h.runner.send(id, text, [], { origin: 'runner', queue: true });
    },
    lastReply: (id) => h.events(id).filter((e) => e.type === 'assistant.text').at(-1)?.text ?? '',
  } });
  h.runner.onThreadActivity((a) => {
    if (a.kind === 'turn.end') mentions.turnEnded(a.threadId, h.runner.threads.get(a.threadId)?.rec.turnId);
  });
  const routine = await scheduler.create({ text: 'Routine', cwd: b.folder, cron: '0 9 * * *', permissionMode: 'ask' });
  const run = await scheduler.runNow(routine.id);
  const worker = run.threadId!;
  const s = h.adapter.last;
  s.init();
  mentions.ask({ fromThreadId: asker.id, bear: b.id, text: 'First question' });
  const registry = new HookRegistry(h.home);
  registry.add('hook', { kind: 'folder', cwd: b.folder, permissionMode: 'ask' });
  const hooks = webhookCommands({ on: () => true, home: h.home, registry, create: (p) => h.runner.create(p), send: (id, text) => h.runner.send(id, text, [], { origin: 'runner', queue: true }), modeOf: (id) => h.runner.get(id).permissionMode, foldInto: () => bears.busyUnattended(b.id)?.id });
  hooks.webhookRun({ hookId: 'hook', name: 'Test' }, 'create', undefined, { cwd: b.folder, payloads: [{ body: 'Hook job' }] });
  mentions.ask({ fromThreadId: asker.id, bear: b.id, text: 'Second question' });
  assert.equal(h.runner.list().length, 2, 'one asker, one worker');
  assert.equal(h.runner.threads.get(worker)!.rec.queue.length, 3);
  for (const reply of ['Routine report', 'First answer', 'Webhook report', 'Second answer']) {
    s.text(`reply-${reply}`, reply);
    s.result('completed');
  }
  assert.equal(replies.length, 2);
  assert.match(replies[0], /First answer/);
  assert.match(replies[1], /Second answer/);
  assert.ok(replies.every((r) => !r.includes('Routine report') && !r.includes('Webhook report')));
  scheduler.stop();
});
