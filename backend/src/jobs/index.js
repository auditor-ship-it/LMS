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
import { refreshStage3FormCache } from '../services/stage3Form.service.js';
import { warmFmsCache } from '../services/stage8.service.js';
import { checkPendingClientToClientMoves } from '../services/offlease.service.js';
import { sendLeaseExpiryDigest } from '../services/leaseExpiryDigest.service.js';
import { sendMonthlyReport } from '../services/monthlyReport.service.js';
import { sendPoAgreementDigest } from '../services/poAgreementDigest.service.js';
import { sendDeployedSummaryDigest } from '../services/deployedSummaryDigest.service.js';
import { saveDeployedSheetSnapshotIfNeeded } from '../services/deployedSheetSnapshot.service.js';
import { sendRenewalReminderDigest } from '../services/renewalReminderDigest.service.js';
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

  /* Daily, 9:00 AM — server runs in Asia/Calcutta (confirmed via
     Intl.DateTimeFormat().resolvedOptions().timeZone, 2026-09-04), so this
     single-value hour field needs no explicit timezone/offset handling.
     Explicit request 2026-09-04: one email per sales executive, grouped by
     their own Lease Expiry rows (overdue + expiring soon) — see
     leaseExpiryDigest.service.js for the grouping/send logic. */
  cron.schedule('0 9 * * *', safeRun('leaseExpiryDigest', () => sendLeaseExpiryDigest()));

  /* Daily, 9:05 AM — explicit request 2026-10-27 ("sep deployed sheet and
     oct deployed... kya kya change nahi hua hai" — what changed from one
     month's Deployed sheet to the next): saves one dated snapshot of the
     Deployed sheet PER CALENDAR MONTH, so the Deployed Summary digest
     (below) can show a real row-by-row diff against the previous month
     once two snapshots exist. Safe to run daily — saving is idempotent per
     month (see deployedSheetSnapshot.service.js's own doc comment); this
     just needs to land once near the start of each month, and running
     daily means a single missed/failed run self-heals the next day rather
     than waiting a whole month. Deliberately its own small job, not folded
     into deployedSummaryDigest below — that one only runs the 25th-2nd,
     which would miss most of the month for taking a fresh snapshot if the
     process happened to restart and lose whichever day it first landed on. */
  cron.schedule('5 9 * * *', safeRun('deployedSheetSnapshot', () => saveDeployedSheetSnapshotIfNeeded()));

  /* 1st of every month, 6:00 AM — explicit request 2026-10-07: the complete
     PREVIOUS calendar month's Renew + Off-Lease activity, to Pushpa Shetty
     and Shivani Dhall. A single value in the day-of-month field, not a
     range/step — see this file's own header note on why range+step cron
     syntax is unsafe here; a single value has no such ambiguity. Idempotency
     (skip if this month was already sent) is handled inside
     monthlyReport.service.js, not here — this schedule alone can't protect
     against a manual re-trigger or a restart landing on the same day. */
  cron.schedule('0 6 1 * *', safeRun('monthlyRenewOffLeaseReport', () => sendMonthlyReport()));

  /* 25th of every month, 9:00 AM — explicit request 2026-10-21: which
     deployed containers need their PO and/or Agreement updated (overdue or
     due within 30 days), same data the PO & Agreement Tracker page shows,
     to the same two recipients as the monthly report above. A single value
     in the day-of-month field, same reasoning as that job's own schedule
     above. Idempotency handled inside poAgreementDigest.service.js. */
  cron.schedule('0 9 25 * *', safeRun('poAgreementDigest', () => sendPoAgreementDigest()));

  /* EVERY DAY from the 25th through the 2nd of the following month, 10:00
     AM — explicit request 2026-10-23 for the content (Deployed Summary
     page's own month-wise movement numbers, Excel attachment matching that
     page's "Export to Excel" button), schedule widened 2026-10-27 from a
     single day to this daily window ("25 to 2 date tak maild jana chahiye
     hai subh 10 bhje") — a reminder on each of the last few days of the
     month plus the first couple of the next, not just once. "25-31,1,2" is
     a plain comma-separated day list (verified via cron.validate), not the
     range+STEP combination this file's own header warns about — a month
     without a 31st (or 30th/29th) simply never fires that literal date,
     same as standard cron day-of-month semantics; no special handling
     needed. Idempotency is now PER-DAY (lastSentDateKey), not per-month —
     see deployedSummaryDigest.service.js's own header comment; the old
     monthly key would have let only the first of these 9 daily sends
     through each cycle. */
  cron.schedule('0 10 25-31,1,2 * *', safeRun('deployedSummaryDigest', () => sendDeployedSummaryDigest()));

  // STOPPED 2026-10-30 — explicit request ("mail stop for this... stop the
  // mails agrment and po reminder") after the every-5-minute testing
  // cadence below kept re-sending a 160-container digest. Left as a plain
  // comment (not deleted) so this can be re-enabled later at a sane
  // cadence once the feature itself is revisited — see
  // renewalReminderDigest.service.js for what it would send.
  // cron.schedule('*/5 * * * *', safeRun('renewalReminderDigest', () => sendRenewalReminderDigest()));

  logger.info('[CRON] registered: runAutoApproval + copyApprovedData (hourly), leaseExpiryDigest (daily 9:00 AM), deployedSheetSnapshot (daily 9:05 AM), monthlyRenewOffLeaseReport (1st of month, 6:00 AM), poAgreementDigest (25th of month, 9:00 AM), deployedSummaryDigest (25th-2nd daily, 10:00 AM), renewalReminderDigest (STOPPED 2026-10-30, was every 5 min testing cadence)');
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
/* 3 minutes after RECONCILE_MINUTES — enough time for that job's own 9-sheet
   sync (spaced 4s apart, ~35s+ actual read/write time) to have actually
   finished writing STAGE-8/9/10 before this re-reads them. See
   warmFmsCache's doc comment for why this exists: without it, the ~17s cold
   Mongo read for these three large collections happened on whichever real
   user's Stage 2 tab switch landed on an expired application-level cache. */
