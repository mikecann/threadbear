// Restarting the runner without cutting a turn short (docs/dev-tools.md,
// section 2). runner.restart saves the request in <home>/restart.json and
// waits until no thread is starting, running or waiting on an approval or
// a question, and no CLI is running background shells or subagents; then
// main.ts shuts down the way it does on SIGTERM and exits 0, and launchd
// starts the runner again. The next start reads the file, notes the restart
// in the threads that asked to carry on, and sends each of them its resume
// text as a turn of the runner's own.
import type { ArchiveStatus } from './agent-archive.ts';
import type { SecretCheckStatus } from './secret-check.ts';
import type { MacScreenStatus } from './mac-screen.ts';
import type { UpstreamStatus } from './upstream.ts';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Runner } from './runner.ts';
import type { Clock } from './clock.ts';
import type { Logger } from './log.ts';
import type { SyncStatus } from './sync.ts';
import type { ThreadStatus, ThreadSummary } from './protocol.ts';
import { ErrorCode, RpcError } from './protocol.ts';
import { atomicWriteFileSync, readJsonSync } from './fsutil.ts';
import { paths, RUNNER_VERSION } from './config.ts';
import { currentLink, pointCurrentAt, readState, releaseExists, releaseHome } from './release.ts';
import type { TimerHandle } from './clock.ts';
import type { UpdateStatus } from './update.ts';
import { isCarryOn, stoppedWorkMessage } from './runner/carry-on.ts';

export type RestartWhen = 'idle' | 'now';
export type ResumeRequest = { threadId: string; text: string };

// A resume as saved. release is the release the request expected to come
// back on (deploy-runner.sh's), so a thread resumed on another one (after a
// crash rollback, or a later deploy) is told its change isn't running.
// afterSeq is the thread's last event when it asked: a message someone sent
// after that means they've moved on, and the resume isn't sent.
export type SavedResume = ResumeRequest & { requestedAt: string; release?: string; afterSeq?: number };

type ResumeDelivery = SavedResume & { from: string; restartAt?: string; handledRelease?: string; replacesSince?: number; rolledBack?: string };
type DeferredRecovery = { baseline: ResumeDelivery[] | null; resumes: ResumeDelivery[] };

// <home>/restart.json. Several requests merge into one: "now" wins and
// every thread's resume is kept (a later one for the same thread replaces
// its earlier one).
export type RestartFile = {
  when: RestartWhen;
  reason?: string;
  requestedAt: string;
  fromVersion: string; // the runner that took the request, for the note afterwards
  release?: string; // the latest request's expected release
  resumes: SavedResume[];
  // When this runner began shutting down for it, or stopped for any other
  // reason while it was pending. A resume's age counts from here, so a
  // restart that waited an hour for a long turn still resumes.
  shutdownAt?: string;
  // After this, background shells and subagents no longer hold it (a dev
  // server never finishes); turns always do.
  backgroundUntil?: string;
  // restart.done.json only: the runner that handled it.
  handledBy?: string;
  handledRelease?: string;
};

export type RestartParams = { when?: RestartWhen; resume?: ResumeRequest; reason?: string; release?: string; backgroundWaitMs?: number; cancel?: boolean };

export type Background = { threadId: string; tasks: string[] };

// runner.restart's result. background is the background work among the
// threads it waits for, so the scripts can name it; note says what a cancel
// did about the release the withdrawn restart was for; noResume why the
// resume asked for won't be sent as things stand, so the scripts don't tell
// an agent to end its turn and wait for a message that never comes.
export type RestartResult = { scheduled: boolean; waitingFor: string[]; background?: Background[]; note?: string; noResume?: string; handover?: { keeps: string[] } };

export type Notice = { level: 'info' | 'warning' | 'error'; message: string };

// runner.status's result (docs/protocol.md).
export type RunnerStatus = {
  webRuntimeProblem?: string;
  version: string;
  release?: string;
  pid: number;
  startedAt: string;
  home: string;
  logFile?: string;
  branch?: string;
  liveClis: number;
  running: string[]; // starting, running or waiting on an approval or a question
  background?: Background[]; // background shells and subagents still going
  // Every thread a reinstall waits for: running, background work, a
  // turn-end hook, between turns, or running an action (busyThreads below).
  // For deploy.mjs's --check-idle, which install-runner.sh asks again right
  // before it stops the runner; running and background alone missed hooks.
  busy?: string[];
  pendingRestart?: { when: RestartWhen; reason?: string; release?: string; resumeThreadId?: string; requestedAt: string; backgroundUntil?: string; waitingFor: string[] };
  // This release is running because launch.mjs went back to it from `from`,
  // which kept crashing at startup. A deploy's health check can pass before
  // the crash, so tb status says so for as long as it holds.
  rolledBack?: { from: string; at: string };
  // Older runners still finishing turns after a handover (main.ts adds it).
  draining?: { pid: number; version: string; release?: string; since: string; threads: string[] }[];
  // The runner following main by itself (src/update.ts).
  update?: UpdateStatus;
  // Mike's releases, for a fork (upstream.ts; main.ts adds it).
  upstream?: UpstreamStatus;
  // Other runners that aren't following GitHub's main properly, from their
  // heartbeats (the main Mac's runner only; main.ts adds it).
  behindRunners?: { name: string; problem: string }[];
  // The Convex mirror (src/sync.ts; main.ts adds it).
  sync?: SyncStatus;
  secretCheck?: SecretCheckStatus;
  // Agent Archive's sync, with the archive experiment on (agent-archive.ts; main.ts adds it).
  archive?: ArchiveStatus;
  // Dialogs on this Mac's screen and Full Disk Access (mac-screen.ts; main.ts adds it).
  macScreen?: MacScreenStatus;
};

export const RESUME_MAX_AGE_MS = 15 * 60_000;
export const RESUMES_PER_HOUR = 3;
// These strings also identify resumes persisted by releases before the deferred file.
const RESTART_NOTE_START = 'Runner restarted: ';
const RESUME_SKIPPED_START = 'Not carrying on by itself: ';
const RESUME_WAKE_REASON = 'The runner restarted';
const RESUME_NOTE_START = 'Note from the runner: ';
const RESUME_NOTE_END = ' Check tb logs before going on. Your message for after the restart follows.\n\n';
const HOUR_MS = 60 * 60_000;

