import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createFastLaneLookup,
  fastLaneHelper,
  formatFastAnswer,
  formatFastHandoff,
  formatFastNote,
  parseExaAnswer,
  parseFastQuery,
} from '../../src/fast-lane.ts';
import { makeHarness, tick, tmpDir } from '../helpers/fakes.ts';

function enableFastLane(home: string): void {
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ experiments: { fastLane: true } }));
}

test('fast-lane: parseFastQuery handles /web prefix and explicit fast flag', () => {
  assert.deepEqual(parseFastQuery('What is the weather in SF?'), { fast: false });
  assert.deepEqual(parseFastQuery('/web'), { fast: false });
  assert.deepEqual(parseFastQuery('/web   '), { fast: false });
  assert.deepEqual(parseFastQuery('/web weather in San Francisco'), {
    fast: true,
    query: 'weather in San Francisco',
    viaPrefix: true,
  });
  assert.deepEqual(parseFastQuery('  /WEB   latest Convex version  '), {
    fast: true,
    query: 'latest Convex version',
    viaPrefix: true,
  });
  assert.deepEqual(parseFastQuery('weather in SF', true), {
    fast: true,
    query: 'weather in SF',
    viaPrefix: false,
  });
  assert.deepEqual(parseFastQuery('/web weather in SF', true), {
    fast: true,
    query: 'weather in SF',
    viaPrefix: false,
  });
  assert.deepEqual(parseFastQuery('   ', true), {
    fast: true,
    query: '',
    viaPrefix: false,
  });
});

test('fast-lane: parseExaAnswer and formatFastAnswer handle wrapped JSON, dated links and plain text', () => {
  const wrapped = JSON.stringify({
    status: 200,
    body: JSON.stringify({
      answer: 'San Francisco is 61F and partly cloudy today.',
      citations: [
        { title: 'National [Weather] Service', url: 'https://weather.gov/sf', publishedDate: '2026-11-21T08:00:00Z' },
        { title: 'Duplicate link', url: 'https://weather.gov/sf', publishedDate: '2026-11-21' },
        { title: 'SF Chronicle', url: 'https://sfchronicle.com/weather' },
      ],
    }),
  });
  const parsed = parseExaAnswer(wrapped);
  assert.equal(parsed.answer, 'San Francisco is 61F and partly cloudy today.');
  assert.equal(parsed.citations.length, 2);
  assert.deepEqual(parsed.citations[0], {
    title: 'National [Weather] Service',
    url: 'https://weather.gov/sf',
    publishedDate: '2026-11-21',
  });
  const formatted = formatFastAnswer(parsed.answer, parsed.citations);
  assert.ok(formatted.includes('San Francisco is 61F and partly cloudy today.'));
  assert.ok(formatted.includes('- [National Weather Service](https://weather.gov/sf) (2026-11-21)'));
  assert.ok(formatted.includes('- [SF Chronicle](https://sfchronicle.com/weather)'));
  assert.equal(formatFastNote(2140, 'Exa'), 'Fast web search · 2.1s · Exa');

  const plain = parseExaAnswer('Just a plain text answer.');
  assert.deepEqual(plain, { answer: 'Just a plain text answer.', citations: [] });
  assert.throws(() => parseExaAnswer('   '), /empty answer/i);
});

test('fast-lane: fastLaneHelper swaps agent id to threadbear or respects override', () => {
  assert.equal(fastLaneHelper('/Users/w/bin/headers.sh claude-main'), '/Users/w/bin/headers.sh threadbear');
  assert.equal(fastLaneHelper('/Users/w/bin/headers.sh claude-main', '/custom/helper.sh'), '/custom/helper.sh');
});

