// The public profile page's runner side (src/public-profile.ts): what it
// counts, what it leaves out, and when it sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeClock } from '../../src/clock.ts';
import { ACTIVITY_DAYS, PublicProfile, activityOf, localDay, numbersOf, readSettings } from '../../src/public-profile.ts';
import type { Project, ThreadSummary } from '../../src/protocol.ts';

const NOW = new Date(2026, 10, 8, 15, 0).getTime();
const log = { info() {}, warn() {}, error() {}, debug() {} } as never;

function thread(id: string, created: Date, extra: Partial<ThreadSummary> = {}): ThreadSummary {
  return { id, title: `Secret title ${id}`, cwd: '/Users/w/code', createdAt: created.toISOString(), provider: 'claude', ...extra } as ThreadSummary;
}
const day = (daysAgo: number, hour = 12) => new Date(2026, 10, 8 - daysAgo, hour);

function setup(opts: { threads?: ThreadSummary[]; projects?: Project[]; off?: string } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-profile-'));
  const sent: (Record<string, unknown> | undefined)[] = [];
  const uploads: number[] = [];
  const clock = new FakeClock(NOW);
  const backend = {
    offReason: () => opts.off,
    site: () => 'https://seal.convex.site',
    publishProfile: async (p: Record<string, unknown> | undefined) => void sent.push(p),
    uploadProfilePicture: async (bytes: Uint8Array) => (uploads.push(bytes.byteLength), `_storage:${uploads.length}`),
  };
  const p = new PublicProfile({
    home,
    backend: () => backend,
    threads: () => opts.threads ?? [],
    projects: () => opts.projects ?? [],
    isPrivate: (cwd) => cwd.startsWith('/Users/w/private'),
    clock,
    log,
  });
  return { p, sent, uploads, clock, home };
}

const settings = { published: true, name: 'Wayne', bio: '', links: [], show: ['activity', 'numbers'], numbers: ['threads', 'streak'], projectIds: [], order: ['numbers', 'activity', 'github', 'projects'] };

test('activity counts threads by the local day they started, over 53 weeks', () => {
  const a = activityOf([thread('a', day(0, 0)), thread('b', day(0, 23)), thread('c', day(2)), thread('old', day(400))], NOW);
  assert.equal(a.counts.length, ACTIVITY_DAYS);
  assert.equal(a.start, localDay(day(ACTIVITY_DAYS - 1).getTime()));
  assert.equal(a.counts.at(-1), 2);
  assert.equal(a.counts.at(-3), 1);
  assert.equal(a.counts.reduce((x, y) => x + y, 0), 3);
});

test('numbers: the year, active days, longest streak, live projects and models', () => {
  const threads = [thread('a', day(0), { model: 'claude-opus-5-5' }), thread('b', day(1), { model: 'claude-sonnet-5-5' }), thread('c', day(2)), thread('d', day(10), { model: 'claude-opus-5-5' })];
  const n = numbersOf(threads, [{ id: 'p', archived: false } as Project, { id: 'q', archived: true } as Project], activityOf(threads, NOW));
  assert.deepEqual(n, { threads: '4', activeDays: '4', streak: '3 days', projects: '1', models: '2' });
});

test('settings are checked: at most 4 links, only known parts, home only when published', () => {
  const s = readSettings({ ...settings, handle: 'from-an-older-app', show: ['activity', 'titles'], numbers: ['threads', 'secrets'] });
  assert.ok(!('handle' in s), 'no handle: a deployment is one person\'s');
  assert.deepEqual(s.show, ['activity']);
  assert.deepEqual(s.numbers, ['threads']);
  assert.equal(readSettings({ ...settings, home: true }).home, true);
  assert.equal(readSettings({ ...settings, published: false, home: true }).home, false);
  assert.throws(() => readSettings({ ...settings, home: 'yes' }));
  assert.throws(() => readSettings({ ...settings, links: Array.from({ length: 5 }, () => ({ title: 'x', url: 'https://x.example' })) }));
  assert.throws(() => readSettings({ ...settings, links: [{ title: 'x', url: 'javascript:alert(1)' }] }));
  assert.throws(() => readSettings({ ...settings, published: 'yes' }));
});

test('what goes to the backend: only parts turned on, never titles, folders or private threads', async () => {
  const s = setup({
    threads: [thread('a', day(0)), thread('b', day(0), { cwd: '/Users/w/private/x' })],
    projects: [{ id: 'p1', title: 'Threadbear', threadCount: 9, archived: false, goals: 'secret goals', icon: { symbol: 'book', by: 'librarian', updatedAt: '' } } as unknown as Project],
  });
  await s.p.update({ ...settings, projectIds: ['p1'], githubUser: 'waynesutton' });
  const row = s.sent[0]!;
  assert.deepEqual(row.order, ['numbers', 'activity']);
  assert.equal((row.activity as { counts: number[] }).counts.at(-1), 1, 'the private-folder thread is not counted');
  assert.deepEqual(row.numbers, [
    { key: 'threads', label: 'Threads this year', value: '1' },
    { key: 'streak', label: 'Longest streak', value: '1 day' },
  ]);
  assert.ok(!('github' in row) && !('projects' in row) && !('memberSince' in row) && !('pictureId' in row));
  const text = JSON.stringify(row);
  for (const secret of ['Secret title', '/Users/w', 'secret goals']) assert.ok(!text.includes(secret), secret);

  await s.p.update({ ...settings, show: ['projects', 'github', 'memberSince'], projectIds: ['p1', 'gone'], githubUser: 'waynesutton' });
  const two = s.sent[1]!;
  assert.deepEqual(two.order, ['github', 'projects']);
  assert.deepEqual(two.projects, [{ title: 'Threadbear', threads: 9, symbol: 'book' }]);
  assert.equal(two.github, 'waynesutton');
  assert.equal(two.memberSince, localDay(day(0).getTime()));
  assert.equal(s.p.status().url, 'https://seal.convex.site/profile');
  await s.p.update({ ...settings, home: true });
  assert.equal(s.sent.at(-1)!.home, true);
  assert.equal(s.p.status().url, 'https://seal.convex.site/');
});

