/**
 * Drains _sync_outbox (see writeThrough.service.js) — every Mongo-first
 * write enqueues an entry here, and this poll loop is what actually pushes
 * the equivalent mutation to Google Sheets, asynchronously, after the HTTP
 * request that made the write has already responded.
 *
 * Rate-limit handling is scoped ENTIRELY to this module: a Sheets quota hit
 * pauses only this worker's own claiming (workerPausedUntil), never the
 * shared memoryCache.js Map or anything Express-visible — Mongo-backed API
 * traffic must keep working normally even while this worker is backing off.
 */
import { getCollection } from '../services/mongo.service.js';
import { resolveOutboxHandler } from './outboxHandlers.js';
import { isGoogleQuotaError } from '../middlewares/errorHandler.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const OUTBOX_COLLECTION = '_sync_outbox';
const BATCH_SIZE = 20;
const BASE_DELAY_MS = 30000; // 30s, doubles per attempt — "a few minutes is fine" per the user's own requirement
const MAX_DELAY_MS = 30 * 60 * 1000; // 30 min cap
const QUOTA_PAUSE_MS = 5 * 60 * 1000; // mirrors the app's old global-lockout duration, but local to this worker only

let workerPausedUntil = 0;
let ticking = false;
let intervalHandle = null;

async function claimBatch(col) {
  const now = new Date();
  const due = await col.find({
    status: { $in: ['pending', 'failed'] },
    nextAttemptAt: { $lte: now }
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
  logger.info(`[SYNC] Pushed to Sheets | Target: ${entry.targetSheet} | Handler: ${entry.handler} | Duration: ${durationMs.toFixed(1)}ms`);
}

async function markFailure(col, entry, err) {
  const now = new Date();
  const attempts = entry.attempts + 1;
  const message = err?.message || String(err);

  if (isGoogleQuotaError(err)) {
    workerPausedUntil = Date.now() + QUOTA_PAUSE_MS;
    logger.warn(`[SYNC] Google Sheets quota hit — pausing outbox worker for ${QUOTA_PAUSE_MS / 1000}s`);
  }

  if (attempts >= entry.maxAttempts) {
    await col.updateOne({ _id: entry._id }, { $set: { status: 'dead', attempts, lastError: message, updatedAt: now } });
    logger.error(`[SYNC ERROR] entry ${entry._id} (${entry.handler}) exhausted retries -> dead | Reason: ${message}`);
    return;
  }

  const delay = Math.min(BASE_DELAY_MS * 2 ** entry.attempts, MAX_DELAY_MS);
  await col.updateOne({ _id: entry._id }, {
    $set: { status: 'failed', attempts, lastError: message, nextAttemptAt: new Date(Date.now() + delay), updatedAt: now }
  });
  logger.warn(`[SYNC ERROR] entry ${entry._id} (${entry.handler}) failed (attempt ${attempts}/${entry.maxAttempts}) | Reason: ${message} | Retrying in ${Math.round(delay / 1000)}s`);
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
        const handler = resolveOutboxHandler(entry.handler);
        await handler(entry.payload, entry.documentId);
        await markDone(col, entry, Number(process.hrtime.bigint() - start) / 1e6);
      } catch (err) {
        await markFailure(col, entry, err);
      }
      if (Date.now() < workerPausedUntil) break; // stop draining this batch once quota-paused mid-loop
    }
  } catch (err) {
    logger.error('[SYNC ERROR] outbox tick failed:', err?.message || err);
  } finally {
    ticking = false;
  }
}

export function startOutboxWorker() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    tick().catch((e) => logger.error('[SYNC ERROR] unhandled outbox tick error:', e));
  }, env.outboxPollMs);
  logger.info(`[SYNC] Outbox worker started (poll every ${env.outboxPollMs}ms)`);
}

export function stopOutboxWorker() {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
}
