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
