---
id: xSearch
name: X search
title: X search: agents search X (Twitter) through xAI's Grok
added: 2026-11-09
on: false
reminder: 91593c98
---

## What it does

Gives every thread's agent, on Claude and Codex, an x_search tool: it asks xAI's Grok to search X and answer, with links to the posts it used and what the call cost. Agents' own web search can't read X, so this is how a thread finds out what people are posting about something, or what an account said. It can keep to some accounts or leave some out, and keep to a range of days. xAI's account filter covers its searches but not every post they bring in, so sources from other accounts are listed apart. It uses an xAI API key of your own (make one at console.x.ai): the first search asks for it in a secret card, and Threadbear keeps it in its secrets folder for every thread after. Each search is billed to your xAI credit, often $0.10 to $0.30 ($5 per 1,000 posts Grok reads, plus its searches and tokens), and each answer says what it cost. If xAI turns the key down, Threadbear forgets it and the next search asks again. What a thread searches for goes to xAI.

## Lives in

`runner/src/x-search.ts` (the call to xAI, the answer and the key file, `secrets/xai-api-key`); the `x_search` tool in `buildThreadbearTools` (`runner/src/threadbear-mcp.ts`), with its name in `NEVER_ASK_TOOLS`; `xSearchFor` and `xSearchMethods` in `runner/src/main.ts`; the X search row in the Connectors panel (`XSearchSection` in `ConnectorsPanel.swift`, `loadXSearch` and `forgetXaiKey` in `ConnectorsModel.swift`)

## Taking it out

Delete `runner/src/x-search.ts` and its test, the `x_search` tool, its `xSearch` option and its name in `NEVER_ASK_TOOLS` in `threadbear-mcp.ts`, `xSearchFor` and `xSearchMethods` in `main.ts`, the `xSearch.*` rows and "X search" in `docs/protocol.md`, and the panel's `XSearchSection`, `loadXSearch`, `forgetXaiKey`, `XSearchStatus` and the two client calls in the app. A saved key is the file `secrets/xai-api-key` in Threadbear's data folder.
