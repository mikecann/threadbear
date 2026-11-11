// X search (the xSearch experiment, experiments/xSearch.md): the x_search
// threadbear tool asks xAI's Grok to search X and answer, through xAI's
// Responses API with its server-side `x_search` tool. X's own API has no
// search a thread can reach without a paid key of its own, and agents'
// web search can't read X, so this is how a thread sees what people are
// posting.
//
// The xAI key is the user's own, asked for once in a secret card and kept
// in the runner's secrets/ folder, which the mirror's masking already reads
// (secret-values.ts), so the key never reaches Convex even if it turns up
// in a thread. Nothing here logs it, and errors never include it.
import fs from 'node:fs';
import path from 'node:path';

export const XAI_KEY_FILE = 'xai-api-key';
export const XAI_RESPONSES_URL = 'https://api.x.ai/v1/responses';
// docs.x.ai/developers/pricing, 9 Nov 2026: the newest model on the public
// API. The search itself is billed per post and profile returned, the same
// whichever model asks.
export const XAI_MODEL = 'grok-4.7';
export const MAX_HANDLES = 20;
// One call can't run long or come back huge. Grok decides how many
// searches to make, and max_turns caps its rounds, not the searches in
// each (docs.x.ai, tool-usage-details): the first real call, with 3, ran
// 41 searches for $0.26 (11 Nov). So rounds are 2, as xAI's own examples
// use, and the prompt asks for few searches. The answer is cut too.
const MAX_TURNS = 2;
const TIMEOUT_MS = 120_000;
const MAX_ANSWER = 8000;
const MAX_SOURCES = 20;
// usage.cost_in_usd_ticks: 1 USD is 10^10 ticks (docs.x.ai/developers/cost-tracking).
const TICKS_PER_USD = 1e10;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

export function xaiKeyPath(secretsDir: string): string {
  return path.join(secretsDir, XAI_KEY_FILE);
}

export function readXaiKey(secretsDir: string): string | undefined {
  try {
    const key = fs.readFileSync(xaiKeyPath(secretsDir), 'utf8').trim();
    return key || undefined;
  } catch {
    return undefined;
  }
}

// Owner-only, written beside the runner's other secrets and renamed into
// place, so a reader never sees half a key.
export function saveXaiKey(secretsDir: string, key: string): void {
  const value = key.trim();
  if (!value) throw new Error('The key is empty.');
  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const file = xaiKeyPath(secretsDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, value, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function forgetXaiKey(secretsDir: string): void {
  fs.rmSync(xaiKeyPath(secretsDir), { force: true });
}

export type XSearchArgs = {
  query: string;
  handles?: string[];
  excludeHandles?: string[];
  from?: string;
  to?: string;
};

// Handles as xAI takes them: no @, X's own rules for the name.
export function cleanHandles(raw: readonly string[] | undefined): string[] {
  return [...new Set((raw ?? []).map((h) => h.trim().replace(/^@/, '')).filter(Boolean))];
}

// Why these arguments can't go to xAI, or undefined when they can. xAI
// rejects some of these itself, but a plain reason here saves a paid call.
export function xSearchProblem(a: XSearchArgs): string | undefined {
  const handles = cleanHandles(a.handles);
  const excluded = cleanHandles(a.excludeHandles);
  if (handles.length && excluded.length) return 'Give handles or excludeHandles, not both: xAI takes one or the other.';
  for (const list of [handles, excluded]) {
    if (list.length > MAX_HANDLES) return `At most ${MAX_HANDLES} handles.`;
    const bad = list.find((h) => !HANDLE.test(h));
    if (bad) return `"${bad}" isn't an X handle (letters, numbers and _, up to 15).`;
  }
  for (const d of [a.from, a.to]) if (d !== undefined && (!DATE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)))) return `"${d}" isn't a date like 2026-11-09.`;
  if (a.from && a.to && a.from >= a.to) return 'from has to be before to (to is the day after the last one searched).';
  return undefined;
}

export function xSearchBody(a: XSearchArgs): Record<string, unknown> {
  const handles = cleanHandles(a.handles);
  const excluded = cleanHandles(a.excludeHandles);
  const tool: Record<string, unknown> = { type: 'x_search' };
  if (handles.length) tool.allowed_x_handles = handles;
  if (excluded.length) tool.excluded_x_handles = excluded;
  if (a.from) tool.from_date = a.from;
  if (a.to) tool.to_date = a.to;
  // xAI applies the handles to keyword and semantic searches only: user
  // search, thread fetches and quoted or parent posts can bring in other
  // accounts (docs.x.ai, x-search). The first real call, kept to one
  // handle, quoted three others (11 Nov), so the prompt says it too.
  const keep = handles.length
    ? ` Use and quote only posts written by ${handles.map((h) => `@${h}`).join(', ')}. If they posted nothing about it, say so rather than citing other accounts.`
    : '';
  return {
    model: XAI_MODEL,
    input: [
      {
        role: 'system',
        content: `Search X to answer, with as few searches as you need: two or three is usually enough. Be brief and factual. Quote posts exactly when you quote them, with the handle and date, and cite each post you rely on. Say plainly when you found little or nothing.${keep}`,
      },
      { role: 'user', content: a.query },
    ],
    tools: [tool],
    max_turns: MAX_TURNS,
    store: false,
  };
}

