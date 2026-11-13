// Bear notes (experiment bearNotes): the librarian's end-of-turn look may
// carry one cheer or idea from an opted-in bear, shown in its Highlights
// line. None on a thread waiting on the user, none from a bear it wasn't
// shown, none of a kind the bear doesn't leave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, tmpDir } from '../helpers/fakes.ts';
import { Projects } from '../../src/projects.ts';
import { BEAR_NOTE_MAX, bearNoteLines, Librarian, pickBearNote, type NoteBear } from '../../src/librarian.ts';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';

const R: NoteBear = { id: 'researcher-1a2b', name: 'Researcher', does: 'Finds sources', personality: 'dry and calm', notes: 'both' };
const C: NoteBear = { id: 'cheery-0000', name: 'Cheery', notes: 'cheers' };

test('pickBearNote: only a shown bear, a kind it leaves, one line of at most 120 characters', () => {
  assert.equal(pickBearNote(null, [R]), undefined);
  assert.equal(pickBearNote({ bear: 'someone-else', kind: 'cheer', text: 'hi' }, [R]), undefined);
  assert.equal(pickBearNote({ bear: R.id, kind: 'rant', text: 'hi' }, [R]), undefined);
  assert.equal(pickBearNote({ bear: C.id, kind: 'idea', text: 'add a test' }, [C]), undefined, 'cheers only');
  const n = pickBearNote({ bear: R.id, kind: 'idea', text: `Idea:\nadd a test for the 429 path ${'x'.repeat(200)}` }, [R]);
  assert.equal(n?.kind, 'idea');
  assert.ok(!n!.text.includes('\n'));
  assert.equal(n!.text.length, BEAR_NOTE_MAX);
});

test('the prompt names the bears and the rule only when there are some', () => {
  const lines = bearNoteLines([R, C]).join('\n');
  assert.match(lines, /researcher-1a2b "Researcher", Finds sources; personality: dry and calm; may leave a cheer or an idea/);
  assert.match(lines, /"Cheery"; may leave a cheer/);
  assert.match(lines, /Usually null/);
});

function setup(bears: NoteBear[]) {
  const home = tmpDir();
  const projects = new Projects({ home, clock: new FakeClock(), log: nullLogger });
  const h = makeHarness(home, {}, { projects });
  projects.start(h.runner);
  const briefs: string[] = [];
  const host = new Proxy(h.runner, { get: (t, k) => (k === 'setBrief' ? (_id: string, text: string) => void briefs.push(text) : (t as never)[k]) });
  const lib = new Librarian({ host: host as never, projects, clock: new FakeClock(), log: nullLogger, home });
  lib.bearNotes = () => bears;
  const { thread } = h.runner.create({ text: 'ship it', cwd: tmpDir() });
  const rec = () => h.store.load(thread.id)!;
  const job = { threadId: thread.id, reason: 'turn-end', why: '', dueAtMs: 0 };
  const run = (answer: Record<string, unknown>, r = rec()) => {
    const any = lib as unknown as { prompt: (r: unknown, j: unknown) => string; apply: (j: unknown, r: unknown, a: unknown) => void };
    const prompt = any.prompt(r, job);
    any.apply(job, r, answer);
    return prompt;
  };
  return { run, briefs, rec };
}

test('a cheer joins the librarian line; with no note, the line is as it was', () => {
  const s = setup([R]);
  const prompt = s.run({ thread: '- Tests pass and it is pushed.', bearNote: { bear: R.id, kind: 'cheer', text: 'Nice, tests pass and it is pushed.' } });
  assert.match(prompt, /Bears who may leave one short note/);
  assert.equal(s.briefs[0], '- Tests pass and it is pushed.\n- Researcher: Nice, tests pass and it is pushed.');
  s.run({ thread: '- Next step booked.', bearNote: null });
  assert.equal(s.briefs[1], '- Next step booked.');
  s.run({ thread: '- More.', bearNote: { bear: R.id, kind: 'idea', text: 'Add a test for the 429 path.' } });
  assert.equal(s.briefs[2], '- More.\n- Researcher has an idea: Add a test for the 429 path.');
});

test("no bears shown, and no note taken, on a thread that's waiting on the user or with none opted in", () => {
  const s = setup([R]);
  const r = s.rec();
  r.needs = { seq: 1, needs: 'you' };
  const prompt = s.run({ thread: '- Waiting on you.', bearNote: { bear: R.id, kind: 'cheer', text: 'Yay' } }, r);
  assert.ok(!prompt.includes('Bears who may leave'));
  assert.equal(s.briefs[0], '- Waiting on you.');
  const none = setup([]);
  assert.ok(!none.run({ thread: '- x' }).includes('Bears who may leave'));
});
