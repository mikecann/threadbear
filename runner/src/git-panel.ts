// The Git panel (docs/protocol.md, "The Git panel"): a small Source Control
// page beside a thread whose folder, or one of its projects' folders, is in
// a git repo. It shows the branch and how far it is from its remote, the
// staged and unstaged files with + and - to stage them, a message box with
// Generate (Haiku writes it from the staged diff), Commit, Commit & Push,
// Push and Sync. Two chips above the composer, Commit staged & push and
// Sync, hand the same jobs to the agent instead, and only show when there's
// something to do.
//
// The runner serves the page and its API from its own port, under /git/
// (rpc.ts hands those requests here), to this Mac only: a request has to
// come from the loopback address with a Host of 127.0.0.1 or localhost,
// so a runner listening on the tailnet doesn't serve it there, and a web
// page can't reach it by DNS rebinding. The panel's address carries a key
// for its one repo, an HMAC of the repo's path under the runner's token,
// and every API call sends it back in a header and as JSON, which no other
// page can do without a preflight this never answers. A repo is served
// only once a thread of this runner has had its panel (gitPatch notes it).
//
// Git runs with execFile, never a shell, paths after `--`. What the panel
// reads by itself (the state it polls, the chips' counts, the diff for
// Generate) runs with liveCommandEnv's settings, so nothing in the repo's
// own .git/config runs, and not at all in a repo whose config sets a
// filter or a diff driver. What you press (stage, commit, push, sync,
// fetch) runs as git in a terminal would, hooks and all: it never forces a
// push and never skips a hook. A push only goes to a remote whose owner is
// allowed: runner.json's gitPanel.pushOwners, or else your GitHub login
// (gh config get user), so a fork's upstream is left to you or the agent.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { Action, Panel } from './protocol.ts';
import { liveCommandEnv } from './shell-allowlist.ts';

export const GIT_PATCH = 'git';
export const GIT_ICON = 'arrow.triangle.branch';
export const GIT_PREFIX = '/git/';

export type GitChips = 'when-needed' | 'always' | 'off';
// runner.json's `gitPanel`.
export type GitPanelSettings = { pushOwners?: string[]; chips?: GitChips };

export type GitGenerate = (p: { feature: string; cwd?: string; system?: string; prompt: string; maxTokens?: number }) => Promise<{ ok: true; value: string } | { ok: false; reason: string; message: string }>;

// What the runner hands the panel once it's listening (main.ts). Until
// then, and in a runner that never calls it (tests), there's no Git panel.
export type GitPanelHost = {
  port: number;
  token: string;
  on: () => boolean;
  settings: () => GitPanelSettings;
  generate?: GitGenerate;
  // Your GitHub login, for the default push rule; tests pass their own.
  githubLogin?: () => Promise<string | undefined>;
};

// runner.json's gitPanel as the panel takes it: anything malformed is left out.
export function gitPanelSettings(raw: unknown): GitPanelSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: GitPanelSettings = {};
  if (Array.isArray(r.pushOwners)) out.pushOwners = r.pushOwners.filter((o): o is string => typeof o === 'string' && /^(\*|[A-Za-z0-9._-]{1,100})$/.test(o.trim())).map((o) => o.trim());
  if (r.chips === 'when-needed' || r.chips === 'always' || r.chips === 'off') out.chips = r.chips;
  return out;
}

let host: GitPanelHost | undefined;
const served = new Set<string>();

export function configureGitPanel(h: GitPanelHost | undefined): void {
  host = h;
  ownerCache = undefined;
  states.clear();
}

export function gitPanelOn(): boolean {
  return !!host && host.on();
}

// The key in a repo's panel address: only the runner, which has its token,
// can make one, and it's good for that repo alone.
export function gitPanelKey(token: string, top: string): string {
  return crypto.createHmac('sha256', token).update(`git-panel\u0000${top}`).digest('base64url');
}

export function gitPanelUrl(port: number, token: string, top: string): string {
  return `http://127.0.0.1:${port}${GIT_PREFIX}?repo=${encodeURIComponent(top)}&k=${gitPanelKey(token, top)}`;
}

// ------------------------------------------------------------ the patch

