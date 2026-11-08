// Outside agents (Grok Bot) through /mcp: the backend's side (convex/mcp.ts,
// convex/mcpRpc.ts) against an in-memory database. Each attack in the plan's
// security table has a test here: a key used on phone:*, another key's
// threads, a read key writing, guessing keys, floods, revokes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, outcome } from '../helpers/convex-memory.ts';

const OWNER = 'owner-key';
const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const mcp = load('mcp');
const rpc = load('mcpRpc');
const phone = load('phone');
const sync = load('sync');

const NOW = Date.now();

async function setup() {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  const b = memoryBackend();
  const issue = (over: Record<string, unknown> = {}) => call(b.ctx, mcp.issueAgentKey, { key: OWNER, name: 'Grok Bot', scope: 'read', readAll: false, ...over });
  // An HTTP request as http.ts makes it, with this key (or none).
  const post = async (secret: string | undefined, body: unknown, opts: { ip?: string; now?: number; origin?: string; method?: string } = {}) => {
    const hash = secret ? await sha256(secret) : '';
    const out = await rpc.handleMcp(
      { method: opts.method ?? 'POST', header: (n: string) => (n === 'origin' ? (opts.origin ?? null) : null), body: typeof body === 'string' ? body : JSON.stringify(body) },
      {
        begin: (tool: string) => call(b.ctx, mcp.begin, { hash, tool, ip: opts.ip ?? '203.0.113.7', now: opts.now ?? NOW }),
        listThreads: (agent: unknown, view: string) => call(b.ctx, mcp.listThreads, { agent, view }),
        readThread: (agent: unknown, threadId: string, limit?: number) => call(b.ctx, mcp.readThread, { agent, threadId, limit }),
        startThread: (agent: unknown, text: string) => call(b.ctx, mcp.startThread, { agent, text }),
        sendMessage: (agent: unknown, threadId: string, text: string) => call(b.ctx, mcp.sendMessage, { agent, threadId, text }),
      },
    );
    return { status: out.status, json: out.body ? JSON.parse(out.body) : undefined };
  };
  const tool = (secret: string | undefined, name: string, args: Record<string, unknown> = {}, opts = {}) => post(secret, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, opts);
  const thread = (threadId: string, extra: Record<string, unknown> = {}) => b.ctx.db.insert('threads', { threadId, runnerId: 'm5', title: `T ${threadId}`, status: 'idle', needsYou: false, view: 'inbox', lastActivityAt: 'now', lastActivityMs: 1, cwd: '/Users/secret/folder', accountId: 'claude-main', ...extra });
  // What the runner does once it has made the thread an agent asked for.
  const land = async (commandId: string, threadId: string) => {
    await thread(threadId);
    await call(b.ctx, sync.finishCommand, { key: OWNER, commandId, ok: true, resultThreadId: threadId });
  };
  return { ...b, issue, post, tool, thread, land };
}

const result = (r: { json: any }) => r.json.result;
const toolOut = (r: { json: any }) => r.json.result.structuredContent;

test('a key is shown once and stored only as its hash, in agentKeys rather than tokens', async () => {
  const s = await setup();
  const { secret, key } = await s.issue();
  assert.match(secret, /^tba_[0-9a-f]{64}$/);
  const rows = s.rows('agentKeys');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.hash, await sha256(secret));
  assert.ok(!JSON.stringify(rows).includes(secret));
  assert.equal(s.rows('tokens').length, 0);
  assert.equal(key.scope, 'read');
  assert.equal((await call(s.ctx, mcp.listAgentKeys, { key: OWNER })).length, 1);
});

test('only the main Mac key issues, lists or revokes agent keys', async () => {
  const s = await setup();
  assert.equal(await outcome(call(s.ctx, mcp.issueAgentKey, { key: 'nope', name: 'x', scope: 'write', readAll: true })), 'auth');
  assert.equal(await outcome(call(s.ctx, mcp.listAgentKeys, { key: 'nope' })), 'auth');
  assert.equal(await outcome(call(s.ctx, mcp.revokeAgentKey, { key: 'nope' })), 'auth');
  assert.equal(await outcome(call(s.ctx, mcp.issueAgentKey, { key: OWNER, name: '  ', scope: 'read', readAll: false })), 'badArgs');
  assert.equal(await outcome(call(s.ctx, mcp.issueAgentKey, { key: OWNER, name: 'x', scope: 'read', readAll: false, days: 91 })), 'badArgs');
});

