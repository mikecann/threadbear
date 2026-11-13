---
id: tables
name: Tables
title: Tables: a group of bears around one goal, talking in one thread you can read
added: 2026-11-13
on: false
reminder: c8fe31a0
---

## What it does

A table is a group of bears with a shared goal and you at the head of it. It needs Bears on too. `tb tables new "Launch crew" --bears "Researcher,Writer" --goal "Plan the launch post"` makes it: a project marked as a table, whose goals are the table's goal and whose notes are its decisions, with a folder of its own in `ThreadbearThreads/Tables`. With `--parent Launch` it's a part of that project, so every bear at it sees the project's goals too.

A thread in the table's folder is the table chat. Its host agent decides who speaks and passes work with `tb bears ask`; each bear's reply comes back into the chat, quoted and marked with its name. Bears can ask each other only through a table they share, so you see every exchange. Each message you send allows at most 6 bear replies (`--max` changes it); after that the host sums up and the bears wait for you. Each reply runs in the lower of the bear's mode and the table thread's. The librarian keeps a table's state but never files a thread into one, and phones see a table as an ordinary project.

## Lives in

`runner/src/tables.ts` (the `tables.*` RPCs and the host's `CLAUDE.md`), the `table` field and the `Bears:` brief line in `runner/src/projects.ts`, the table check in `runner/src/mentions.ts`, the librarian's filter in `runner/src/librarian.ts` (`prompt` and `apply`), `tb tables` in `runner/src/cli-bears.ts`, and its wiring in `main.ts`.

## Taking it out

Delete `tables.ts`, its lines in `main.ts`, `cli.ts`, `cli-bears.ts` and `rpc-gate.ts`, the `table` field and `describeBears` in `projects.ts` and `protocol.ts`, the `tableOf` option in `mentions.ts`, and the two `!p.table` filters in `librarian.ts`. Tables already made stay as ordinary projects.