type Live = { when?: () => unknown; badge?: () => unknown; label?: () => unknown };
export type GitPatch = { panel: Panel; actions: Action[]; live: Map<string, Live> };

// The built-in patch for the repo at `top` (patches.ts builtins), or
// undefined while the panel is off. `fromProject`: the repo is a project
// folder's rather than the thread's own, so the chips say which.
export function gitPatch(top: string, fromProject: boolean): GitPatch | undefined {
  if (!host || !host.on()) return undefined;
  served.add(top);
  const chips = host.settings().chips ?? 'when-needed';
  const where = fromProject ? ` · ${path.basename(top)}` : '';
  const panel: Panel = { id: `${GIT_PATCH}.git`, title: 'Git', kind: 'url', url: gitPanelUrl(host.port, host.token, top), icon: GIT_ICON, patch: GIT_PATCH, note: path.basename(top) };
  const live = new Map<string, Live>();
  // Staged files plus commits to push: what's waiting on you.
  live.set(panel.id, { badge: async () => {
    const s = await counts(top);
    return s ? s.staged + (s.upstream ? s.ahead : s.unpublished) : 0;
  } });
  const actions: Action[] = [];
  if (chips !== 'off') {
    const rules = pushRules(host.settings().pushOwners);
    const commit: Action = { id: `${GIT_PATCH}.commit-staged-push`, title: 'Commit staged & push', kind: 'prompt', prompt: commitPrompt(rules), patch: GIT_PATCH, icon: 'arrow.up.circle' };
    const sync: Action = { id: `${GIT_PATCH}.sync`, title: 'Sync', kind: 'prompt', prompt: syncPrompt(rules), patch: GIT_PATCH, icon: 'arrow.triangle.2.circlepath' };
    live.set(commit.id, {
      when: async () => chips === 'always' || ((await counts(top))?.staged ?? 0) > 0,
      label: async () => {
        const s = await counts(top);
        return `${s?.staged ? `Commit ${s.staged} staged & push` : 'Commit staged & push'}${where}`;
      },
    });
    live.set(sync.id, {
      when: async () => {
        const s = await counts(top);
        if (!s) return chips === 'always';
        return chips === 'always' || (s.upstream ? s.ahead + s.behind > 0 : s.unpublished > 0);
      },
      label: async () => {
        const s = await counts(top);
        if (s && !s.upstream) return `Publish branch${where}`;
        const arrows = s ? [s.ahead ? `↑${s.ahead}` : '', s.behind ? `↓${s.behind}` : ''].filter(Boolean).join(' ') : '';
        return `Sync${arrows ? ` ${arrows}` : ''}${where}`;
      },
    });
    actions.push(commit, sync);
  }
  return { panel, actions, live };
}

const WHICH_REPO = `Which repo: this thread's folder if it's in a git repo. If it isn't, use the first git repo among the folders of this thread's projects (read_project lists them) and run git there with git -C. Say which repo you used.`;

function pushRules(owners: string[] | undefined): string {
  const who = owners?.includes('*')
    ? 'Push to any remote (runner.json\'s gitPanel.pushOwners allows all).'
    : owners?.length
      ? `Only push to a remote owned by ${owners.join(' or ')} (runner.json's gitPanel.pushOwners).`
      : `Only push to a remote owned by me: my GitHub login (gh config get user -h github.com).`;
  return `Push rules:
- Never force-push, never use --no-verify, never open or change a pull request.
- Push the current branch to its upstream. With no upstream, push to origin with -u.
- ${who} If the remote belongs to someone else (a fork's upstream, say), stop and ask before pushing.
- If this repo has its own landing flow (Threadbear's thread worktrees and tb land, a CLAUDE.md rule), follow it instead and say so.
- If the push is rejected because the branch is behind, pull with --rebase and push again. On a conflict, stop (git rebase --abort if it's half-done) and list the clashing files.
- Finish with: the repo, branch, commit hash and subject, and where it went (remote and URL).`;
}

function commitPrompt(rules: string): string {
  return `Commit what I've staged and push it.

${WHICH_REPO}

- Commit only what's staged (git diff --cached). Don't stage, unstage or change anything else. If nothing is staged, tell me to stage what I want first (the Git panel's +, or git add), and stop.
- Write the commit message from the staged diff, in this repo's style (look at git log). If a commit hook fails, show me why and stop.

${rules}`;
}

