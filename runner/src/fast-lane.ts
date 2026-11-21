// Fast lane (experiment `fastLane`): read-only quick web lookup that answers
// in a couple of seconds without spawning a coding CLI, loading skills or
// touching local files. Calls `treg__call` (`exa.web.answer`) through the
// local Connectors gateway as the Threadbear agent, with an optional direct
// Exa fallback configured in `runner.json`.
import type { Logger } from './log.ts';
import { helperHeaders, parseRpc } from './notion-tasks.ts';
import { cutSafely } from './safe-cut.ts';
import { credentialUrlProblem } from './secure-url.ts';

// The gateway's "Waiting for Wayne" reply carries an approvals link: a fast
// turn says so rather than showing the raw text.
function waitingFor(text: string): { id: string; url: string } | undefined {
  if (!/waiting for/i.test(text)) return undefined;
  const m = /(https?:\/\/\S+?\/approvals\/(ap_[\w-]+))/.exec(text);
  return m ? { id: m[2]!, url: m[1]! } : undefined;
}

// The main login's headers helper, pointed at another of the gateway's
// agent ids (`headers.sh <agent>`), so its calls show as Threadbear's.
function helperForAgent(mainHelper: string, agentId: string): string | undefined {
  if (!/^[a-z0-9-]+$/.test(agentId)) return undefined;
  const m = /^(.*headers\.sh['"]?)\s+\S+\s*$/.exec(mainHelper.trim());
  return m ? `${m[1]} ${agentId}` : undefined;
}

export const FAST_LANE_EXPERIMENT = 'fastLane';
export const DEFAULT_FAST_LANE_ENDPOINT = 'exa.web.answer';
export const DEFAULT_FAST_LANE_TIMEOUT_MS = 15_000;
export const DEFAULT_EXA_ANSWER_URL = 'https://api.exa.ai/answer';
const MIN_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_CITATIONS = 8;
const MAX_HANDOFF_CHARS = 2_500;

export type FastLaneConfig = {
  timeoutMs?: number;
  endpointId?: string;
  headersHelper?: string;
  exaApiKey?: string;
  exaUrl?: string;
};

export type FastCitation = {
  title: string;
  url: string;
  publishedDate?: string;
};

export type FastLookupResult = {
  answer: string;
  citations: FastCitation[];
  source: string;
  durationMs: number;
};

export type FastLookup = (query: string, opts?: { signal?: AbortSignal }) => Promise<FastLookupResult>;

export type ParsedFastQuery =
  | { fast: true; query: string; viaPrefix: boolean }
  | { fast: false };

const WEB_PREFIX = /^\/web(?:\s+([\s\S]*))?$/i;

/** Detects whether a turn should use the fast lane (`fast: true` or `/web <query>`). */
export function parseFastQuery(text: string, fastFlag = false): ParsedFastQuery {
  const trimmed = text.trim();
  const match = WEB_PREFIX.exec(trimmed);
  if (fastFlag) {
    const query = match ? (match[1] ?? '').trim() : trimmed;
    return { fast: true, query, viaPrefix: false };
  }
  if (match && match[1] && match[1].trim()) {
    return { fast: true, query: match[1].trim(), viaPrefix: true };
  }
  return { fast: false };
}

/** Connectors login helper for Fast lane: override, else the `threadbear` agent login. */
export function fastLaneHelper(mainHelper: string, override?: string): string | undefined {
  if (override?.trim()) return override.trim();
  return helperForAgent(mainHelper, 'threadbear');
}

function clampTimeout(ms: number | undefined): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return DEFAULT_FAST_LANE_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.floor(ms)));
}

function combinedSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timer = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([external, timer]) : timer;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function unwrapPayload(raw: unknown): Json | undefined {
  let current = asObject(raw);
  for (let depth = 0; depth < 3 && current; depth++) {
    if (typeof current.answer === 'string' || Array.isArray(current.citations) || Array.isArray(current.results)) {
      return current;
    }
    const next = current.body ?? current.data ?? current.response ?? current.result;
    if (typeof next === 'string') {
      current = asObject(tryJson(next));
    } else {
      current = asObject(next);
    }
  }
  return current;
}

function formatIsoDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  if (iso) return iso[1];
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toISOString().slice(0, 10);
}