type Annotation = { type?: unknown; url?: unknown };
type OutputItem = { type?: unknown; content?: { type?: unknown; text?: unknown; annotations?: Annotation[] }[] };
type Usage = { input_tokens?: unknown; output_tokens?: unknown; cost_in_usd_ticks?: unknown; server_side_tool_usage_details?: Record<string, unknown> };

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export type XSearchResult = { answer: string; sources: string[]; posts?: number; profiles?: number; searches?: number; costUsd?: number };

export function parseXSearch(json: unknown): XSearchResult {
  const r = (json ?? {}) as { output?: OutputItem[]; usage?: Usage };
  const texts: string[] = [];
  const sources: string[] = [];
  for (const item of Array.isArray(r.output) ? r.output : []) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const c of item.content) {
      if (c?.type !== 'output_text' || typeof c.text !== 'string') continue;
      texts.push(c.text);
      for (const a of Array.isArray(c.annotations) ? c.annotations : []) {
        if (a?.type === 'url_citation' && typeof a.url === 'string' && /^https:\/\//.test(a.url) && !sources.includes(a.url)) sources.push(a.url);
      }
    }
  }
  const d = r.usage?.server_side_tool_usage_details ?? {};
  const ticks = num(r.usage?.cost_in_usd_ticks);
  return {
    answer: texts.join('\n\n').trim(),
    sources,
    posts: num(d.x_posts_fetched),
    profiles: num(d.x_users_fetched),
    searches: num(d.x_search_calls),
    costUsd: ticks === undefined ? undefined : ticks / TICKS_PER_USD,
  };
}

// The account a post link is from: x.com/<handle>/status/<id>.
export function postHandle(url: string): string | undefined {
  const m = /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\//.exec(url);
  return m?.[1].toLowerCase();
}

// With handles asked for, sources from other accounts are listed apart, as
// xAI's filter doesn't cover every search (xSearchBody), so the agent can
// tell what's really from those accounts.
export function formatXSearch(r: XSearchResult, handles: readonly string[] = []): string {
  const answer = r.answer ? (r.answer.length > MAX_ANSWER ? `${r.answer.slice(0, MAX_ANSWER)}…` : r.answer) : 'Grok gave no answer.';
  const lines = [answer];
  const asked = new Set(cleanHandles(handles).map((h) => h.toLowerCase()));
  const sources = r.sources.slice(0, MAX_SOURCES);
  const outside = asked.size ? sources.filter((u) => { const h = postHandle(u); return h !== undefined && !asked.has(h); }) : [];
  const inside = sources.filter((u) => !outside.includes(u));
  if (inside.length) lines.push('', 'Sources:', ...inside.map((u) => `- ${u}`));
  if (outside.length) lines.push('', `From other accounts than ${[...asked].map((h) => `@${h}`).join(', ')}:`, ...outside.map((u) => `- ${u}`));
  const used = [
    r.searches !== undefined ? `${r.searches} search${r.searches === 1 ? '' : 'es'}` : '',
    r.posts !== undefined ? `${r.posts} post${r.posts === 1 ? '' : 's'}` : '',
    r.profiles ? `${r.profiles} profile${r.profiles === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  const cost = r.costUsd !== undefined ? `$${r.costUsd < 0.01 ? r.costUsd.toFixed(4) : r.costUsd.toFixed(2)}` : '';
  if (used.length || cost) lines.push('', `xAI: ${[used.join(', '), cost && `${cost} billed`].filter(Boolean).join('; ')}.`);
  return lines.join('\n');
}

// A rejected key, as opposed to anything else going wrong: the tool then
// forgets it, so the next call asks for a new one.
export class XaiKeyRejected extends Error {}

export async function xSearch(a: XSearchArgs, key: string, deps: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<XSearchResult> {
  const doFetch = deps.fetch ?? fetch;
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await doFetch(XAI_RESPONSES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(xSearchBody(a)),
      signal,
    });
  } catch (e) {
    if (timeout.aborted) throw new Error(`xAI didn't answer within ${TIMEOUT_MS / 1000} seconds.`);
    throw new Error(`Couldn't reach xAI: ${(e as Error).message}`);
  }
  if (res.status === 401 || res.status === 403) throw new XaiKeyRejected(`xAI turned the key down (${res.status}).`);
  const text = await res.text();
  if (!res.ok) {
    // xAI's own message, cut short; it never echoes the key.
    let why = '';
    try {
      const j = JSON.parse(text) as { error?: unknown; message?: unknown };
      const e = j.error as { message?: unknown } | string | undefined;
      why = typeof e === 'string' ? e : typeof e?.message === 'string' ? e.message : typeof j.message === 'string' ? j.message : '';
    } catch {
      why = '';
    }
    throw new Error(`xAI said ${res.status}${why ? `: ${why.slice(0, 300)}` : ''}.`);
  }
  try {
    return parseXSearch(JSON.parse(text));
  } catch {
    throw new Error("xAI's answer wasn't JSON.");
  }
}

// xSearch.status and xSearch.forgetKey (docs/protocol.md, "X search"): the
// Connectors panel's X search row. Whether a key is saved, never the key.
export function xSearchMethods(deps: { on: () => boolean; secretsDir: string }): Record<string, (p: Record<string, unknown>) => unknown> {
  const status = () => ({ on: deps.on(), keySaved: readXaiKey(deps.secretsDir) !== undefined });
  return {
    'xSearch.status': () => status(),
    'xSearch.forgetKey': () => {
      forgetXaiKey(deps.secretsDir);
      return status();
    },
  };
}