const BUSY: ThreadStatus[] = ['starting', 'running', 'waiting'];
const ALL: ('inbox' | 'snoozed' | 'archived')[] = ['inbox', 'snoozed', 'archived'];

export function restartPath(home: string): string {
  return path.join(home, 'restart.json');
}

// The restart.json this runner handled, kept until it has stayed up long
// enough to be marked good. If it crashes and launch.mjs goes back to the
// last good release, that runner resumes the same threads once more.
export function donePath(home: string): string {
  return path.join(home, 'restart.done.json');
}

export function resumesPath(home: string): string {
  return path.join(paths.run(home), 'resumes.json');
}

function deferredResumesPath(home: string): string {
  return path.join(paths.run(home), 'deferred-resumes.json');
}

function deferredRecoveryPath(home: string): string {
  return path.join(home, 'restart.deferred.json');
}

// This runner's own bin/ (the release's, or the checkout's when run from
// source). Threads get threadBinDir's, below.
export const BIN_DIR = path.resolve(import.meta.dirname, '..', 'bin');

// The bin/ a thread's PATH starts with. A CLI outlives the runner that
// started it (the runner updates itself onto main several times a day) and
// keeps the PATH it started with, so a release's own bin/ there pins the
// thread to that release's tb: on 24 Nov a day-old thread's `tb land`
// still refused with a hold main had taken out, and old releases are
// pruned, which leaves no tb at all. So a release's runner names
// <home>/runner/current/bin instead, the link every deploy and rollback
// moves, which always gets the tb of the release this Mac runs (as
// ~/.local/bin/tb does, scripts/link-tb.sh). A checkout's runner (a dev
// runner) keeps its own bin/, and so does Windows, where current is a text
// file rather than a link (release.ts, currentLink).
export function threadBinDir(binDir = BIN_DIR, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return binDir;
  const home = releaseHome(path.dirname(binDir));
  if (!home) return binDir;
  const current = path.join(home, 'runner', 'current');
  try {
    if (fs.lstatSync(current).isSymbolicLink() && fs.statSync(path.join(current, 'bin', 'tb')).isFile()) return path.join(current, 'bin');
  } catch {
    // No link, or one to a release without a tb: this release's own.
  }
  return binDir;
}

// Every CLI gets these, so tools an agent runs (tb self, deploy-runner.sh)
// know which thread and which runner they're in. THREADBEAR_HOME is the one
// tb reads, and agents point it at a dev runner; THREADBEAR_RUNNER_HOME
// always names the runner the thread is on, so the scripts' guards against
// restarting it from inside one of its threads go by that.
// `key` is the thread's own RPC credential (docs/protocol/connection.md, "A thread's own
// key"), only for a thread's CLI: a patch's action and a worktree's setup run
// on the runner's say-so, so tb there still reads the token. The empty value
// matters: a dev runner started from a thread would otherwise pass its parent
// thread's key on to everything it starts.
export function threadEnv(threadId: string, home: string, basePath = process.env.PATH, key?: string): Record<string, string> {
  return {
    THREADBEAR_THREAD_ID: threadId,
    THREADBEAR_THREAD_KEY: key ?? '',
    THREADBEAR_HOME: home,
    THREADBEAR_RUNNER_HOME: home,
    THREADBEAR_RUNNER_VERSION: RUNNER_VERSION,
    // A picture copied in here can be on the thread's shared page; one
    // anywhere else can't (docs/protocol/runners.md, "Sharing").
    THREADBEAR_MEDIA_DIR: paths.media(home, threadId),
    // The Node this runner runs on, which the repo's scripts take before
    // looking on PATH (scripts/find-node.sh): a thread's checks, landing and
    // deploys then use the runner's own Node on any Mac, not one at a path
    // only Mike's has (a fork's commit, 8 Nov).
    THREADBEAR_NODE: process.execPath,
    // The old names too, for skills and scripts written before the rename.
    THREADBARE_THREAD_ID: threadId,
    THREADBARE_HOME: home,
    THREADBARE_RUNNER_HOME: home,
    // On Windows the runner's Node goes on too: bin/tb is a node script,
    // and Git Bash (Claude's Bash tool there) runs it with whatever node
    // is on PATH, which a fresh PC hasn't got (cmd and PowerShell run
    // tb.cmd, which uses THREADBEAR_NODE).
    PATH: [threadBinDir(), ...(process.platform === 'win32' ? [path.dirname(process.execPath)] : []), ...(basePath ? [basePath] : [])].join(path.delimiter),
  };
}

export type RestarterDeps = {
  runner: Pick<Runner, 'list' | 'get' | 'send' | 'note' | 'notice' | 'onNotification' | 'events' | 'queuedMessages' | 'replaceQueuedText' | 'startedAt' | 'backgroundWork' | 'threadsWithHooksRunning' | 'threadsBetweenTurns' | 'refuseNewTurns'> & Partial<Pick<Runner, 'threadsRunningActions'>>;
  home: string;
  clock: Clock;
  log: Logger;
  // Shuts the runner down the way SIGTERM does and exits 0 (main.ts).
  restart: () => void;
  // Handovers (docs/protocol.md): whether one is possible (launch.mjs
  // supervises this runner), and starting one, which keeps `keeps` here
  // until their turns end and has the new release take everything else.
  canHandOver?: () => boolean;
  handOver?: (keeps: string[]) => void;
  // Threads still on a draining runner or on their way across: their
  // resumes wait for resumeAdopted.
  elsewhere?: (threadId: string) => boolean;
  version?: string;
  release?: string;
  branch?: string; // the branch the release was built from (release.json)
  logFile?: string;
  // launch.mjs's rollback notice, when this runner is an earlier release
  // because the one deployed kept crashing: the resumed thread asked for
  // the new one, so its note says so.
  rolledBack?: string;
  rolledBackFrom?: string; // the release launch.mjs went back from
  updateStatus?: () => UpdateStatus | undefined;
  // The idle check and the restart run after the current tick: a turn that
  // ends and the queued message that starts straight after it never look
  // idle, and the runner.restart reply goes out before the runner stops.
  defer?: (fn: () => void) => void;
};