test('fast-lane: createFastLaneLookup calls Connectors treg__call with threadbear helper and 401 fallback', async () => {
  const calls: Array<{ url: string; auth?: string; body: Record<string, unknown> }> = [];
  let nowVal = 1_000;
  const lookup = createFastLaneLookup({
    connectors: {
      mcpUrl: 'http://127.0.0.1:8795/mcp',
      headers: async () => ({ authorization: 'Bearer threadbear-token' }),
      fallback: async () => ({ authorization: 'Bearer main-token' }),
    },
    now: () => {
      nowVal += 500;
      return nowVal;
    },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ url: String(url), auth: headers.authorization, body });
      if (headers.authorization === 'Bearer threadbear-token') {
        return new Response('unauthorized', { status: 401 });
      }
      const rpcReply = {
        jsonrpc: '2.0',
        id: body.id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                answer: 'Convex is at 1.31.0.',
                citations: [{ title: 'npm convex', url: 'https://www.npmjs.com/package/convex', publishedDate: '2026-11-20' }],
              }),
            },
          ],
        },
      };
      return new Response(`event: message\ndata: ${JSON.stringify(rpcReply)}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as typeof fetch,
  });

  const res = await lookup('latest Convex npm version');
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.auth, 'Bearer threadbear-token');
  assert.equal(calls[1]!.auth, 'Bearer main-token');
  const params = (calls[1]!.body.params as { name: string; arguments: { endpoint_id: string; params: { query: string } } });
  assert.equal(params.name, 'treg__call');
  assert.equal(params.arguments.endpoint_id, 'exa.web.answer');
  assert.equal(params.arguments.params.query, 'latest Convex npm version');
  assert.equal(res.answer, 'Convex is at 1.31.0.');
  assert.equal(res.source, 'Exa');
  assert.equal(res.citations.length, 1);
  assert.equal(res.durationMs, 500);
});

test('fast-lane: falls back to direct Exa API when Connectors asks for approval or errors', async () => {
  const seenUrls: string[] = [];
  const lookup = createFastLaneLookup({
    connectors: {
      mcpUrl: 'http://127.0.0.1:8795/mcp',
      headers: async () => ({ authorization: 'Bearer tb' }),
    },
    exa: {
      apiKey: 'exa-test-key',
      url: 'https://api.exa.ai/answer',
    },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrls.push(String(url));
      if (String(url).includes('127.0.0.1:8795')) {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              content: [{ type: 'text', text: 'Waiting for Wayne to approve this at http://127.0.0.1:8795/approvals/ap_123' }],
            },
          }),
          { status: 200 },
        );
      }
      const headers = (init?.headers ?? {}) as Record<string, string>;
      assert.equal(headers['x-api-key'], 'exa-test-key');
      return new Response(
        JSON.stringify({
          answer: 'Fallback answer from direct Exa.',
          citations: [{ title: 'Exa', url: 'https://exa.ai' }],
        }),
        { status: 200 },
      );
    }) as typeof fetch,
  });

  const res = await lookup('test fallback');
  assert.deepEqual(seenUrls, ['http://127.0.0.1:8795/mcp', 'https://api.exa.ai/answer']);
  assert.equal(res.answer, 'Fallback answer from direct Exa.');
  assert.equal(res.source, 'Exa direct');
});

test('fast-lane: experiment off rejects explicit fast: true and leaves /web on stock CLI path', async () => {
  const h = makeHarness();
  assert.throws(
    () => h.runner.create({ text: 'weather in SF', fast: true }),
    /Fast lane is off/i,
  );
  // /web behaves as an ordinary CLI turn while the experiment is off.
  const { thread } = h.runner.create({ text: '/web weather in SF' });
  await tick();
  assert.equal(h.adapter.sessions.length, 1);
  assert.throws(
    () => h.runner.send(thread.id, 'follow up', [], { fast: true }),
    /Fast lane is off/i,
  );
  await h.runner.shutdown();
});

test('fast-lane: Runner executes fast create and /web turns without CLI and preserves handoff context', async () => {
  const home = tmpDir();
  enableFastLane(home);
  const queries: string[] = [];
  const h = makeHarness(home, {}, {
    fastLane: async (query) => {
      queries.push(query);
      return {
        answer: `Answer for ${query}`,
        citations: [{ title: 'Source One', url: 'https://example.com/1', publishedDate: '2026-11-21' }],
        source: 'Exa',
        durationMs: 1_850,
      };
    },
  });

  // 1. Fast create bypasses CLI adapter completely.
  const { thread } = h.runner.create({ text: 'What is the SF weather?', fast: true });
  await tick(6);
  assert.deepEqual(queries, ['What is the SF weather?']);
  assert.equal(h.adapter.sessions.length, 0, 'no coding CLI spawned for fast lane');

  const evs = h.events(thread.id);
  const reply = evs.find((e) => e.type === 'assistant.text');
  assert.ok(reply, 'assistant.text emitted');
  assert.ok(String(reply.text).includes('Answer for What is the SF weather?'));
  assert.ok(String(reply.text).includes('[Source One](https://example.com/1) (2026-11-21)'));
  const note = evs.find((e) => e.type === 'system.note' && String(e.text).includes('Fast web search'));
  assert.equal(note?.text, 'Fast web search · 1.9s · Exa');
  const done = evs.find((e) => e.type === 'turn.completed');
  assert.equal(done?.outcome, 'completed');
  assert.equal(done?.needs, 'nothing');

  // 2. Follow-up normal coding turn starts CLI with handoff context from the fast lookup.
  h.runner.send(thread.id, 'Now build a widget using that forecast.');
  await tick(6);
  assert.equal(h.adapter.sessions.length, 1);
  const firstCliMsg = h.adapter.sessions[0]!.sent[0]!.text;
  assert.ok(firstCliMsg.includes('[Threadbear handoff] This thread began with a read-only fast web search'));
  assert.ok(firstCliMsg.includes('Answer for What is the SF weather?'));
  assert.ok(firstCliMsg.includes('Now build a widget using that forecast.'));

  // Finish the coding turn so session is live and idle.
  h.adapter.sessions[0]!.init();
  h.adapter.sessions[0]!.text('m1', 'Built the widget.');
  h.adapter.sessions[0]!.result();
  await tick(6);

  // 3. Mid-thread /web prefix (as from iPhone) runs Fast lane without spawning a new CLI.
  h.runner.send(thread.id, '/web latest Convex version', [], { origin: 'phone' });
  await tick(6);
  assert.deepEqual(queries, ['What is the SF weather?', 'latest Convex version']);
  assert.equal(h.adapter.sessions.length, 1, 'still only the original CLI session');
  assert.equal(h.adapter.sessions[0]!.sent.length, 1, 'fast turn did not send into coding CLI');

  // 4. Subsequent coding turn on the SAME live CLI receives the mid-thread fast search context.
  h.runner.send(thread.id, 'Bump package.json to that version.');
  await tick(6);
  assert.equal(h.adapter.sessions[0]!.sent.length, 2);
  const secondCliMsg = h.adapter.sessions[0]!.sent[1]!.text;
  assert.ok(secondCliMsg.includes('[Threadbear fast web search context]'));
  assert.ok(secondCliMsg.includes('Answer for latest Convex version'));
  assert.ok(secondCliMsg.includes('Bump package.json to that version.'));

  await h.runner.shutdown();
});

test('fast-lane: lookup error fails cleanly and interrupt aborts an in-flight lookup', async () => {
  const home = tmpDir();
  enableFastLane(home);
  let aborted = false;
  let releasePending: (() => void) | undefined;
  let mode: 'error' | 'hang' = 'error';

  const h = makeHarness(home, {}, {
    fastLane: async (_query, opts) => {
      if (mode === 'error') throw new Error('Connectors gateway answered 503.');
      return await new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('Aborted', 'AbortError'));
        });
        releasePending = () => reject(new Error('released'));
      });
    },
  });

  // Error path fails the turn cleanly with the error message.
  const { thread } = h.runner.create({ text: 'test error', fast: true });
  await tick(6);
  const failed = h.events(thread.id).find((e) => e.type === 'turn.completed');
  assert.equal(failed?.outcome, 'failed');
  assert.match(String(failed?.error), /503/);

  // Interrupt path aborts the HTTP lookup immediately.
  mode = 'hang';
  h.runner.send(thread.id, '/web slow query');
  await tick(3);
  h.runner.interrupt(thread.id, { byMike: true });
  await tick(6);
  assert.equal(aborted, true);
  const interrupted = h.events(thread.id).filter((e) => e.type === 'turn.completed').at(-1);
  assert.equal(interrupted?.outcome, 'interrupted');
  releasePending?.();

  const handoff = formatFastHandoff('q', 'a');
  assert.ok(handoff.includes('[Threadbear fast web search context]'));
  await h.runner.shutdown();
});