function syncPrompt(rules: string): string {
  return `Sync this branch with its remote: fetch, pull with --rebase, then push. If the branch has no upstream yet, publish it (push -u origin).

${WHICH_REPO}

- Don't commit anything. If there are uncommitted changes, rebase with --autostash; if that would clash, stop and tell me.
- If there's nothing to pull or push, say it's up to date.

${rules}`;
}

// ------------------------------------------------------------ running git

type Ran = { ok: boolean; out: string; err: string };

// A read the panel makes by itself: the repo's own config can't make it
// run anything (liveCommandEnv).
const readEnv = () => ({ ...process.env, ...liveCommandEnv(process.env), GIT_OPTIONAL_LOCKS: '0' });
// Something you pressed: git as in a terminal, hooks included, but never
// waiting on a prompt or an editor.
const writeEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' });

function git(top: string, args: string[], opts: { write?: boolean; input?: string; timeoutMs?: number } = {}): Promise<Ran> {
  return new Promise((resolve) => {
    const child = execFile('git', ['-C', top, ...args], { env: opts.write ? writeEnv() : readEnv(), timeout: opts.timeoutMs ?? 30_000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout), err: String(stderr) });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

const lines = (s: string) => s.split('\n').filter(Boolean);
const say = (r: Ran, fallback: string) => (r.err.trim() || r.out.trim() || fallback).split('\n').slice(-12).join('\n');

// Why the panel won't read this repo by itself, or undefined: its own
// config sets a filter or a diff driver, which reading its status or diff
// would run. Checked once a minute per repo.
const configChecks = new Map<string, { at: number; problem?: string }>();
async function readProblem(top: string): Promise<string | undefined> {
  const hit = configChecks.get(top);
  if (hit && Date.now() - hit.at < 60_000) return hit.problem;
  const r = await git(top, ['config', '--local', '--list', '--includes', '--name-only']);
  const bad = lines(r.out).find((k) => /^(filter|diff|merge)\..+\.(clean|smudge|process|textconv|command|driver)$/i.test(k));
  const problem = bad ? `This repo's own git config sets ${bad.slice(0, 80)}, which reading it would run, so the Git panel leaves it alone. Ask the agent instead.` : undefined;
  configChecks.set(top, { at: Date.now(), problem });
  return problem;
}

// ------------------------------------------------------------ the counts

// unpublished: commits no remote has, counted only when there's a remote
// to publish to.
type Counts = { staged: number; upstream: boolean; ahead: number; behind: number; unpublished: number };

// The chips' and badge's counts, shared by every thread on the repo for a
// few seconds: the live poll asks for each thread in turn.
const states = new Map<string, { at: number; value: Promise<Counts | undefined> }>();
const COUNTS_MS = 5_000;

export function counts(top: string): Promise<Counts | undefined> {
  const hit = states.get(top);
  if (hit && Date.now() - hit.at < COUNTS_MS) return hit.value;
  const value = readCounts(top);
  states.set(top, { at: Date.now(), value });
  return value;
}

async function readCounts(top: string): Promise<Counts | undefined> {
  if (await readProblem(top)) return undefined;
  const [staged, up] = await Promise.all([git(top, ['diff', '--cached', '--name-only', '--no-ext-diff', '--no-textconv']), git(top, ['rev-parse', '--abbrev-ref', '@{u}'])]);
  if (!staged.ok) return undefined;
  const n = lines(staged.out).length;
  if (up.ok && up.out.trim()) {
    const c = (await git(top, ['rev-list', '--left-right', '--count', '@{u}...HEAD'])).out.trim().split(/\s+/).map(Number);
    return { staged: n, upstream: true, behind: c[0] || 0, ahead: c[1] || 0, unpublished: 0 };
  }
  const remotes = lines((await git(top, ['remote'])).out);
  const u = remotes.length ? Number((await git(top, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])).out.trim() || 0) : 0;
  return { staged: n, upstream: false, ahead: 0, behind: 0, unpublished: u };
}

// ------------------------------------------------------------ remotes and the push rule

type RemoteInfo = { upstream: string | null; remote: string | null; url: string | null; host: string | null; owner: string | null; web: string | null };

export function parseRemote(url: string): { host: string; owner: string; repo: string } | undefined {
  const m = /^(?:git@|ssh:\/\/git@|https:\/\/(?:[^@/]+@)?)([^/:]+)(?::\d+)?[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { host: m[1].toLowerCase(), owner: m[2], repo: m[3] } : undefined;
}

async function remoteInfo(top: string): Promise<RemoteInfo> {
  const up = (await git(top, ['rev-parse', '--abbrev-ref', '@{u}'])).out.trim();
  const remote = up ? up.split('/')[0] : 'origin';
  const url = (await git(top, ['remote', 'get-url', '--', remote])).out.trim();
  const p = url ? parseRemote(url) : undefined;
  return { upstream: up || null, remote: url ? remote : null, url: url || null, host: p?.host ?? null, owner: p?.owner ?? null, web: p ? `https://${p.host}/${p.owner}/${p.repo}` : null };
}

let ownerCache: { at: number; login?: string } | undefined;

// `gh config get user` reads the login from gh's own settings, on this Mac:
// no network, and nothing of its token.
function ghLogin(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('gh', ['config', 'get', 'user', '-h', 'github.com'], { timeout: 10_000 }, (err, stdout) => {
      const login = String(stdout).trim();
      resolve(!err && /^[A-Za-z0-9-]{1,39}$/.test(login) ? login : undefined);
    });
  });
}

