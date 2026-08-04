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
 *     Access edits, draining to Sheets).
 *
 * The 5-minute reconciliation cadence is offset to minute 1/6/11/... (not
 * minute 0/5/10/...) so this app's sync doesn't land in the same second as
 * Accounts & Collection's or the Original Application's own 5-minute sync —
 * same shared Google service-account quota, staggered to smooth bursts
 * (decision recorded in splendid-rolling-candy.md).
 *
 * Every job is wrapped so a thrown/rejected error is caught and logged —
 * node-cron has no built-in per-task error isolation, and one bad run must
 * never crash the process or block any of the other scheduled jobs.
 */
import cron from 'node-cron';
import { runAutoApproval } from '../services/approve.service.js';
import { copyApprovedData } from '../services/offlease.service.js';
import { runSheetsReconciliation } from './sheetsReconcile.job.js';
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
  logger.info('[SYNC] Sheets<->Mongo reconciliation registered (every 5 min, offset :01) + outbox worker started');
}
