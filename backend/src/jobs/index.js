/**
 * node-cron registrations, gated behind ENABLE_CRON/ENABLE_SHEETS_SYNC in
 * .env — this backend's OWN independent copy, scoped to only the jobs this
 * app's domain owns (see splendid-rolling-candy.md Phase 1c):
 *
 *   - runAutoApproval (approve.service.js) and copyApprovedData
 *     (offlease.service.js) — the two cron jobs Lease Management owns out of
 *     the original app's 13-job list. The other 11 belong to Accounts &
 *     Collection or the Original Application and are NOT registered here.
 *   - Sheets<->Mongo reconciliation (every 5 min) — keeps the Mongo mirror in
 *     step with live Sheets. MONGO-FIRST READS restored 2026-08-26: every
 *     display/list read across the app (Off-Lease, Lease Expiry, Verify
 *     Lease, Approve Lease, My Task, Roles) now serves from this mirror
 *     instead of a live Sheets call — see mongoSheetData.service.js's header
 *     note. The app's own writes still land on Sheets directly and patch the
 *     mirror immediately (patchMongoMirrorRow / inline getCollection
 *     updates), so this job only needs to catch edits made directly in the
 *     raw spreadsheet, outside the app — plus a proactive re-read of the
 *     external FMS workbook's STAGE-8/9/10 tabs (every 5 min) so a change
 *     there is visible without waiting out the 30-min cache TTL or depending
 *     on someone opening Stage 2 to trigger a refresh.
 *
 * BACK TO EVERY 5 MIN 2026-08-26 — briefly widened to 15 min the same day
 * this comment was last touched, when this job was competing with live
 * Sheets reads on nearly every page load for the same per-minute quota.
 * Restoring Mongo-first reads above removed that competition — hot page
 * loads no longer call Sheets at all — so this job is now close to the ONLY
 * source of Sheets read traffic, and 5 min freshness is safe again.
 *
 * OFFSET BUG FOUND AND FIXED 2026-08-26 — this was ALWAYS meant to run at
 * :01/:06/:11.../:56, a clean 2 minutes ahead of the FMS refresh's
 * :03/:08/:13.../:58, so the two jobs' Sheets reads never overlap. The cron
 * strings actually used to express that, `'1-59/5 * * * *'` and
 * `'3-59/5 * * * *'`, do NOT do that: node-cron's range+step parsing applies
 * the step from the field's natural floor (0), then filters by the range —
 * so both strings reduce to the exact same set, {5,10,15,...,55}. The two
 * jobs were firing at the SAME instant every single cycle, not 2 minutes
 * apart — confirmed 2026-08-26 by lining up the actual log timestamps
 * (reconcile started at :45:00, :50:00, :55:00, :05:00, :10:00 — never
 * :01/:06/:11 as intended). That collision, not the Mongo-first read change
 * made the same day, was what kept tripping the quota lock afterward: 9
 * sheets (reconcile) plus 4 more (FMS + Stage 3 form) landing back-to-back
 * instead of 2 minutes apart. Fixed by spelling out the minute lists
 * explicitly instead of relying on range+step, which sidesteps the parsing
 * ambiguity entirely and is what actually produces the intended offset.
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
import { refreshStage3FormCache } from '../services/stage3Form.service.js';
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
 * Sheets -> Mongo reconciliation (every 5 min, offset to minute 1 — see file
 * header). Independent of ENABLE_CRON, which only gates the
 * business-automation jobs above.
 *
 * Explicit minute lists, not range+step ('1-59/5') — see file header for why
 * that syntax silently fails to produce the intended offset in node-cron.
 */
const RECONCILE_MINUTES = '1,6,11,16,21,26,31,36,41,46,51,56';
const FMS_REFRESH_MINUTES = '3,8,13,18,23,28,33,38,43,48,53,58';

export function registerSheetsSync() {
  cron.schedule(`${RECONCILE_MINUTES} * * * *`, safeRun('sheetsReconcile', runSheetsReconciliation));
  cron.schedule(`${FMS_REFRESH_MINUTES} * * * *`, safeRun('refreshFmsCaches', refreshFmsCaches));
  cron.schedule(`${FMS_REFRESH_MINUTES} * * * *`, safeRun('refreshStage3FormCache', refreshStage3FormCache));
  logger.info('[SYNC] Sheets<->Mongo reconciliation registered (every 5 min, offset :01)');
  logger.info('[SYNC] FMS (STAGE-8/9/10) + Stage 3 Gate-In form refresh registered (every 5 min, offset :03)');
}
