---
id: lateAnswers
name: Late answers
title: Late answers: an answer to an expired tool card resumes the work
added: 2026-11-14
on: false
reminder: eb789430
---

## What it does

If you answer a tool card within a day of it expiring, the thread receives the original request and your answer as a new message. An Allow is for that request once, even if you pressed Always allow. Deny tells the agent not to do it. It never replays the old call or changes the thread's access. Unknown, older, already answered and rewound cards stay closed. Questions, secrets, plans and requests to start on another Mac keep their existing handling. Cards whose full contents cannot be shown remotely still require their owning Mac to allow them.

The runner handles an answer already in flight. A deliberate late-answer control is planned for GPUI; frozen Swift screens do not gain buttons. Turn this on only to try the runner behaviour until that control ships.

## Lives in

`runner/src/runner/late-answers.ts`, called by `approvals.ts` when the pending callback is gone. Original requests and expiry times come from the thread's existing event log, so they survive restart without another copy of the input.

## Taking it out

Remove `late-answers.ts` and its call in `approvals.ts`; restore the old no-longer-pending error there. Remove this experiment and regenerate docs/experiments.md. Existing transcript events stay readable.
