import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();
// Finished commands and paged messages older than a day.
crons.interval('prune old rows', { hours: 6 }, internal.sync.pruneOld, {});
// Stored files whose rows ran out (tool pictures, uploads never sent) and
// commands no runner took in two weeks: on their own, so neither holds up the other.
crons.interval('prune old files', { hours: 6 }, internal.sync.pruneFiles, {});
// Tool output past its 30 days, a batch at a time (each row is read to be deleted).
crons.interval('prune old tool output', { minutes: 15 }, internal.sync.pruneBodies, {});
// Webhook calls and bad-key rows past their time, and ended hooks (webhooks.ts).
crons.interval('prune webhook calls', { hours: 1 }, internal.webhooks.prune, {});
// Moves nobody answered, or frozen too long (moves.ts), and old ended ones.
crons.interval('expire moves', { minutes: 5 }, internal.moves.expireMoves, {});
// Pushes held for a Mac that went to sleep with Mike at it (sync.ts).
crons.interval('send stale held pushes', { minutes: 2 }, internal.sync.sendStaleHeldPushes, {});
export default crons;
