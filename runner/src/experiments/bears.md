---
id: bears
name: Bears
title: Bears: named teammates with their own folder, persona, memory, face and routines
added: 2026-11-13
on: false
reminder: 0a6703f6
---

## What it does

A bear is a named teammate, like Researcher or Writer, kept as a folder in `ThreadbearThreads/Bears/<id>`. Its `CLAUDE.md` is its persona and house rules, `memory/` is what it remembers (with a shared `Bears/memory/` for facts about you), and `bear.json` holds its name, face, what it does, model and effort. A thread in that folder is that bear. Its id never changes, so renaming it keeps its memory, routines and old threads.

The first time bears are listed, Head Bear is made as the chief of staff: it can hand jobs to the other bears. `tb bears head <bear>` gives the job to another one.

Make and manage bears with `tb bears` (new, rename, set, pin, move, away, archive, delete, head, ask) or the `bears.*` calls. New bears get a daily "tidy memory" routine. Routines and other unattended runs start in Ask unless you raise the bear with `tb bears access`, which a bear's own thread can't do. A follow-up a bear books in its quiet hours (19:30 to 08:30 by default) moves to the morning. A bear that's away or archived skips its routines.

`@Name` or `@bear:<id>` in a message you send, or `tb bears ask` from a thread, hands the message to that bear, and its reply comes back to the thread that asked.

## Lives in

`runner/src/bears.ts` (the folder model, `bears.json`, faces and the `bears.*` RPCs), `runner/src/mentions.ts`, `runner/src/cli-bears.ts` (`tb bears`), the bear defaults in `runner/src/runner/new-threads.ts` (`bearDefaults`), the `holdFor` and `adjustAt` hooks in `runner/src/schedules.ts`, the `bears.*` lines in `runner/src/rpc-gate.ts`, its wiring in `main.ts`, the faces in `runner/skills/bears/avatars/`, the skill `runner/skills/bears/SKILL.md`, and the `open-bot-avatar` package.

## Taking it out

Delete `bears.ts`, `mentions.ts`, `cli-bears.ts`, `runner/skills/bears/`, their lines in `main.ts`, `cli.ts` and `rpc-gate.ts`, the `bearDefaults` block in `new-threads.ts` and `runner.ts`, the two hooks in `schedules.ts`, and `open-bot-avatar` from `runner/package.json`. Bears' folders stay where they are as ordinary folders.
