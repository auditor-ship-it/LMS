/**
 * OFF-LEASE EFFICIENCY ENGINE
 *
 * REPLACED 2026-09-03 (explicit, detailed spec) — this file previously
 * computed an "Overdue %" metric (what fraction of records ran late against
 * a budget; lower is better, red-ring framing). That system is gone. This
 * file now computes `Efficiency % = (Target Time / Actual Time) × 100`,
 * capped at 100%, per an explicit business decision — a stage finishing
 * early scores 100%, not above it. It is the SINGLE authoritative source for
 * GET /offlease/efficiency, consumed by both the internal Off-Lease
 * Efficiency page and the external "Company Efficiency Dashboard" via the
 * public API-key route (public.routes.js) — one calculation, two consumers,
 * never two formulas (see this file's own functions: nothing downstream is
 * allowed to recompute this independently).
 *
 * Stage target durations are NOT restated as numbers here — every one is
 * read from SLA_MS (offleaseSla.service.js), the same single source of
 * truth the pending-queue TAT columns (Stage 1..5 tabs) already use.
 *
 * Start/end business-event signals for each stage reuse exactly what was
 * built and verified earlier the same day for the pending-queue TAT columns
 * and the Container Lookup detail view (Transportation's Approval→FMS-
 * booking window with a STAGE-10 fallback, Gate In's STAGE-10→real-gate-form
 * window, Inspection/Billing's real-completion fallback chain) — no signal
 * is re-derived differently here.
 *
 * THREE DATA-MODEL LIMITATIONS THIS ENGINE IS DELIBERATELY HONEST ABOUT,
 * rather than inventing a number to paper over (audited 2026-09-03):
 *
 *  1. HOLD DURATION IS NOT COMPUTABLE. Off-Lease's Hold feature (Stage 1
 *     only) stores exactly one timestamp — when a record was put on hold
 *     (OL_HOLD_TIMESTAMP_COL, offlease.service.js). There is no "released
 *     at" column anywhere, and un-holding (saveOffLeaseSendBackToStage1)
 *     BLANKS that one column — the very moment a duration could be computed,
 *     the start-of-hold value is destroyed. A second hold cycle overwrites
 *     the same cells with no history. "Net Actual = Gross − Hold Duration"
 *     (the spec's own recommended Hold policy) is therefore not computable
 *     for any Stage 1 record that was ever held and later released: the
 *     number to subtract does not exist in this data. Rather than invent it
 *     or silently treat it as zero, every Stage 1 result carries
 *     `holdDurationMinutes: null` and a `dataLimitation` string saying so —
 *     see dataQuality.knownLimitations for the recommended schema fix.
 *  2. REWORK/ATTEMPT HISTORY IS ONLY PARTIALLY RECONSTRUCTABLE. The
 *     Stage-1-reject rework path (saveOffLeaseSendRejectedToStage1) blanks
 *     Stage 1's own status/timestamp cell with zero audit trail — a
 *     rejected-then-resubmitted record is indistinguishable from a
 *     first-attempt one once resubmitted. The Move-To-Stage jump-and-
 *     send-back path DOES log to offleaseMoveHistory.service.js
 *     (append-only, never overwritten) — `hadRework` on each container is
 *     sourced from that log, so it is a real signal, just not an exhaustive
 *     one. The calculation itself always uses whichever timestamps
 *     currently exist — there is nothing else to calculate from.
 *  3. SERVER TIMEZONE is not pinned by a TZ env var anywhere in this repo;
 *     Date.now() (used only for a STILL-RUNNING stage's live elapsed
 *     reading) resolves against the host OS default. A COMPLETED stage's
 *     duration is unaffected — both its start and end timestamps are
 *     sheet-derived via the same parseStamp component-constructor parser
 *     (offleaseSla.service.js), which never has a dd/MM-vs-MM/dd ambiguity.
 *     Flagged in dataQuality.knownLimitations as an infra/deploy item, not a
 *     bug in this file.
 */
