import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, tmpDir, tick } from '../helpers/fakes.ts';

function setup(on = true) {
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ experiments: { lateAnswers: on } }));
  const h = makeHarness(home);
  const t = h.runner.create({ text: 'Make a note', accountId: 'claude-main', permissionMode: 'ask' }).thread;
  const s = h.adapter.last;
  s.init();
  const answer = s.sink.requestApproval({ toolUseId: 'call1', name: 'Bash', title: 'Print a greeting', input: { command: 'printf hello' }, canAlwaysAllow: true, signal: new AbortController().signal });
  const id = h.events(t.id).find((e) => e.type === 'approval.requested')!.approvalId as string;
  s.result('completed');
  return { h, t, s, id, answer };
}

for (const restart of [false, true]) test(`a partial late-answer start retries its original message (${restart ? 'restart' : 'same runner'})`, async () => {
  const { h, t, id } = setup();
  const log = h.store.log(t.id);
  const append = log.append.bind(log);
  log.append = (event) => {
    if (event.type === 'turn.started') throw new Error('disk full');
    append(event);
  };
  try {
    assert.throws(() => h.runner.respondApproval({ threadId: t.id, approvalId: id, decision: 'allow', message: 'Proceed once' }), /disk full/);
  } finally { log.append = append; }
  assert.equal(h.runner.threads.get(t.id)!.rt.turn, undefined);
  assert.equal(h.runner.threads.get(t.id)!.rec.queue.length, 0);
  const next = restart ? h.restart() : h;
  next.runner.respondApproval({ threadId: t.id, approvalId: id, decision: 'allow', message: 'Proceed once' });
  await tick(8);
  const events = next.store.log(t.id).read(1, next.store.log(t.id).lastSeq);
  const messages = events.filter((e) => e.type === 'user.message' && e.text.includes('answered an expired tool card'));
  assert.equal(messages.length, 1, 'reuse the logged message');
  assert.equal(events.filter((e) => e.type === 'turn.started' && e.turnId === messages[0].turnId).length, 1, 'start the turn on retry');
  assert.equal(next.runner.threads.get(t.id)!.rt.turn?.turnId, messages[0].turnId);
  assert.match(next.adapter.last.sent.at(-1)?.text ?? '', /Proceed once/);
});

for (const decision of ['allow', 'deny', 'allowAlways'] as const) test(`late ${decision} resumes exactly once without replay or mode changes`, async () => {
  const { h, t, id, answer } = setup();
  assert.equal((await answer).decision, 'expired');
  h.runner.respondApproval({ threadId: t.id, approvalId: id, decision });
  const message = h.events(t.id).filter((e) => e.type === 'user.message').at(-1)!;
  assert.match(message.text, /answered an expired tool card/);
  assert.match(message.text, /printf hello/);
  assert.match(message.text, decision === 'deny' ? /Do not carry out/ : /allowed this request once/);
  assert.equal(message.origin, 'runner');
  assert.equal(h.runner.get(t.id).permissionMode, 'ask');
  assert.throws(() => h.runner.respondApproval({ threadId: t.id, approvalId: id, decision }), /no longer pending/);
  assert.equal(h.events(t.id).filter((e) => e.type === 'tool.call').length, 0);
});

test('late answers reject disabled, unknown, old and invalid cards', () => {
  const off = setup(false);
  assert.throws(() => off.h.runner.respondApproval({ threadId: off.t.id, approvalId: off.id, decision: 'allow' }), /no longer pending/);
  const { h, t, id } = setup();
  assert.throws(() => h.runner.respondApproval({ threadId: t.id, approvalId: 'unknown', decision: 'allow' }), /no longer pending/);
  assert.throws(() => h.runner.respondApproval({ threadId: t.id, approvalId: id, decision: 'answered' }), /no longer pending/);
  h.clock.advance(86_400_001);
  assert.throws(() => h.runner.respondApproval({ threadId: t.id, approvalId: id, decision: 'allow' }), /no longer pending/);
});

