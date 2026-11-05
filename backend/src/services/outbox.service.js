import { getCollection } from './mongo.service.js';
import { logger } from '../utils/logger.js';

/**
 * MONGO-FIRST WRITES (2026-08-26) — the write half of the same move that
 * made reads Mongo-first (mongoSheetData.service.js). Explicit, informed
 * trade-off the user chose: every write action responds the instant its
 * Mongo write lands; the matching Google Sheets write happens afterward, in
 * the background, via the outbox worker (jobs/outboxWorker.js) — typically
 * within one poll interval (env.outboxPollMs, ~7s), not instantly. Anyone
 * viewing the raw spreadsheet directly, or another app sharing it, sees the
 * change with that same short lag. This was flagged and explicitly accepted
 * before building it: "sheet can go background and can take time it's ok."
 *
 * DESIGN — replay the ORIGINAL function, not a second implementation.
 * An earlier version of this pattern (writeThrough.service.js /
 * outboxWorker.js, removed 2026-08-21) required a hand-written "pusher"
 * function per write action that re-implemented that action's Sheets logic
 * a second time — real risk of the two implementations drifting apart.
 * This version instead enqueues a replay of the EXACT SAME, already-correct
 * live-Sheets function (saveOffLeaseStage, saveVerifyAction, ...) with the
 * exact same arguments it would have been called with directly. That
 * function still does its own fresh live read, its own guard checks
 * (ALREADY_PROCESSED etc.), and its own write — authoritative and
 * unchanged. The only new code per action is a fast "decide against Mongo +
 * patch Mongo + enqueue" wrapper (see e.g. offlease.service.js's
 * saveOffLeaseStageFast) — no Sheets logic is ever duplicated.
 *
 * Each outbox entry: { kind, args, status, attempts, nextAttemptAt, ... }.
 * `kind` is a registry key (jobs/outboxRegistry.js) resolving to the real
 * function; `args` is the exact positional argument list to call it with.
 */
export const OUTBOX_COLLECTION = '_sync_outbox';
const DEFAULT_MAX_ATTEMPTS = 8;

export async function enqueueSheetReplay(kind, args, opts = {}) {
  const now = new Date();
  await getCollection(OUTBOX_COLLECTION).insertOne({
    kind,
    args,
    actor: opts.actor || null,
    status: 'pending',
    attempts: 0,
    maxAttempts: opts.maxAttempts || DEFAULT_MAX_ATTEMPTS,
    nextAttemptAt: now,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null
  });
  logger.debug(`[OUTBOX] enqueued ${kind}`);
}

/**
 * Read-only outbox summary — explicit request 2026-10-17 ("there should be
 * a log that which [records] are left to be added in the sheet"): visibility
 * into what's still waiting to replay against live Sheets, since the whole
 * point of Mongo-first writes is that the Mongo side is already done by the
 * time anyone would look. Counts every status; the entry list only covers
 * the ones NOT yet 'done' (pending/processing/failed/dead/skipped), newest
 * first, capped at `limit` — 'done' entries are routine history, not
 * something needing attention. 'skipped' (added 2026-10-23, see
 * outboxWorker.js's GUARD_REJECTION_SENTINELS) means the replay ran but a
 * guard check rejected it — nothing was written to Sheets, needs review.
 */
export async function getOutboxStatus(limit = 200) {
  const col = getCollection(OUTBOX_COLLECTION);
  const [counts, entries] = await Promise.all([
    col.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]).toArray(),
    col.find({ status: { $ne: 'done' } }).sort({ createdAt: -1 }).limit(limit).toArray()
  ]);
  const byStatus = { pending: 0, processing: 0, failed: 0, dead: 0, skipped: 0, done: 0 };
  for (const c of counts) if (c._id in byStatus) byStatus[c._id] = c.count;
  return {
    counts: byStatus,
    entries: entries.map((e) => ({
      id: String(e._id),
      kind: e.kind,
      // Most registered actions take containerNo as their first arg — a
      // best-effort label for the list, not authoritative; the full args
      // array is also returned for anyone who needs the exact detail.
      subject: Array.isArray(e.args) && e.args.length ? String(e.args[0]) : '',
      args: e.args || [],
      actor: e.actor || '',
      status: e.status,
      attempts: e.attempts,
      maxAttempts: e.maxAttempts,
      lastError: e.lastError || '',
      nextAttemptAt: e.nextAttemptAt,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt
    }))
  };
}
