---
id: fastLane
name: Fast lane
title: Fast lane: answer quick web queries in seconds without starting a CLI
added: 2026-11-21
on: false
reminder: 00000000
---

## What it does

Adds a circular bolt button beside Send in the GPUI desktop app (and a `/web ` prefix on any surface, including iPhone) that answers quick web queries in seconds without spawning a coding CLI. It calls `treg__call` (`exa.web.answer`) through your local Connectors gateway (or an optional fallback configured in `runner.json`), writes the answer with dated links straight into the thread, and keeps full read-only isolation with no shell or file access. Sending a normal follow-up message in the same thread starts or continues a coding session with a compact handoff note carrying the fast search answer.

## Lives in

`runner/src/fast-lane.ts` (Connectors `treg__call` client, optional `runner.json` fallback, `/web ` prefix parsing and answer formatting), its hooks in `runner/src/config.ts`, `runner/src/rpc.ts`, `runner/src/store.ts`, `runner/src/runner/new-threads.ts`, `runner/src/runner/pools.ts`, `runner/src/runner.ts` and `runner/src/main.ts`; in the GPUI app `desktop/gpui/src/fast_lane.rs` with hooks in `desktop/gpui/src/main.rs`, `desktop/gpui/src/composer.rs`, `desktop/gpui/src/composer_chips.rs`, `desktop/gpui/src/thread.rs` and `desktop/gpui/src/new_thread.rs`

## Taking it out

Delete `runner/src/fast-lane.ts`, `runner/test/unit/fast-lane.test.ts`, `runner/src/experiments/fastLane.md`, `desktop/gpui/src/fast_lane.rs`, the `fast` parameter handling in `rpc.ts`, `store.ts`, `config.ts`, `new-threads.ts`, `pools.ts`, `runner.ts` and `main.ts`, and the bolt button hooks in `composer.rs`, `composer_chips.rs`, `thread.rs` and `new_thread.rs`. Run `npm run experiment-docs` in `runner/`.
