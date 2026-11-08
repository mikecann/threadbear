// Outside agents (Grok Bot) reaching Threadbear: what /mcp (http.ts,
// mcpRpc.ts) runs once a request has a key. docs/convex-backend.md,
// "Outside agents", has the why; SECURITY.md what it may never do.
//
// An agent key lives in agentKeys, never in tokens (schema.ts says why). It
// can list and read threads, and with write scope start threads, always in
// Ask mode where the phone's new threads go (mainRunner: the first online Mac
// in Mike's order, else the main Mac; that Mac's runner refuses it unless
// Outside agents is on there too), with no folder, login or model of its choosing,
// and message only the threads it started. The runner checks all of that
// again when it applies the command (runner/src/outside-agents.ts), so a
// thread switched to Full access stops taking its messages.
//
// Every call goes through `begin`: the key's check, the limits and a row in
// agentCalls (no text). Keys are issued, listed and revoked only with the
// main Mac's runner key (runnerAccess.ts ACCESS).
import { ConvexError, v } from 'convex/values';
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { pageLimit, runnerAuth, sha256 } from './lib';
import { findThread, mainRunner, queue } from './phone';

export const AGENT_DEFAULT_DAYS = 30;
export const AGENT_MAX_DAYS = 90;
// What one call may carry and get back.
export const AGENT_TEXT_MAX = 4_000;
export const AGENT_MESSAGE_MAX = 8_000;
export const AGENT_LIST_MAX = 30;
export const AGENT_READ_DEFAULT = 20;
export const AGENT_READ_MAX = 50;
// Per key, and for all keys together.
export const AGENT_CALLS_PER_MINUTE = 30;
export const AGENT_STARTS_PER_DAY = 10;
export const AGENT_SENDS_PER_DAY = 100;
export const AGENT_GLOBAL_PER_MINUTE = 120;
// Bad keys: per IP and in all, over ten minutes.
export const AGENT_FAILS_PER_IP = 20;
export const AGENT_FAILS_GLOBAL = 200;
const FAIL_WINDOW_MS = 10 * 60_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const CALLS_KEPT_MS = 30 * DAY;
const PRUNE_BATCH = 4_000;
// The threads of its own an agent can hold; past this, older ones drop off
// what it may message (it can't start more than AGENT_STARTS_PER_DAY a day).
const OWN_THREADS_MAX = 200;

export const AGENT_TOOLS = ['list_threads', 'read_thread', 'start_thread', 'send_message'] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];
const WRITE_TOOLS: readonly string[] = ['start_thread', 'send_message'];

const agentRef = v.object({ keyId: v.id('agentKeys'), name: v.string(), scope: v.union(v.literal('read'), v.literal('write')), readAll: v.boolean() });
export type AgentRef = { keyId: Id<'agentKeys'>; name: string; scope: 'read' | 'write'; readAll: boolean };

// --------------------------------------------------------------- begin