test('a picture is uploaded once, and again only when the file changes', async () => {
  const s = setup();
  const pic = path.join(s.home, 'me.png');
  fs.writeFileSync(pic, 'png-bytes');
  await s.p.update({ ...settings, show: ['picture'], picturePath: pic });
  await s.p.update({ ...settings, show: ['picture'], picturePath: pic });
  assert.equal(s.uploads.length, 1);
  assert.equal(s.sent[1]!.pictureId, '_storage:1');
  fs.writeFileSync(pic, 'other-bytes');
  await s.p.update({ ...settings, show: ['picture'], picturePath: pic });
  assert.equal(s.uploads.length, 2);
  await s.p.update({ ...settings, show: [], picturePath: pic });
  assert.ok(!('pictureId' in s.sent[3]!), 'turned off, the picture is not named, so the backend deletes it');
});

// The backend as convex/profile.ts behaves: a send that leaves a picture out
// deletes its file, and naming a file that isn't there is refused.
function strictBackend() {
  const files = new Set<string>();
  let n = 0;
  const sent: Record<string, unknown>[] = [];
  return {
    files,
    sent,
    offReason: () => undefined,
    site: () => 'https://seal.convex.site',
    uploadProfilePicture: async () => {
      const id = `_storage:${++n}`;
      files.add(id);
      return id;
    },
    publishProfile: async (p: Record<string, unknown> | undefined) => {
      const named = [p?.pictureId, p?.backgroundId].filter((x): x is string => typeof x === 'string');
      if (named.some((id) => !files.has(id))) throw Object.assign(new Error('ConvexError: bad'), { data: { kind: 'badProfile', message: 'A picture it names was never uploaded.' } });
      for (const id of [...files]) if (!named.includes(id)) files.delete(id);
      sent.push(p!);
    },
  };
}

test('a picture turned off and on again is uploaded again, as the backend deleted it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-profile-'));
  const backend = strictBackend();
  const p = new PublicProfile({ home, backend: () => backend, threads: () => [], projects: () => [], isPrivate: () => false, clock: new FakeClock(NOW), log });
  const pic = path.join(home, 'me.png');
  fs.writeFileSync(pic, 'png-bytes');
  await p.update({ ...settings, show: ['picture'], picturePath: pic });
  await p.update({ ...settings, show: [], picturePath: pic });
  const back = await p.update({ ...settings, show: ['picture'], picturePath: pic });
  assert.equal(back.problem, undefined);
  assert.ok(backend.files.has(backend.sent.at(-1)!.pictureId as string));
});

test('a picture id the backend no longer has (saved by an older runner) is uploaded again', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-profile-'));
  const pic = path.join(home, 'me.png');
  fs.writeFileSync(pic, 'png-bytes');
  const hash = (await import('node:crypto')).createHash('sha256').update('png-bytes').digest('hex');
  fs.writeFileSync(path.join(home, 'profile.json'), JSON.stringify({ files: { picture: { hash, storageId: '_storage:gone' } } }));
  const backend = strictBackend();
  const p = new PublicProfile({ home, backend: () => backend, threads: () => [], projects: () => [], isPrivate: () => false, clock: new FakeClock(NOW), log });
  const st = await p.update({ ...settings, show: ['picture'], picturePath: pic });
  assert.equal(st.problem, undefined);
  assert.equal(backend.sent.at(-1)!.pictureId, '_storage:1');
});

test('the hourly resend goes only when the row has changed', async () => {
  const threads = [thread('a', day(0))];
  const s = setup({ threads });
  await s.p.update(settings);
  s.p.start();
  await s.clock.advance(5_000);
  await new Promise((r) => setImmediate(r));
  assert.equal(s.sent.length, 1, 'nothing new, nothing sent');
  threads.push(thread('b', day(0)));
  await s.clock.advance(60 * 60 * 1000);
  await new Promise((r) => setImmediate(r));
  assert.equal(s.sent.length, 2);
  s.p.stop();
});

test('settings survive a restart; remove takes the page down and forgets them', async () => {
  const s = setup();
  await s.p.update(settings);
  const again = new PublicProfile({ home: s.home, backend: () => undefined, threads: () => [], projects: () => [], isPrivate: () => false, clock: s.clock, log });
  assert.equal(again.status().profile?.name, 'Wayne');
  await s.p.remove();
  assert.equal(s.sent.at(-1), undefined);
  assert.equal(s.p.status().profile, null);
});

test('settings an older runner saved, with a handle and no home, load in today\'s shape', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-profile-'));
  fs.writeFileSync(path.join(home, 'profile.json'), JSON.stringify({ settings: { ...settings, handle: 'wayne' } }));
  const p = new PublicProfile({ home, backend: () => undefined, threads: () => [], projects: () => [], isPrivate: () => false, clock: new FakeClock(NOW), log });
  const loaded = p.status().profile!;
  assert.ok(!('handle' in loaded));
  assert.equal(loaded.home, false);
  assert.equal(loaded.name, 'Wayne');
});

test('with no backend, update says why rather than saving quietly', async () => {
  const s = setup({ off: 'no sync.url' });
  await assert.rejects(s.p.update(settings), /isn't connected/);
  assert.equal(s.sent.length, 0);
});
