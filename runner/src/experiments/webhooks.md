---
id: webhooks
name: Webhooks
title: Webhooks: a secret URL on your backend that starts a thread in a folder or a bear, or messages a thread
added: 2026-11-13
on: false
reminder: 64db19b0
---

## What it does

`tb webhooks new "GitHub" --bear Researcher` makes a secret URL on your own backend, `https://<deployment>.convex.site/hook/tbh_...`, shown once. A POST to it starts a thread in that folder or bear (in Ask, or Auto with `--auto`, never Full access), or messages one thread that's on Ask or Auto (`--thread`). The thread shows a bolt and the webhook's name, and the payload arrives quoted, after a line saying it's data from an outside service and not your words.

Only a hash of the key is kept. A body over 64 KB gets 413, a call from a browser (with an Origin header) 403, an unknown, revoked or expired key 404, and past 30 calls a minute or 50 a day per hook 429. A repeat `Idempotency-Key` or `X-GitHub-Delivery` within a day is dropped. Deliveries within 10 seconds (`--batch`) become one run. A bear that's away holds its deliveries until it's back. `tb webhooks revoke` ends one, and turning this off ends every one. It needs a public `.convex.site` URL, so a local backend can't take webhooks.

## Lives in

`convex/webhooks.ts`, `convex/hookHttp.ts`, the `/hook/` route in `convex/http.ts`, the `webhooks`, `webhookCalls` and `webhookFails` tables in `convex/schema.ts`, the cron in `convex/crons.ts` and three lines in `convex/runnerAccess.ts`; `runner/src/webhooks.ts` (its runs and the `webhooks.*` RPCs), the `webhookOf` check and webhook calls in `runner/src/sync.ts`, `tb webhooks` in `runner/src/cli-bears.ts`, and its wiring in `main.ts`.

## Taking it out

Delete `convex/webhooks.ts`, `convex/hookHttp.ts`, the route, the three tables, the cron and the `runnerAccess.ts` lines; `runner/src/webhooks.ts` and its lines in `main.ts`, `sync.ts`, `cli.ts`, `cli-bears.ts` and `rpc-gate.ts`. Turn it off first so every hook is revoked.
