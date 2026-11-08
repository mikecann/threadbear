---
id: outsideAgents
name: Outside agents
title: Outside agents: Grok Bot and other cloud agents reach Threadbear through your backend's /mcp
added: 2026-11-08
on: false
reminder: f7ab4c06
---

## What it does

Lets an agent that runs in the cloud, such as Grok Bot, use Threadbear as an MCP server. In the Connectors panel, Connect Grok Bot makes a key for it and shows the server address (your backend's `/mcp`). A read-only key can list and read threads it started, or every live thread if you tick that. A key that can write can also start threads, which always run in Ask mode so every tool asks you first, and message the threads it started while they stay in Ask mode. It never sees approvals, secrets, schedules or archived threads. Messages from it say who sent them, so threads don't take them as yours. Revoke ends a key on its next call, and turning this off ends every key.

## Lives in

`convex/mcp.ts`, `convex/mcpRpc.ts`, the `/mcp` route in `convex/http.ts` and the `agent*` tables in `convex/schema.ts`; `runner/src/outside-agents.ts` (its commands and the `agents.*` RPCs), built in `main.ts`; the app's Connectors panel (`ConnectorsPanel.swift`, `OutsideAgentsModel.swift`)

## Taking it out

Delete `convex/mcp.ts`, `convex/mcpRpc.ts`, the route, the four tables and the cron; `outside-agents.ts` and its lines in `main.ts`, `sync.ts` (the `agentOf` check and the `agent*` calls) and `settings.ts` (`onExperimentOff`); and the panel's Outside agents section.