async function githubLogin(): Promise<string | undefined> {
  if (ownerCache && Date.now() - ownerCache.at < 10 * 60_000) return ownerCache.login;
  const login = await (host?.githubLogin ?? ghLogin)();
  ownerCache = { at: Date.now(), login };
  return login;
}

// Whether the panel may push to this remote, and why not.
export async function pushAllowed(info: Pick<RemoteInfo, 'remote' | 'host' | 'owner'>, owners: string[] | undefined, login: () => Promise<string | undefined> = githubLogin): Promise<{ ok: true } | { ok: false; why: string }> {
  if (!info.remote) return { ok: false, why: 'This repo has no remote to push to.' };
  if (owners?.includes('*')) return { ok: true };
  const owner = info.owner?.toLowerCase();
  if (owners?.length) {
    if (owner && owners.some((o) => o.toLowerCase() === owner)) return { ok: true };
    return { ok: false, why: `${info.remote} belongs to ${info.owner ?? 'someone else'}, and runner.json's gitPanel.pushOwners has only ${owners.join(', ')}. Ask the agent if you mean to push there.` };
  }
  const me = await login();
  if (!me) return { ok: false, why: `Threadbear doesn't know whose remotes are yours. Sign in with gh, or list the owners in runner.json: "gitPanel": { "pushOwners": ["you"] }.` };
  if (info.host === 'github.com' && owner === me.toLowerCase()) return { ok: true };
  return { ok: false, why: `${info.remote} belongs to ${info.owner ?? 'someone else'}, not ${me}. Ask the agent if you mean to push there, or add the owner to runner.json's gitPanel.pushOwners.` };
}

const allowed = async (info: RemoteInfo) => pushAllowed(info, host?.settings().pushOwners);

// ------------------------------------------------------------ the state

function label(c: string): string {
  return ({ M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed' } as Record<string, string>)[c] ?? c;
}

async function busyState(top: string): Promise<string | null> {
  const dir = (await git(top, ['rev-parse', '--absolute-git-dir'])).out.trim();
  if (!dir) return null;
  for (const [file, what] of [['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick']]) {
    if (fs.existsSync(path.join(dir, file))) return what;
  }
  return null;
}

type FileRow = { file: string; code: string; label: string };

// `git status --porcelain=v1 -z`, as the panel's lists.
export function parseStatus(out: string): { staged: FileRow[]; changes: FileRow[]; conflicts: FileRow[] } {
  const staged: FileRow[] = [];
  const changes: FileRow[] = [];
  const conflicts: FileRow[] = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const x = p[0];
    const y = p[1];
    const file = p.slice(3);
    if (x === 'R' || x === 'C') i++; // the old name follows
    if (x === '?' && y === '?') {
      changes.push({ file, code: 'U', label: 'new' });
      continue;
    }
    if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
      conflicts.push({ file, code: '!', label: 'conflict' });
      continue;
    }
    if (x !== ' ') staged.push({ file, code: x, label: label(x) });
    if (y !== ' ') changes.push({ file, code: y, label: label(y) });
  }
  return { staged, changes, conflicts };
}

