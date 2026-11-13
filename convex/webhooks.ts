// Webhooks (experiment `webhooks`, docs/convex-backend.md "Webhooks"): a
// secret URL, /hook/<key>, that starts a thread in a folder or messages one.
// Keys are kept the way runner keys are: only the key's SHA-256 is kept,
// the body is capped (http.ts), limits are counted by hand, bad keys are
// counted by IP, and the runner checks everything again when it takes the
// command (runner/src/webhooks.ts): the experiment, the folder's bear, and
// that a thread target is no more open than Auto. The payload is anyone's
// text, so it's scrubbed here and quoted as data there.
//
// Deliveries to one hook within its batchSeconds become one run, with
// every payload in order, so a burst of five GitHub events starts one
// thread, not five. Keys are issued, listed and revoked only with the main
// Mac's runner key.
import { ConvexError, v } from 'convex/values';
import { internalMutation, mutation, query, type MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { runnerAuth, sha256 } from './lib';
import { queue } from './phone';
import { scrubDoc, HELD_BACK } from './redaction';

export const HOOK_PER_MINUTE = 30;
export const HOOK_PER_DAY = 50;
export const HOOKS_GLOBAL_PER_MINUTE = 120;
export const HOOK_FAILS_PER_IP = 20;
export const HOOK_FAILS_GLOBAL = 200;
export const HOOK_BATCH_DEFAULT = 10;
export const HOOK_BATCH_MAX = 300;
export const HOOK_MAX_DAYS = 365;
// What one run carries: the payloads together, past which the rest are cut.
export const HOOK_RUN_BYTES = 48 * 1024;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const FAIL_WINDOW_MS = 10 * MINUTE;
const CALLS_KEPT_MS = 30 * DAY;
const PRUNE_BATCH = 4_000;

export const hookTarget = v.union(
  v.object({ kind: v.literal('thread'), threadId: v.string() }),
  v.object({ kind: v.literal('folder'), cwd: v.string(), permissionMode: v.union(v.literal('ask'), v.literal('auto')) }),
);

const hookInfo = v.object({
  id: v.string(),
  name: v.string(),
  runnerId: v.string(),
  target: hookTarget,
  batchSeconds: v.number(),
  createdAt: v.number(),
  expiresAt: v.optional(v.number()),
  lastUsedAt: v.optional(v.number()),
});

function infoOf(row: Doc<'webhooks'>) {
  return {
    id: row._id as string,
    name: row.name,
    runnerId: row.runnerId,
    target: row.target,
    batchSeconds: row.batchSeconds,
    createdAt: row.createdAt,
    ...(row.expiresAt !== undefined ? { expiresAt: row.expiresAt } : {}),
    ...(row.lastUsedAt !== undefined ? { lastUsedAt: row.lastUsedAt } : {}),
  };
}

function clean<T>(value: T): T {
  return scrubDoc(value, undefined, (e) => console.error(`secret check failed, stored "${HELD_BACK}" instead:`, (e as Error)?.name));
}

// ------------------------------------------------------------- keys

export const issueWebhook = mutation({
  args: { key: v.string(), name: v.string(), runnerId: v.string(), target: hookTarget, batchSeconds: v.optional(v.number()), days: v.optional(v.number()) },
  returns: v.object({ hook: hookInfo, secret: v.string() }),
  handler: async (ctx, { key, name, runnerId, target, batchSeconds, days }) => {
    await runnerAuth(ctx, key, 'issueWebhook');
    const trimmed = name.replace(/[\u0000-\u001f\u007f\[\]]/g, '').trim().slice(0, 60);
    if (!trimmed) throw new ConvexError({ kind: 'badArgs', message: 'name must not be blank' });
    if (!runnerId.trim() || runnerId.length > 200) throw new ConvexError({ kind: 'badArgs', message: 'runnerId is required' });
    const batch = batchSeconds ?? HOOK_BATCH_DEFAULT;
    if (!Number.isInteger(batch) || batch < 0 || batch > HOOK_BATCH_MAX) throw new ConvexError({ kind: 'badArgs', message: `batchSeconds must be 0 to ${HOOK_BATCH_MAX}` });
    if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > HOOK_MAX_DAYS)) throw new ConvexError({ kind: 'badArgs', message: `days must be 1 to ${HOOK_MAX_DAYS}` });
    if (target.kind === 'folder' && (!target.cwd.trim() || target.cwd.length > 1000)) throw new ConvexError({ kind: 'badArgs', message: 'cwd is required' });
    if (target.kind === 'thread' && (!target.threadId.trim() || target.threadId.length > 200)) throw new ConvexError({ kind: 'badArgs', message: 'threadId is required' });
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const secret = 'tbh_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    const now = Date.now();
    const id = await ctx.db.insert('webhooks', {
      hash: await sha256(secret),
      name: trimmed,
      runnerId,
      target,
      batchSeconds: batch,
      createdAt: now,
      ...(days !== undefined ? { expiresAt: now + days * DAY } : {}),
    });
    return { hook: infoOf((await ctx.db.get(id))!), secret };
  },
});

