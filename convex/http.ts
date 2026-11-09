// The website's HTTP routes (docs/website.md). Everything is the static
// site from the static-hosting component, except a shared thread's page,
// /s/<slug>, which is the same index.html with that thread's title, the
// start of its last reply and its first picture in the meta tags, so a
// link pasted into Slack, X or iMessage unfurls as the thread rather than
// as plain "Threadbear". Link-preview bots don't run the page's script, so
// the tags have to be in the HTML itself.
import { httpRouter } from 'convex/server';
import { registerStaticRoutes } from '@convex-dev/static-hosting';
import { components, internal } from './_generated/api';
import { httpAction } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { MAX_RUNNER_UPLOAD_BYTES } from './sync';
import { PHONE_UPLOADS } from './phone';
import { sha256 } from './lib';
import { handleMcp, MCP_BODY_MAX } from './mcpRpc';

const http = httpRouter();

http.route({
  pathPrefix: '/s/',
  method: 'GET',
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const slug = decodeURIComponent(url.pathname.slice('/s/'.length).replace(/\/$/, ''));
    const asset = await ctx.runQuery(components.staticHosting.lib.resolveAssetForHttp, { path: '/index.html' });
    // The page is in one of the three places the component keeps files
    // (registerStaticRoutes reads them the same way).
    let html: string | null = null;
    if (asset?.blobId) html = await text(fetch(`${url.origin}/fs/blobs/${asset.blobId}`));
    else if (asset?.storageUrl) html = await text(fetch(asset.storageUrl));
    else if (asset?.appStorageId) html = (await (await ctx.storage.get(asset.appStorageId as Id<'_storage'>))?.text()) ?? null;
    if (!html) return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    const card = slug && !slug.includes('/') ? await ctx.runQuery(internal.share.preview, { slug }) : null;
    return new Response(card ? withCard(html, card, url) : html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // Sharing can stop at any time; a cached card would outlive it.
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }),
});

// The push relay asks here whether a /register that named this deployment
// really came from it (push.ts relayInstall, relay/convex/http.ts): it posts
// back the nonce the registration carried, which only this deployment has.
// Answers nothing else, so it tells a caller only whether a guess was right.
http.route({
  path: '/relay/verify',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const b = (await request.json().catch(() => null)) as { nonce?: unknown } | null;
    const nonce = typeof b?.nonce === 'string' && /^[0-9a-f]{48}$/.test(b.nonce) ? b.nonce : null;
    const ok = nonce ? await ctx.runMutation(internal.devices.takeRelayCheck, { nonce }) : false;
    return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
  }),
});

// A runner key's uploads (sync:iconUploadUrl hands out this URL with a
// one-use ticket): the file is stored here and recorded as that runner's,
// so its key can attach it, and only it (docs/protocol.md, "Runner keys").
// Answers { storageId } as Convex's own upload URL does, so the runner's
// uploader is the same for both.

http.route({
  path: '/runner/upload',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const ticket = new URL(request.url).searchParams.get('ticket') ?? '';
    const refuse = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } });
    if (!(await ctx.runQuery(internal.sync.uploadTicketOk, { ticket }))) return refuse(403, 'bad or used upload ticket');
    const blob = await request.blob();
    if (blob.size > MAX_RUNNER_UPLOAD_BYTES) return refuse(413, 'too big');
    const storageId = await ctx.storage.store(blob);
    // Checked again with the hour's bytes, and the key still live. 429: try
    // again later (an allowance); 403: this ticket won't do.
    const redeemed = await ctx.runMutation(internal.sync.redeemUpload, { ticket, storageId, bytes: blob.size });
    if (redeemed !== true) {
      await ctx.storage.delete(storageId);
      return redeemed === 'later' ? refuse(429, 'over the upload allowance for now: try again later') : refuse(403, 'upload refused: a bad or used ticket, or a revoked key');
    }
    return new Response(JSON.stringify({ storageId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }),
});

// A picture the main Mac's runner sends to another runner's thread
// (relay:pictureUploadUrl hands out this URL with a one-use ticket): stored
// here and recorded (relayUploads), so a command can name it and one that
// never went out is found and deleted after a day.
http.route({
  path: '/relay/upload',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const ticket = new URL(request.url).searchParams.get('ticket') ?? '';
    const refuse = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } });
    if (!(await ctx.runQuery(internal.relay.relayTicketOk, { ticket }))) return refuse(403, 'bad or used upload ticket');
    if (Number(request.headers.get('content-length') ?? 0) > MAX_RUNNER_UPLOAD_BYTES) return refuse(413, 'too big');
    const blob = await request.blob();
    if (blob.size > MAX_RUNNER_UPLOAD_BYTES) return refuse(413, 'too big');
    const storageId = await ctx.storage.store(blob);
    // Not recorded (refused, or the mutation threw), it would be found by
    // nothing, so it goes now (Codex's review, 8 Nov).
    let redeemed = false;
    try {
      redeemed = await ctx.runMutation(internal.relay.redeemRelayUpload, { ticket, storageId, bytes: blob.size });
    } finally {
      if (!redeemed) await ctx.storage.delete(storageId);
    }
    if (!redeemed) return refuse(403, 'upload refused: a bad or used ticket');
    return new Response(JSON.stringify({ storageId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }),
});