import { getSheetDataFromMongo } from './mongoSheetData.service.js';
import { SHEETS } from '../config/sheets.config.js';
import {
  OL_STAGE_INFO, OL_STAGE2_INTERNAL, OL_STAGE3_INTERNAL, OL_HOLD_TIMESTAMP_COL,
  _isOnHold, _offLeaseAccessGate, _findOlColumnMulti
} from './offlease.service.js';
import { getGateFormIndexSync, pickGateFormForClient, isGatedIn } from './stage3Form.service.js';
import { getMatchedFmsForContainer } from './stage8.service.js';
import { getMoveHistory } from './offleaseMoveHistory.service.js';
import { SLA_MS, parseStamp } from './offleaseSla.service.js';
import { safeStr } from '../utils/format.js';
import { normKey } from '../utils/normalize.js';

const OL_SHEET = SHEETS.OFF_LEASE_TRACKING;
/* Internal stage numbers for Inspection/Billing/FMS Closure — matching
   offlease.service.js's own (private) OL_INSPECTION_INTERNAL/OL_BILLING_INTERNAL,
   duplicated as plain numbers rather than re-exporting two more private
   constants for values that are already implied by OL_STAGE_INFO's own keys. */
const OL_INSPECTION_STAGE = 3;
const OL_BILLING_STAGE = 5;
const OL_CLOSURE_STAGE = 8;

/** Later of two Dates, ignoring whichever is null — duplicated from
 *  offlease.service.js's own _laterStamp (not exported), same small-helper
 *  duplication convention this codebase already uses between these files. */
function _laterStamp(a, b) {
  if (a && b) return a.getTime() >= b.getTime() ? a : b;
  return a || b || null;
}
const _containerKey = (v) => safeStr(v).toUpperCase().replace(/[^A-Z0-9]/g, '');

const MIN_MS = 60 * 1000;
const round2 = (n) => Math.round(n * 100) / 100;
const msToMin = (ms) => (ms == null ? null : round2(ms / MIN_MS));

/**
 * STAGE_TAT_CONFIG — single source of truth for stage identity + target
 * duration, in true workflow order (NOT numeric stage-id order — the real
 * sequence is 1 -> approval -> 6 -> 7 -> 3 -> 5 -> 8). `targetMs` is read
 * from SLA_MS, never restated. Names follow the user's own SOP table
 * exactly for Stages 1/1A/2/3/4/5; "FMS Closure" is a 7th, already-real
 * workflow step (SLA_MS[8], same as every other stage's budget config) not
 * listed in that table — included rather than silently dropped, flagged in
 * the implementation report for confirmation.
 */
const STAGE_OWNERS = {
  1: 'Christopher', approval: 'Pushpa Maam', [OL_STAGE2_INTERNAL]: 'Kshirod Khatua',
  [OL_STAGE3_INTERNAL]: 'Pritam', [OL_INSPECTION_STAGE]: 'Sitaram', [OL_BILLING_STAGE]: 'Shivani Maam',
  [OL_CLOSURE_STAGE]: 'Unassigned'
};

export const STAGE_TAT_CONFIG = [
  { id: 1, name: 'Off-Lease Intimation', order: 1 },
  { id: 'approval', name: 'Intimation Approval', order: 2 },
  { id: OL_STAGE2_INTERNAL, name: 'Transportation', order: 3 },
  { id: OL_STAGE3_INTERNAL, name: 'Gate In', order: 4 },
  { id: OL_INSPECTION_STAGE, name: 'Inspection / Repair Process', order: 5 },
  { id: OL_BILLING_STAGE, name: 'Final Billing', order: 6 },
  { id: OL_CLOSURE_STAGE, name: 'FMS Closure', order: 7 }
].map((s) => ({ ...s, targetMs: SLA_MS[s.id], owner: STAGE_OWNERS[s.id] }));

