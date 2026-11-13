---
id: bearNotes
name: Bear notes
title: Bear notes: an opted-in bear leaves one short cheer or idea on another thread when it's earned
added: 2026-11-13
on: false
reminder: 72a6dc65
---

## What it does

Needs Bears on too. A bear that opts in (`tb bears set Researcher --notes both`, or `cheers` or `ideas`) can leave one short line on another thread when its turn ends: a cheer when something real shipped ("Nice, tests pass and it's pushed."), or an idea when there's one clear next step ("Add a test for the 429 path."). It shows under the librarian's line at the top of Highlights, with the bear's name.

It costs nothing extra: the librarian's own end-of-turn look, the one cheap call it already makes, is shown the opted-in bears and may return one note, usually none. At most one note a turn across all bears, never on a thread that's waiting on you, never on a bear's own threads or a private folder, and none while the librarian is paused or the bear is away. A note never starts work.

## Lives in

`runner/src/librarian.ts` (`bearNotes`, `bearNoteLines` and `pickBearNote`, and the two lines in `prompt` and `apply`), the `notes` field in `runner/src/bears.ts`, and the line in `main.ts` that sets `librarian.bearNotes`.

## Taking it out

Delete `bearNotes`, `shownBears`, `NoteBear`, `bearNoteLines` and `pickBearNote` from `librarian.ts` and put `apply`'s `setBrief` line back to its one-line form; delete the `librarian.bearNotes` line in `main.ts`. The `notes` field in a bear's `bear.json` can stay: nothing reads it.
