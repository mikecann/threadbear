# Check a login again

Wayne, 14 Nov 2026: a login runs out, you buy more usage on claude.ai or
chatgpt.com, and Threadbear keeps treating it as out until the reset it
noted. Threads stay in Waiting for room though you've paid.

## What it does

A refresh button on every login row, in the Usage panel and in Settings >
Pools (GPUI app). Pressing it:

1. Asks the login for a fresh reading.
   - Codex: `account/rateLimits/read` on a short-lived app-server. No tokens.
   - Claude: there is no usage endpoint, so one tiny Haiku call in print
     mode (`--output-format stream-json --verbose`, nothing of the user's
     setup loaded) and its `rate_limit_event`. A few hundred tokens.
2. Records it. A reading that says the login isn't rejected clears the
   runner's ran-dry mark and the saved block.
3. A Claude call that answered proves there's room even when the weekly
   window reads 0% left (extra usage you paid for runs past the plan's
   limit). The login is marked as having room by a check (`checkedRoom`),
   which counts as room for the pool code until a later reading says it's
   blocked or the window resets.
4. Ends the wait of every thread waiting for room on that login, its own
   login included (`earlyLogin` never picks it), pinned threads too.
5. Replies with what it found: room again, or still out and when it's back.

## Pieces

- `AgentAdapter.readLimits?(account)`: Codex and Claude.
- Runner `recheckLogin(accountId)`, RPC `accounts.recheck { accountId }`
  returns `{ ok, blocked, backAt?, account }`. One check at a time per
  login; 30 s timeout.
- `UsageStore.record` keeps `checkedRoom`; `AccountUsage.checkedRoom`
  (protocol). `loginOk` takes it as room.
- GPUI: refresh icon on `login_row` in `usage.rs` and
  `settings_window/pools.rs`, spinner while it runs, tooltip, result line.
- Docs: guide "Accounts, pools and Usage", protocol.md method.
- Tests: runner unit tests for the recheck and the wake.

## Not in this

- SwiftUI app (fixes only), phone and web.
- A login on another Mac: the check runs on this Mac's runner, and the
  main Mac's shared reading still wins on other Macs until it's checked
  there.
