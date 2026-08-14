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
import { getSheetDataFromMongo as getSheetData } from './mongoSheetData.service.js';

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
  olStage1: ['Off-Lease Stage 1: Intimation', 'olStage1'],
  olStage2: ['Off-Lease Stage 2: Lifting', 'olStage2'],
  olStage3: ['Off-Lease Stage 3: Inspection', 'olStage3'],
  olStage4: ['Off-Lease Stage 4: Quotation', 'olStage4'],
  olStage5: ['Off-Lease Stage 5: Billing', 'olStage5'],
  olStage6: ['Off-Lease Stage 6: Transport', 'olStage6'],
  olStage7: ['Off-Lease Stage 7: Gate In', 'olStage7'],
  olStage8: ['Off-Lease Stage 8: FMS Closure', 'olStage8']
};

/**
 * "My Task" counts — the pending work across the app, in ONE call. All
 * getters are read-only, so no permission check is needed; the UI decides
 * WHICH cards to show based on what the user is allowed to act on.
 */
export async function getMyTasks(force) {
  if (force) { cacheRemove(MYTASKS_CACHE_KEY); cacheRemove('dash_v1'); } // force fresh counts
  else { const hit = cacheGet(MYTASKS_CACHE_KEY); if (hit) return hit; }

  const out = {
    pendingVerify: 0, pendingApprovals: 0, offleaseApproval: 0,
    expiring7: 0, expired: 0, renewPending: 0,
    olStage1: 0, olStage2: 0, olStage3: 0, olStage4: 0, olStage5: 0, olStage6: 0, olStage7: 0, olStage8: 0
  };

  try { out.pendingVerify = ((await getVerifyData()).data || []).length; } catch (e) { /* noop */ }
  try { out.pendingApprovals = ((await getApproveData()).data || []).length; } catch (e) { /* noop */ }

  /* Same "pending" list Lease Expiry's own page bands client-side —
     mirror that banding here so the tile counts always agree with it. */
  try {
    const pending = (await getExpiryDataByFilter('pending')).data || [];
    out.expiring7 = pending.filter((r) => r.band === 'critical').length;
    out.expired = pending.filter((r) => r.band === 'overdue').length;
  } catch (e) { /* noop */ }

  /* Count from the EXACT same source as the Renew -> Documents tab ("Awaiting
     Completion"), so the Renew Pending card always matches that list. */
  try { out.renewPending = ((await getExpiryDataByFilter('documents')).data || []).length; } catch (e) { /* noop */ }

  try {
    const olc = await _olStageCounts();
    out.offleaseApproval = olc.approval;
    out.olStage1 = olc.s1; out.olStage2 = olc.s2; out.olStage3 = olc.s3; out.olStage4 = olc.s4;
    out.olStage5 = olc.s5; out.olStage6 = olc.s6; out.olStage7 = olc.s7; out.olStage8 = olc.s8;
  } catch (e) { /* noop */ }

  cachePut(MYTASKS_CACHE_KEY, out, 60); // 60s cache -> repeat opens are instant
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
  const t = (await getMyTasks(force === true)) || {};
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
