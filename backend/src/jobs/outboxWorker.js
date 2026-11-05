/**
 * Drains _sync_outbox (see outbox.service.js) — every Mongo-first write
 * enqueues an entry here, and this poll loop is what actually replays the
 * matching write against Google Sheets, asynchronously, after the HTTP
 * request that made the write has already responded.
 *
 * Rate-limit handling is scoped ENTIRELY to this module: a Sheets quota hit
 * pauses only this worker's own claiming (workerPausedUntil) — Mongo-backed
 * API traffic (every read, and the fast-path Mongo writes) must keep
 * working normally even while this worker is backing off.
 */
import { getCollection } from '../services/mongo.service.js';
import { resolveReplay } from './outboxRegistry.js';
import { isGoogleQuotaError } from '../middlewares/errorHandler.js';
import { OUTBOX_COLLECTION } from '../services/outbox.service.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const BATCH_SIZE = 20;
const BASE_DELAY_MS = 15000; // 15s, doubles per attempt
const MAX_DELAY_MS = 15 * 60 * 1000; // 15 min cap
const QUOTA_PAUSE_MS = 5 * 60 * 1000; // mirrors the app's global-lockout duration, but local to this worker only
// BUG FOUND AND FIXED 2026-10-17 ("there should be a log that which... are
// left to be added in the sheet" — building that log surfaced this): a
// process restart (deploy, crash) between claimBatch setting an entry to
// 'processing' and markDone/markFailure running orphans it forever — the
// claim query only ever looked at 'pending'/'failed', so a 'processing'
// entry was never reclaimed by anything. Confirmed live: 84 entries stuck
// in 'processing' since 2026-10-10, their Sheets writes never replayed, no
// error logged anywhere — a silent week-long Mongo/Sheet desync. A real
// write only ever takes seconds, so anything still 'processing' after this
// long is abandoned, not slow — safe to treat as claimable again.
const STALE_PROCESSING_MS = 10 * 60 * 1000; // 10 min

// BUG FOUND AND FIXED 2026-10-23 (same user request that asked for a Fast
// path on Save/Submit — reviewing the existing worker surfaced this): a
// replay that returns one of these guard-rejection sentinels (the record's
// state in live Sheets no longer matches what the Mongo-first write assumed
// — e.g. someone else already approved/sent-back the row in the meantime)
// was being treated as a SUCCESS and marked 'done', because it didn't
// throw. Nothing was actually written to Sheets, and there was no trace of
// that anywhere — the queued change was silently dropped. These are the
// exact sentinel strings every registered replay target in this codebase
// uses for "guard rejected, nothing written" (grep-verified across
// expiry.service.js and offlease.service.js — 'OK' is the only success
// sentinel; everything else these functions return on success is either
// 'OK' or a free-form success sentence, never one of these all-caps ones).
const GUARD_REJECTION_SENTINELS = new Set(['ALREADY_PROCESSED', 'INVALID_STATE', 'MISSING_PO_OR_AGR', 'AWAITING_APPROVAL']);

let workerPausedUntil = 0;
let ticking = false;
let intervalHandle = null;

async function claimBatch(col) {
  const now = new Date();
  const due = await col.find({
    $or: [
      { status: { $in: ['pending', 'failed'] }, nextAttemptAt: { $lte: now } },
      { status: 'processing', updatedAt: { $lte: new Date(now - STALE_PROCESSING_MS) } }
    ]
  }).sort({ nextAttemptAt: 1 }).limit(BATCH_SIZE).toArray();

  const claimed = [];
  for (const entry of due) {
    const res = await col.findOneAndUpdate(
      { _id: entry._id, status: entry.status },
      { $set: { status: 'processing', updatedAt: now } },
      { returnDocument: 'after' }
    );
    if (res) claimed.push(res);
  }
  return claimed;
}

async function markDone(col, entry, durationMs) {
  const now = new Date();
  await col.updateOne({ _id: entry._id }, { $set: { status: 'done', completedAt: now, updatedAt: now, lastError: null } });
  logger.info(`[OUTBOX] Replayed to Sheets | Kind: ${entry.kind} | Duration: ${durationMs.toFixed(1)}ms`);
}

