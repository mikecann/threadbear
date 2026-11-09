---
id: gitPanel
name: Git panel
title: Git panel: stage, commit, push and sync a thread's repo from a panel beside it
added: 2026-11-09
on: false
reminder: dce1082b
---

## What it does

Gives every thread whose folder, or one of its projects' folders, is in a git repo a Git panel on the right-hand rail, like VS Code's Source Control: the branch and how far it is from its remote, staged and unstaged files with + and - to stage them, a message box with ✨ to have Haiku write the message from the staged diff, and one button that changes with what's next (Commit, Sync, Publish branch), its chevron for Commit & Push and Commit & Sync. ⌘↩ commits and ⇧⌘↩ commits and pushes. Two chips above the message box, Commit staged & push and Sync, hand the same jobs to the agent instead, and only show when there's something to do. It never force-pushes or skips a hook, and only pushes to remotes you own: your GitHub login, or the owners in runner.json's `gitPanel.pushOwners`.

## Lives in

`runner/src/git-panel.ts` and its page, `runner/src/git-panel/page.html`, served under `/git/` by the runner's own server (`pages` in `rpc.ts`, `configureGitPanel` in `main.ts`); the built-in patch in `builtins()` in `runner/src/patches.ts`

## Taking it out

Delete `git-panel.ts` and `git-panel/`, the git part of `builtins()` and `BUILTIN_LIVE` in `patches.ts`, `pages` in `rpc.ts`, the `configureGitPanel` call in `main.ts`, and `gitPanel` in `RunnerJson`.
