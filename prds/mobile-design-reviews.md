# Read and answer design reviews on the phone

Created: 2026-11-17T00:00:00Z

## Problem

The phone shows that a design review needs an answer but cannot open its options. People away from their Mac cannot inspect the proposal before deciding.

## Approach

Use the existing authenticated phone command queue to list pending reviews, read a named review and submit its structured response. Keep revision checks and retry handling in the runner's existing review methods. Reuse reply-image storage for review still previews. No new table is needed. Add two command kinds and an index on existing reply images by thread and source.

Add a Reviews sheet to the iPhone thread, reachable from its pending review count and review links. Show each option's title, notes, recommendation, reference status and shots. Let the user select several options or none, write notes and submit. Pages and videos are explicitly labeled still previews; their interactive originals remain on the Mac. Loading, offline, conflict and submission errors retain the user's answer.

## Acceptance

- A paired phone can inspect a pending review and send an answer through its owning runner.
- Reference options cannot be selected. Empty replies and contradictory picks are rejected.
- Duplicate identical submissions do not send twice; stale revisions retain the draft and require another deliberate send after reload.
- Existing Mac review behavior and older backends keep working.
- No user screenshot or private transcript enters the PR.

## Validation

Focused runner/backend and Swift model tests, type checks, and an iOS simulator build when the local toolchain is available. This PR does not deploy the backend or replace the installed phone app.