async function state(top: string): Promise<Record<string, unknown>> {
  const problem = await readProblem(top);
  if (problem) return { repo: top, name: path.basename(top), problem };
  const [branch, status, info, log, busy] = await Promise.all([
    git(top, ['branch', '--show-current']),
    git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    remoteInfo(top),
    git(top, ['log', '-n', '8', '--format=%H%x09%ct%x09%s']),
    busyState(top),
  ]);
  const { staged, changes, conflicts } = parseStatus(status.out);
  let ahead = 0;
  let behind = 0;
  let unpublished = 0;
  if (info.upstream) {
    const c = (await git(top, ['rev-list', '--left-right', '--count', '@{u}...HEAD'])).out.trim().split(/\s+/).map(Number);
    behind = c[0] || 0;
    ahead = c[1] || 0;
  } else {
    unpublished = Number((await git(top, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])).out.trim() || 0);
  }
  const notPushed = new Set(lines((await git(top, ['rev-list', 'HEAD', '--not', '--remotes', '--max-count=50'])).out));
  const dirs = await Promise.all([git(top, ['rev-parse', '--absolute-git-dir']), git(top, ['rev-parse', '--path-format=absolute', '--git-common-dir'])]);
  let lastFetch: number | null = null;
  for (const d of dirs.map((r) => r.out.trim()).filter(Boolean)) {
    try {
      lastFetch = Math.max(lastFetch ?? 0, fs.statSync(path.join(d, 'FETCH_HEAD')).mtimeMs);
    } catch {
      // never fetched
    }
  }
  const commits = lines(log.out).map((l) => {
    const [hash, ct, subject] = l.split('\t');
    const pushed = !notPushed.has(hash);
    return { hash, short: hash.slice(0, 7), at: Number(ct) * 1000, subject, pushed, url: info.web && pushed ? `${info.web}/commit/${hash}` : null };
  });
  return {
    repo: top, name: path.basename(top), branch: branch.out.trim() || null, upstream: info.upstream, remote: info.remote, web: info.web,
    ahead, behind, unpublished, staged, changes, conflicts, commits, busy, lastFetch,
    push: await allowed(info),
    generate: !!host?.generate,
  };
}

// ------------------------------------------------------------ doing things

type Result = { ok: boolean; message?: string; text?: string };

async function stage(top: string, files: string[], all: boolean): Promise<Result> {
  const r = await git(top, all ? ['add', '-A'] : ['add', '--', ...files], { write: true });
  states.delete(top);
  return r.ok ? { ok: true } : { ok: false, message: say(r, 'git add failed') };
}

async function unstage(top: string, files: string[], all: boolean): Promise<Result> {
  const hasHead = (await git(top, ['rev-parse', '--verify', '-q', 'HEAD'])).ok;
  const which = all ? ['.'] : files;
  const r = await git(top, hasHead ? ['restore', '--staged', '--', ...which] : ['rm', '--cached', '-r', '-q', '--', ...which], { write: true });
  states.delete(top);
  return r.ok ? { ok: true } : { ok: false, message: say(r, 'git restore failed') };
}

async function commit(top: string, message: unknown): Promise<Result> {
  if (typeof message !== 'string' || !message.trim()) return { ok: false, message: 'Write a message, or press Generate.' };
  const staged = (await git(top, ['diff', '--cached', '--name-only', '--no-ext-diff', '--no-textconv'])).out.trim();
  if (!staged) return { ok: false, message: 'Nothing is staged. Press + on a file (or Stage all) first.' };
  const r = await git(top, ['commit', '-F', '-'], { write: true, input: message.trim() + '\n', timeoutMs: 120_000 });
  states.delete(top);
  if (!r.ok) return { ok: false, message: say(r, 'git commit failed (a hook may have stopped it)') };
  const hash = (await git(top, ['rev-parse', '--short', 'HEAD'])).out.trim();
  return { ok: true, message: `Committed ${hash}.` };
}