export class Restarter {
  private deps: RestarterDeps;
  private version: string;
  private defer: (fn: () => void) => void;
  private startedAt: string;
  private pending?: RestartFile;
  private restarting = false;
  // Resumes for threads still on a draining runner, sent when they arrive.
  private deferred = new Map<string, ResumeDelivery>();
  private deferredBaseline: ResumeDelivery[] | null = null;
  private deferredSaveRetry?: TimerHandle;
  private checkQueued = false;
  // Re-checks when background work stops holding the restart.
  private backgroundTimer?: TimerHandle;

  constructor(deps: RestarterDeps) {
    this.deps = deps;
    this.version = deps.version ?? RUNNER_VERSION;
    this.defer = deps.defer ?? ((fn) => setImmediate(fn));
    this.startedAt = new Date(deps.clock.now()).toISOString();
    // Any summary change can be a thread finishing, and a deleted thread
    // (threads.delete, the delete_thread tool) stops whatever it was doing
    // without one.
    deps.runner.onNotification((n) => {
      if (n.method === 'thread.deleted') this.takeDeferred(n.params.threadId);
      if (n.method === 'thread.updated' || n.method === 'thread.deleted') this.queueCheck();
    });
  }

  // ------------------------------------------------------------ requests

  request(p: RestartParams): RestartResult {
    const { runner, log } = this.deps;
    if (p.cancel) return this.cancel();
    // A thread that doesn't exist is an error now, not a lost resume later.
    const thread = p.resume ? runner.get(p.resume.threadId) : undefined;
    const now = this.isoNow();
    const next: RestartFile = this.pending ?? { when: 'idle', requestedAt: now, fromVersion: this.version, resumes: [] };
    if (p.when === 'now') next.when = 'now';
    if (p.reason) next.reason = p.reason;
    if (p.release) next.release = p.release;
    if (p.backgroundWaitMs !== undefined) {
      // The most impatient request wins, as "now" does.
      const until = this.deps.clock.now() + p.backgroundWaitMs;
      const had = next.backgroundUntil ? Date.parse(next.backgroundUntil) : Infinity;
      if (until < had) next.backgroundUntil = new Date(until).toISOString();
    }
    if (p.resume && thread) {
      const { threadId, text } = p.resume;
      next.resumes = next.resumes.filter((r) => r.threadId !== threadId);
      const saved: SavedResume = { threadId, text, requestedAt: now, afterSeq: thread.lastSeq };
      if (p.release) saved.release = p.release;
      next.resumes.push(saved);
    }
    this.pending = next;
    this.save();
    this.armBackgroundTimer();
    const waitingFor = next.when === 'now' || this.restarting ? [] : this.busy();
    log.info('restart requested', { when: next.when, reason: p.reason, resumeThreadId: p.resume?.threadId, waitingFor, backgroundUntil: next.backgroundUntil });
    // Busy threads needn't hold it: they finish here while the new release
    // takes everything else.
    if (!this.restarting && waitingFor.length && next.when === 'idle' && this.deps.canHandOver?.()) {
      const out: RestartResult = { scheduled: true, waitingFor: [], handover: { keeps: waitingFor } };
      if (p.resume && thread && resumesInLastHour(this.deps.home, p.resume.threadId, this.deps.clock.now()) >= RESUMES_PER_HOUR) {
        out.noResume = `this thread has already been resumed ${RESUMES_PER_HOUR} times in the last hour`;
      }
      this.beginHandover(waitingFor);
      return out;
    }
    if (!this.restarting) {
      if (waitingFor.length === 0) this.begin();
      else runner.notice('info', pendingMessage(waitingFor.length, this.onYou(waitingFor)));
    }
    const background = waitingFor.length ? runner.backgroundWork().filter((b) => waitingFor.includes(b.threadId)) : [];
    const out: RestartResult = background.length ? { scheduled: true, waitingFor, background } : { scheduled: true, waitingFor };
    // Checked without using one up: the restart may still be an hour off.
    if (p.resume && thread && resumesInLastHour(this.deps.home, p.resume.threadId, this.deps.clock.now()) >= RESUMES_PER_HOUR) {
      out.noResume = `this thread has already been resumed ${RESUMES_PER_HOUR} times in the last hour`;
    }
    return out;
  }

  // Withdraws a restart that hasn't begun (tb restart --cancel). A deploy
  // has already pointed current at the release the restart was for, and
  // that would start on the next restart of any kind (a crash, a reboot)
  // with no health check and nobody watching, so current goes back to the
  // release this runner is.
  private cancel(): RestartResult {
    if (this.restarting) throw new RpcError(ErrorCode.busy, 'The runner is already restarting.');
    const p = this.pending;
    if (!p) return { scheduled: false, waitingFor: [] };
    this.pending = undefined;
    this.backgroundTimer?.cancel();
    this.backgroundTimer = undefined;
    try {
      fs.rmSync(restartPath(this.deps.home), { force: true });
    } catch (e) {
      this.deps.log.warn('could not remove restart.json', { error: String(e) });
    }
    const note = this.putCurrentBack(p);
    this.deps.log.info('restart cancelled', { release: p.release, note });
    this.deps.runner.notice('info', 'The pending runner restart was cancelled.');
    return note ? { scheduled: false, waitingFor: [], note } : { scheduled: false, waitingFor: [] };
  }

  private putCurrentBack(p: RestartFile): string | undefined {
    const { home, release: mine } = this.deps;
    const wanted = p.release;
    if (!wanted || wanted === mine || currentLink(home) !== wanted) return undefined;
    if (mine && releaseExists(home, mine)) {
      try {
        pointCurrentAt(home, mine);
        return `current points at ${mine} again (the release running now), so ${wanted} won't start on the next restart.`;
      } catch (e) {
        this.deps.log.warn('could not point current back at the running release', { release: mine, error: String(e) });
      }
    }
    const back = mine ? ` deploy-runner.sh --rollback goes back to ${mine}.` : '';
    return `Release ${wanted} is still current and starts on the runner's next restart (a crash or a reboot too).${back}`;
  }

