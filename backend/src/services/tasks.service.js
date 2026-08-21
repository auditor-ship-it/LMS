/**
 * Port of LMS.js lines 1234-1356: getMyTasks, getEmployeeTasks (the "My Task"
 * pending-work counts + per-employee-code task lookup).
 *
 * LEASE-MANAGEMENT BACKEND NOTE: the original getMyTasks() also sourced
 * pendingBilling/receivablesPending/receivablesAmount/disputesPending via
 * dashboard.service.js/receivables.service.js/disputes.service.js —
 * Collections-domain modules that don't exist in this standalone backend.
 * Those 4 fields were dropped from the output below because
 * lease-management's own MyTaskPage.jsx no longer renders tiles for them
 * (removed earlier) — pendingVerify/pendingApprovals/expiring7/expired now
 * come directly from this backend's own verify/approve/expiry services
 * instead of routing through the dashboard aggregate.
 */
import { SHEETS } from '../config/sheets.config.js';
import { cacheGet, cachePut, cacheRemove } from '../utils/memoryCache.js';
import { AppError } from '../utils/AppError.js';
import { _olStageCounts, getApproveData } from './approve.service.js';
import { getExpiryDataByFilter } from './expiry.service.js';
import { getVerifyData } from './verify.service.js';
import { getSheetData } from './googleSheets.service.js';
import { salePersonScopeFor, scopeCacheKey } from './salePersonAccess.service.js';

const MYTASKS_CACHE_KEY = 'mytasks_v1';

/** Task ownership per email — mirror of the UI's MY_TASK_BY_EMAIL (keep both in sync). */
const MY_TASK_BY_EMAIL_BACKEND = {
  'pushpa.shetty@crystalgroup.in': ['approve', 'offleaseApproval'],
  'sc@crystalgroup.in': ['verify', 'olStage1'],
  'shivani.dhall@crystalgroup.in': ['billing', 'olStage5'],
  'kshirod.khatua@crystalgroup.in': ['olStage2', 'olStage6']
};

/** task key -> [human label, field name in getMyTasks() output] */
const MY_TASK_KEY_META = {
  verify: ['Pending Verify', 'pendingVerify'],
  approve: ['Pending Approvals', 'pendingApprovals'],
  offleaseApproval: ['Off-Lease Pending Approval', 'offleaseApproval'],
  billing: ['Pending Billing', 'pendingBilling'],
  disputes: ['Disputes Pending', 'disputesPending'],
  expiring7: ['Expiring in 7 Days', 'expiring7'],
  expired: ['Already Expired', 'expired'],
  receivables: ['Pending Receivables', 'receivablesPending'],
  renewPending: ['Renew Pending', 'renewPending'],
  /* Labels only, updated 2026-08-18 to match the live workflow order in
   * frontend/src/constants/stages.js (WORKFLOW = [1,6,7,3,5,8]) — see the
   * identical fix and full explanation in permissions.config.js's
   * PERMISSION_KEYS. The `olStage1..8` KEYS still map 1:1 to _olStageCounts'
   * internal stage numbers (approve.service.js) and are unchanged; only the
   * human-readable text changes. */
  olStage1: ['Off-Lease Stage 1: Intimation', 'olStage1'],
  olStage2: ['Off-Lease (Retired) Lifting / Arrival', 'olStage2'],
  olStage3: ['Off-Lease Stage 4: Inspection Checklist', 'olStage3'],
  olStage4: ['Off-Lease (Retired) Quotation / Order', 'olStage4'],
  olStage5: ['Off-Lease Stage 5: Billing Reconciliation', 'olStage5'],
  olStage6: ['Off-Lease Stage 2: Transportation', 'olStage6'],
  olStage7: ['Off-Lease Stage 3: Gate In', 'olStage7'],
  olStage8: ['Off-Lease Stage 6: FMS Closure', 'olStage8']
};

/**
 * "My Task" counts — the pending work across the app, in ONE call. Most
 * getters are read-only DESK totals with no permission check, matching the
 * original: the UI decides WHICH cards to show based on what the user is
 * allowed to act on (verify/approve/billing/off-lease stages are whole-desk
 * work, not owned by one person, so they stay global for every caller).
 *
 * `expired` and `renewPending` are the exception: they are Lease Expiry /
 * Renew & Document counts, and those two pages are user-wise filtered by
 * Sale Person (salePersonAccess.service.js) — so the two "My Task" cards
 * that mirror them must show the SAME scoped number the page itself would,
 * or the sidebar badge and the page it links to would disagree.
 *
 * Because these two fields now vary by caller, the 60s cache is keyed by
 * scope (one of 5 values: the 4 mapped names, or 'all') instead of a single
 * global key — otherwise the first request of the minute would freeze its
 * scope's numbers into what every other caller sees for the next 60s.
 */