// One call's check. `hash` is the SHA-256 of the key the request carried
// ("" for none). Answers the key, or why not: `auth` (no, bad, expired or
// revoked key, all the same), `slow` (too many bad keys from here, or in
// all), `limited` (this key's limits), `scope` (a read key calling a write
// tool). Each bad key is counted against its IP before anything else.
export const begin = internalMutation({
  args: { hash: v.string(), tool: v.string(), ip: v.string(), now: v.number() },
  returns: v.union(v.object({ ok: v.literal(true), agent: agentRef }), v.object({ ok: v.literal(false), why: v.union(v.literal('auth'), v.literal('slow'), v.literal('limited'), v.literal('scope')) })),
  handler: async (ctx, { hash, tool, ip, now }) => {
    // The key first: a good key is never held up by other people's bad ones
    // (a flood of made-up keys would otherwise lock Grok Bot out).
    const row = hash ? await ctx.db.query('agentKeys').withIndex('by_hash', (q) => q.eq('hash', hash)).unique() : null;
    if (!row || row.revokedAt !== undefined || row.expiresAt <= now) {
      // A bad key: slow once there have been too many from here, or in all.
      const since = now - FAIL_WINDOW_MS;
      const ipKey = ip.slice(0, 64) || 'unknown';
      const ipFails = await ctx.db.query('agentAuthFails').withIndex('by_ip_at', (q) => q.eq('ip', ipKey).gte('at', since)).take(AGENT_FAILS_PER_IP);
      const allFails = await ctx.db.query('agentAuthFails').withIndex('by_at', (q) => q.gte('at', since)).take(AGENT_FAILS_GLOBAL);
      if (ipFails.length >= AGENT_FAILS_PER_IP || allFails.length >= AGENT_FAILS_GLOBAL) return { ok: false as const, why: 'slow' as const };
      await ctx.db.insert('agentAuthFails', { ip: ipKey, at: now });
      return { ok: false as const, why: 'auth' as const };
    }
    if (WRITE_TOOLS.includes(tool) && row.scope !== 'write') return { ok: false as const, why: 'scope' as const };
    const mine = await ctx.db.query('agentCalls').withIndex('by_key_at', (q) => q.eq('keyId', row._id).gte('at', now - MINUTE)).take(AGENT_CALLS_PER_MINUTE);
    const everyone = await ctx.db.query('agentCalls').withIndex('by_at', (q) => q.gte('at', now - MINUTE)).take(AGENT_GLOBAL_PER_MINUTE);
    if (mine.length >= AGENT_CALLS_PER_MINUTE || everyone.length >= AGENT_GLOBAL_PER_MINUTE) return { ok: false as const, why: 'limited' as const };
    const perDay = tool === 'start_thread' ? AGENT_STARTS_PER_DAY : tool === 'send_message' ? AGENT_SENDS_PER_DAY : 0;
    if (perDay) {
      const today = await ctx.db.query('agentCalls').withIndex('by_key_tool_at', (q) => q.eq('keyId', row._id).eq('tool', tool).gte('at', now - DAY)).take(perDay);
      if (today.length >= perDay) return { ok: false as const, why: 'limited' as const };
    }
    // Only tools it knows are counted under their name; anything else (an
    // initialize, a list of tools) under "other".
    await ctx.db.insert('agentCalls', { keyId: row._id, tool: (AGENT_TOOLS as readonly string[]).includes(tool) ? tool : 'other', at: now });
    await ctx.db.patch(row._id, { lastUsedAt: now });
    return { ok: true as const, agent: { keyId: row._id, name: row.name, scope: row.scope, readAll: row.readAll } };
  },
});

// ------------------------------------------------------------- the tools

const listRow = v.object({ threadId: v.string(), title: v.string(), status: v.string(), needsYou: v.boolean(), lastActivityAt: v.string(), startedByYou: v.boolean() });
type ListRow = { threadId: string; title: string; status: string; needsYou: boolean; lastActivityAt: string; startedByYou: boolean };

// The threads this key started that have landed, newest first.
async function ownThreadIds(ctx: QueryCtx, keyId: Id<'agentKeys'>): Promise<string[]> {
  const rows = await ctx.db.query('agentThreads').withIndex('by_key', (q) => q.eq('keyId', keyId)).order('desc').take(OWN_THREADS_MAX);
  return rows.flatMap((r) => (r.threadId ? [r.threadId] : []));
}

// What a list shows of a thread: never its folder, login, links or cards.
function project(t: Doc<'threads'>, own: Set<string>): ListRow {
  return { threadId: t.threadId, title: t.title, status: t.status, needsYou: t.needsYou, lastActivityAt: t.lastActivityAt, startedByYou: own.has(t.threadId) };
}

// The same answer for a thread that isn't there, is archived, or isn't
// this key's to see, so ids can't be probed.
function hidden(): never {
  throw new ConvexError({ kind: 'notFound', message: 'no such thread' });
}

async function visibleThread(ctx: QueryCtx, agent: AgentRef, threadId: string): Promise<Doc<'threads'>> {
  if (threadId.length > 100) hidden();
  const t = await ctx.db.query('threads').withIndex('by_threadId', (q) => q.eq('threadId', threadId)).unique();
  if (!t || t.view === 'den' || t.archivedAt) hidden();
  if (!agent.readAll && !(await ownThreadIds(ctx, agent.keyId)).includes(threadId)) hidden();
  return t;
}

export const listThreads = internalQuery({
  args: { agent: agentRef, view: v.union(v.literal('inbox'), v.literal('hibernating')) },
  returns: v.array(listRow),
  handler: async (ctx, { agent, view }) => {
    const own = new Set(await ownThreadIds(ctx, agent.keyId));
    if (agent.readAll) {
      const rows = await ctx.db.query('threads').withIndex('by_view_activity', (q) => q.eq('view', view)).order('desc').take(AGENT_LIST_MAX);
      return rows.filter((t) => !t.archivedAt).map((t) => project(t, own));
    }
    const out: ListRow[] = [];
    for (const id of own) {
      if (out.length >= AGENT_LIST_MAX) break;
      const t = await ctx.db.query('threads').withIndex('by_threadId', (q) => q.eq('threadId', id)).unique();
      if (t && t.view === view && !t.archivedAt) out.push(project(t, own));
    }
    return out;
  },
});

const readMessage = v.object({ seq: v.number(), role: v.union(v.literal('user'), v.literal('assistant')), from: v.optional(v.string()), text: v.string(), at: v.string() });

