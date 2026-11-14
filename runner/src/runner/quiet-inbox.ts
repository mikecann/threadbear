// A quiet inbox (experiment quietInbox; docs/protocol.md, "A quiet
// inbox"): a finished thread with nothing for Mike keeps out of it.
//
// Mike, 12 Nov 2026, of three threads other threads had started (a bun fix
// split off a Let's Build It thread, two GPUI fixes from the port's
// thread): "there's nothing for me to do... it should just auto archive."
// And of a done card listing four threads its thread had started that
// were still building: "If that thread is waiting on another thread, then
// it shouldn't be in the inbox." Before this a thread only archived itself
// when asked (end_turn's archive), and only waited on others when its
// agent said so (waitFor).
//
// Each method's `this` is the Runner; runner.ts puts them on its prototype.
import type { Runner, ThreadState } from '../runner.ts';
import type { RunnerPart } from './part.ts';
import type { LooseEnd } from '../protocol.ts';
import { sentByAgent } from '../protocol.ts';
import { experimentOn } from '../experiments.ts';
import { above } from '../threadbear-mcp.ts';

export const QUIET_INBOX = 'quietInbox';
export const HELPER_ARCHIVED_NOTE = 'Archived: another thread started this one, and it finished with nothing left for you.';

export const quietInboxPart = {
  // After a turn that finished for good (completeTurn's `finished`, with no
  // review of it to come). `next`: whether it suggested follow-ups, which
  // are Mike's to tick or leave.
  async settleQuietly(this: Runner, st: ThreadState, next: boolean, quiet = false): Promise<void> {
    const { rec, rt } = st;
    const quietInbox = experimentOn(this.cfg.home, QUIET_INBOX);
    const bear = experimentOn(this.cfg.home, 'bears') && Boolean(this.bearOf?.(rec.cwd));
    const unattended = Boolean(rec.schedule || ['thread', 'schedule', 'tool'].includes(rec.startedBy?.kind ?? ''));
    const quietBear = bear && unattended && quiet;
    // A useful bear report stays even if it is also a helper thread.
    if (bear ? !quietBear : !quietInbox) return;
    const seq = this.looseEndsCard(st);
    if (seq === undefined) return;
    let ends: LooseEnd[];
    try {
      // The done card's own check of this card, if it's going (looseEnds).
      ends = await (rt.looseEndsGather ?? this.gatherLooseEnds(st));
    } catch (e) {
      // Not known to be clean, so it stays where Mike can see it.
      this.log.warn("couldn't check a finished thread's loose ends", { threadId: rec.id, error: String(e) });
      return;
    }
    // Git took a moment. Anything since (a message, a new turn, Mike or a
    // schedule putting it away, the runner stopping) decides instead.
    if (rt.deleted || this.stopping || rt.turn || rec.queue.length || this.looseEndsCard(st) !== seq || this.bucket(rec) !== 'inbox') return;
    // The threads it started, as they stand now rather than when git began.
    const open = [...ends.filter((e) => e.kind !== 'thread' && e.kind !== 'scheduled'), ...this.childEnds(st)];
    const waits = open.filter((e) => e.kind === 'thread' && e.threadId).map((e) => ({ id: e.threadId! }));
    // Only on threads with as much access as it has: the wake passes on what
    // they said, which from one with less would need send_message's card
    // (Daybreak, 12 Nov 2026). Otherwise it stays in the inbox, as before.
    const me = this.authorityNow(rec.id);
    if (waits.some((w) => above(me, this.authorityNow(w.id)))) {
      this.log.info('quiet inbox: not waiting on threads it started with less access', { threadId: rec.id });
      return;
    }
    if (quietInbox && waits.length && waits.length === open.length) {
      // All that's left is theirs to finish: it waits on them, as end_turn's
      // waitFor would have, and wakes with what they said. No longer
      // finished itself, for anything waiting on it in turn.
      delete rec.finished;
      this.waitOn(st, waits, undefined);
      // So its wake says the runner put it away, not the agent (deliverWaits).
      for (const w of rec.waitingOn ?? []) w.quiet = true;
      this.markDirty(st);
      this.log.info('quiet inbox: waiting on the threads it started', { threadId: rec.id, on: waits.map((w) => w.id) });
      return;
    }
    // A check-in it booked brings it back by itself; it goes after that run.
    if (open.length || ends.some((e) => e.kind === 'scheduled')) return;
    if (!this.helperNobodyTouched(st, quietBear) || next) return;
    this.emit(st, { type: 'system.note', text: quietBear ? 'Archived: this bear finished its unattended run with nothing new to report.' : HELPER_ARCHIVED_NOTE });
    this.update({ threadId: rec.id, archived: true, archivedBy: 'threadbear' });
    this.log.info('quiet inbox: archived a finished helper thread', { threadId: rec.id, startedBy: rec.startedBy?.threadId });
  },

  // One another thread's agent started that Mike has had nothing to do
  // with: never written in (answering its card counts), starred, or taken
  // back out of the archive. A tool's, a schedule's or the librarian's is
  // often the thing he wants to read, and has no thread holding its result.
  helperNobodyTouched(this: Runner, st: ThreadState, unattendedBear = false): boolean {
    const { rec } = st;
    if ((!unattendedBear && rec.startedBy?.kind !== 'thread') || rec.starredAt || rec.keptOut || rec.reviewOf) return false;
    // Its first message is its starter's brief, whatever it looks like (`tb
    // new` from an agent's shell has no "Sent by the agent" line, so
    // rec.asked can't be trusted for it). Anything of Mike's after that
    // makes it his.
    const log = this.store.log(rec.id);
    const events = log.read(1, log.lastSeq);
    if (unattendedBear && events.some((e) => e.type === 'approval.resolved' && e.decision !== 'expired')) return false;
    if (unattendedBear) {
      // A final empty check must not hide an earlier report in this shared
      // worker. Every completed turn in it must have explicitly been quiet.
      const quietTurns = new Map<string, boolean>();
      for (const e of events) {
        if (!e.turnId) continue;
        if (e.type === 'tool.call' && e.name.split('__').at(-1) === 'end_turn') quietTurns.set(e.turnId, e.input?.quiet === true);
        if (e.type === 'turn.completed' && (e.outcome !== 'completed' || !quietTurns.get(e.turnId))) return false;
      }
    }
    const said = events.filter((e) => e.type === 'user.message');
    return !said.slice(1).some((m) => (!m.origin || m.origin === 'phone') && !sentByAgent(m.text));
  },
};

export type QuietInboxPart = RunnerPart<typeof quietInboxPart>;