test("an agent key opens none of the phone's functions", async () => {
  const s = await setup();
  const { secret } = await s.issue({ scope: 'write', readAll: true });
  await s.thread('t1');
  assert.equal(await outcome(call(s.ctx, phone.threads, { token: secret, view: 'inbox' })), 'auth');
  assert.equal(await outcome(call(s.ctx, phone.send, { token: secret, threadId: 't1', text: 'hi' })), 'auth');
  assert.equal(await outcome(call(s.ctx, phone.create, { token: secret, text: 'hi' })), 'auth');
  assert.equal(await outcome(call(s.ctx, phone.respond, { token: secret, threadId: 't1', approvalId: 'a', decision: 'allow' })), 'auth');
});

test('no key, a made-up key, an expired or a revoked key all get the same 401', async () => {
  const s = await setup();
  const { secret, key } = await s.issue({ days: 1 });
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };
  assert.equal((await s.post(secret, init)).status, 200);
  assert.equal((await s.post(undefined, init)).status, 401);
  assert.equal((await s.post('tba_' + '0'.repeat(64), init)).status, 401);
  assert.equal((await s.post(secret, init, { now: NOW + 2 * 24 * 60 * 60_000 })).status, 401);
  await call(s.ctx, mcp.revokeAgentKey, { key: OWNER, id: key.id });
  const after = await s.post(secret, init);
  assert.equal(after.status, 401);
  assert.equal(after.json.error.message, 'unauthorized: a bad, expired or revoked key');
});