function extractCitations(payload: Json): FastCitation[] {
  const list = Array.isArray(payload.citations)
    ? payload.citations
    : Array.isArray(payload.sources)
      ? payload.sources
      : Array.isArray(payload.results)
        ? payload.results
        : [];
  const seen = new Set<string>();
  const out: FastCitation[] = [];
  for (const entry of list) {
    const item = asObject(entry);
    if (!item) continue;
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const rawTitle = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : url;
    const publishedDate = formatIsoDate(item.publishedDate ?? item.published_date ?? item.date);
    out.push({ title: rawTitle, url, ...(publishedDate ? { publishedDate } : {}) });
    if (out.length >= MAX_CITATIONS) break;
  }
  return out;
}

/** Parses `exa.web.answer` JSON (or wrapped `treg__call` responses) into answer + dated citations. */
export function parseExaAnswer(rawText: string): { answer: string; citations: FastCitation[] } {
  const trimmed = rawText.trim();
  if (!trimmed) throw new Error('Fast web search returned an empty answer.');
  const parsed = tryJson(trimmed);
  const payload = unwrapPayload(parsed);
  if (!payload) {
    return { answer: trimmed, citations: [] };
  }
  const answer = typeof payload.answer === 'string' && payload.answer.trim()
    ? payload.answer.trim()
    : typeof payload.text === 'string' && payload.text.trim()
      ? payload.text.trim()
      : '';
  const citations = extractCitations(payload);
  if (!answer && citations.length === 0) {
    throw new Error('Fast web search returned no answer.');
  }
  return { answer: answer || 'Here are the top matching sources:', citations };
}

/** Formats the fast-lane reply markdown with compact dated citation links. */
export function formatFastAnswer(answer: string, citations: FastCitation[]): string {
  const body = answer.trim();
  if (!citations.length) return body;
  const links = citations.map((c) => {
    const cleanTitle = c.title.replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim() || c.url;
    const date = c.publishedDate ? ` (${c.publishedDate})` : '';
    return `- [${cleanTitle}](${c.url})${date}`;
  });
  return `${body}\n\n${links.join('\n')}`;
}

/** Compact system note shown under a fast-lane reply on both GPUI and iPhone. */
export function formatFastNote(durationMs: number, source = 'Exa'): string {
  const secs = Math.max(0.1, durationMs / 1000).toFixed(1);
  return `Fast web search · ${secs}s · ${source}`;
}

/** Compact handoff line injected before the next coding turn when a live session follows a fast lookup. */
export function formatFastHandoff(question: string, answer: string): string {
  const q = cutSafely(question.trim(), 300);
  const a = cutSafely(answer.trim(), MAX_HANDOFF_CHARS);
  return (
    `[Threadbear fast web search context] Between coding turns, the user ran a read-only fast web lookup.\n` +
    `Question: ${q}\n` +
    `Answer:\n${a}\n` +
    `[End of fast web search context. The new message follows.]\n\n`
  );
}

export type FastLaneLookupOptions = {
  connectors?: {
    mcpUrl: string;
    headers: () => Promise<Record<string, string>>;
    fallback?: () => Promise<Record<string, string>>;
  };
  endpointId?: string;
  exa?: {
    apiKey: string;
    url?: string;
  };
  timeoutMs?: number;
  fetch?: typeof fetch;
  log?: Logger;
  now?: () => number;
};

/**
 * Creates a read-only Fast lane lookup function.
 * Primary: local Connectors gateway `treg__call` (`exa.web.answer`).
 * Optional fallback: direct Exa Answer API when `fastLane.exaApiKey` is configured in `runner.json`.
 */
