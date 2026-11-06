// Plan and Ask modes (modes.ts): read-only turns, and a plan saved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, tick, tmpDir } from '../helpers/fakes.ts';
import { planPath } from '../../src/modes.ts';

function reply(h: ReturnType<typeof makeHarness>, text: string) {
  const s = h.adapter.last;
  s.init();
  s.out({ kind: 'event', event: { type: 'assistant.text', itemId: `a${Math.random()}`, text } as never });
  s.result('completed');
}

test('a Plan mode message: read-only, told what Plan mode is, and its reply saved as the plan and pinned', async () => {
  const cwd = tmpDir();
  const h = makeHarness();
  const { thread } = h.runner.create({ text: 'How should we add billing?', cwd, accountId: 'claude-3', mode: 'plan' });
  await tick();
  const sent = h.adapter.last.sent.at(-1)!;
  assert.equal(sent.readOnly, true);
  assert.match(sent.text, /^\[Plan mode\][\s\S]*\n\nHow should we add billing\?$/);
  assert.equal(h.events(thread.id).find((e) => e.type === 'user.message')?.mode, 'plan');
  reply(h, '## Goal\n\nAdd Stripe.\n\n## Steps\n\n1. Install');
  await tick();
  const plans = fs.readdirSync(path.join(cwd, 'plans'));
  assert.equal(plans.length, 1);
  assert.match(plans[0], /^\d{4}-\d{2}-\d{2}-.+\.md$/);
  const doc = fs.readFileSync(path.join(cwd, 'plans', plans[0]), 'utf8');
  assert.match(doc, /^# Plan: /);
  assert.match(doc, /## Goal\n\nAdd Stripe\./);
  assert.ok(h.events(thread.id).some((e) => e.type === 'system.note' && /Saved the plan to plans\//.test(e.text)));
  assert.ok(h.runner.highlights(thread.id).highlights.some((i) => i.path?.includes(`plans/${plans[0]}`)));
  // The next message without a mode is an ordinary turn again.
  h.runner.send(thread.id, 'Go ahead');
  await tick();
  assert.equal(h.adapter.last.sent.at(-1)!.readOnly, undefined);
  assert.equal(h.adapter.last.sent.at(-1)!.text, 'Go ahead');
});

test('an Ask mode message is read-only and saves nothing', async () => {
  const cwd = tmpDir();
  const h = makeHarness();
  h.runner.create({ text: 'What does this repo do?', cwd, accountId: 'claude-3', mode: 'ask' });
  await tick();
  const sent = h.adapter.last.sent.at(-1)!;
  assert.equal(sent.readOnly, true);
  assert.match(sent.text, /^\[Ask mode\]/);
  reply(h, 'It is a podcast player.');
  await tick();
  assert.equal(fs.existsSync(path.join(cwd, 'plans')), false);
});

test('plan files are named for the day and project, and never overwrite', () => {
  const cwd = tmpDir();
  const day = new Date('2026-11-06T10:00:00Z');
  const first = planPath(cwd, 'Hello App!', day);
  assert.equal(path.basename(first), '2026-11-06-hello-app.md');
  fs.mkdirSync(path.dirname(first), { recursive: true });
  fs.writeFileSync(first, 'x');
  assert.equal(path.basename(planPath(cwd, 'Hello App!', day)), '2026-11-06-hello-app-2.md');
});

