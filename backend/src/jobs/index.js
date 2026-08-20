/**
 * node-cron registrations, gated behind ENABLE_CRON/ENABLE_SHEETS_SYNC in
 * .env — this backend's OWN independent copy, scoped to only the jobs this
 * app's domain owns (see splendid-rolling-candy.md Phase 1c):
 *
 *   - runAutoApproval (approve.service.js) and copyApprovedData
 *     (offlease.service.js) — the two cron jobs Lease Management owns out of
 *     the original app's 13-job list. The other 11 belong to Accounts &
 *     Collection or the Original Application and are NOT registered here.
 *   - Sheets<->Mongo reconciliation (every 5 min) + the outbox worker
 *     (Mongo-first writes, e.g. roles.service.js's Team Accounts/Sidebar
 *     Access edits, draining to Sheets), plus a proactive re-read of the
 *     external FMS workbook's STAGE-8/9/10 tabs (every 1 min — tightened
 *     from 5 min on request, since Stage 2's Site Delivery lookup needs to
 *     reflect a new STAGE-10 row within a minute of it landing) so a change
 *     there is visible without waiting out the 30-min cache TTL or depending
 *     on someone opening Stage 2 to trigger a refresh.
 *
 * The 5-minute reconciliation cadence is offset to minute 1/6/11/... (not
 * minute 0/5/10/...) so this app's sync doesn't land in the same second as
 * Accounts & Collection's or the Original Application's own 5-minute sync —
 * same shared Google service-account quota, staggered to smooth bursts
 * (decision recorded in splendid-rolling-candy.md). The FMS refresh runs
 * every minute at :00 — 3 Sheets reads/min against the same service-account
 * quota. If quota errors show up in logs, widen this back toward 5 min
 * (readOffleaseRows/readStage9OffleaseRows/readStage10Rows still serve
 * cached data on read failure via their disk-persisted "last good" fallback,
 * so a quota error here degrades to stale data, not an outage).
 *
 * Every job is wrapped so a thrown/rejected error is caught and logged —
 * node-cron has no built-in per-task error isolation, and one bad run must
 * never crash the process or block any of the other scheduled jobs.
 */
import cron from 'node-cron';
import { runAutoApproval } from '../services/approve.service.js';
import { copyApprovedData } from '../services/offlease.service.js';
import { runSheetsReconciliation } from './sheetsReconcile.job.js';
import { refreshFmsCaches } from '../services/stage8.service.js';
import { startOutboxWorker } from './outboxWorker.js';
import { logger } from '../utils/logger.js';

function safeRun(name, fn) {
  return () => {
    Promise.resolve()
      .then(fn)
      .catch((e) => logger.error(`[CRON ERROR] ${name} FAILED:`, e?.message || e));
  };
}

export function registerCronJobs() {
  // Hourly — same schedule as the original app's copy of these two jobs.
  cron.schedule('0 * * * *', safeRun('runAutoApproval', runAutoApproval));
  cron.schedule('0 * * * *', safeRun('copyApprovedData', copyApprovedData));

  logger.info('[CRON] registered: runAutoApproval + copyApprovedData (hourly)');
}

/**
 * Mongo-as-primary infrastructure: the outbox worker (Mongo -> Sheets, near
 * real-time) and the reconciliation job (Sheets -> Mongo, every 5 min,
 * offset to minute 1 — see file header). Independent of ENABLE_CRON, which
 * only gates the business-automation jobs above.
 */
export function registerSheetsSync() {
  startOutboxWorker();
  cron.schedule('1-59/5 * * * *', safeRun('sheetsReconcile', runSheetsReconciliation));
  cron.schedule('* * * * *', safeRun('refreshFmsCaches', refreshFmsCaches));
  logger.info('[SYNC] Sheets<->Mongo reconciliation registered (every 5 min, offset :01) + outbox worker started');
  logger.info('[SYNC] FMS (STAGE-8/9/10) refresh registered (every 1 min)');
}