// A thread's newest text messages, oldest first. The text is what the runner
// sent here, which its secret rules scrubbed before it left the Mac (and the
// backend checked again): tool output never comes here at all.
export const readThread = internalQuery({
  args: { agent: agentRef, threadId: v.string(), limit: v.optional(v.number()) },
  returns: v.object({ threadId: v.string(), title: v.string(), status: v.string(), needsYou: v.boolean(), messages: v.array(readMessage), more: v.boolean() }),
  handler: async (ctx, { agent, threadId, limit }) => {
    const t = await visibleThread(ctx, agent, threadId);
    const want = pageLimit(limit, AGENT_READ_DEFAULT, AGENT_READ_MAX);
    const out: { seq: number; role: 'user' | 'assistant'; from?: string; text: string; at: string }[] = [];
    let seen = 0;
    let more = false;
    // Tool rows are skipped, but only so many are looked past.
    for await (const m of ctx.db.query('messages').withIndex('by_thread_seq', (q) => q.eq('threadId', threadId)).order('desc')) {
      if (++seen > want * 4 + 40) {
        more = true;
        break;
      }
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      if (out.length >= want) {
        more = true;
        break;
      }
      const text = m.text.length > AGENT_MESSAGE_MAX ? `${m.text.slice(0, AGENT_MESSAGE_MAX)}\n[cut]` : m.text;
      out.push({ seq: m.seq, role: m.role, ...(m.origin ? { from: m.origin } : {}), text, at: m.at });
    }
    out.reverse();
    return { threadId: t.threadId, title: t.title, status: t.status, needsYou: t.needsYou, messages: out, more };
  },
});

function checkText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new ConvexError({ kind: 'invalid', message: 'text must not be empty' });
  if (trimmed.length > AGENT_TEXT_MAX) throw new ConvexError({ kind: 'invalid', message: `text is at most ${AGENT_TEXT_MAX} characters` });
  return trimmed;
}

// What every command from an agent carries, so the runner knows who sent it
// (runner/src/outside-agents.ts). Set here, never taken from the request.
function from(agent: AgentRef) {
  return { agent: { keyId: agent.keyId, name: agent.name } };
}

export const startThread = internalMutation({
  args: { agent: agentRef, text: v.string() },
  returns: v.object({ commandId: v.string() }),
  handler: async (ctx, { agent, text }) => {
    if (agent.scope !== 'write') throw new ConvexError({ kind: 'forbidden', message: 'this key is read only' });
    // Ask mode always, where the phone's new threads go, on that Mac's default folder, login and model:
    // none of those are the agent's to pick.
    const commandId = await queue(ctx, await mainRunner(ctx), 'create', undefined, { text: checkText(text), permissionMode: 'ask', ...from(agent) });
    await ctx.db.insert('agentThreads', { keyId: agent.keyId, commandId });
    return { commandId };
  },
});

export const sendMessage = internalMutation({
  args: { agent: agentRef, threadId: v.string(), text: v.string() },
  returns: v.object({ commandId: v.string() }),
  handler: async (ctx, { agent, threadId, text }) => {
    if (agent.scope !== 'write') throw new ConvexError({ kind: 'forbidden', message: 'this key is read only' });
    // Only into a thread this key started, whatever readAll says.
    if (threadId.length > 100 || !(await ownThreadIds(ctx, agent.keyId)).includes(threadId)) hidden();
    const t = await findThread(ctx, threadId).catch(() => hidden());
    if (t.view === 'den' || t.archivedAt) hidden();
    const commandId = await queue(ctx, t.runnerId, 'send', threadId, { text: checkText(text), ...from(agent) });
    return { commandId };
  },
});

// -------------------------------------------------- keys, for the runner

const keyInfo = v.object({ id: v.string(), name: v.string(), scope: v.union(v.literal('read'), v.literal('write')), readAll: v.boolean(), createdAt: v.string(), expiresAt: v.string(), lastUsedAt: v.optional(v.string()), expired: v.boolean() });

function infoOf(row: Doc<'agentKeys'>, now: number) {
  return { id: row._id, name: row.name, scope: row.scope, readAll: row.readAll, createdAt: new Date(row.createdAt).toISOString(), expiresAt: new Date(row.expiresAt).toISOString(), ...(row.lastUsedAt ? { lastUsedAt: new Date(row.lastUsedAt).toISOString() } : {}), expired: row.expiresAt <= now };
}