async function push(top: string): Promise<Result> {
  const info = await remoteInfo(top);
  const ok = await allowed(info);
  if (!ok.ok) return { ok: false, message: ok.why };
  const branch = (await git(top, ['branch', '--show-current'])).out.trim();
  if (!branch) return { ok: false, message: "Not on a branch (detached HEAD), so there's nothing to push." };
  // Never --force or --no-verify: a rejected push is left to Sync.
  const r = info.upstream
    ? await git(top, ['push'], { write: true, timeoutMs: 120_000 })
    : await git(top, ['push', '-u', '--', info.remote!, branch], { write: true, timeoutMs: 120_000 });
  states.delete(top);
  if (!r.ok) {
    if (/rejected|non-fast-forward|fetch first/i.test(r.err)) return { ok: false, message: "The remote has commits you don't have. Press Sync to pull them in first." };
    return { ok: false, message: say(r, 'git push failed') };
  }
  return { ok: true, message: info.upstream ? `Pushed ${branch} to ${info.upstream}.` : `Published ${branch} to ${info.remote}.` };
}

async function fetchRemote(top: string): Promise<Result> {
  const r = await git(top, ['fetch', '--prune'], { write: true, timeoutMs: 120_000 });
  states.delete(top);
  return r.ok ? { ok: true, message: 'Fetched.' } : { ok: false, message: say(r, 'git fetch failed') };
}

async function sync(top: string): Promise<Result> {
  const info = await remoteInfo(top);
  if (!info.upstream) return push(top); // publishing a new branch
  const ok = await allowed(info);
  if (!ok.ok) return { ok: false, message: ok.why };
  const f = await fetchRemote(top);
  if (!f.ok) return f;
  const pull = await git(top, ['pull', '--rebase', '--autostash'], { write: true, timeoutMs: 120_000 });
  if (!pull.ok) {
    const clashing = lines((await git(top, ['diff', '--name-only', '--diff-filter=U'])).out);
    if (await busyState(top)) await git(top, ['rebase', '--abort'], { write: true });
    states.delete(top);
    return { ok: false, message: clashing.length ? `Pulling clashed in ${clashing.join(', ')}. Nothing changed. Ask the agent to sort it out.` : say(pull, 'git pull failed') };
  }
  const c = (await git(top, ['rev-list', '--left-right', '--count', '@{u}...HEAD'])).out.trim().split(/\s+/).map(Number);
  if (!c[1]) {
    states.delete(top);
    return { ok: true, message: 'Pulled. Nothing to push.' };
  }
  const p = await push(top);
  return p.ok ? { ok: true, message: `Synced: pulled, then pushed ${c[1]} commit${c[1] === 1 ? '' : 's'}.` } : p;
}

const MESSAGE_SYSTEM = "You write git commit messages. Match the repo's style from its recent subjects. A subject line under 72 characters saying what changed and why, then, only if it helps, a blank line and a short body. Output only the message: no quotes, no code fences, no preamble.";
const DIFF_KEPT = 60_000;

async function generate(top: string): Promise<Result> {
  if (!host?.generate) return { ok: false, message: 'This runner has no model to write messages with.' };
  if (await readProblem(top)) return { ok: false, message: (await readProblem(top))! };
  const diff = (await git(top, ['diff', '--cached', '--stat', '--patch', '--no-color', '--no-ext-diff', '--no-textconv'])).out;
  if (!diff.trim()) return { ok: false, message: 'Nothing is staged to describe. Stage some files first.' };
  const log = (await git(top, ['log', '-n', '12', '--format=%s'])).out;
  const prompt = `Recent commit subjects in this repo, for its style:\n${log}\n\nThe staged diff:\n${diff.slice(0, DIFF_KEPT)}${diff.length > DIFF_KEPT ? '\n[diff cut short]' : ''}\n\nWrite the commit message for this staged diff.`;
  const res = await host.generate({ feature: 'git-panel', cwd: top, system: MESSAGE_SYSTEM, prompt, maxTokens: 400 });
  if (!res.ok) return { ok: false, message: `Couldn't write a message: ${res.message}` };
  const text = res.value.trim().replace(/^```\w*\n?|\n?```$/g, '').trim();
  return text ? { ok: true, text } : { ok: false, message: "Couldn't write a message." };
}

