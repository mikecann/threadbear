// Mentions (rides on the bears experiment; docs/protocol.md "Bears"):
// `@Name` or `@bear:<id>` in a message the user sends, or `tb bears ask` from
// a thread (bears.mention), hands the message to that bear in a fresh
// thread in its folder, and brings the bear's reply back when its turn
// ends. The bear's thread joins the asking thread's projects, so it starts
// with the same brief.
//
// Rules:
// - access never widens: the bear's thread runs in the lower of the bear's
//   mode (Ask unless the user raised it) and the asking thread's;
// - a thread never mentions its own bear; at most 3 bears a message;
// - a bear's own thread can ask another bear only through a table they
//   share, unless it's Head Bear (the chief of staff);
// - at a table, each of the user's messages allows at most maxTurns bear
//   replies; after that the host has to sum up (tables.ts);
// - one job at a time per bear: a new ask while its mention thread is
//   still going folds into that thread, and the reply goes to everyone
//   who asked.
import fs from 'node:fs';
import path from 'node:path';
import type { PermissionMode, ThreadStartedBy } from './protocol.ts';
import { awayText, lowerMode, type BearInfo, type Bears } from './bears.ts';

export const MAX_BEARS_PER_MESSAGE = 3;
export const REPLY_MAX = 6_000;
export const BEAR_REPLY_PREFIX = '[Bear: ';

type ThreadView = { id: string; title: string; cwd: string; permissionMode?: PermissionMode; status?: string; projects?: { id: string }[] };

export type MentionHost = {
  has(threadId: string): boolean;
  get(threadId: string): ThreadView;
  create(p: { text: string; cwd: string; permissionMode: PermissionMode; startedBy: ThreadStartedBy; origin: 'runner'; projectIds?: string[]; title?: string }): { thread: { id: string } };
  send(threadId: string, text: string): unknown;
  note?(threadId: string, text: string): void;
  // The last turn's reply text.
  lastReply(threadId: string): string;
};

// A table the asking thread sits at (tables.ts): its bears and turn cap.
export type TableOf = (cwd: string) => { id: string; title: string; bears: string[]; maxTurns: number } | undefined;

type Waiter = { fromThreadId: string; tableId?: string };
type State = { jobs: Record<string, { bearId: string; bearName: string; waiters: Waiter[] }>; rounds: Record<string, number> };

export type MentionResult = { threadId?: string; bear: string; note?: string };