export const listWebhooks = query({
  args: { key: v.string() },
  returns: v.array(hookInfo),
  handler: async (ctx, { key }) => {
    await runnerAuth(ctx, key, 'listWebhooks');
    const out = [];
    for await (const row of ctx.db.query('webhooks')) if (row.revokedAt === undefined) out.push(infoOf(row));
    return out;
  },
});

// Revokes one hook (`id`) or every one (no id), drops what's waiting in its
// batch, and cancels what it sent that no runner has taken yet.
export async function revokeHooks(ctx: MutationCtx, id: Id<'webhooks'> | undefined, now = Date.now()): Promise<number> {
  const rows: Doc<'webhooks'>[] = [];
  if (id) {
    const row = await ctx.db.get(id);
    if (row && row.revokedAt === undefined) rows.push(row);
  } else for await (const row of ctx.db.query('webhooks')) if (row.revokedAt === undefined) rows.push(row);
  const ids = new Set<string>(rows.map((r) => r._id));
  for (const r of rows) {
    await ctx.db.patch(r._id, { revokedAt: now });
    for (const c of await ctx.db.query('webhookCalls').withIndex('by_hook_state', (q) => q.eq('hookId', r._id).eq('state', 'waiting')).take(500)) {
      await ctx.db.patch(c._id, { state: 'dropped', payload: undefined });
    }
  }
  if (ids.size) {
    for await (const c of ctx.db.query('commands').withIndex('by_state', (q) => q.eq('state', 'pending'))) {
      const by = (c.args as { webhook?: { hookId?: string } } | undefined)?.webhook?.hookId;
      if (by && ids.has(by)) await ctx.db.patch(c._id, { state: 'failed', doneAt: now, args: {}, note: 'Its webhook was revoked.' });
    }
  }
  return rows.length;
}

export const revokeWebhook = mutation({
  args: { key: v.string(), id: v.optional(v.string()) },
  returns: v.number(),
  handler: async (ctx, { key, id }) => {
    await runnerAuth(ctx, key, 'revokeWebhook');
    if (id === undefined) return revokeHooks(ctx, undefined);
    const norm = ctx.db.normalizeId('webhooks', id);
    return norm ? revokeHooks(ctx, norm) : 0;
  },
});

// ------------------------------------------------------------- deliver

// One delivery, after http.ts has capped the body and refused browsers.
// Answers what http.ts turns into a status: `ok` (202), `duplicate` (200,
// dropped), `unknown` (404: no such key, revoked or expired, all the same),
// `slow` (429: too many bad keys) or `limited` (429: this hook's limits).
export const deliver = internalMutation({
  args: { hash: v.string(), ip: v.string(), now: v.number(), body: v.string(), contentType: v.string(), dedupe: v.optional(v.string()) },
  returns: v.union(
    v.object({ ok: v.literal(true), duplicate: v.boolean() }),
    v.object({ ok: v.literal(false), why: v.union(v.literal('unknown'), v.literal('slow'), v.literal('limited')), retryAfter: v.optional(v.number()) }),
  ),
  handler: async (ctx, { hash, ip, now, body, contentType, dedupe }) => {
    const row = hash ? await ctx.db.query('webhooks').withIndex('by_hash', (q) => q.eq('hash', hash)).unique() : null;
    if (!row || row.revokedAt !== undefined || (row.expiresAt !== undefined && row.expiresAt <= now)) {
      const since = now - FAIL_WINDOW_MS;
      const ipKey = ip.slice(0, 64) || 'unknown';
      const ipFails = await ctx.db.query('webhookFails').withIndex('by_ip_at', (q) => q.eq('ip', ipKey).gte('at', since)).take(HOOK_FAILS_PER_IP);
      const allFails = await ctx.db.query('webhookFails').withIndex('by_at', (q) => q.gte('at', since)).take(HOOK_FAILS_GLOBAL);
      if (ipFails.length >= HOOK_FAILS_PER_IP || allFails.length >= HOOK_FAILS_GLOBAL) return { ok: false as const, why: 'slow' as const, retryAfter: 600 };
      await ctx.db.insert('webhookFails', { ip: ipKey, at: now });
      return { ok: false as const, why: 'unknown' as const };
    }
    // Limits first, so a repeat can't be sent over and over for free.
    const minute = await ctx.db.query('webhookCalls').withIndex('by_hook_at', (q) => q.eq('hookId', row._id).gte('at', now - MINUTE)).take(HOOK_PER_MINUTE);
    if (minute.length >= HOOK_PER_MINUTE) return { ok: false as const, why: 'limited' as const, retryAfter: 60 };
    const day = await ctx.db.query('webhookCalls').withIndex('by_hook_at', (q) => q.eq('hookId', row._id).gte('at', now - DAY)).take(HOOK_PER_DAY);
    if (day.length >= HOOK_PER_DAY) return { ok: false as const, why: 'limited' as const, retryAfter: 3600 };
    const all = await ctx.db.query('webhookCalls').withIndex('by_at', (q) => q.gte('at', now - MINUTE)).take(HOOKS_GLOBAL_PER_MINUTE);
    if (all.length >= HOOKS_GLOBAL_PER_MINUTE) return { ok: false as const, why: 'limited' as const, retryAfter: 60 };
    const key = dedupe?.trim().slice(0, 200) || undefined;
    if (key) {
      const seen = await ctx.db.query('webhookCalls').withIndex('by_hook_dedupe', (q) => q.eq('hookId', row._id).eq('dedupe', key)).order('desc').first();
      if (seen && seen.at > now - DAY) {
        // Counted, with no words kept, and dropped.
        await ctx.db.insert('webhookCalls', { hookId: row._id, at: now, state: 'dropped' });
        return { ok: true as const, duplicate: true };
      }
    }
    await ctx.db.insert('webhookCalls', {
      hookId: row._id,
      at: now,
      state: 'waiting',
      payload: clean(body),
      contentType: contentType.slice(0, 100),
      ...(key ? { dedupe: key } : {}),
    });
    await ctx.db.patch(row._id, { lastUsedAt: now });
    // The first delivery of a window books the run; later ones join it.
    if (row.batchSeconds === 0) await flushHook(ctx, row, now);
    else if (row.flushAt === undefined || row.flushAt <= now) {
      await ctx.db.patch(row._id, { flushAt: now + row.batchSeconds * 1000 });
      await ctx.scheduler.runAfter(row.batchSeconds * 1000, internal.webhooks.flush, { hookId: row._id });
    }
    return { ok: true as const, duplicate: false };
  },
});