// A phone's photo (phone:imageUploadUrl hands out this URL with a one-use
// ticket): stored here and recorded as that phone token's (phoneUploads), so
// only its own commands can send it and only it can discard it, and one
// never sent is found and deleted after a day. Answers { storageId } as
// Convex's own upload URL does, which is what the iPhone app reads.
http.route({
  path: '/phone/upload',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const ticket = new URL(request.url).searchParams.get('ticket') ?? '';
    const refuse = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } });
    if (!(await ctx.runQuery(internal.phone.phoneTicketOk, { ticket }))) return refuse(403, 'bad or used upload ticket');
    // Said up front by an honest client; checked again on what arrived.
    if (Number(request.headers.get('content-length') ?? 0) > PHONE_UPLOADS.maxBytes) return refuse(413, 'too big');
    const blob = await request.blob();
    if (blob.size > PHONE_UPLOADS.maxBytes) return refuse(413, 'too big');
    const storageId = await ctx.storage.store(blob);
    const redeemed = await ctx.runMutation(internal.phone.redeemPhoneUpload, { ticket, storageId, bytes: blob.size });
    if (redeemed !== true) {
      await ctx.storage.delete(storageId);
      return redeemed === 'later' ? refuse(429, 'over the upload allowance for now: try again later') : refuse(403, 'upload refused: a bad or used ticket, or a revoked phone');
    }
    return new Response(JSON.stringify({ storageId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }),
});

// Outside agents (Grok Bot): Threadbear as a remote MCP server, with an
// agent key (mcp.ts, mcpRpc.ts; docs/convex-backend.md "Outside agents").
// Only internal functions are called, and only after the key's check.
const mcp = httpAction(async (ctx, request) => {
  const headers = request.headers;
  const tooBig = () => new Response(JSON.stringify({ error: 'too big' }), { status: 413, headers: { 'Content-Type': 'application/json' } });
  const length = Number(headers.get('content-length') ?? 0);
  if (request.method === 'POST' && (!Number.isFinite(length) || length > MCP_BODY_MAX)) return tooBig();
  // Read no more than the cap, whatever Content-Length said (or if it said nothing).
  let body = '';
  if (request.method === 'POST' && request.body) {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MCP_BODY_MAX) {
        await reader.cancel();
        return tooBig();
      }
      chunks.push(value);
    }
    const all = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.byteLength;
    }
    body = new TextDecoder().decode(all);
  }
  const auth = headers.get('authorization') ?? '';
  const presented = /^Bearer\s+(tba_[0-9a-f]{64})$/i.exec(auth.trim())?.[1] ?? '';
  const hash = presented ? await sha256(presented) : '';
  // The caller's address as Convex saw it, never a header the caller can set
  // (X-Forwarded-For would let it pick a new one each try). Without it, bad
  // keys still meet the global limit.
  const meta = await (ctx as { meta?: { getRequestMetadata?: () => Promise<{ ip: string | null }> } }).meta?.getRequestMetadata?.().catch(() => undefined);
  const ip = meta?.ip ?? 'unknown';
  const now = Date.now();
  const out = await handleMcp(
    { method: request.method, header: (n) => headers.get(n), body },
    {
      begin: (tool) => ctx.runMutation(internal.mcp.begin, { hash, tool, ip, now }),
      listThreads: (agent, view) => ctx.runQuery(internal.mcp.listThreads, { agent: agent as never, view }),
      readThread: (agent, threadId, limit) => ctx.runQuery(internal.mcp.readThread, { agent: agent as never, threadId, ...(limit === undefined ? {} : { limit }) }),
      startThread: (agent, text) => ctx.runMutation(internal.mcp.startThread, { agent: agent as never, text }),
      sendMessage: (agent, threadId, text) => ctx.runMutation(internal.mcp.sendMessage, { agent: agent as never, threadId, text }),
    },
  );
  return new Response(out.body ?? null, { status: out.status, headers: out.headers });
});
http.route({ path: '/mcp', method: 'POST', handler: mcp });
http.route({ path: '/mcp', method: 'GET', handler: mcp });
http.route({ path: '/mcp', method: 'DELETE', handler: mcp });

registerStaticRoutes(http, components.staticHosting);

export default http;

// index.html with the thread's title and Open Graph and Twitter card tags.
export function withCard(html: string, card: { title: string; description: string; image?: string }, url: URL): string {
  const e = escapeHtml;
  const tags = [
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="Threadbear" />`,
    `<meta property="og:title" content="${e(card.title)}" />`,
    `<meta property="og:url" content="${e(url.origin + url.pathname)}" />`,
    card.description ? `<meta property="og:description" content="${e(card.description)}" />` : '',
    card.description ? `<meta name="description" content="${e(card.description)}" />` : '',
    `<meta property="og:image" content="${e(card.image ?? `${url.origin}/icon.png`)}" />`,
    `<meta name="twitter:card" content="${card.image ? 'summary_large_image' : 'summary'}" />`,
    `<meta name="twitter:title" content="${e(card.title)}" />`,
    card.description ? `<meta name="twitter:description" content="${e(card.description)}" />` : '',
  ]
    .filter(Boolean)
    .join('\n    ');
  return html.replace(/<title>[^<]*<\/title>/, `<title>${e(card.title)} · Threadbear</title>\n    ${tags}`);
}

async function text(response: Promise<Response>): Promise<string | null> {
  const r = await response;
  return r.ok ? r.text() : null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