  status(): RunnerStatus {
    const all = this.deps.runner.list(ALL);
    const running = all.filter((t) => BUSY.includes(t.status)).map((t) => t.id);
    const out: RunnerStatus = {
      version: this.version,
      pid: process.pid,
      startedAt: this.startedAt,
      home: this.deps.home,
      liveClis: all.filter((t) => t.live).length,
      running,
      background: this.deps.runner.backgroundWork(),
      busy: this.busyThreads(),
    };
    if (this.deps.release) out.release = this.deps.release;
    if (this.deps.branch) out.branch = this.deps.branch;
    const rolledBack = this.rolledBackOnto();
    if (rolledBack) out.rolledBack = rolledBack;
    if (this.deps.logFile) out.logFile = this.deps.logFile;
    const update = this.deps.updateStatus?.();
    if (update) out.update = update;
    const p = this.pending;
    if (p) {
      const pr: NonNullable<RunnerStatus['pendingRestart']> = { when: p.when, requestedAt: p.requestedAt, waitingFor: p.when === 'now' || this.restarting ? [] : this.busy() };
      if (p.reason) pr.reason = p.reason;
      if (p.release) pr.release = p.release;
      if (p.backgroundUntil) pr.backgroundUntil = p.backgroundUntil;
      const last = p.resumes.at(-1);
      if (last) pr.resumeThreadId = last.threadId;
      out.pendingRestart = pr;
    }
    return out;
  }

  // launch.mjs's last crash rollback, if it went back to this release and
  // nobody has activated this release on purpose since (deploy-runner.sh
  // --rollback onto it is a choice, not a crash).
  private rolledBackOnto(): RunnerStatus['rolledBack'] {
    const mine = this.deps.release;
    if (!mine) return undefined;
    const s = readState(this.deps.home);
    const rb = s?.rolledBack;
    if (!rb || typeof rb !== 'object' || rb.to !== mine || typeof rb.from !== 'string' || typeof rb.at !== 'string') return undefined;
    const act = s?.activated;
    if (act && act.release === mine && Date.parse(act.at) > Date.parse(rb.at)) return undefined;
    return { from: rb.from, at: rb.at };
  }

  // Sent after each hello, so an app that connects while a restart waits
  // knows about it.
  helloNotices(): Notice[] {
    if (!this.pending) return [];
    const busy = this.busy();
    return [{ level: 'info', message: this.restarting ? pendingMessage(0) : pendingMessage(busy.length, this.onYou(busy)) }];
  }

  // How many of these threads wait on Mike (an approval or a question).
  private onYou(ids: string[]): number {
    const waiting = new Set(this.deps.runner.list(ALL).filter((t) => t.status === 'waiting').map((t) => t.id));
    return ids.filter((id) => waiting.has(id)).length;
  }

  // --------------------------------------------------------- idle check

  // The threads a restart waits for: a turn starting, running or waiting on
  // an approval or a question, or background shells and subagents the CLI
  // is still running after its turn ended. Stopping the runner stops those
  // too, and an agent waiting on a 40-minute test run would never hear back.
  // Background work only holds it until backgroundUntil, though: a dev
  // server or a watcher never finishes.
  // For the LaunchAgent reinstall (reinstall.ts), which stops every runner
  // at once, handovers and all: what a restart waits for, and Run commands
  // and patch actions too.
  busyThreads(): string[] {
    return [...new Set([...this.busy(), ...(this.deps.runner.threadsRunningActions?.() ?? [])])];
  }

  private busy(): string[] {
    const ids = new Set(
      this.deps.runner
        .list(ALL)
        .filter((t) => BUSY.includes(t.status))
        .map((t) => t.id),
    );
    const until = this.pending?.backgroundUntil ? Date.parse(this.pending.backgroundUntil) : Infinity;
    if (this.deps.clock.now() < until) for (const b of this.deps.runner.backgroundWork()) ids.add(b.threadId);
    // A turn-end hook: stopping would lose its result, and any archive waiting
    // for it would wait for the next runner. Hooks end by themselves (runCommand's
    // timeout), so no limit like background work's.
    for (const id of this.deps.runner.threadsWithHooksRunning()) ids.add(id);
    // An edit cutting the session back, or a worktree being set up.
    for (const id of this.deps.runner.threadsBetweenTurns()) ids.add(id);
    return [...ids];
  }

  private armBackgroundTimer(): void {
    this.backgroundTimer?.cancel();
    this.backgroundTimer = undefined;
    const until = this.pending?.backgroundUntil ? Date.parse(this.pending.backgroundUntil) : NaN;
    if (!Number.isFinite(until) || this.restarting) return;
    this.backgroundTimer = this.deps.clock.setTimeout(() => {
      this.backgroundTimer = undefined;
      this.queueCheck();
    }, until - this.deps.clock.now());
  }

  private queueCheck(): void {
    if (!this.pending || this.restarting || this.checkQueued) return;
    this.checkQueued = true;
    this.defer(() => {
      this.checkQueued = false;
      if (!this.pending || this.restarting) return;
      if (this.pending.when === 'now' || this.busy().length === 0) this.begin();
    });
  }

  private beginHandover(keeps: string[]): void {
    if (this.restarting || !this.pending) return;
    this.restarting = true;
    this.backgroundTimer?.cancel();
    this.backgroundTimer = undefined;
    // From here the restart counts as done for the new runner: it takes
    // restart.json and resumes the threads (a kept one when it arrives).
    this.pending.shutdownAt = this.isoNow();
    this.save();
    this.deps.log.info('handing over', { reason: this.pending.reason, keeps });
    const n = keeps.length;
    // "The runner is restarting" first: the app reads that as a restart
    // under way (RunnerRestart.parse) and keeps its banner quiet while the
    // connection moves to the new runner.
    // Onto a new release when one was asked for; after an uncaught error
    // (main.ts) it's the same release again.
    const onto = this.pending.release ? ' onto a new release' : '';
    this.deps.runner.notice('info', `The runner is restarting${onto}. ${n === 1 ? '1 busy thread finishes its turn' : `${n} busy threads finish their turns`} on the old one first, then ${n === 1 ? 'moves' : 'move'} across.`);
    this.defer(() => this.deps.handOver!(keeps));
  }