// ------------------------------------------------------------ serving

const PAGE = path.join(import.meta.dirname, 'git-panel', 'page.html');

const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  res.writeHead(status, { 'Content-Type': type, ...HEADERS, ...(type.startsWith('text/html') ? { 'Content-Security-Policy': CSP } : {}) });
  res.end(type === 'application/json' ? JSON.stringify(body) : String(body));
}

const same = (a: unknown, b: string) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const loopback = (addr: string | undefined) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

// A file name from the page: inside the repo, never an option.
const relative = (f: unknown): f is string => typeof f === 'string' && f !== '' && !path.isAbsolute(f) && !f.split('/').includes('..') && !f.includes('\0');

// Answers a request under /git/; false for any other path, which rpc.ts
// answers itself.
export async function handleGitPanel(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const raw = req.url ?? '';
  if (!raw.startsWith(GIT_PREFIX) && raw.split('?')[0] !== '/git') return false;
  try {
    if (!host || !host.on()) return (send(res, 404, { error: 'The Git panel is off in this runner.' }), true);
    const port = host.port;
    if (!loopback(req.socket.remoteAddress) || (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`)) return (send(res, 421, { error: 'wrong host' }), true);
    const url = new URL(raw, `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && (url.pathname === GIT_PREFIX || url.pathname === '/git')) {
      const top = url.searchParams.get('repo') ?? '';
      if (!served.has(top) || !same(url.searchParams.get('k'), gitPanelKey(host.token, top))) {
        return (send(res, 403, '<p>This page needs its link from a Threadbear thread\'s Git panel.</p>', 'text/html; charset=utf-8'), true);
      }
      return (send(res, 200, fs.readFileSync(PAGE, 'utf8'), 'text/html; charset=utf-8'), true);
    }
    if (!url.pathname.startsWith(`${GIT_PREFIX}api/`)) return (send(res, 404, { error: 'not found' }), true);
    let body: Record<string, unknown> = {};
    if (req.method === 'POST') {
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return (send(res, 415, { error: 'json only' }), true);
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return (send(res, 403, { error: 'forbidden' }), true);
      let text = '';
      for await (const chunk of req) {
        text += chunk;
        if (text.length > 1e6) return (send(res, 413, { error: 'too big' }), true);
      }
      try {
        const parsed = text ? JSON.parse(text) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed;
      } catch {
        return (send(res, 400, { error: 'bad json' }), true);
      }
    } else if (req.method !== 'GET') return (send(res, 405, { error: 'GET or POST' }), true);
    const top = String(body.repo ?? url.searchParams.get('repo') ?? '');
    if (!same(req.headers['x-threadbear-git'], gitPanelKey(host.token, top))) return (send(res, 403, { error: 'forbidden' }), true);
    if (!served.has(top) || !fs.existsSync(path.join(top, '.git'))) return (send(res, 404, { error: "That repo isn't one of this runner's threads'." }), true);
    const op = url.pathname.slice(`${GIT_PREFIX}api/`.length);
    if (req.method === 'GET') {
      if (op !== 'state') return (send(res, 404, { error: 'unknown' }), true);
      return (send(res, 200, await state(top)), true);
    }
    const files = Array.isArray(body.files) ? body.files.filter(relative) : [];
    const all = body.all === true;
    if ((op === 'stage' || op === 'unstage') && !all && !files.length) return (send(res, 400, { ok: false, message: 'No files given.' }), true);
    const result: Result | null =
      op === 'stage' ? await stage(top, files, all)
      : op === 'unstage' ? await unstage(top, files, all)
      : op === 'commit' ? await commit(top, body.message)
      : op === 'push' ? await push(top)
      : op === 'sync' ? await sync(top)
      : op === 'fetch' ? await fetchRemote(top)
      : op === 'generate' ? await generate(top)
      : null;
    if (!result) return (send(res, 404, { error: 'unknown action' }), true);
    send(res, 200, result);
  } catch (e) {
    if (!res.headersSent) send(res, 500, { ok: false, message: String((e as Error)?.message ?? e) });
  }
  return true;
}
