// X search (the xSearch experiment, src/x-search.ts): the request it sends
// xAI, the answer it gives back, and the x_search tool's key handling. No
// network: xAI is a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
import { buildThreadbearTools, NEVER_ASK_TOOLS, type ThreadControl } from '../../src/threadbear-mcp.ts';
import { XAI_MODEL, XAI_RESPONSES_URL, formatXSearch, postHandle, parseXSearch, readXaiKey, saveXaiKey, xSearchBody, xSearchMethods, xSearchProblem, xaiKeyPath } from '../../src/x-search.ts';
import type { SecretAnswer, SecretRequest } from '../../src/runner/approvals.ts';

const KEY = 'xai-test-0123456789abcdef';

const RESPONSE = {
  output: [
    { type: 'custom_tool_call', name: 'x_keyword_search' },
    {
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: 'People like the new release [1].',
          annotations: [
            { type: 'url_citation', url: 'https://x.com/a/status/1', title: '1' },
            { type: 'url_citation', url: 'https://x.com/a/status/1', title: '1' },
            { type: 'url_citation', url: 'javascript:alert(1)', title: '2' },
          ],
        },
      ],
    },
  ],
  usage: { input_tokens: 900, output_tokens: 80, cost_in_usd_ticks: 412_000_000, server_side_tool_usage_details: { x_search_calls: 2, x_posts_fetched: 31, x_users_fetched: 0 } },
};

test('xSearchProblem: handles, dates and their order', () => {
  assert.equal(xSearchProblem({ query: 'q' }), undefined);
  assert.equal(xSearchProblem({ query: 'q', handles: ['@convex_dev', 'mikecann'], from: '2026-11-01', to: '2026-11-09' }), undefined);
  assert.match(xSearchProblem({ query: 'q', handles: ['a'], excludeHandles: ['b'] })!, /not both/);
  assert.match(xSearchProblem({ query: 'q', handles: ['not a handle'] })!, /isn't an X handle/);
  assert.match(xSearchProblem({ query: 'q', handles: Array.from({ length: 21 }, (_, i) => `h${i}`) })!, /At most 20/);
  assert.match(xSearchProblem({ query: 'q', from: '9 Nov' })!, /isn't a date/);
  assert.match(xSearchProblem({ query: 'q', from: '2026-11-09', to: '2026-11-09' })!, /before/);
});

test('xSearchBody: the x_search tool with only what was given, handles without @', () => {
  const body = xSearchBody({ query: 'What is Convex shipping?', handles: ['@convex_dev', 'convex_dev'], from: '2026-11-01' });
  assert.equal(body.model, XAI_MODEL);
  assert.deepEqual(body.tools, [{ type: 'x_search', allowed_x_handles: ['convex_dev'], from_date: '2026-11-01' }]);
  const input = body.input as { role: string; content: string }[];
  assert.deepEqual(input.at(-1), { role: 'user', content: 'What is Convex shipping?' });
  assert.deepEqual((xSearchBody({ query: 'q' }).tools as unknown[])[0], { type: 'x_search' });
});

test('parseXSearch and formatXSearch: the answer, each https source once, and the bill', () => {
  const r = parseXSearch(RESPONSE);
  assert.equal(r.answer, 'People like the new release [1].');
  assert.deepEqual(r.sources, ['https://x.com/a/status/1']);
  assert.deepEqual([r.searches, r.posts, r.profiles], [2, 31, 0]);
  assert.equal(r.costUsd, 0.0412);
  const text = formatXSearch(r);
  assert.match(text, /Sources:\n- https:\/\/x\.com\/a\/status\/1/);
  assert.match(text, /xAI: 2 searches, 31 posts; \$0\.04 billed\./);
  assert.equal(formatXSearch(parseXSearch({})), 'Grok gave no answer.');
});

test('saveXaiKey: owner-only, trimmed, read back', () => {
  const dir = path.join(tmpDir(), 'secrets');
  assert.equal(readXaiKey(dir), undefined);
  saveXaiKey(dir, `  ${KEY}\n`);
  assert.equal(readXaiKey(dir), KEY);
  assert.equal(fs.statSync(xaiKeyPath(dir)).mode & 0o777, 0o600);
});

type Call = { url: string; init: RequestInit };
function setup(o: { status?: number; secret?: SecretAnswer | 'none' } = {}) {
  const dir = path.join(tmpDir(), 'secrets');
  const calls: Call[] = [];
  const asked: SecretRequest[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(o.status && o.status >= 400 ? { error: 'nope' } : RESPONSE), { status: o.status ?? 200 });
  }) as unknown as typeof fetch;
  const answer = (): SecretAnswer => {
    if (o.secret && o.secret !== 'none') return o.secret;
    const file = path.join(tmpDir(), 'asked');
    fs.writeFileSync(file, KEY);
    fs.writeFileSync(`${file}.askpass`, '#!/bin/sh\n');
    return { status: 'saved', file, askpass: `${file}.askpass` };
  };
  const control = new Proxy({}, { get: (_, k) => (k === 'requestSecret' ? async (_id: string, req: SecretRequest) => (asked.push(req), answer()) : () => undefined) }) as ThreadControl;
  const list = buildThreadbearTools(control, 'self', Date.now, undefined, undefined, undefined, { xSearch: () => ({ secretsDir: dir, fetch: fakeFetch }) });
  const t = list.find((x) => x.name === 'x_search');
  assert.ok(t, 'x_search is offered');
  const call = async (args: Record<string, unknown>) => {
    const r = (await t.handler(args as never, {})) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join('\n'), error: r.isError === true };
  };
  return { dir, calls, asked, call };
}