  // A thread a draining runner kept has come across: the resume it was
  // waiting for goes now, and its 15 minutes count from now.
  resumeAdopted(threadId: string): void {
    const r = this.takeDeferred(threadId);
    if (r) this.resumeOne(r, { deferred: true, adoptedAt: this.deps.clock.now() });
  }

  // Consume before sending, as with restart.json: a resume that brings the
  // runner down mustn't start again on every boot.
  private takeDeferred(threadId: string): ResumeDelivery | undefined {
    const r = this.deferred.get(threadId);
    if (!r) return undefined;
    const kept = new Map(this.deferred);
    kept.delete(threadId);
    this.saveDeferred(kept);
    return r;
  }

  private saveDeferred(kept: Map<string, ResumeDelivery>): void {
    this.deferred = kept;
    this.flushDeferred();
  }

  private flushDeferred(retryMs = 1_000): void {
    this.deferredSaveRetry?.cancel();
    this.deferredSaveRetry = undefined;
    if (!this.writeDeferred() && !this.restarting) {
      this.deferredSaveRetry = this.deps.clock.setTimeout(() => {
        this.deferredSaveRetry = undefined;
        if (!this.restarting) this.flushDeferred(Math.min(retryMs * 2, 30_000));
      }, retryMs);
    }
  }

  private writeDeferred(): boolean {
    const file = deferredResumesPath(this.deps.home);
    const recovery = deferredRecoveryPath(this.deps.home);
    const resumes = [...this.deferred.values()];
    const saveRecovery = () =>
      atomicWriteFileSync(recovery, JSON.stringify({ baseline: this.deferredBaseline, resumes }, null, 2) + '\n', 0o600);
    // A failed read can leave the previous queue on disk. Keep the last
    // known contents so those reservations aren't mistaken for new ones.
    this.deferredBaseline = readDeferredQueue(file) ?? this.deferredBaseline;
    try {
      if (fs.existsSync(recovery)) saveRecovery();
      if (resumes.length) atomicWriteFileSync(file, JSON.stringify(resumes, null, 2) + '\n', 0o600);
      else fs.rmSync(file, { force: true });
      this.deferredBaseline = resumes;
      fs.rmSync(recovery, { force: true });
      return true;
    } catch (e) {
      this.deps.log.warn('could not save deferred resumes', { error: String(e) });
      try {
        saveRecovery();
      } catch (error) {
        this.deps.log.warn('could not save deferred resume recovery copy', { error: String(error) });
      }
      return false;
    }
  }

  private begin(): void {
    if (this.restarting || !this.pending) return;
    this.restarting = true;
    this.backgroundTimer?.cancel();
    this.backgroundTimer = undefined;
    // A turn started now would be cut off before it got going.
    this.deps.runner.refuseNewTurns('The runner is restarting; send again in a moment.');
    this.pending.shutdownAt = this.isoNow();
    this.save();
    this.deps.log.info('restarting', { when: this.pending.when, reason: this.pending.reason });
    this.deps.runner.notice('info', pendingMessage(0));
    this.defer(() => this.deps.restart());
  }

  // A restart or handover has begun (main.ts: an uncaught error then is no
  // reason for another).
  get underway(): boolean {
    return this.restarting;
  }

  // main.ts calls this whenever the runner stops, whatever stopped it
  // (launchctl kickstart, a reboot, the restart itself). A pending restart
  // counts as done from here, so a resume's age starts now rather than when
  // the restart was first asked for.
  stopping(): void {
    this.deferredSaveRetry?.cancel();
    this.deferredSaveRetry = undefined;
    // Stopping cleanly isn't crashing: the restart this runner handled is done.
    this.proven();
    if (!this.pending || this.pending.shutdownAt) return;
    this.pending.shutdownAt = this.isoNow();
    this.save();
  }

  // main.ts calls this once the runner has stayed up long enough to be
  // marked good: resumes the runner has attempted won't need rollback
  // replay. Requests that are still waiting live in their own file.
  proven(): void {
    try {
      fs.rmSync(donePath(this.deps.home), { force: true });
    } catch (e) {
      this.deps.log.warn('could not remove restart.done.json', { error: String(e) });
    }
  }

  private save(): void {
    try {
      atomicWriteFileSync(restartPath(this.deps.home), JSON.stringify(this.pending, null, 2) + '\n');
    } catch (e) {
      // Still restarts; only a crash before then would lose it.
      this.deps.log.error('could not save restart.json', { error: String(e) });
    }
  }

  // ------------------------------------------------------- next start

  resumeAfterRestart(adoptedDuringStartup?: ReadonlyMap<string, number>): void {
    const home = this.deps.home;
    const file = deferredResumesPath(home);
    const recoveryPath = deferredRecoveryPath(home);
    const recovery = readJsonSync<DeferredRecovery | ResumeDelivery[]>(recoveryPath);
    const primary = readDeferredQueue(file);
    this.deferredBaseline = primary ?? (!Array.isArray(recovery) && Array.isArray(recovery?.baseline) ? recovery.baseline : null);
    if (Array.isArray(recovery)) {
      // The earlier recovery format lacked a baseline. Prefer the regular
      // file when it was written after that snapshot.
      this.deferred = deferredByThread(primary && newerFile(file, recoveryPath) ? primary : recovery);
    } else if (Array.isArray(recovery?.resumes)) {
      this.deferred = deferredByThread(recovery.resumes);
      if (primary && Array.isArray(recovery.baseline)) {
        const baseline = deferredByThread(recovery.baseline);
        const current = deferredByThread(primary);
        for (const id of new Set([...baseline.keys(), ...current.keys()])) {
          const resume = current.get(id);
          if (isDeepStrictEqual(resume, baseline.get(id))) continue;
          if (resume) this.deferred.set(id, resume);
          else this.deferred.delete(id);
        }
      }
    } else {
      this.deferred = deferredByThread(primary ?? []);
    }
    this.resumeSavedRestart(adoptedDuringStartup);
    if (recovery && !this.deferredSaveRetry) this.flushDeferred();
    // A kept thread may already have come across by the next startup.
    for (const id of this.deferred.keys()) {
      if (this.deps.elsewhere?.(id)) continue;
      const r = this.takeDeferred(id);
      if (r) this.resumeOne(r, { deferred: true, adoptedAt: adoptedDuringStartup?.get(id) });
    }
  }