test('a rewound request and non-tool cards cannot be revived as tools', () => {
  const { h, t, id } = setup();
  const st = h.runner.threads.get(t.id)!;
  const card = h.events(t.id).find((e) => e.type === 'approval.requested')!;
  st.rec.rewinds = [{ from: card.seq, to: card.seq }];
  assert.throws(() => h.runner.respondApproval({ threadId: t.id, approvalId: id, decision: 'allow' }), /no longer pending/);
  for (const type of ['question.requested', 'secret.requested'] as const) {
    const approvalId = type;
    if (type === 'question.requested') h.runner.emit(st, { type, approvalId, questions: [] });
    else h.runner.emit(st, { type, approvalId, label: 'Key', reason: 'Test' });
    h.runner.emit(st, { type: 'approval.resolved', approvalId, decision: 'expired' });
    assert.throws(() => h.runner.respondApproval({ threadId: t.id, approvalId, decision: 'allow' }), /no longer pending/);
  }
});

test('a failed send is retryable and a failed resolution cannot duplicate a queued message', () => {
  const { h, t, id } = setup();
  const send = h.runner.send.bind(h.runner);
  h.runner.send = () => { throw new Error('handover'); };
  assert.throws(() => h.runner.respondApproval({ threadId: t.id, approvalId: id, decision: 'allow' }), /handover/);
  h.runner.send = send;
  h.runner.send(t.id, 'Another job');
  const emit = h.runner.emit.bind(h.runner);
  h.runner.emit = (st, body, turn) => {
    if (body.type === 'approval.resolved' && body.approvalId === id) throw new Error('disk unavailable');
    return emit(st, body, turn);
  };
  assert.throws(() => h.runner.respondApproval({ threadId: t.id, approvalId: id, decision: 'allow' }), /disk unavailable/);
  h.runner.emit = emit;
  h.runner.respondApproval({ threadId: t.id, approvalId: id, decision: 'allow' });
  assert.equal(h.runner.threads.get(t.id)!.rec.queue.length, 1);
});

test('the queued answer is persisted before the card closes, even with a deferred save', () => {
  const { h, t, id } = setup();
  h.runner.send(t.id, 'Another job');
  h.runner.defer = () => {};
  h.runner.respondApproval({ threadId: t.id, approvalId: id, decision: 'allow' });
  const disk = JSON.parse(fs.readFileSync(path.join(h.home, 'threads', t.id, 'thread.json'), 'utf8'));
  assert.equal(disk.queue.length, 1);
  assert.match(disk.queue[0].text, /allowed this request once/);
});

test('late answer survives restart and does not decide a different pending card', async () => {
  const { h, t, id } = setup();
  h.runner.flush();
  const next = h.restart();
  next.runner.send(t.id, 'Another job');
  const s = next.adapter.last;
  s.init();
  void s.sink.requestApproval({ toolUseId: 'call2', name: 'Bash', title: 'Second request', input: { command: 'pwd' }, canAlwaysAllow: false, signal: new AbortController().signal });
  const st = next.runner.threads.get(t.id)!;
  const other = [...st.rt.approvals.keys()][0];
  next.runner.respondApproval({ threadId: t.id, approvalId: id, decision: 'allow' });
  assert.ok(st.rt.approvals.has(other));
  assert.equal(st.rec.queue.length, 1);
});

test('a late remote allow cannot approve a card whose contents it cannot show', () => {
  const { h, t } = setup();
  h.runner.send(t.id, 'Write a file');
  const s = h.adapter.last;
  s.init();
  void s.sink.requestApproval({ toolUseId: 'write', name: 'Write', title: 'Write build.sh', input: { file_path: '/tmp/build.sh', content: 'exit 1' }, canAlwaysAllow: false, signal: new AbortController().signal });
  const id = [...h.runner.threads.get(t.id)!.rt.approvals.keys()][0];
  s.result('completed');
  assert.throws(() => h.runner.respondApproval({ threadId: t.id, approvalId: id, decision: 'allow', remote: true }), /Deny still works/);
  h.runner.respondApproval({ threadId: t.id, approvalId: id, decision: 'deny', remote: true });
});