const WARM_FMS_CACHE_MINUTES = '4,9,14,19,24,29,34,39,44,49,54,59';
/* 1 minute after WARM_FMS_CACHE_MINUTES — Transportation's "Client to
   Client" pending-DO check (explicit request 2026-09-24) needs the FRESHEST
   possible STAGE-8 mirror to match a newly-typed DO Number against, so it
   runs last in this same 5-minute chain, after reconcile has pulled STAGE-8
   in and warmFmsCache has refreshed the application-level read cache on top
   of it. See checkPendingClientToClientMoves' own doc comment. */
const CTC_PENDING_CHECK_MINUTES = '5,10,15,20,25,30,35,40,45,50,55,0';

export function registerSheetsSync() {
  // STAGE-8/9/10 (2026-08-28): now part of runSheetsReconciliation's own
  // sheet list (mongoSheetMapping.js) — the separate refreshFmsCaches live-
  // read job that used to cover them is retired; stage8.service.js reads
  // exclusively from the Mongo mirror now, same as every other sheet.
  cron.schedule(`${RECONCILE_MINUTES} * * * *`, safeRun('sheetsReconcile', runSheetsReconciliation));
  cron.schedule(`${FMS_REFRESH_MINUTES} * * * *`, safeRun('refreshStage3FormCache', refreshStage3FormCache));
  cron.schedule(`${WARM_FMS_CACHE_MINUTES} * * * *`, safeRun('warmFmsCache', warmFmsCache));
  cron.schedule(`${CTC_PENDING_CHECK_MINUTES} * * * *`, safeRun('checkPendingClientToClientMoves', checkPendingClientToClientMoves));
  logger.info('[SYNC] Sheets<->Mongo reconciliation registered (every 5 min, offset :01) — now includes STAGE-8/9/10');
  logger.info('[SYNC] Stage 3 Gate-In form refresh registered (every 5 min, offset :03)');
  logger.info('[SYNC] STAGE-8/9/10 application cache warm registered (every 5 min, offset :04)');
  logger.info('[SYNC] Transportation "Client to Client" pending-DO check registered (every 5 min, offset :05)');
}
