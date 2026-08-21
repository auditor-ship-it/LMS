/**
 * node-cron registrations, gated behind ENABLE_CRON/ENABLE_SHEETS_SYNC in
 * .env — this backend's OWN independent copy, scoped to only the jobs this
 * app's domain owns (see splendid-rolling-candy.md Phase 1c):
 *
 *   - runAutoApproval (approve.service.js) and copyApprovedData
 *     (offlease.service.js) — the two cron jobs Lease Management owns out of
 *     the original app's 13-job list. The other 11 belong to Accounts &
 *     Collection or the Original Application and are NOT registered here.
 *   - Sheets<->Mongo reconciliation (every 5 min) — keeps the Mongo backup
 *     mirror in step with live Sheets (SHEETS-FIRST app-wide, reverted
 *     2026-08-21; the outbox worker that used to drain Mongo-first writes
 *     back to Sheets is gone along with the writes it served — see
 *     writeThrough.service.js's removal) — plus a proactive re-read of the
 *     external FMS workbook's STAGE-8/9/10 tabs (every 5 min) so a change
 *     there is visible without waiting out the 30-min cache TTL or depending
 *     on someone opening Stage 2 to trigger a refresh.
 *
 * The 5-minute reconciliation cadence is offset to minute 1/6/11/... (not
 * minute 0/5/10/...) so this app's sync doesn't land in the same second as
 * Accounts & Collection's or the Original Application's own 5-minute sync —
 * same shared Google service-account quota, staggered to smooth bursts
 * (decision recorded in splendid-rolling-candy.md). The FMS refresh is
 * offset to minute :03 for the same reason.
 *
 * REVERTED FROM A 1-MINUTE FMS REFRESH 2026-08-20 — tightening this to every
 * minute (3 Sheets reads/min just for this job, on top of the reconciliation
 * pass, the outbox worker, and every live user request) reliably blew
 * through the account's "Read requests per minute" quota within about 20
 * minutes of steady use, which trips responseCache.middleware.js's GLOBAL
 * lockout — every GET across the WHOLE app (not just FMS reads) starts
 * failing for up to 5 minutes. That is a strictly worse outage than the
 * up-to-5-minute staleness this job exists to shrink. Do not tighten this
 * again without also reducing how much else reads Sheets in the same
 * window. (readOffleaseRows/readStage9OffleaseRows/readStage10Rows still
 * serve cached data on read failure via their disk-persisted "last good"
 * fallback, so a quota error here degrades to stale data, not a crash.)
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
  cron.schedule('1-59/5 * * * *', safeRun('sheetsReconcile', runSheetsReconciliation));
  cron.schedule('3-59/5 * * * *', safeRun('refreshFmsCaches', refreshFmsCaches));
  logger.info('[SYNC] Sheets<->Mongo reconciliation registered (every 5 min, offset :01)');
  logger.info('[SYNC] FMS (STAGE-8/9/10) refresh registered (every 5 min, offset :03)');
}
