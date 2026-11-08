---
id: localConnectors
name: Local connectors
title: Local connectors: run local MCP servers like Blender's through the Connectors gateway
added: 2026-11-08
on: false
reminder: 364d24a4
---

## What it does

Lets the Connectors panel add MCP servers that run on this Mac as a command, not just ones on the web. Blender is in Add a service, marked On this Mac, and Other local server takes any uvx or npx package at one exact version. Before anything is added, a sheet shows the exact command that will run and which of its tools ask you first (Blender's run-any-code tool always does). The gateway (plugbear) runs the command whenever it's running, and every login and Codex gets its tools, the same as Notion's. A local server has nothing to sign in to, so its row has no Connect button. It needs Connectors setup on too.

## Lives in

`LocalEntry`, `localAddMessage` and `localServerProblem` in `runner/src/connectors-catalog.ts`; `readLocalIds`, `findLauncher` and the `local` parts of `parseHealth` and `connectors.add` in `runner/src/connectors.ts`, wired in `main.ts`; the app's Connectors panel (`LocalTrustSheet` and `OtherLocalServer` in `ConnectorsPanel.swift`)

## Taking it out

Delete the local entries from `CATALOG`, `localAddMessage`, `localServerProblem`, `readLocalIds` and `findLauncher`, the `local` branches in `connectors.add` and `parseHealth`, the two `localConnectors` lines in `main.ts`, and the panel's trust sheet and Other local server.