test('x_search: only handed out with the experiment on, and never asks first', () => {
  const names = buildThreadbearTools({} as ThreadControl, 'self', Date.now).map((t) => t.name);
  assert.ok(!names.includes('x_search'));
  assert.ok(NEVER_ASK_TOOLS.has('mcp__threadbear__x_search'));
});

test('x_search: the first call asks for the key, keeps it, and the next reuses it', async () => {
  const s = setup();
  const first = await s.call({ query: 'What are people saying about Convex?' });
  assert.equal(first.error, false, first.text);
  assert.equal(s.asked.length, 1);
  assert.equal(s.asked[0].label, 'xAI API key');
  assert.equal(readXaiKey(s.dir), KEY);
  assert.match(first.text, /People like the new release/);
  assert.ok(!first.text.includes(KEY));
  assert.equal(s.calls[0].url, XAI_RESPONSES_URL);
  assert.equal((s.calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
  await s.call({ query: 'again' });
  assert.equal(s.asked.length, 1, 'not asked twice');
  assert.equal(s.calls.length, 2);
});

test('x_search: a declined card, bad arguments and a rejected key', async () => {
  const declined = setup({ secret: { status: 'declined' } });
  const d = await declined.call({ query: 'q' });
  assert.match(d.text, /declined/);
  assert.equal(declined.calls.length, 0);

  const bad = setup();
  const b = await bad.call({ query: 'q', handles: ['a'], excludeHandles: ['b'] });
  assert.ok(b.error);
  assert.equal(bad.asked.length + bad.calls.length, 0, 'no card and no paid call');

  const rejected = setup({ status: 401 });
  saveXaiKey(rejected.dir, KEY);
  const r = await rejected.call({ query: 'q' });
  assert.ok(r.error);
  assert.match(r.text, /turned the key down \(401\).*forgot it/);
  assert.equal(readXaiKey(rejected.dir), undefined);

  const down = setup({ status: 500 });
  saveXaiKey(down.dir, KEY);
  const e = await down.call({ query: 'q' });
  assert.match(e.text, /xAI said 500: nope\./);
  assert.equal(readXaiKey(down.dir), KEY, 'kept on other errors');
});

test('xSearchBody: with handles, the prompt keeps Grok to those accounts', () => {
  const sys = (xSearchBody({ query: 'q', handles: ['convex'] }).input as { content: string }[])[0].content;
  assert.match(sys, /only posts written by @convex/);
  assert.doesNotMatch((xSearchBody({ query: 'q' }).input as { content: string }[])[0].content, /only posts written/);
  assert.equal(xSearchBody({ query: 'q' }).max_turns, 2);
});

test('formatXSearch: sources from other accounts than the handles are listed apart', () => {
  assert.equal(postHandle('https://x.com/Convex/status/1'), 'convex');
  assert.equal(postHandle('https://twitter.com/a_b/status/2?s=1'), 'a_b');
  assert.equal(postHandle('https://luma.com/x'), undefined);
  const r = { answer: 'a', sources: ['https://x.com/convex/status/1', 'https://x.com/someone_else/status/2', 'https://luma.com/e'], posts: 3 };
  const text = formatXSearch(r, ['@Convex']);
  assert.match(text, /Sources:\n- https:\/\/x\.com\/convex\/status\/1\n- https:\/\/luma\.com\/e\n\nFrom other accounts than @convex:\n- https:\/\/x\.com\/someone_else\/status\/2/);
  assert.doesNotMatch(formatXSearch(r), /other accounts/);
});

test('xSearch.status and xSearch.forgetKey: whether a key is saved, never the key', async () => {
  const dir = path.join(tmpDir(), 'secrets');
  let on = true;
  const m = xSearchMethods({ on: () => on, secretsDir: dir });
  assert.deepEqual(await m['xSearch.status']!({}), { on: true, keySaved: false });
  saveXaiKey(dir, KEY);
  const saved = await m['xSearch.status']!({});
  assert.deepEqual(saved, { on: true, keySaved: true });
  assert.ok(!JSON.stringify(saved).includes(KEY));
  assert.deepEqual(await m['xSearch.forgetKey']!({}), { on: true, keySaved: false });
  assert.equal(readXaiKey(dir), undefined);
  on = false;
  assert.deepEqual(await m['xSearch.status']!({}), { on: false, keySaved: false });
});
