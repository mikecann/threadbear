// Webhooks: the backend's side (convex/webhooks.ts, convex/hookHttp.ts)
// against an in-memory database. Hash lookup, 404, 413, 403, 429, dedupe,
// scrub, batching and revoke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, outcome } from '../helpers/convex-memory.ts';

const OWNER = 'owner-key';
const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const hooks = load('webhooks');
const http = load('hookHttp');

// The real clock: issueWebhook stamps a hook's expiry with Date.now(), so a
// fixed date here turns the expiry test into one that fails a day later.
const NOW = Date.now();

async function setup(batchSeconds = 0) {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  const b = memoryBackend();
  const issue = (over: Record<string, unknown> = {}) =>
    call(b.ctx, hooks.issueWebhook, { key: OWNER, name: 'GitHub', runnerId: 'm5', target: { kind: 'folder', cwd: '/Users/w/ThreadbearThreads/Bears/r-1a2b', permissionMode: 'ask' }, batchSeconds, ...over });
  const post = async (path: string, body: string, o: { headers?: Record<string, string>; ip?: string; now?: number; method?: string } = {}) => {
    const h = Object.fromEntries(Object.entries(o.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const out = await http.handleHook({ method: o.method ?? 'POST', path, header: (n: string) => h[n.toLowerCase()] ?? null, body }, (a: { hash: string; body: string; contentType: string; dedupe?: string }) =>
      call(b.ctx, hooks.deliver, { hash: a.hash, ip: o.ip ?? '203.0.113.7', now: o.now ?? NOW, body: a.body, contentType: a.contentType, ...(a.dedupe ? { dedupe: a.dedupe } : {}) }),
    );
    return { status: out.status, headers: out.headers, json: JSON.parse(out.body) };
  };
  const pathOf = (secret: string) => `/hook/${secret}`;
  const commands = () => b.rows('commands');
  return { ...b, issue, post, pathOf, commands };
}

test('a hook key is shown once and stored only as its hash', async () => {
  const s = await setup();
  const { secret, hook } = await s.issue();
  assert.match(secret, /^tbh_[0-9a-f]{64}$/);
  const rows = s.rows('webhooks');
  assert.equal(rows[0]!.hash, await sha256(secret));
  assert.ok(!JSON.stringify(rows).includes(secret));
  assert.equal(hook.name, 'GitHub');
  assert.equal((await call(s.ctx, hooks.listWebhooks, { key: OWNER })).length, 1);
});

test('only the main Mac key issues, lists or revokes hooks', async () => {
  const s = await setup();
  assert.equal(await outcome(s.issue({ key: 'nope' })), 'auth');
  assert.equal(await outcome(call(s.ctx, hooks.listWebhooks, { key: 'nope' })), 'auth');
  assert.equal(await outcome(call(s.ctx, hooks.revokeWebhook, { key: 'nope' })), 'auth');
  assert.equal(await outcome(s.issue({ batchSeconds: 9999 })), 'badArgs');
});

test('a delivery queues one create in the folder, scrubbed, in the mode the hook says', async () => {
  const s = await setup();
  const { secret } = await s.issue();
  const r = await s.post(s.pathOf(secret), '{"hello":1,"token":"ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}', { headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 202);
  const cmds = s.commands();
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0]!.kind, 'create');
  assert.equal(cmds[0]!.runnerId, 'm5');
  assert.equal(cmds[0]!.args.permissionMode, 'ask');
  assert.equal(cmds[0]!.args.cwd, '/Users/w/ThreadbearThreads/Bears/r-1a2b');
  assert.equal(cmds[0]!.args.webhook.name, 'GitHub');
  const body = cmds[0]!.args.payloads[0].body as string;
  assert.ok(body.includes('"hello":1'));
  assert.ok(!body.includes('ghp_aaaaaaaa'), 'secrets scrubbed');
  assert.equal(s.rows('webhookCalls')[0]!.payload, undefined, 'the words are not kept once sent');
});

test('a thread target queues a send to that thread', async () => {
  const s = await setup();
  const { secret } = await s.issue({ target: { kind: 'thread', threadId: 'th-1' } });
  assert.equal((await s.post(s.pathOf(secret), 'plain text')).status, 202);
  assert.equal(s.commands()[0]!.kind, 'send');
  assert.equal(s.commands()[0]!.threadId, 'th-1');
});

test('unknown, malformed, revoked and expired keys all get the same 404', async () => {
  const s = await setup();
  const { secret, hook } = await s.issue({ days: 1 });
  assert.equal((await s.post(`/hook/tbh_${'0'.repeat(64)}`, '{}')).status, 404);
  assert.equal((await s.post('/hook/nonsense', '{}')).status, 404);
  assert.equal((await s.post(s.pathOf(secret), '{}', { now: NOW + 2 * 86_400_000 })).status, 404, 'expired');
  assert.equal(await call(s.ctx, hooks.revokeWebhook, { key: OWNER, id: hook.id }), 1);
  assert.equal((await s.post(s.pathOf(secret), '{}')).status, 404, 'revoked');
});

test('browsers get 403, too big 413, and only POST', async () => {
  const s = await setup();
  const { secret } = await s.issue();
  assert.equal((await s.post(s.pathOf(secret), '{}', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await s.post(s.pathOf(secret), 'x'.repeat(64 * 1024 + 1))).status, 413);
  assert.equal((await s.post(s.pathOf(secret), '{}', { method: 'GET' })).status, 405);
  assert.equal(s.commands().length, 0);
});

test('a repeat Idempotency-Key or X-GitHub-Delivery within a day is dropped', async () => {
  const s = await setup();
  const { secret } = await s.issue();
  assert.equal((await s.post(s.pathOf(secret), '{}', { headers: { 'Idempotency-Key': 'abc' } })).status, 202);
  const again = await s.post(s.pathOf(secret), '{}', { headers: { 'Idempotency-Key': 'abc' }, now: NOW + 1000 });
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicate, true);
  assert.equal((await s.post(s.pathOf(secret), '{}', { headers: { 'X-GitHub-Delivery': 'g1' } })).status, 202);
  assert.equal((await s.post(s.pathOf(secret), '{}', { headers: { 'X-GitHub-Delivery': 'g1' } })).status, 200);
  assert.equal((await s.post(s.pathOf(secret), '{}', { headers: { 'Idempotency-Key': 'abc' }, now: NOW + 2 * 86_400_000 })).status, 202, 'a day later it counts again');
  assert.equal(s.commands().length, 3);
});

test('limits: 30 a minute per hook, then 429 with Retry-After', async () => {
  const s = await setup();
  const { secret } = await s.issue();
  for (let i = 0; i < 30; i++) assert.equal((await s.post(s.pathOf(secret), `{"i":${i}}`, { now: NOW + i })).status, 202);
  const r = await s.post(s.pathOf(secret), '{}', { now: NOW + 31 });
  assert.equal(r.status, 429);
  assert.equal(r.headers['Retry-After'], '60');
});

test('repeats count against the limits too, so they are not free to send', async () => {
  const s = await setup();
  const { secret } = await s.issue();
  for (let i = 0; i < 30; i++) await s.post(s.pathOf(secret), '{}', { headers: { 'Idempotency-Key': 'same' }, now: NOW + i });
  assert.equal((await s.post(s.pathOf(secret), '{}', { headers: { 'Idempotency-Key': 'same' }, now: NOW + 40 })).status, 429);
  assert.equal(s.commands().length, 1);
  assert.ok(s.rows('webhookCalls').every((c) => c.payload === undefined));
});

test('limits: 50 a day per hook', async () => {
  const s = await setup();
  const { secret } = await s.issue();
  for (let i = 0; i < 50; i++) assert.equal((await s.post(s.pathOf(secret), '{}', { now: NOW + i * 120_000 })).status, 202);
  const r = await s.post(s.pathOf(secret), '{}', { now: NOW + 51 * 120_000 });
  assert.equal(r.status, 429);
  assert.equal(r.headers['Retry-After'], '3600');
});

test('bad keys from one IP slow down to 429 after 20, while a good key still works', async () => {
  const s = await setup();
  const { secret } = await s.issue();
  for (let i = 0; i < 20; i++) assert.equal((await s.post(`/hook/tbh_${String(i).padStart(64, '0')}`, '{}', { ip: '198.51.100.1' })).status, 404);
  assert.equal((await s.post(`/hook/tbh_${'f'.repeat(64)}`, '{}', { ip: '198.51.100.1' })).status, 429);
  assert.equal((await s.post(s.pathOf(secret), '{}', { ip: '198.51.100.1' })).status, 202);
});

test('batching: deliveries in one window wait, then go as one run in order', async () => {
  const s = await setup(10);
  const { secret, hook } = await s.issue();
  for (let i = 0; i < 5; i++) assert.equal((await s.post(s.pathOf(secret), `{"event":${i}}`, { now: NOW + i * 1000 })).status, 202);
  assert.equal(s.commands().length, 0, 'nothing queued yet');
  assert.equal(s.rows('webhookCalls').filter((c) => c.state === 'waiting').length, 5);
  await call(s.ctx, hooks.flush, { hookId: hook.id });
  const cmds = s.commands();
  assert.equal(cmds.length, 1);
  assert.deepEqual(cmds[0]!.args.payloads.map((p: { body: string }) => JSON.parse(p.body).event), [0, 1, 2, 3, 4]);
  assert.equal(s.rows('webhookCalls').filter((c) => c.state === 'waiting').length, 0);
});

test('revoking drops waiting deliveries and cancels runs no runner has taken', async () => {
  const s = await setup(10);
  const { secret } = await s.issue();
  await s.post(s.pathOf(secret), '{"a":1}');
  const other = await setup();
  void other;
  assert.equal(await call(s.ctx, hooks.revokeWebhook, { key: OWNER }), 1);
  assert.equal(s.rows('webhookCalls')[0]!.state, 'dropped');
  assert.equal(s.rows('webhookCalls')[0]!.payload, undefined);
  const s2 = await setup();
  const k2 = await s2.issue();
  await s2.post(s2.pathOf(k2.secret), '{}');
  assert.equal(s2.commands()[0]!.state, 'pending');
  await call(s2.ctx, hooks.revokeWebhook, { key: OWNER, id: k2.hook.id });
  assert.equal(s2.commands()[0]!.state, 'failed');
});