/** See GUARD_REJECTION_SENTINELS above — a terminal state distinct from
 *  'done' (nothing was actually written) and from 'dead' (this isn't a
 *  failure that exhausted retries; retrying it again would just get the
 *  same rejection forever, since the args are fixed). Surfaced on the Sync
 *  Status page for manual review. */
async function markSkipped(col, entry, result) {
  const now = new Date();
  await col.updateOne({ _id: entry._id }, {
    $set: { status: 'skipped', completedAt: now, updatedAt: now, lastError: `Replay returned '${result}' — nothing was written to Sheets. The record's state likely changed before this queued write could be applied; review manually.` }
  });
  logger.warn(`[OUTBOX] entry ${entry._id} (${entry.kind}) skipped — replay returned '${result}', not a Sheets write`);
}

async function markFailure(col, entry, err) {
  const now = new Date();
  const message = err?.message || String(err);

  if (isGoogleQuotaError(err)) {
    workerPausedUntil = Date.now() + QUOTA_PAUSE_MS;
    logger.warn(`[OUTBOX] Google Sheets quota hit — pausing outbox worker for ${QUOTA_PAUSE_MS / 1000}s`);
    // BUG FOUND AND FIXED 2026-10-23: quota exhaustion is never the entry's
    // own fault and has no fixed bound on how long it lasts — it used to
    // still burn an attempt and apply the escalating backoff like any other
    // failure, so a long outage could exhaust maxAttempts and leave the
    // entry permanently 'dead' even though the write was always going to
    // succeed once the lock cleared. Attempt count is left untouched; it
    // just retries right after this worker-wide pause ends.
    await col.updateOne({ _id: entry._id }, {
      $set: { status: 'failed', lastError: message, nextAttemptAt: new Date(workerPausedUntil), updatedAt: now }
    });
    return;
  }

  const attempts = entry.attempts + 1;
  if (attempts >= entry.maxAttempts) {
    await col.updateOne({ _id: entry._id }, { $set: { status: 'dead', attempts, lastError: message, updatedAt: now } });
    logger.error(`[OUTBOX ERROR] entry ${entry._id} (${entry.kind}) exhausted retries -> dead | Reason: ${message}`);
    return;
  }

  const delay = Math.min(BASE_DELAY_MS * 2 ** entry.attempts, MAX_DELAY_MS);
  await col.updateOne({ _id: entry._id }, {
    $set: { status: 'failed', attempts, lastError: message, nextAttemptAt: new Date(Date.now() + delay), updatedAt: now }
  });
  logger.warn(`[OUTBOX ERROR] entry ${entry._id} (${entry.kind}) failed (attempt ${attempts}/${entry.maxAttempts}) | Reason: ${message} | Retrying in ${Math.round(delay / 1000)}s`);
}

async function tick() {
  if (ticking || Date.now() < workerPausedUntil) return;
  ticking = true;
  try {
    const col = getCollection(OUTBOX_COLLECTION);
    const claimed = await claimBatch(col);
    for (const entry of claimed) {
      const start = process.hrtime.bigint();
      try {
        const fn = resolveReplay(entry.kind);
        const result = await fn(...(entry.args || []));
        if (GUARD_REJECTION_SENTINELS.has(result)) {
          await markSkipped(col, entry, result);
        } else {
          await markDone(col, entry, Number(process.hrtime.bigint() - start) / 1e6);
        }
      } catch (err) {
        await markFailure(col, entry, err);
      }
      if (Date.now() < workerPausedUntil) break; // stop draining this batch once quota-paused mid-loop
    }
  } catch (err) {
    logger.error('[OUTBOX ERROR] tick failed:', err?.message || err);
  } finally {
    ticking = false;
  }
}

export function startOutboxWorker() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    tick().catch((e) => logger.error('[OUTBOX ERROR] unhandled tick error:', e));
  }, env.outboxPollMs);
  logger.info(`[OUTBOX] worker started (poll every ${env.outboxPollMs}ms)`);
}

export function stopOutboxWorker() {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
}