test('a phone token is no good at /mcp', async () => {
  const s = await setup();
  const { token } = await call(s.ctx, sync.issueToken, { key: OWNER, kind: 'phone', name: 'iphone' });
  assert.equal((await s.post(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
});

test('guessing keys gets slow from that address, but never locks the real key out', async () => {
  const s = await setup();
  const { secret } = await s.issue();
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  const bad = (i: number) => 'tba_' + String(i).padStart(64, '0');
  for (let i = 0; i < 20; i++) assert.equal((await s.post(bad(i), list, { ip: '198.51.100.1' })).status, 401);
  // The 21st bad key from there is slowed; another address isn't yet.
  assert.equal((await s.post(bad(99), list, { ip: '198.51.100.1' })).status, 429);
  assert.equal((await s.post(bad(98), list, { ip: '198.51.100.2' })).status, 401);
  // The real key gets in from the same address all the same.
  assert.equal((await s.post(secret, list, { ip: '198.51.100.1' })).status, 200);
  // Ten minutes on, bad keys from the first address are only refused again.
  assert.equal((await s.post(bad(97), list, { ip: '198.51.100.1', now: NOW + 11 * 60_000 })).status, 401);
});

test('a flood of bad keys from everywhere still leaves the real key working', async () => {
  const s = await setup();
  const { secret } = await s.issue();
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  for (let i = 0; i < 200; i++) await s.post('tba_' + String(i).padStart(64, '1'), list, { ip: `203.0.113.${i}` });
  assert.equal((await s.post('tba_' + 'f'.repeat(64), list, { ip: '192.0.2.1' })).status, 429);
  assert.equal((await s.post(secret, list, { ip: '192.0.2.1' })).status, 200);
});

test("prune clears an ended key's thread rows before the key, across runs", async () => {
  const s = await setup();
  const { key } = await s.issue({ scope: 'write' });
  for (let i = 0; i < 600; i++) await s.ctx.db.insert('agentThreads', { keyId: key.id, commandId: `commands:${i}`, threadId: `t${i}` });
  await s.ctx.db.patch(key.id, { revokedAt: 1 });
  await call(s.ctx, mcp.prune, {});
  assert.equal(s.rows('agentKeys').length, 1);
  assert.equal(s.rows('agentThreads').length, 100);
  await call(s.ctx, mcp.prune, {});
  assert.equal(s.rows('agentKeys').length, 0);
  assert.equal(s.rows('agentThreads').length, 0);
});

test('browsers, other methods, batches and big bodies are refused before the key is even looked at', async () => {
  const s = await setup();
  const { secret } = await s.issue();
  assert.equal((await s.post(secret, { jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await s.post(secret, '', { method: 'GET' })).status, 405);
  assert.equal((await s.post(secret, 'x'.repeat(64 * 1024 + 1))).status, 413);
  assert.equal((await s.post(secret, '{not json')).status, 400);
  assert.equal((await s.post(secret, [{ jsonrpc: '2.0', id: 1, method: 'ping' }])).status, 400);
  assert.equal(s.rows('agentCalls').length, 0);
});

test('initialize, ping and tools/list answer as MCP says; a read key sees only the read tools', async () => {
  const s = await setup();
  const read = (await s.issue()).secret;
  const write = (await s.issue({ scope: 'write' })).secret;
  const init = await s.post(read, { jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(result(init).protocolVersion, '2025-06-18');
  assert.deepEqual(result(init).capabilities, { tools: { listChanged: false } });
  assert.equal((await s.post(read, { jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).json.result.protocolVersion, '2025-11-25');
  assert.equal((await s.post(read, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  assert.deepEqual(result(await s.post(read, { jsonrpc: '2.0', id: 2, method: 'ping' })), {});
  const names = (r: any) => result(r).tools.map((t: any) => t.name);
  assert.deepEqual(names(await s.post(read, { jsonrpc: '2.0', id: 3, method: 'tools/list' })), ['list_threads', 'read_thread']);
  assert.deepEqual(names(await s.post(write, { jsonrpc: '2.0', id: 3, method: 'tools/list' })), ['list_threads', 'read_thread', 'start_thread', 'send_message']);
  assert.equal((await s.post(read, { jsonrpc: '2.0', id: 4, method: 'resources/list' })).json.error.code, -32601);
});

test("a read key can't start or send; the call isn't logged as made", async () => {
  const s = await setup();
  const { secret } = await s.issue({ readAll: true });
  await s.thread('t1');
  const start = await s.tool(secret, 'start_thread', { text: 'rm -rf ~' });
  assert.equal(result(start).isError, true);
  assert.equal(result(start).content[0].text, 'this key is read only');
  assert.equal(result(await s.tool(secret, 'send_message', { threadId: 't1', text: 'hi' })).isError, true);
  assert.equal(s.rows('commands').length, 0);
});

test('without readAll a key lists and reads only threads it started, and never folders or logins', async () => {
  const s = await setup();
  const { secret } = await s.issue({ scope: 'write' });
  await s.thread('mikes');
  assert.deepEqual(toolOut(await s.tool(secret, 'list_threads')).threads, []);
  assert.equal(result(await s.tool(secret, 'read_thread', { threadId: 'mikes' })).content[0].text, 'no such thread');
  const started = toolOut(await s.tool(secret, 'start_thread', { text: 'Summarise my week' }));
  await s.land(started.startId, 'grok1');
  const rows = toolOut(await s.tool(secret, 'list_threads')).threads;
  assert.deepEqual(rows.map((r: any) => r.threadId), ['grok1']);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['lastActivityAt', 'needsYou', 'startedByYou', 'status', 'threadId', 'title']);
  assert.equal(rows[0].startedByYou, true);
});

test('with readAll a key reads every live thread, but not archived ones, and only text messages', async () => {
  const s = await setup();
  const { secret } = await s.issue({ readAll: true });
  await s.thread('a');
  await s.thread('gone', { view: 'den', archivedAt: 'yesterday' });
  await s.ctx.db.insert('messages', { threadId: 'a', seq: 1, role: 'user', text: 'hello', at: '1' });
  await s.ctx.db.insert('messages', { threadId: 'a', seq: 2, role: 'tool', text: 'Ran secret command', at: '2' });
  await s.ctx.db.insert('messages', { threadId: 'a', seq: 3, role: 'assistant', text: 'x'.repeat(9_000), at: '3' });
  assert.deepEqual(toolOut(await s.tool(secret, 'list_threads')).threads.map((r: any) => r.threadId), ['a']);
  const read = toolOut(await s.tool(secret, 'read_thread', { threadId: 'a' }));
  assert.deepEqual(read.messages.map((m: any) => m.role), ['user', 'assistant']);
  assert.ok(read.messages[1].text.length < 8_100);
  assert.equal(result(await s.tool(secret, 'read_thread', { threadId: 'gone' })).content[0].text, 'no such thread');
});

test("start_thread always asks for Ask mode on the main Mac, with nothing of the agent's choosing but the text", async () => {
  const s = await setup();
  const { secret, key } = await s.issue({ scope: 'write' });
  await s.tool(secret, 'start_thread', { text: 'hi', cwd: '/', permissionMode: 'full', accountId: 'x', model: 'opus' });
  const [c] = s.rows('commands');
  assert.equal(c!.kind, 'create');
  assert.deepEqual(c!.args, { text: 'hi', permissionMode: 'ask', agent: { keyId: key.id, name: 'Grok Bot' } });
});

test("key B can't message key A's thread, nor any thread it didn't start, nor an archived one", async () => {
  const s = await setup();
  const a = await s.issue({ scope: 'write', name: 'A' });
  const bKey = await s.issue({ scope: 'write', readAll: true, name: 'B' });
  const started = toolOut(await s.tool(a.secret, 'start_thread', { text: 'one' }));
  await s.land(started.startId, 'ta');
  await s.thread('mikes');
  const before = s.rows('commands').length;
  assert.equal(result(await s.tool(bKey.secret, 'send_message', { threadId: 'ta', text: 'hijack' })).content[0].text, 'no such thread');
  assert.equal(result(await s.tool(bKey.secret, 'send_message', { threadId: 'mikes', text: 'hijack' })).content[0].text, 'no such thread');
  assert.equal(s.rows('commands').length, before);
  // A's own works, and says who sent it.
  assert.equal(toolOut(await s.tool(a.secret, 'send_message', { threadId: 'ta', text: 'two' })).sent, true);
  assert.deepEqual(s.rows('commands').at(-1)!.args, { text: 'two', agent: { keyId: a.key.id, name: 'A' } });
  await s.ctx.db.patch(s.rows('threads').find((t) => t.threadId === 'ta')!._id, { view: 'den', archivedAt: 'now' });
  assert.equal(result(await s.tool(a.secret, 'send_message', { threadId: 'ta', text: 'three' })).isError, true);
});

test('text is checked: empty or over 4,000 characters is refused', async () => {
  const s = await setup();
  const { secret } = await s.issue({ scope: 'write' });
  assert.equal(result(await s.tool(secret, 'start_thread', { text: '   ' })).isError, true);
  assert.equal(result(await s.tool(secret, 'start_thread', { text: 'x'.repeat(4_001) })).isError, true);
  assert.equal(result(await s.tool(secret, 'start_thread', {})).isError, true);
  assert.equal(s.rows('commands').length, 0);
});

test('limits: 30 calls a minute, 10 starts a day, and a global ceiling', async () => {
  const s = await setup();
  const { secret } = await s.issue({ scope: 'write' });
  for (let i = 0; i < 10; i++) assert.equal(result(await s.tool(secret, 'start_thread', { text: `go ${i}` }, { now: NOW + i * 61_000 })).isError, false);
  assert.equal((await s.tool(secret, 'start_thread', { text: 'eleventh' }, { now: NOW + 11 * 61_000 })).status, 429);
  const other = (await s.issue()).secret;
  for (let i = 0; i < 30; i++) assert.equal((await s.tool(other, 'list_threads', {}, { now: NOW + 5_000_000 })).status, 200);
  assert.equal((await s.tool(other, 'list_threads', {}, { now: NOW + 5_000_000 })).status, 429);
  assert.equal(mcp.AGENT_GLOBAL_PER_MINUTE > mcp.AGENT_CALLS_PER_MINUTE, true);
});

test('each call is logged without its text, and marks the key used', async () => {
  const s = await setup();
  const { secret } = await s.issue({ scope: 'write' });
  await s.tool(secret, 'start_thread', { text: 'my secret plan' });
  assert.ok(!JSON.stringify(s.rows('agentCalls')).includes('secret plan'));
  assert.equal(s.rows('agentCalls')[0]!.tool, 'start_thread');
  assert.equal(s.rows('agentKeys')[0]!.lastUsedAt, NOW);
});

test("revoking cancels that key's commands no runner has taken, and Revoke all ends every key", async () => {
  const s = await setup();
  const a = await s.issue({ scope: 'write' });
  const b2 = await s.issue({ scope: 'write' });
  await s.tool(a.secret, 'start_thread', { text: 'a' });
  await s.tool(b2.secret, 'start_thread', { text: 'b' });
  assert.equal(await call(s.ctx, mcp.revokeAgentKey, { key: OWNER, id: a.key.id }), 1);
  const states = s.rows('commands').map((c) => c.state);
  assert.deepEqual(states, ['failed', 'pending']);
  assert.deepEqual(s.rows('commands')[0]!.args, {});
  assert.equal(await call(s.ctx, mcp.revokeAgentKey, { key: OWNER }), 1);
  assert.equal((await call(s.ctx, mcp.listAgentKeys, { key: OWNER })).length, 0);
});

test('an error a tool hits says only what it may: never an internal message', async () => {
  const s = await setup();
  const { secret } = await s.issue({ readAll: true });
  const out = await rpc.handleMcp(
    { method: 'POST', header: () => null, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_threads' } }) },
    {
      begin: async () => call(s.ctx, mcp.begin, { hash: await sha256(secret), tool: 'list_threads', ip: 'x', now: NOW }),
      listThreads: async () => {
        throw new Error('database password is hunter2');
      },
      readThread: async () => null,
      startThread: async () => null,
      sendMessage: async () => null,
    },
  );
  assert.ok(!out.body.includes('hunter2'));
  assert.equal(JSON.parse(out.body).error.code, -32603);
});