  // Handles the restart.json the previous runner left (it restarted, or
  // crashed while a restart was pending, which comes to the same thing).
  // The file moves to restart.done.json first, so a resume that crashes
  // this runner isn't sent again by the next start of the same release; but
  // if this release keeps crashing and launch.mjs goes back to the last good
  // one, that runner finds restart.done.json with the rollback and resumes
  // the same threads once more, saying what happened.
  private resumeSavedRestart(adoptedDuringStartup: ReadonlyMap<string, number> | undefined): void {
    const { log, home } = this.deps;
    const file = restartPath(home);
    const done = donePath(home);
    const pending = fs.existsSync(file);
    if (!pending && !fs.existsSync(done)) return;
    const saved = readJsonSync<RestartFile>(pending ? file : done);
    const handled = typeof saved?.handledRelease === 'string' ? saved.handledRelease : undefined;
    const again = !pending && Boolean(this.deps.rolledBack) && handled !== undefined && handled === this.deps.rolledBackFrom;
    if (!pending && !again) {
      if (!this.deps.rolledBack && handled !== undefined && handled === this.deps.release) {
        // The same release getting a second start: keep the rollback record.
        log.info('restart.done.json is from this release, which has not been marked good yet; keeping it');
      } else {
        this.proven();
      }
      return;
    }

    const fromVersion = typeof saved?.fromVersion === 'string' ? saved.fromVersion : 'an unknown version';
    const from = again && typeof saved?.handledBy === 'string' ? saved.handledBy : fromVersion;
    const handledRelease = pending ? this.deps.release : handled;
    const ready: ResumeDelivery[] = [];
    const kept = new Map(this.deferred);
    let changed = false;
    for (const r of Array.isArray(saved?.resumes) ? saved.resumes : []) {
      if (!r || typeof r.threadId !== 'string' || typeof r.text !== 'string') continue;
      // Age starts at shutdown, or at the request if the runner crashed first.
      const restartAt = saved?.shutdownAt ?? r.requestedAt ?? saved?.requestedAt;
      const at = Date.parse(restartAt ?? '');
      const prior = kept.get(r.threadId);
      // A rollback or an interrupted move of restart.json can encounter
      // the same still-waiting request. Its age still counts from adoption.
      const same = prior && prior.requestedAt === r.requestedAt && prior.afterSeq === r.afterSeq && prior.text === r.text && prior.release === r.release;
      const replacesSince = same ? prior.replacesSince : again && Number.isFinite(at) ? at : undefined;
      const rolledBack = this.deps.rolledBack ?? (same ? prior.rolledBack : undefined);
      const delivery = { ...r, from, restartAt, handledRelease, replacesSince, rolledBack };
      if (same || this.deps.elsewhere?.(r.threadId)) {
        kept.set(r.threadId, delivery);
        changed = true;
        if (!same) log.info('the resume will wait for the thread to come across', { threadId: r.threadId });
      } else {
        changed = kept.delete(r.threadId) || changed;
        ready.push(delivery);
      }
    }
    // Try to persist waiting resumes before retiring the source request.
    // A failed save keeps them in memory and leaves ready resumes free to go.
    if (changed) this.saveDeferred(kept);
    try {
      if (pending && saved && typeof saved === 'object') {
        atomicWriteFileSync(done, JSON.stringify({ ...saved, handledBy: this.version, handledRelease: this.deps.release }, null, 2) + '\n');
      }
      fs.unlinkSync(pending ? file : done);
    } catch (e) {
      log.warn(`could not move ${pending ? 'restart.json' : 'restart.done.json'} aside`, { error: String(e) });
    }
    if (!saved || typeof saved !== 'object') {
      log.warn('restart.json could not be read; nothing to resume');
      return;
    }
    log.info('restarted', { from, to: this.version, reason: saved.reason, again });
    for (const r of ready) this.resumeOne(r, { adoptedAt: adoptedDuringStartup?.get(r.threadId) });
  }

  private resumeOne(r: ResumeDelivery, { deferred = false, adoptedAt }: { deferred?: boolean; adoptedAt?: number }): void {
    const { runner, log, home } = this.deps;
    let thread: ThreadSummary;
    try {
      thread = runner.get(r.threadId);
    } catch {
      log.warn('the thread to resume after the restart is gone', { threadId: r.threadId });
      return;
    }
    try {
      const now = this.deps.clock.now();
      let at = adoptedAt ?? Date.parse(r.restartAt ?? r.requestedAt);
      if (deferred && adoptedAt === undefined) {
        // Without a live handover, use the activity the old runner recorded.
        // Recovering the thread can itself start queued messages at startup.
        const activity = Date.parse(thread.lastActivityAt);
        if (activity < runner.startedAt && (!Number.isFinite(at) || activity > at)) at = activity;
      }
      const fresh = Number.isFinite(at) && now - at < RESUME_MAX_AGE_MS;
      const branch = this.deps.branch && this.deps.branch !== 'main' ? ` (from branch ${this.deps.branch})` : '';
      let note = `${RESTART_NOTE_START}${r.from} to ${this.version}${branch}`;
      const rolledBack = this.deps.rolledBack ?? r.rolledBack;
      if (rolledBack) note += `\n\n${rolledBack}`;
      const warning = this.wrongRelease(r);
      if (warning && !rolledBack) note += `\n\n${warning}`;
      const heads = [rolledBack, warning].filter(Boolean);
      const text = heads.length ? `${RESUME_NOTE_START}${heads.join(' ')}${RESUME_NOTE_END}${r.text}` : r.text;
      const checkHandled = deferred && r.replacesSince === undefined;
      if (checkHandled || r.replacesSince !== undefined) {
        const queued = runner.queuedMessages(r.threadId).find((m) => m.origin === 'runner' && m.wakeReason === RESUME_WAKE_REASON && sameResumeText(m.text, r.text));
        if (queued) {
          if (r.replacesSince !== undefined) {
            runner.replaceQueuedText(r.threadId, queued.turnId, text);
            runner.note(r.threadId, note);
          }
          return;
        }
      }
      let why = !fresh
        ? `the request is more than ${RESUME_MAX_AGE_MS / 60_000} minutes old`
        : thread.archivedAt
          ? 'this thread is archived'
          : thread.snoozedUntil !== undefined && Date.parse(thread.snoozedUntil) > now
            ? 'this thread is snoozed'
            : undefined;
      // A previous release may already have handled this after a rollback.
      // Discard its deferred copy before writing any note about this restart.
      // An explicit rollback replay still gets its own attempt.
      const input = checkHandled || !why ? this.inputSince(r, checkHandled) : undefined;
      if (input === 'handled') {
        log.info('discarded a deferred resume that was already handled', { threadId: r.threadId });
        return;
      }
      if (!why) {
        if (input === 'spoken') why = 'a message was sent to this thread after the restart was asked for';
        else if (!takeResume(home, r.threadId, now, r.replacesSince)) why = `this thread has already been resumed ${RESUMES_PER_HOUR} times in the last hour`;
      }
      if (why) note += `\n\n${RESUME_SKIPPED_START}${why}.`;
      runner.note(r.threadId, note);
      if (why) {
        log.info('not resuming a thread after the restart', { threadId: r.threadId, why });
        return;
      }
      // The note is only for the app; the model hears about a rollback, or a
      // release that isn't the one it deployed, from the message itself.
      runner.send(r.threadId, text, [], { origin: 'runner', wakeReason: RESUME_WAKE_REASON });
      log.info('resumed a thread after the restart', { threadId: r.threadId });
    } catch (e) {
      log.error('could not resume a thread after the restart', { threadId: r.threadId, error: String(e) });
    }
  }

