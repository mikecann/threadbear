// The public profile page's backend (convex/profile.ts) against an
// in-memory database: only the owner key writes it, a page that isn't
// published is no one's but Mike's, and nothing outside the row's shape
// (a thread title, a folder) can be kept or read back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, outcome } from '../helpers/convex-memory.ts';

const OWNER = 'owner-key';
const BRUCE_KEY = 'bruce-key';
const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const profile = load('profile');
const sync = load('sync');

const base = { handle: 'wayne', published: true, name: 'Wayne Sutton', bio: 'Builds with agents', links: [{ title: 'GitHub', url: 'https://github.com/waynesutton' }], order: ['numbers', 'activity'] };

async function setup() {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  const b = memoryBackend();
  await b.ctx.db.insert('runnerKeys', { runnerId: 'bruce', keyHash: await sha256(BRUCE_KEY), name: 'bruce', createdAt: 1 });
  const publish = (p: Record<string, unknown> | undefined, key = OWNER) => call(b.ctx, profile.publish, { key, ...(p ? { profile: p } : {}) });
  const view = (handle: string, token?: string) => call(b.ctx, profile.view, { handle, ...(token ? { token } : {}) });
  return { b, publish, view };
}

test('the owner publishes the page and anyone reads it by handle, in any case', async () => {
  const s = await setup();
  await s.publish({ ...base, numbers: [{ key: 'threads', label: 'Threads this year', value: '12' }], activity: { start: '2026-01-01', counts: [0, 2, 1] } });
  const page = await s.view('@Wayne');
  assert.equal(page.name, 'Wayne Sutton');
  assert.equal(page.preview, false);
  assert.deepEqual(page.activity.counts, [0, 2, 1]);
  assert.equal(page.links[0].url, 'https://github.com/waynesutton');
  assert.equal(await s.view('someone-else'), null);
  assert.equal(s.b.rows('profile').length, 1);
});

test('a runner key can neither write the page nor get an upload address for it', async () => {
  const s = await setup();
  assert.equal(await outcome(s.publish(base, BRUCE_KEY)), 'forbidden');
  assert.equal(await outcome(call(s.b.ctx, profile.uploadUrl, { key: BRUCE_KEY })), 'forbidden');
  assert.equal(await outcome(s.publish(base, 'not-a-key')), 'auth');
  assert.equal(s.b.rows('profile').length, 0);
});

test('a page that is not published is gone to strangers and a preview for Mike', async () => {
  const s = await setup();
  await s.publish({ ...base, published: false });
  assert.equal(await s.view('wayne'), null);
  assert.equal(await s.view('wayne', 'made-up-token'), null);
  const { token } = await call(s.b.ctx, sync.issueToken, { key: OWNER, kind: 'phone', name: 'browser' });
  const page = await s.view('wayne', token);
  assert.equal(page.preview, true);
  assert.equal(await call(s.b.ctx, profile.card, { handle: 'wayne' }), null);
});

test('fields outside the shape are dropped, strings are cut and lists capped', async () => {
  const s = await setup();
  await s.publish({ ...base, name: 'x'.repeat(500), order: ['numbers', 'threadTitles', 'numbers'], projects: Array.from({ length: 30 }, (_, i) => ({ title: `P${i}`, threads: 3 })) });
  const [row] = s.b.rows('profile');
  assert.equal(row.name.length, 60);
  assert.deepEqual(row.order, ['numbers']);
  assert.equal(row.projects.length, 12);
  assert.ok(!('threadTitles' in row));
});

test('bad handles, links and GitHub names are refused', async () => {
  const s = await setup();
  for (const handle of ['ab', '-wayne', 'way--ne', 'way ne', 'wayne!', 'w'.repeat(31)]) assert.equal(await outcome(s.publish({ ...base, handle })), 'badProfile', handle);
  assert.equal(await outcome(s.publish({ ...base, links: [{ title: 'x', url: 'javascript:alert(1)' }] })), 'badProfile');
  assert.equal(await outcome(s.publish({ ...base, links: Array.from({ length: 5 }, () => ({ title: 'x', url: 'https://a.example' })) })), 'badProfile');
  assert.equal(await outcome(s.publish({ ...base, github: 'not a name' })), 'badProfile');
  assert.equal(await outcome(s.publish({ ...base, activity: { start: 'yesterday', counts: [] } })), 'badProfile');
});

test('a replaced picture is deleted, and unpublishing for good takes the row and its pictures', async () => {
  const s = await setup();
  const one = s.b.file('_storage:one');
  const two = s.b.file('_storage:two');
  const bg = s.b.file('_storage:bg');
  await s.publish({ ...base, pictureId: one, backgroundId: bg, backgroundDim: 4 });
  assert.equal((await s.view('wayne')).picture, 'https://files.example/_storage:one');
  assert.equal(s.b.rows('profile')[0].backgroundDim, 0.95);
  await s.publish({ ...base, pictureId: two, backgroundId: bg });
  assert.deepEqual(s.b.deleted, ['_storage:one']);
  await s.publish(undefined);
  assert.equal(s.b.rows('profile').length, 0);
  assert.deepEqual(s.b.deleted.sort(), ['_storage:bg', '_storage:one', '_storage:two']);
  assert.equal(await outcome(s.publish({ ...base, pictureId: '_storage:never' })), 'badProfile');
});

test('the link preview card has the name, bio and picture of a published page', async () => {
  const s = await setup();
  const pic = s.b.file('_storage:pic');
  await s.publish({ ...base, pictureId: pic });
  assert.deepEqual(await call(s.b.ctx, profile.card, { handle: 'WAYNE' }), { title: 'Wayne Sutton', description: 'Builds with agents', image: 'https://files.example/_storage:pic' });
});
