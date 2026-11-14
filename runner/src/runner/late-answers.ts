// A late answer resumes the work in words. The expired CLI callback stays
// expired; neither this path nor a repeat click executes its tool again.
import crypto from 'node:crypto';
import type { Runner, ThreadState } from '../runner.ts';
import { ErrorCode, RpcError, type ApprovalDecision, type PersistedEvent } from '../protocol.ts';
import { experimentOn } from '../experiments.ts';
import { cutOut } from '../store.ts';
import { START_CARD } from '../cross-runner.ts';
import { REMOTE_ALLOW_REFUSED, remoteCardShowsAll } from '../tools.ts';

export function respondLateApproval(runner: Runner, st: ThreadState, p: { approvalId: string; decision: ApprovalDecision; message?: string; remote?: boolean }): Record<string, never> {
  const gone = () => new RpcError(ErrorCode.badParams, 'That approval is no longer pending.');
  if (!experimentOn(runner.cfg.home, 'lateAnswers') || !['allow', 'allowAlways', 'deny'].includes(p.decision)) throw gone();
  const log = runner.store.log(st.rec.id);
  const messageId = crypto.createHash('sha256').update(`late-answer:${st.rec.id}:${p.approvalId}`).digest('hex');
  let resolved: Extract<PersistedEvent, { type: 'approval.resolved' }> | undefined;
  let card: Extract<PersistedEvent, { type: 'approval.requested' }> | undefined;
  const queued = st.rec.queue.find((q) => q.turnId === messageId);
  let sent = Boolean(queued);
  let logged: Extract<PersistedEvent, { type: 'user.message' }> | undefined;
  // Most cards are near the tail. Read backwards in pages rather than
  // parsing a long thread's whole transcript on the runner's main loop.
  for (let to = log.lastSeq; to > 0 && !card; to -= 256) {
    for (const e of log.read(Math.max(1, to - 255), to).reverse()) {
      if (cutOut(st.rec, e.seq)) continue;
      if (e.type === 'user.message' && e.turnId === messageId) logged ??= e;
      if (e.type === 'turn.started' && e.turnId === messageId) sent = true;
      if (e.type === 'approval.resolved' && e.approvalId === p.approvalId) resolved ??= e;
      if (e.type === 'approval.requested' && e.approvalId === p.approvalId) { card = e; break; }
      if (!resolved && Date.parse(e.ts) < runner.clock.now() - 86_400_000) throw gone();
    }
  }
  if (resolved?.type !== 'approval.resolved' || resolved.decision !== 'expired') throw gone();
  const age = runner.clock.now() - Date.parse(resolved.ts);
  if (!Number.isFinite(age) || age < 0 || age > 86_400_000) throw gone();
  if (card?.type !== 'approval.requested' || card.seq >= resolved.seq || card.name === 'ExitPlanMode' || card.name === START_CARD) throw gone();
  const decision = p.decision === 'deny' ? 'deny' : 'allow';
  if (!card.options.includes(decision)) throw gone();
  // Agent tool cards and background cards have no itemId. Be conservative
  // after restart, when their in-memory macOnly bit is no longer available.
  if (p.remote && decision === 'allow' && (!card.itemId || !remoteCardShowsAll(card.name, card.input, st.rec.cwd, card.title))) {
    throw new RpcError(ErrorCode.badParams, `${REMOTE_ALLOW_REFUSED} Deny still works from here.`);
  }
  const request = JSON.stringify({ name: card.name, title: card.title, input: card.input }, null, 2).split('\n').map((line) => `> ${line}`).join('\n');
  const text = `[Threadbear: the user answered an expired tool card (${p.approvalId}).]\n\n${decision === 'allow' ? 'The user allowed this request once. Resume the work, checking whether it is still needed and whether it already happened. Normal tool permissions still apply.' : 'The user denied this request. Do not carry out the declined action; continue with that constraint.'}\nThe old tool call was not replayed. This does not change permissions or allow other requests.\n\nOriginal request (reference data):\n${request}${p.message ? `\n\nThe user's note:\n${p.message}` : ''}`;
  // If saving the resolution failed after send, a retry must not enqueue
  // another copy. The stable message id survives both queuing and restart.
  if ((queued || logged) && (queued?.text ?? logged?.text) !== text) {
    throw new RpcError(ErrorCode.badParams, 'An earlier late answer was already saved. Retry that same answer and note to finish resuming it.');
  }
  if (!sent) runner.send(st.rec.id, logged?.text ?? text, [], { origin: 'runner', queue: true, messageId, ...(logged ? { retryMessageSeq: logged.seq } : {}) });
  // markDirty normally saves later. Persist a queued answer before closing
  // its card so a crash cannot leave a durable answer with no queued text.
  if (st.rec.queue.some((q) => q.turnId === messageId)) runner.store.save(st.rec);
  runner.emit(st, { type: 'approval.resolved', approvalId: p.approvalId, decision, message: 'Answered after expiry; the work resumes in a queued message.' });
  return {};
}