  // Set when the thread asked for a release that isn't the one running.
  private wrongRelease(r: SavedResume): string | undefined {
    if (typeof r.release !== 'string' || !r.release || r.release === this.deps.release) return undefined;
    return `Release ${r.release} isn't running (this is ${this.deps.release ?? 'a runner run from source'}), so the change it carries isn't live.`;
  }

  // Once a resume was sent or explicitly skipped, its deferred copy is redundant. Otherwise a
  // new input from anyone else takes precedence over a pending resume.
  private inputSince(r: ResumeDelivery, checkHandled: boolean): 'spoken' | 'handled' | undefined {
    const { runner } = this.deps;
    const matches = (m: { origin?: string; wakeReason?: string; text: string }) =>
      m.origin === 'runner' && m.wakeReason === RESUME_WAKE_REASON && sameResumeText(m.text, r.text);
    if (typeof r.afterSeq !== 'number') return undefined;
    const failedRelease = checkHandled ? r.handledRelease : undefined;
    let spoken = false;
    for (let after = r.afterSeq; ; ) {
      const page = runner.events(r.threadId, { afterSeq: after, limit: 10_000 }).events;
      for (const e of page) {
        if (e.type === 'system.note' && !e.turnId && failedRelease && skippedResumeOnRollback(e.text, failedRelease)) return 'handled';
        if (e.type === 'user.message' && checkHandled && matches(e)) return 'handled';
        const recoveredInput = e.type === 'system.note' && !e.turnId && (e.queuedUserInput ??
          legacyQueuedUserInput(e.text));
        if (recoveredInput || (e.type === 'user.message' && e.origin !== 'runner')) {
          if (!checkHandled) return 'spoken';
          spoken = true;
        }
      }
      if (page.length < 10_000) return spoken ? 'spoken' : undefined;
      after = page[page.length - 1].seq;
    }
  }

  private isoNow(): string {
    return new Date(this.deps.clock.now()).toISOString();
  }
}

function deferredByThread(resumes: ResumeDelivery[]): Map<string, ResumeDelivery> {
  return new Map(resumes.filter((r) => r && typeof r.threadId === 'string' && typeof r.text === 'string' && typeof r.from === 'string')
    .map((r) => [r.threadId, r]));
}

function readDeferredQueue(file: string): ResumeDelivery[] | undefined {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data : undefined;
  } catch (e) {
    // Only a missing file is proof that an older runner emptied the queue.
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? [] : undefined;
  }
}

function newerFile(file: string, baseline: string): boolean {
  try {
    return fs.statSync(file).mtimeMs > fs.statSync(baseline).mtimeMs;
  } catch {
    return false;
  }
}

// Peer callbacks can arrive before the primary starts listening or even
// before its Restarter exists. Keep the actual adoption time until startup
// can safely send messages.
export function handoverResumes(
  runner: Pick<Runner, 'holdWaits' | 'adopt' | 'carryOnStopped'>,
  restarter: () => Pick<Restarter, 'resumeAdopted' | 'resumeAfterRestart'>,
  clock: Clock,
) {
  const adoptedDuringStartup = new Map<string, number>();
  return {
    adopt(threadId: string, opts?: { crashed?: boolean }) {
      const thread = runner.adopt(threadId, opts);
      if (runner.holdWaits) {
        if (thread && !adoptedDuringStartup.has(threadId)) adoptedDuringStartup.set(threadId, clock.now());
      } else {
        restarter().resumeAdopted(threadId);
        if (opts?.crashed) runner.carryOnStopped(threadId);
      }
      return thread;
    },
    ready() {
      try {
        restarter().resumeAfterRestart(adoptedDuringStartup);
      } finally {
        adoptedDuringStartup.clear();
      }
    },
  };
}

// Older releases only record a declined resume in the restart note. Its
// rollback paragraph names the failed release that saved restart.done.json.
function skippedResumeOnRollback(note: string, failedRelease: string): boolean {
  if (!note.startsWith(RESTART_NOTE_START)) return false;
  const [, rollback, skipped] = note.split('\n\n', 3);
  return rollback?.startsWith(`Release ${failedRelease} kept crashing at startup, so the runner went back to `) === true
    && skipped?.startsWith(RESUME_SKIPPED_START) === true;
}

function sameResumeText(sent: string, requested: string): boolean {
  if (sent === requested) return true;
  if (!sent.startsWith(RESUME_NOTE_START)) return false;
  const end = sent.indexOf(RESUME_NOTE_END);
  return end !== -1 && sent.slice(end + RESUME_NOTE_END.length) === requested;
}