export function createFastLaneLookup(opts: FastLaneLookupOptions): FastLookup {
  const f = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const timeoutMs = clampTimeout(opts.timeoutMs);
  const endpointId = opts.endpointId?.trim() || DEFAULT_FAST_LANE_ENDPOINT;
  let rpcId = 0;
  let useMainHelper = false;

  async function callConnectors(query: string, signal?: AbortSignal): Promise<{ answer: string; citations: FastCitation[] }> {
    const conn = opts.connectors;
    if (!conn) throw new Error('Connectors is not configured on this Mac.');
    const problem = credentialUrlProblem(conn.mcpUrl);
    if (problem) throw new Error(`The Connectors gateway URL ${problem}.`);

    const loadHeaders = async (): Promise<Record<string, string>> => {
      if (!useMainHelper) {
        try {
          return await conn.headers();
        } catch (err) {
          if (!conn.fallback) throw err;
          useMainHelper = true;
          opts.log?.warn('fast-lane: no Threadbear login for Connectors, falling back to main login');
        }
      }
      return conn.fallback!();
    };

    const post = async (hdrs: Record<string, string>) =>
      f(conn.mcpUrl, {
        method: 'POST',
        headers: { ...hdrs, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++rpcId,
          method: 'tools/call',
          params: {
            name: 'treg__call',
            arguments: {
              endpoint_id: endpointId,
              params: { query, text: true },
            },
          },
        }),
        redirect: 'error',
        signal: combinedSignal(timeoutMs, signal),
      });

    let res = await post(await loadHeaders());
    if (res.status === 401 && !useMainHelper && conn.fallback) {
      useMainHelper = true;
      res = await post(await conn.fallback());
    }
    if (!res.ok) throw new Error(`Connectors gateway answered ${res.status}.`);
    const msg = parseRpc(await res.text());
    if (msg.error) throw new Error(msg.error.message ?? 'Connectors gateway returned an error.');
    const text = (msg.result?.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
    if (msg.result?.isError) throw new Error(text.slice(0, 300) || 'Fast web search failed at Connectors.');
    const held = waitingFor(text);
    if (held) {
      throw new Error(`Connectors asked for approval before running fast web search (${held.url}).`);
    }
    return parseExaAnswer(text);
  }

  async function callDirectExa(query: string, signal?: AbortSignal): Promise<{ answer: string; citations: FastCitation[] }> {
    const exa = opts.exa;
    if (!exa?.apiKey) throw new Error('No direct Exa fallback key is configured.');
    const url = exa.url?.trim() || DEFAULT_EXA_ANSWER_URL;
    const problem = credentialUrlProblem(url);
    if (problem) throw new Error(`The Exa API URL ${problem}.`);
    const res = await f(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-api-key': exa.apiKey,
      },
      body: JSON.stringify({ query, text: true }),
      redirect: 'error',
      signal: combinedSignal(timeoutMs, signal),
    });
    if (!res.ok) throw new Error(`Exa answered ${res.status}.`);
    return parseExaAnswer(await res.text());
  }

  return async (query: string, callOpts?: { signal?: AbortSignal }): Promise<FastLookupResult> => {
    const clean = query.trim();
    if (!clean) throw new Error('Fast web search needs a question.');
    const startedAt = now();
    const signal = callOpts?.signal;
    let connectorsErr: unknown;

    if (opts.connectors) {
      try {
        const { answer, citations } = await callConnectors(clean, signal);
        return { answer, citations, source: 'Exa', durationMs: Math.max(0, now() - startedAt) };
      } catch (err) {
        if (signal?.aborted) throw err;
        connectorsErr = err;
        opts.log?.warn('fast-lane: Connectors lookup failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (opts.exa?.apiKey) {
      try {
        const { answer, citations } = await callDirectExa(clean, signal);
        return { answer, citations, source: 'Exa direct', durationMs: Math.max(0, now() - startedAt) };
      } catch (err) {
        if (signal?.aborted) throw err;
        if (isAbortError(err)) {
          throw new Error(`Fast web search timed out after ${Math.round(timeoutMs / 1000)}s.`);
        }
        throw err;
      }
    }

    if (connectorsErr) {
      if (isAbortError(connectorsErr)) {
        throw new Error(`Fast web search timed out after ${Math.round(timeoutMs / 1000)}s.`);
      }
      throw connectorsErr;
    }
    throw new Error('Fast web search needs local Connectors (treg) or fastLane.exaApiKey in runner.json.');
  };
}

/** Builds the live runner's Fast lane lookup from runner config (Connectors + optional runner.json fallback). */
export function fastLaneFromConfig(
  connectorsClient: { mcpUrl: string; headersHelper: string } | undefined,
  fastLaneCfg: FastLaneConfig | undefined,
  log?: Logger,
): FastLookup {
  const helperCmd = connectorsClient ? fastLaneHelper(connectorsClient.headersHelper, fastLaneCfg?.headersHelper) : undefined;
  const connectors = connectorsClient
    ? {
        mcpUrl: connectorsClient.mcpUrl,
        headers: helperHeaders(helperCmd ?? connectorsClient.headersHelper),
        ...(helperCmd ? { fallback: helperHeaders(connectorsClient.headersHelper) } : {}),
      }
    : undefined;
  const exa = fastLaneCfg?.exaApiKey?.trim()
    ? { apiKey: fastLaneCfg.exaApiKey.trim(), ...(fastLaneCfg.exaUrl ? { url: fastLaneCfg.exaUrl } : {}) }
    : undefined;
  return createFastLaneLookup({
    ...(connectors ? { connectors } : {}),
    ...(fastLaneCfg?.endpointId ? { endpointId: fastLaneCfg.endpointId } : {}),
    ...(exa ? { exa } : {}),
    ...(fastLaneCfg?.timeoutMs !== undefined ? { timeoutMs: fastLaneCfg.timeoutMs } : {}),
    ...(log ? { log } : {}),
  });
}