// The bears a message names: `@bear:<id>`, or `@Name` for a bear's name
// (any case, longest name first, so "@Head Bear" beats "@Head").
export function findMentions(text: string, bears: Pick<BearInfo, 'id' | 'name'>[]): string[] {
  const out: string[] = [];
  const add = (id: string) => {
    if (!out.includes(id)) out.push(id);
  };
  for (const m of text.matchAll(/(?:^|[\s(])@bear:([a-z0-9][a-z0-9-]{0,40})/g)) if (bears.some((b) => b.id === m[1])) add(m[1]);
  const byLength = [...bears].sort((a, b) => b.name.length - a.name.length);
  const lower = text.toLowerCase();
  for (const b of byLength) {
    const name = b.name.toLowerCase();
    let at = lower.indexOf(`@${name}`);
    while (at >= 0) {
      const before = at === 0 ? ' ' : lower[at - 1];
      const after = lower[at + 1 + name.length] ?? ' ';
      if (/[\s(]/.test(before) && !/[a-z0-9_-]/.test(after)) {
        add(b.id);
        break;
      }
      at = lower.indexOf(`@${name}`, at + 1);
    }
  }
  return out;
}

function quote(text: string): string {
  const body = text.trim().slice(0, REPLY_MAX) || '(no reply text)';
  return body.split(/\r?\n/).map((l) => `> ${l}`).join('\n');
}

export class Mentions {
  private readonly file: string;
  private readonly bears: Bears;
  private readonly host: MentionHost;
  private readonly tableOf: TableOf;

  constructor(d: { home: string; bears: Bears; host: MentionHost; tableOf?: TableOf }) {
    this.file = path.join(d.home, 'runner', 'mentions.json');
    this.bears = d.bears;
    this.host = d.host;
    this.tableOf = d.tableOf ?? (() => undefined);
  }

  private read(): State {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<State>;
      return { jobs: j.jobs ?? {}, rounds: j.rounds ?? {} };
    } catch {
      return { jobs: {}, rounds: {} };
    }
  }

  private write(s: State): void {
    const ids = Object.keys(s.jobs);
    for (const id of ids.slice(0, Math.max(0, ids.length - 300))) delete s.jobs[id];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(s), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  // The user wrote in a thread: a new round at a table, and any bears they
  // named are asked. Answers a line for the asking thread's agent, or
  // undefined when nothing was mentioned.
  fromUser(threadId: string, text: string): string | undefined {
    const s = this.read();
    if (s.rounds[threadId]) {
      delete s.rounds[threadId];
      this.write(s);
    }
    const ids = findMentions(text, this.bears.list({ faces: false })).slice(0, MAX_BEARS_PER_MESSAGE + 1);
    if (!ids.length) return undefined;
    const lines: string[] = [];
    ids.forEach((id, i) => {
      if (i >= MAX_BEARS_PER_MESSAGE) {
        lines.push(`Only ${MAX_BEARS_PER_MESSAGE} bears are asked per message; the rest weren't.`);
        return;
      }
      try {
        const r = this.ask({ fromThreadId: threadId, bear: id, text, byUser: true });
        lines.push(r.note ?? `Asked ${r.bear} in thread:${r.threadId}. Its reply comes back here as a message; to wait for it, end your turn with waitFor that thread.`);
      } catch (e) {
        lines.push((e as Error).message);
      }
    });
    return `[Threadbear: ${lines.join(' ')}]`;
  }

  // One ask. byUser: from a message the user sent (no bear-to-bear rule).
  ask(p: { fromThreadId?: string; bear: string; text: string; byUser?: boolean }): MentionResult {
    const bear = this.bears.get(p.bear, { faces: false });
    const text = p.text.trim();
    if (!text) throw new Error('Say what to ask.');
    if (bear.archived) throw new Error(`${bear.name} is archived.`);
    if (bear.away) return { bear: bear.name, note: `${bear.name} is away until ${awayText(bear.state.awayUntil!)}. \`tb bears away ${bear.id} off\` wakes it.` };
    const from = p.fromThreadId && this.host.has(p.fromThreadId) ? this.host.get(p.fromThreadId) : undefined;
    const asker = from ? this.bears.forCwd(from.cwd) : undefined;
    if (asker?.id === bear.id) throw new Error(`That's ${bear.name}'s own thread: a bear doesn't mention itself.`);
    const table = from ? this.tableOf(from.cwd) : undefined;
    if (table && !table.bears.includes(bear.id)) throw new Error(`${bear.name} isn't at the table "${table.title}".`);
    if (asker && !p.byUser && !asker.head) throw new Error(`${asker.name} can ask another bear only through a table they share, so the user sees it. Ask from the table's thread.`);
    const s = this.read();
    if (table && from) {
      const used = s.rounds[from.id] ?? 0;
      if (used >= table.maxTurns) throw new Error(`This table has had ${table.maxTurns} bear replies since the user last wrote. Sum up and stop; the bears wait for the user.`);
      s.rounds[from.id] = used + 1;
    }
    const waiter: Waiter | undefined = from ? { fromThreadId: from.id, ...(table ? { tableId: table.id } : {}) } : undefined;
    const intro = from ? `[Asked from the thread "${from.title}" (thread:${from.id})${table ? `, at the table "${table.title}"` : ''}. Your reply goes back there when your turn ends.]` : '[Asked with tb bears ask.]';
    const body = `${intro}\n\n${text}`;
    // One job at a time: a mention thread still going takes this one too.
    const busy = Object.entries(s.jobs).find(([id, j]) => j.bearId === bear.id && this.host.has(id) && isBusy(this.host.get(id).status));
    if (busy) {
      const [id, job] = busy;
      if (waiter && !job.waiters.some((w) => w.fromThreadId === waiter.fromThreadId)) job.waiters.push(waiter);
      this.write(s);
      this.host.send(id, body);
      return { threadId: id, bear: bear.name };
    }
    const mode = lowerMode(bear.state.permissionMode ?? 'ask', from?.permissionMode ?? 'ask');
    const { thread } = this.host.create({
      text: body,
      cwd: bear.folder,
      permissionMode: mode,
      origin: 'runner',
      title: `${bear.name}: ${text.replace(/\s+/g, ' ').slice(0, 60)}`,
      startedBy: { kind: 'thread', label: from ? `Mentioned by ${from.title}`.slice(0, 80) : 'Mentioned', ...(from ? { threadId: from.id } : {}) },
      ...(from?.projects?.length ? { projectIds: from.projects.map((x) => x.id) } : {}),
    });
    s.jobs[thread.id] = { bearId: bear.id, bearName: bear.name, waiters: waiter ? [waiter] : [] };
    this.write(s);
    return { threadId: thread.id, bear: bear.name };
  }

  // A thread's turn ended: if it's a bear's mention thread, its reply goes
  // back to whoever asked.
  turnEnded(threadId: string): number {
    const s = this.read();
    const job = s.jobs[threadId];
    if (!job || !job.waiters.length) return 0;
    const reply = this.host.lastReply(threadId);
    const text = `${BEAR_REPLY_PREFIX}${job.bearName} replied in thread:${threadId}. It's a bear's answer, not the user's words.]\n\n${quote(reply)}`;
    let n = 0;
    for (const w of job.waiters) {
      if (!this.host.has(w.fromThreadId)) continue;
      try {
        this.host.send(w.fromThreadId, text);
        n++;
      } catch {
        /* that thread is gone or won't take it */
      }
    }
    job.waiters = [];
    this.write(s);
    return n;
  }
}

function isBusy(status?: string): boolean {
  return status === 'running' || status === 'starting' || status === 'waiting' || status === 'queued';
}
