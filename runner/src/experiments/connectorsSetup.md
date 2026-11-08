---
id: connectorsSetup
name: Connectors setup
title: Connectors setup: set up the plugbear gateway and add services from the Connectors panel
added: 2026-11-08
on: false
reminder: 2d760c1c
---

## What it does

Puts the Connectors panel (the plug on the left-hand rail) in reach before there's a gateway, with a Set up button. Set up starts a thread that installs plugbear on this Mac, listening only on 127.0.0.1, and wires each of your logins to it. Once it's running, Add a service lists services it can add (Notion, Slack, Linear, Sentry, Cloudflare, DeepWiki) and takes any other MCP server by its https address. Each Add starts a short thread that adds it to plugbear and hands you its Connect button. Slack needs a Slack app of your own, and that thread walks you through it. Sign-ins and tokens stay in plugbear, never in Threadbear.

## Lives in

`runner/src/connectors-catalog.ts`; `connectors.setup` and `connectors.add` in `runner/src/connectors.ts`, built in `main.ts`; the app's Connectors panel (`ConnectorsPanel.swift`, `ConnectorsModel.swift`) and Finish setting up (`SetupChecklist.swift`)

## Taking it out

Delete `connectors-catalog.ts`, the two RPCs and their lines in `main.ts`, and the panel's Set up and Add a service parts; the plug icon goes back to showing only with a gateway.