function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : round2((sorted[mid - 1] + sorted[mid]) / 2);
}
/** `sorted` must already be ascending. */
function percentileOfSorted(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const TERMINAL_STATUSES = new Set(['COMPLETED', 'NOT_APPLICABLE', 'REJECTED']);

/**
 * Pure function — one stage's efficiency result from its resolved event
 * data. See this module's header for the status/limitation rationale.
 * `formula` is the human-readable audit string ("Target: Xmin, Actual: Ymin,
 * Formula: ..., Efficiency: Z%") computed once here so the API, the
 * frontend drill-down, and the test suite all read the identical text —
 * never three different explanations of the same number.
 */
export function calculateStageEfficiency(events, config) {
  const { start, end, missingEnd, missingStart, notApplicable, rejected, onHold, holdAt } = events || {};
  const base = { stage: config.id, stageName: config.name, targetDurationMinutes: msToMin(config.targetMs) };
  const withHoldFields = (obj) => (config.id === 1
    ? {
      ...obj,
      holdDurationMinutes: null,
      dataLimitation: 'hold_duration_not_tracked: no release-from-hold timestamp exists in this sheet, so Hold time cannot be subtracted from Stage 1\'s Actual Time — see dataQuality.knownLimitations.'
    }
    : obj);

  const empty = { actualDurationMinutes: null, netActualDurationMinutes: null, efficiencyPercentage: null, efficiencyPercentageRaw: null, formula: null };

  if (notApplicable) {
    return withHoldFields({ ...base, ...empty, status: 'NOT_APPLICABLE', calculationStatus: 'VALID',
      reason: 'Repair Required = No — this container was routed around this stage per SOP.',
      startTimestamp: null, completionTimestamp: null });
  }
  if (rejected) {
    return withHoldFields({ ...base, ...empty, status: 'REJECTED', calculationStatus: 'VALID',
      reason: 'Intimation Approval was rejected — the case does not proceed past this gate.',
      startTimestamp: start ? start.toISOString() : null, completionTimestamp: null });
  }
  // Checked BEFORE the generic "!start -> not reached yet" fallback: a
  // missingStart signal always pairs with start === null in the resolver
  // (e.g. a STAGE-10 delivery marker exists but its timestamp didn't parse),
  // so checking !start first would make this branch permanently unreachable
  // and silently misreport a real data gap as ordinary "not started yet."
  if (missingStart) {
    return withHoldFields({ ...base, ...empty, status: 'IN_PROGRESS', calculationStatus: 'MISSING_DATA',
      reason: `${config.name} appears underway but its start timestamp is missing or unparseable.`,
      startTimestamp: null, completionTimestamp: end ? end.toISOString() : null });
  }
  if (!start) {
    return withHoldFields({ ...base, ...empty, status: 'NOT_STARTED', calculationStatus: 'VALID',
      reason: `${config.name} has not been reached yet.`, startTimestamp: null, completionTimestamp: null });
  }
  if (missingEnd) {
    return withHoldFields({ ...base, ...empty, status: 'COMPLETED', calculationStatus: 'MISSING_DATA',
      reason: `${config.name} is marked complete but its completion timestamp is missing or unparseable.`,
      startTimestamp: start.toISOString(), completionTimestamp: null });
  }
  if (!end) {
    const liveMs = Math.max(0, Date.now() - start.getTime());
    return withHoldFields({ ...base, status: onHold ? 'HOLD' : 'IN_PROGRESS', calculationStatus: 'VALID',
      reason: onHold ? `On hold since ${holdAt ? holdAt.toISOString() : 'an unrecorded time'}.` : null,
      actualDurationMinutes: msToMin(liveMs), netActualDurationMinutes: null,
      efficiencyPercentage: null, efficiencyPercentageRaw: null, formula: null,
      startTimestamp: start.toISOString(), completionTimestamp: null });
  }

  const rawMs = end.getTime() - start.getTime();
  if (rawMs < 0) {
    return withHoldFields({ ...base, ...empty, status: 'COMPLETED', calculationStatus: 'INVALID_DATA',
      reason: `Completion timestamp (${end.toISOString()}) predates start timestamp (${start.toISOString()}) — likely two events landing out of order in the source data.`,
      startTimestamp: start.toISOString(), completionTimestamp: end.toISOString() });
  }

  const targetMs = config.targetMs;
  const actualMin = msToMin(rawMs);
  const targetMin = msToMin(targetMs);
  const effRaw = rawMs > 0 ? (targetMs / rawMs) * 100 : Infinity;
  const effCapped = round2(Math.min(100, effRaw));
  const formula = `Target: ${targetMin}min, Actual: ${actualMin}min, Formula: ${targetMin} / ${actualMin} × 100, Efficiency: ${effCapped}%`;

  return withHoldFields({
    ...base, status: 'COMPLETED', calculationStatus: 'VALID', reason: null,
    actualDurationMinutes: actualMin, netActualDurationMinutes: actualMin,
    efficiencyPercentage: effCapped,
    efficiencyPercentageRaw: Number.isFinite(effRaw) ? round2(effRaw) : null,
    startTimestamp: start.toISOString(), completionTimestamp: end.toISOString(), formula
  });
}

/**
 * Cumulative efficiency for one container — ΣtargetMs / ΣactualMs × 100 over
 * only VALID+COMPLETED stages, NEVER an average of already-rounded stage
 * percentages (the spec is explicit that averaging percentages produces
 * misleading results — a fast 1h stage and a slow 48h stage do not deserve
 * equal weight). NOT_APPLICABLE/REJECTED/MISSING_DATA/INVALID_DATA/
 * IN_PROGRESS/HOLD/NOT_STARTED stages are excluded — their target/actual
 * are either inapplicable or not yet final.
 */
export function calculateCumulativeEfficiency(stageResults) {
  const applicable = stageResults.filter((s) => s.status === 'COMPLETED' && s.calculationStatus === 'VALID');
  if (!applicable.length) {
    return { totalTargetMinutes: 0, totalActualMinutes: 0, cumulativeEfficiencyPercentage: null, calculationStatus: 'MISSING_DATA' };
  }
  const totalTargetMinutes = round2(applicable.reduce((sum, s) => sum + s.targetDurationMinutes, 0));
  const totalActualMinutes = round2(applicable.reduce((sum, s) => sum + s.netActualDurationMinutes, 0));
  const raw = totalActualMinutes > 0 ? (totalTargetMinutes / totalActualMinutes) * 100 : 100;
  return {
    totalTargetMinutes, totalActualMinutes,
    cumulativeEfficiencyPercentage: round2(Math.min(100, raw)),
    calculationStatus: 'VALID'
  };
}

/** First non-terminal stage in true workflow order — "what this container is
 *  currently waiting on," or 'Completed' once every stage is terminal. */
function _currentStageLabel(stages) {
  for (const s of stages) if (!TERMINAL_STATUSES.has(s.status)) return s.stageName;
  return 'Completed';
}

/** `statusCol` non-blank -> stage claims completion; its timestamp (2
 *  columns before, this app's universal convention — see OL_STAGE_INFO's own
 *  doc comments) must then parse, or this is a real MISSING_DATA gap rather
 *  than "not reached yet." */
function _readStatusEnd(row, info) {
  if (!info) return { end: null, missingEnd: false };
  const statusRaw = safeStr(row[info.statusCol]).trim();
  if (statusRaw === '') return { end: null, missingEnd: false };
  const end = parseStamp(safeStr(row[info.statusCol - 2]).trim());
  return { end, missingEnd: !end };
}

/**
 * Resolves every stage's real start/end business-event timestamps for one
 * container row. Reuses the exact FMS/gate-form/approval signals already
 * built and verified for the pending-queue TAT columns and Container Lookup
 * earlier the same day — see this module's header comment for the full
 * per-stage mapping and why each fallback exists.
 */
async function _resolveContainerStageEvents(row, entryByContainer, gfIndex, apStatusCol, apTsCol) {
  const container = row[0];
  const clientName = row[5];

  const entryAt = parseStamp(entryByContainer.get(normKey(container)) || '');

  const apStatus = apStatusCol >= 0 ? safeStr(row[apStatusCol]).trim().toLowerCase() : '';
  const rejected = apStatus === 'rejected';
  const approvedAt = (apStatus === 'approved' && apTsCol >= 0) ? parseStamp(row[apTsCol]) : null;
  const approvalMissingEnd = apStatus === 'approved' && !approvedAt;

  let fms = null;
  try { fms = await getMatchedFmsForContainer(container, clientName); } catch (e) { fms = null; }
  const hasBooking = !!(fms?.movement && fms?.transport);
  const stage89At = hasBooking
    ? _laterStamp(parseStamp(fms.movement.timestamp), parseStamp(fms.transport.lastUpdated))
    : null;
  const hasDelivery = !!fms?.delivery;
  const stage10At = hasDelivery ? parseStamp(fms.delivery.timestamp) : null;
  const transportEndAt = stage89At || stage10At;
  const transportMissingEnd = hasBooking && !transportEndAt;
  const gateInMissingStart = hasDelivery && !stage10At;

  const containerKey = _containerKey(container);
  const gfRow = pickGateFormForClient(gfIndex.get(containerKey) || [], clientName);
  const gatedIn = isGatedIn(gfRow);
  const gateInAt = gatedIn ? parseStamp(gfRow?.timestamp) : null;
  const gateInMissingEnd = gatedIn && !gateInAt;

  const onHold = _isOnHold(row);
  const holdAt = parseStamp(safeStr(row[OL_HOLD_TIMESTAMP_COL]).trim());

  const s1 = _readStatusEnd(row, OL_STAGE_INFO[1]);
  const insp = _readStatusEnd(row, OL_STAGE_INFO[OL_INSPECTION_STAGE]);
  const bill = _readStatusEnd(row, OL_STAGE_INFO[OL_BILLING_STAGE]);
  const close = _readStatusEnd(row, OL_STAGE_INFO[OL_CLOSURE_STAGE]);

  const inspStart = gateInAt || stage10At;
  /* CHANGED 2026-09-04: Inspection is no longer NOT_APPLICABLE for a
     Repair-Required=No container, and Billing no longer has a repairSkip
     fallback start — every container now waits through a real Inspection
     completion regardless of Repair Required Yes/No (same-day change to
     getOffLeaseData's own queue gating; this mirrors it). */
  const billStart = insp.end;

  return {
    1: { start: entryAt, end: s1.end, missingEnd: s1.missingEnd, onHold, holdAt },
    approval: { start: s1.end, end: approvedAt, missingEnd: approvalMissingEnd, rejected },
    [OL_STAGE2_INTERNAL]: { start: approvedAt, end: transportEndAt, missingEnd: transportMissingEnd },
    [OL_STAGE3_INTERNAL]: { start: stage10At, end: gateInAt, missingStart: gateInMissingStart, missingEnd: gateInMissingEnd },
    [OL_INSPECTION_STAGE]: { start: inspStart, end: insp.end, missingEnd: insp.missingEnd },
    [OL_BILLING_STAGE]: { start: billStart, end: bill.end, missingEnd: bill.missingEnd },
    [OL_CLOSURE_STAGE]: { start: bill.end, end: close.end, missingEnd: close.missingEnd }
  };
}

/** Full stage-by-stage + cumulative efficiency for one container. */
export async function calculateContainerEfficiency(row, entryByContainer, gfIndex, apStatusCol, apTsCol) {
  const events = await _resolveContainerStageEvents(row, entryByContainer, gfIndex, apStatusCol, apTsCol);
  const stages = STAGE_TAT_CONFIG.map((config) => calculateStageEfficiency(events[config.id], config));
  const cumulative = calculateCumulativeEfficiency(stages);

  let hadRework = false;
  try {
    const history = await getMoveHistory(safeStr(row[0]), safeStr(row[1]));
    hadRework = history.some((h) => h.event === 'SENT_BACK');
  } catch (e) { hadRework = false; }

  return {
    containerNo: safeStr(row[0]),
    leaseId: safeStr(row[1]),
    clientName: safeStr(row[5]),
    currentStage: _currentStageLabel(stages),
    stages,
    cumulative,
    hadRework
  };
}

/**
 * The single authoritative report — overall + stage-wise + case-wise +
 * data-quality — behind GET /offlease/efficiency (internal page and the
 * public-API-key Company Efficiency Dashboard route alike). Access-scoped
 * via the SAME gate (_offLeaseAccessGate) every other Off-Lease endpoint
 * uses — the previous Overdue-% version of this endpoint was called with no
 * user at all (unscoped), which meant a Sale-Person-restricted login saw
 * every client's data here despite being scoped everywhere else in Off-
 * Lease; this closes that gap per the explicit "use existing permissions"
 * requirement rather than leaving it silently inconsistent.
 */
export async function getOffLeaseEfficiencyReport(user) {
  const { headers, rows } = await getSheetDataFromMongo(OL_SHEET);
  const gate = await _offLeaseAccessGate(user);

  const apStatusCol = _findOlColumnMulti(headers, ['intimation approval status', 'intimation appt status', 'approval status']);
  const apTsCol = _findOlColumnMulti(headers, ['intimation approval timestamp', 'intimation appt timestamp']);

  /* Off-lease entry stamp — identical lookup to attachStageTat's own (see
     offlease.service.js), read once here rather than once per container. */
  const entryByContainer = new Map();
  {
    const { headers: dh, rows: dr } = await getSheetDataFromMongo(SHEETS.DEPLOYED);
    const updCol = _findOlColumnMulti(dh, ['update']);
    const stsCol = _findOlColumnMulti(dh, ['status']);
    if (updCol >= 0) {
      for (const r of dr) {
        if (stsCol >= 0 && !/off[\s-]?lease/i.test(safeStr(r[stsCol]))) continue;
        const k = normKey(r[0]);
        if (k && !entryByContainer.has(k)) entryByContainer.set(k, safeStr(r[updCol]).trim());
      }
    }
  }

  const gfIndex = getGateFormIndexSync();

  const containers = [];
  for (const row of rows) {
    if (!row[0] || safeStr(row[0]).trim() === '') continue;
    if (gate && !gate(safeStr(row[5]))) continue;
    containers.push(await calculateContainerEfficiency(row, entryByContainer, gfIndex, apStatusCol, apTsCol));
  }

  // ---- Overall ----
  const totalCases = containers.length;
  let completedCases = 0, invalidDataCases = 0;
  let totalTargetMinutes = 0, totalActualMinutes = 0;
  for (const c of containers) {
    if (c.currentStage === 'Completed') completedCases++;
    if (c.stages.some((s) => s.calculationStatus === 'MISSING_DATA' || s.calculationStatus === 'INVALID_DATA')) invalidDataCases++;
    totalTargetMinutes += c.cumulative.totalTargetMinutes;
    totalActualMinutes += c.cumulative.totalActualMinutes;
  }
  const inProgressCases = totalCases - completedCases;
  const overallRaw = totalActualMinutes > 0 ? (totalTargetMinutes / totalActualMinutes) * 100 : null;
  const overall = {
    totalCases, completedCases, inProgressCases, invalidDataCases,
    totalTargetMinutes: round2(totalTargetMinutes),
    totalActualMinutes: round2(totalActualMinutes),
    cumulativeEfficiencyPercentage: overallRaw != null ? round2(Math.min(100, overallRaw)) : null,
    calculationStatus: totalCases > 0 ? 'VALID' : 'MISSING_DATA'
  };

  // ---- Stage-wise ----
  let overallCompletedInstances = 0, overallBelowTargetInstances = 0;
  const stages = STAGE_TAT_CONFIG.map((config) => {
    let completedCount = 0, pendingCount = 0, onHoldCount = 0, reworkCount = 0, notApplicableCount = 0, missingDataCount = 0;
    let sumActual = 0, sumTarget = 0, n = 0, belowTargetCount = 0;
    /* Bottlenecks — who this stage's overrun (actual time PAST target) is
       concentrated in, grouped by client. Same "ranked by total overrun
       contributed, not just count" reasoning the old Overdue-% version used:
       one client with a few very long delays should outrank one with many
       barely-late visits — that's what actually costs time. */
    const byClient = new Map();
    for (const c of containers) {
      const s = c.stages.find((x) => x.stage === config.id);
      if (!s) continue;
      if (s.status === 'COMPLETED' && s.calculationStatus === 'VALID') {
        completedCount++; sumActual += s.actualDurationMinutes; sumTarget += s.targetDurationMinutes; n++;
        overallCompletedInstances++;
        const overrun = s.actualDurationMinutes - s.targetDurationMinutes;
        const isLate = overrun > 0;
        if (isLate) { belowTargetCount++; overallBelowTargetInstances++; }
        if (config.id === 1 && c.hadRework) reworkCount++;
        const name = c.clientName || 'Unknown';
        if (!byClient.has(name)) byClient.set(name, { clientName: name, count: 0, belowTargetCount: 0, elapsed: [], overrun: [] });
        const bc = byClient.get(name);
        bc.count++;
        if (isLate) { bc.belowTargetCount++; bc.overrun.push(overrun); }
        bc.elapsed.push(s.actualDurationMinutes);
      } else if (s.status === 'HOLD') { onHoldCount++; pendingCount++; }
      else if (s.status === 'IN_PROGRESS') { pendingCount++; }
      else if (s.status === 'NOT_APPLICABLE') { notApplicableCount++; }
      else if (s.calculationStatus === 'MISSING_DATA' || s.calculationStatus === 'INVALID_DATA') { missingDataCount++; }
    }
    const stageTotalOverrun = [...byClient.values()].reduce((sum, c) => sum + c.overrun.reduce((x, y) => x + y, 0), 0);
    const bottlenecks = [...byClient.values()]
      .filter((c) => c.belowTargetCount > 0)
      .map((c) => {
        const sortedElapsed = [...c.elapsed].sort((x, y) => x - y);
        const totalOverrunMin = round2(c.overrun.reduce((x, y) => x + y, 0));
        return {
          clientName: c.clientName,
          count: c.count,
          belowTargetCount: c.belowTargetCount,
          avgActualDurationMinutes: sortedElapsed.length ? round2(sortedElapsed.reduce((x, y) => x + y, 0) / sortedElapsed.length) : null,
          medianActualDurationMinutes: median(sortedElapsed),
          p90ActualDurationMinutes: percentileOfSorted(sortedElapsed, 90),
          worstActualDurationMinutes: sortedElapsed.length ? sortedElapsed[sortedElapsed.length - 1] : null,
          avgOverrunMinutes: c.overrun.length ? round2(totalOverrunMin / c.overrun.length) : null,
          totalOverrunMinutes: totalOverrunMin,
          contributionPct: stageTotalOverrun ? round2((totalOverrunMin / stageTotalOverrun) * 100) : 0
        };
      })
      .sort((a, b) => b.totalOverrunMinutes - a.totalOverrunMinutes);
    return {
      stage: config.id, stageName: config.name, owner: config.owner, targetDurationMinutes: msToMin(config.targetMs),
      completedCount, pendingCount, onHoldCount, reworkCount, notApplicableCount, missingDataCount,
      belowTargetCount, totalSeen: n,
      onTimeRate: n ? round2(100 - (belowTargetCount / n) * 100) : null,
      timeLostMinutes: round2(stageTotalOverrun),
      avgActualDurationMinutes: n ? round2(sumActual / n) : null,
      bottlenecks,
      efficiencyPercentage: n && sumActual > 0 ? round2(Math.min(100, (sumTarget / sumActual) * 100)) : null
    };
  });
  /* Count-based "% of instances that met target," distinct from the ring's
     time-weighted cumulativeEfficiencyPercentage — the same "how many were
     late" question the old Overdue-% system answered, now framed as its
     positive complement. Assigned after the stage-wise loop above, which is
     what actually computes the two running counters it's built from. */
  overall.onTimeRate = overallCompletedInstances
    ? round2(100 - (overallBelowTargetInstances / overallCompletedInstances) * 100)
    : null;

  // ---- Data quality ----
  let missingTimestampRecords = 0, invalidTimestampRecords = 0, notApplicableRecords = 0, holdRecords = 0, reworkRecords = 0, validEfficiencyRecords = 0;
  for (const c of containers) {
    let flagged = false;
    for (const s of c.stages) {
      if (s.calculationStatus === 'MISSING_DATA') { missingTimestampRecords++; flagged = true; }
      if (s.calculationStatus === 'INVALID_DATA') { invalidTimestampRecords++; flagged = true; }
      if (s.status === 'NOT_APPLICABLE') notApplicableRecords++;
      if (s.status === 'HOLD') holdRecords++;
    }
    if (c.hadRework) reworkRecords++;
    if (!flagged) validEfficiencyRecords++;
  }
  const dataQuality = {
    totalRecords: totalCases,
    validEfficiencyRecords,
    missingTimestampRecords,
    invalidTimestampRecords,
    notApplicableRecords,
    reworkRecords,
    holdRecords,
    recordsRequiringManualReview: missingTimestampRecords + invalidTimestampRecords,
    knownLimitations: [
      'Hold duration: no release-from-hold timestamp exists in the Off-Lease sheet schema (only a single "held at" cell, blanked on release) — Stage 1 Actual Time for a held-then-released record uses gross elapsed time, not a Hold-excluded net figure. Recommend adding a "Hold Released Timestamp" column if precise Net TAT is required.',
      'Rework history: only the Move-To-Stage send-back path is audit-logged (Off-Lease Move History sheet, append-only). A rejected-and-resubmitted Stage 1 record has no trace of the original attempt once resubmitted — "hadRework"/reworkCount reflects the Move-To-Stage path only, not an exhaustive rework count.',
      'Server timezone: no TZ env var is pinned anywhere in this repo; a still-running stage\'s live elapsed reading is computed against the host OS default timezone. Completed-stage durations are unaffected (both timestamps are sheet-derived via the same parser).'
    ]
  };

  return { overall, stages, containers, dataQuality };
}
