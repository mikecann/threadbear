// The /hook/<key> route's decisions (http.ts reads the body, capped): kept
// apart from the HTTP plumbing so the tests can run it (webhooks.ts has the
// why). Every unknown, revoked or expired key gets the same 404.
import { sha256 } from './lib';

export const HOOK_BODY_MAX = 64 * 1024;

export type HookRequest = { method: string; path: string; header: (name: string) => string | null; body: string };
export type HookDeliver = (a: { hash: string; body: string; contentType: string; dedupe?: string }) => Promise<
  { ok: true; duplicate: boolean } | { ok: false; why: 'unknown' | 'slow' | 'limited'; retryAfter?: number }
>;
export type HookReply = { status: number; body: string; headers: Record<string, string> };

const json = (status: number, body: unknown, extra: Record<string, string> = {}): HookReply => ({ status, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } });

export async function handleHook(req: HookRequest, deliver: HookDeliver): Promise<HookReply> {
  if (req.method !== 'POST') return json(405, { error: 'POST only' }, { Allow: 'POST' });
  // A page in a browser sends Origin; nothing here is for one.
  if (req.header('origin')) return json(403, { error: 'not for browsers' });
  if (req.body.length > HOOK_BODY_MAX) return json(413, { error: 'too big' });
  const key = /^\/hook\/(tbh_[0-9a-f]{64})\/?$/.exec(req.path)?.[1];
  const hash = key ? await sha256(key) : '';
  const dedupe = req.header('idempotency-key') ?? req.header('x-github-delivery') ?? undefined;
  const out = await deliver({ hash, body: req.body, contentType: req.header('content-type') ?? '', ...(dedupe ? { dedupe } : {}) });
  if (out.ok) return out.duplicate ? json(200, { ok: true, duplicate: true }) : json(202, { ok: true });
  if (out.why === 'unknown') return json(404, { error: 'not found' });
  return json(429, { error: out.why === 'slow' ? 'too many bad keys, try later' : 'over this hook\'s limits' }, { 'Retry-After': String(out.retryAfter ?? 60) });
}