export async function makeAgentKey(ctx: MutationCtx, args: { name: string; scope: 'read' | 'write'; readAll: boolean; days?: number }, now = Date.now()) {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const key = 'tba_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const days = pageLimit(args.days, AGENT_DEFAULT_DAYS, AGENT_MAX_DAYS);
  const id = await ctx.db.insert('agentKeys', { hash: await sha256(key), name: args.name, scope: args.scope, readAll: args.readAll, createdAt: now, expiresAt: now + days * DAY });
  const row = (await ctx.db.get(id))!;
  return { key: infoOf(row, now), secret: key };
}

// The Mac app's Connect Grok Bot, through the runner with the main Mac's key.
export const issueAgentKey = mutation({
  args: { key: v.string(), name: v.string(), scope: v.union(v.literal('read'), v.literal('write')), readAll: v.boolean(), days: v.optional(v.number()) },
  returns: v.object({ key: keyInfo, secret: v.string() }),
  handler: async (ctx, { key, name, scope, readAll, days }) => {
    await runnerAuth(ctx, key, 'issueAgentKey');
    const trimmed = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
    if (!trimmed) throw new ConvexError({ kind: 'badArgs', message: 'name must not be blank' });
    if (days !== undefined && (!Number.isFinite(days) || days < 1 || days > AGENT_MAX_DAYS)) throw new ConvexError({ kind: 'badArgs', message: `days must be 1 to ${AGENT_MAX_DAYS}` });
    return makeAgentKey(ctx, { name: trimmed, scope, readAll, days });
  },
});

export const listAgentKeys = query({
  args: { key: v.string() },
  returns: v.array(keyInfo),
  handler: async (ctx, { key }) => {
    await runnerAuth(ctx, key, 'listAgentKeys');
    const now = Date.now();
    const out = [];
    for await (const row of ctx.db.query('agentKeys')) if (row.revokedAt === undefined) out.push(infoOf(row, now));
    return out;
  },
});

// Revokes one key (`id`) or all of them (no id), and cancels what they sent
// that no runner has taken yet. Answers how many were revoked.
export async function revokeAgentKeys(ctx: MutationCtx, id: Id<'agentKeys'> | undefined, now = Date.now()): Promise<number> {
  const rows: Doc<'agentKeys'>[] = [];
  if (id) {
    const row = await ctx.db.get(id);
    if (row && row.revokedAt === undefined) rows.push(row);
  } else for await (const row of ctx.db.query('agentKeys')) if (row.revokedAt === undefined) rows.push(row);
  const ids = new Set<string>(rows.map((r) => r._id));
  for (const r of rows) await ctx.db.patch(r._id, { revokedAt: now });
  if (ids.size) {
    for await (const c of ctx.db.query('commands').withIndex('by_state', (q) => q.eq('state', 'pending'))) {
      const by = (c.args as { agent?: { keyId?: string } } | undefined)?.agent?.keyId;
      if (by && ids.has(by)) await ctx.db.patch(c._id, { state: 'failed', doneAt: now, args: {}, note: 'Its key was revoked.' });
    }
  }
  return rows.length;
}

export const revokeAgentKey = mutation({
  args: { key: v.string(), id: v.optional(v.string()) },
  returns: v.number(),
  handler: async (ctx, { key, id }) => {
    await runnerAuth(ctx, key, 'revokeAgentKey');
    if (id === undefined) return revokeAgentKeys(ctx, undefined);
    const norm = ctx.db.normalizeId('agentKeys', id);
    return norm ? revokeAgentKeys(ctx, norm) : 0;
  },
});

// ----------------------------------------------------------------- prune

// Calls past 30 days, bad-key rows past a day, and revoked or expired keys
// with their thread rows a month after. A batch a run, hourly (crons.ts).
export const prune = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    // Enough a run (hourly, crons.ts) to keep up with every key at its limits.
    for (const c of await ctx.db.query('agentCalls').withIndex('by_at', (q) => q.lt('at', now - CALLS_KEPT_MS)).take(PRUNE_BATCH)) await ctx.db.delete(c._id);
    for (const f of await ctx.db.query('agentAuthFails').withIndex('by_at', (q) => q.lt('at', now - DAY)).take(PRUNE_BATCH)) await ctx.db.delete(f._id);
    for await (const k of ctx.db.query('agentKeys')) {
      const ended = k.revokedAt ?? (k.expiresAt <= now ? k.expiresAt : undefined);
      if (ended === undefined || ended > now - CALLS_KEPT_MS) continue;
      // Its thread rows first; the key goes only once none are left, so a
      // key with more than one batch is finished on a later run.
      const rows = await ctx.db.query('agentThreads').withIndex('by_key', (q) => q.eq('keyId', k._id)).take(500);
      for (const t of rows) await ctx.db.delete(t._id);
      if (rows.length < 500) await ctx.db.delete(k._id);
    }
    return null;
  },
});