export async function getMyTasks(user, force) {
  const scope = salePersonScopeFor(user);
  const cacheKey = `${MYTASKS_CACHE_KEY}:${scopeCacheKey(scope)}`;
  if (force) { cacheRemove(cacheKey); cacheRemove('dash_v1'); } // force fresh counts
  else { const hit = cacheGet(cacheKey); if (hit) return hit; }

  const out = {
    pendingVerify: 0, pendingApprovals: 0, offleaseApproval: 0,
    expiring7: 0, expired: 0, renewPending: 0,
    olStage1: 0, olStage2: 0, olStage3: 0, olStage4: 0, olStage5: 0, olStage6: 0, olStage7: 0, olStage8: 0,
    /* Which cards the caller should see, or null for "show everything" (the
     * pre-existing, still-default behaviour for anyone not in this map).
     *
     * A Sale-Person-scoped login (salePersonScopeFor — Gauri/Kedar/Sagar/
     * Sapna today) owns leases, not a workflow desk: "Pending Verify
     * (Christopher)" or an Off-Lease stage card is someone else's job and was
     * confusing noise on their own My Task page, so they only get the three
     * cards that are actually theirs — the same three counts
     * salePersonAccess.service.js already scopes above.
     *
     * Deliberately NOT extended to the pre-existing desk-role entries in
     * MY_TASK_BY_EMAIL_BACKEND (Pushpa/Christopher/Shivani/Kshirod) — that map
     * was already used elsewhere (getEmployeeTasks) but never by this page,
     * so restricting it here now would be a first-time behaviour change for
     * four people who did not ask for it. Scoped narrowly to the identical
     * axis already shipped for Lease Expiry / Renew & Document. */
    visibleKeys: scope ? ['expiring7', 'expired', 'renewPending'] : null
  };

  try { out.pendingVerify = ((await getVerifyData()).data || []).length; } catch (e) { /* noop */ }
  try { out.pendingApprovals = ((await getApproveData()).data || []).length; } catch (e) { /* noop */ }

  /* Same "pending" list Lease Expiry's own page bands client-side —
     mirror that banding here so the tile counts always agree with it. */
  try {
    const pending = (await getExpiryDataByFilter('pending', user)).data || [];
    out.expiring7 = pending.filter((r) => r.band === 'critical').length;
    out.expired = pending.filter((r) => r.band === 'overdue').length;
  } catch (e) { /* noop */ }

  /* Count from the EXACT same source as the Renew -> Documents tab ("Awaiting
     Completion"), so the Renew Pending card always matches that list. */
  try { out.renewPending = ((await getExpiryDataByFilter('documents', user)).data || []).length; } catch (e) { /* noop */ }

  try {
    const olc = await _olStageCounts();
    out.offleaseApproval = olc.approval;
    out.olStage1 = olc.s1; out.olStage2 = olc.s2; out.olStage3 = olc.s3; out.olStage4 = olc.s4;
    out.olStage5 = olc.s5; out.olStage6 = olc.s6; out.olStage7 = olc.s7; out.olStage8 = olc.s8;
  } catch (e) { /* noop */ }

  cachePut(cacheKey, out, 60); // 60s cache -> repeat opens are instant
  return out;
}

/* ==================== PER-EMPLOYEE TASKS ====================
   The lease data rows carry NO employee code (tasks are owned per WORKFLOW
   POINT, not per data row). The bridge to an employee is the USER sheet:
   employee code (col B) -> email (col D) -> task set -> counts (getMyTasks).
   Some desks (e.g. AR / Receivables) are whole-desk, not per person ->
   assigned=false. */

/** Resolve an employee CODE (USER sheet col B) -> that person's pending-task
 *  counts. Returns null if the code is unknown. force=true bypasses the 60s
 *  task cache. */
export async function getEmployeeTasks(employeeCode, force) {
  const code = String(employeeCode == null ? '' : employeeCode).trim();
  if (!code) throw new AppError('employeeCode is required');

  // --- resolve code -> name + email via the USER sheet (A=name B=id C=pass D=email) ---
  const { rows } = await getSheetData(SHEETS.USER, undefined, 'A1:D');
  let name = '', email = '';
  for (const r of rows) {
    if (String(r[1]).trim() === code) {
      name = String(r[0]).trim();
      email = String(r[3]).trim().toLowerCase();
      break;
    }
  }
  if (!email) return null; // unknown employee code

  // --- which tasks belong to this person, with counts from getMyTasks() ---
  const keys = MY_TASK_BY_EMAIL_BACKEND[email];
  /* Scoped to the LOOKED-UP employee (`email`), not whoever is calling this
     endpoint — "Kedar's tasks" must mean Kedar's numbers regardless of who
     asked to see them. */
  const t = (await getMyTasks({ email }, force === true)) || {};
  const tasks = [];
  let total = 0;
  if (keys && keys.length) {
    for (const k of keys) {
      const meta = MY_TASK_KEY_META[k];
      if (!meta) continue;
      const n = t[meta[1]] || 0;
      total += n;
      tasks.push({ key: k, label: meta[0], count: n });
    }
  }
  return {
    employeeCode: code,
    name,
    email,
    assigned: !!(keys && keys.length), // false -> no per-person tasks (e.g. AR desk is whole-desk)
    tasks,
    totalPending: total
  };
}