// Old recovery notes kept the words but lost their origins. Recognize
// built-in carry-ons and stopped-work messages. Unknown text still wins
// over an automatic resume because it could be a user's stop.
function legacyQueuedUserInput(text: string): boolean {
  const match = /^The runner restarted before (a queued message was|(\d+) queued messages were) sent:\n\n([\s\S]*)$/.exec(text);
  if (!match) return false;
  const count = Number(match[2] ?? 1);
  const paragraphs = match[3].split('\n\n');
  let i = 0;
  for (let n = 0; n < count; n++) {
    if (isCarryOn({ text: paragraphs[i], origin: 'runner' })) {
      i++;
      continue;
    }
    const jobs = paragraphs[i + 1]?.split('\n');
    if (!jobs?.every((job) => job.startsWith('- '))) return true;
    const names = jobs.map((job) => job.slice(2));
    if (paragraphs.slice(i, i + 4).join('\n\n') === stoppedWorkMessage(names, true)) i += 4;
    else if (paragraphs.slice(i, i + 3).join('\n\n') === stoppedWorkMessage(names, false)) i += 3;
    else return true;
  }
  return i !== paragraphs.length;
}

// The notice while a restart waits. onYou of the waiting threads are
// waiting on Mike's answer to an approval or a question, which won't come by
// itself, so the line says so. The Mac app reads these sentences
// (RunnerRestart.parse in app/Sources/ThreadbearCore/RPC/RunnerRestart.swift:
// the prefix, and the numbers after it adding up to the count), and so does
// the mock runner's copy; restart.test.ts pins them.
export function pendingMessage(waiting: number, onYou = 0): string {
  if (waiting === 0) return 'The runner is restarting now.';
  const answer = Math.min(Math.max(0, onYou), waiting);
  const finishing = waiting - answer;
  const finish = finishing === 1 ? '1 thread finishes' : `${finishing} threads finish`;
  if (answer === 0) return `The runner will restart when ${finish}.`;
  if (finishing === 0) return `The runner will restart when you answer ${answer === 1 ? '1 thread' : `${answer} threads`}.`;
  return `The runner will restart when ${finish} and you answer ${answer}.`;
}

// At most RESUMES_PER_HOUR automatic resumes per thread in any hour, kept in
// run/resumes.json so a restart loop (an agent that deploys, resumes and
// deploys again) stops by itself. Returns false when the thread is over.
// replacesSince: resumes recorded from then on are dropped first. After a
// crash rollback the release that crashed resumed the thread once already
// for the same restart, and the one going back resumes it again; counting
// both stopped an agent at good deploy, broken deploy, fix.
export function takeResume(home: string, threadId: string, now: number, replacesSince?: number): boolean {
  const file = resumesPath(home);
  const out = recentResumes(home, now);
  let mine = out[threadId] ?? [];
  if (replacesSince !== undefined && Number.isFinite(replacesSince)) mine = mine.filter((t) => Date.parse(t) < replacesSince);
  if (mine.length >= RESUMES_PER_HOUR) return false;
  out[threadId] = [...mine, new Date(now).toISOString()];
  atomicWriteFileSync(file, JSON.stringify(out, null, 2) + '\n');
  return true;
}

// How many times the thread has been resumed in the last hour, without
// recording anything.
export function resumesInLastHour(home: string, threadId: string, now: number): number {
  return (recentResumes(home, now)[threadId] ?? []).length;
}

function recentResumes(home: string, now: number): Record<string, string[]> {
  const all = readJsonSync<Record<string, string[]>>(resumesPath(home)) ?? {};
  const recent = (ts: unknown): string[] =>
    Array.isArray(ts) ? ts.filter((t): t is string => typeof t === 'string' && now - Date.parse(t) < HOUR_MS) : [];
  const out: Record<string, string[]> = {};
  for (const [id, ts] of Object.entries(all)) {
    const kept = recent(ts);
    if (kept.length) out[id] = kept;
  }
  return out;
}

// ----------------------------------------------------------------- RPC

// runner.status and runner.restart, served by rpc.ts beside the runner's
// own methods.
export function restartMethods(r: Restarter): Record<string, (p: Record<string, unknown>) => unknown> {
  return {
    'runner.status': () => r.status(),
    'runner.restart': (p) => r.request(parseRestartParams(p)),
  };
}

function bad(message: string): RpcError {
  return new RpcError(ErrorCode.badParams, message);
}

export function parseRestartParams(p: Record<string, unknown>): RestartParams {
  const out: RestartParams = {};
  if (p.cancel !== undefined && p.cancel !== null && p.cancel !== false) {
    if (p.cancel !== true) throw bad('cancel must be true or false');
    out.cancel = true;
  }
  if (p.release !== undefined && p.release !== null) {
    if (typeof p.release !== 'string' || !p.release) throw bad('release must be a release id');
    out.release = p.release;
  }
  if (p.when !== undefined && p.when !== null) {
    if (p.when !== 'idle' && p.when !== 'now') throw bad('when must be "idle" or "now"');
    out.when = p.when;
  }
  if (p.backgroundWaitMs !== undefined && p.backgroundWaitMs !== null) {
    if (typeof p.backgroundWaitMs !== 'number' || !Number.isFinite(p.backgroundWaitMs) || p.backgroundWaitMs < 0) throw bad('backgroundWaitMs must be a number of milliseconds');
    out.backgroundWaitMs = p.backgroundWaitMs;
  }
  if (p.reason !== undefined && p.reason !== null) {
    if (typeof p.reason !== 'string') throw bad('reason must be a string');
    if (p.reason.trim()) out.reason = p.reason.trim();
  }
  if (p.resume !== undefined && p.resume !== null) {
    const r = p.resume as Record<string, unknown>;
    if (typeof r !== 'object' || Array.isArray(r)) throw bad('resume must be an object');
    if (typeof r.threadId !== 'string' || !r.threadId) throw bad('resume.threadId must be a string');
    if (typeof r.text !== 'string' || !r.text.trim()) throw bad('resume.text must be a non-empty string');
    out.resume = { threadId: r.threadId, text: r.text };
  }
  return out;
}