// The hook's waiting deliveries as one command to its runner.
async function flushHook(ctx: MutationCtx, row: Doc<'webhooks'>, now: number): Promise<void> {
  const waiting = await ctx.db.query('webhookCalls').withIndex('by_hook_state', (q) => q.eq('hookId', row._id).eq('state', 'waiting')).take(HOOK_PER_DAY);
  await ctx.db.patch(row._id, { flushAt: undefined });
  if (!waiting.length || row.revokedAt !== undefined) return;
  waiting.sort((a, b) => a.at - b.at);
  const payloads: { at: number; contentType: string; body: string }[] = [];
  let bytes = 0;
  let cut = 0;
  for (const c of waiting) {
    const body = c.payload ?? '';
    if (bytes + body.length > HOOK_RUN_BYTES) cut++;
    else {
      payloads.push({ at: c.at, contentType: c.contentType ?? '', body });
      bytes += body.length;
    }
    // The words aren't kept once they're on their way.
    await ctx.db.patch(c._id, { state: 'sent', payload: undefined });
  }
  const webhook = { hookId: row._id as string, name: row.name };
  const args = { webhook, payloads, ...(cut ? { cut } : {}) };
  try {
    if (row.target.kind === 'thread') await queue(ctx, row.runnerId, 'send', row.target.threadId, args);
    else await queue(ctx, row.runnerId, 'create', undefined, { ...args, cwd: row.target.cwd, permissionMode: row.target.permissionMode });
  } catch (e) {
    // Too much waiting for that runner: these are dropped, and the
    // caller's next delivery tries again.
    console.warn('webhook run not queued', (e as Error)?.message);
  }
  void now;
}

export const flush = internalMutation({
  args: { hookId: v.id('webhooks') },
  returns: v.null(),
  handler: async (ctx, { hookId }) => {
    const row = await ctx.db.get(hookId);
    if (row) await flushHook(ctx, row, Date.now());
    return null;
  },
});

// ------------------------------------------------------------- prune

// Calls past 30 days, bad-key rows past a day, revoked or expired hooks a
// month after. A batch a run, hourly (crons.ts).
export const prune = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    for (const c of await ctx.db.query('webhookCalls').withIndex('by_at', (q) => q.lt('at', now - CALLS_KEPT_MS)).take(PRUNE_BATCH)) await ctx.db.delete(c._id);
    for (const f of await ctx.db.query('webhookFails').withIndex('by_at', (q) => q.lt('at', now - DAY)).take(PRUNE_BATCH)) await ctx.db.delete(f._id);
    for await (const h of ctx.db.query('webhooks')) {
      const ended = h.revokedAt ?? (h.expiresAt !== undefined && h.expiresAt <= now ? h.expiresAt : undefined);
      if (ended !== undefined && ended <= now - CALLS_KEPT_MS) await ctx.db.delete(h._id);
    }
    return null;
  },
});
