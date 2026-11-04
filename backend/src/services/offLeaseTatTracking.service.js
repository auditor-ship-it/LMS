/**
 * Off-Lease TAT (Turnaround Time) Tracking — explicit spec 2026-11-04
 * ("Offlease New TAT Tracking System"), covering all 11 stages (1, 1A, 2, 3,
 * 4, 5, 6, 6A, 6B, 6C, 7) with Entry/Planned/Actual/Delay per stage.
 *
 * This is a NEW, dedicated engine — intentionally NOT a replacement of the
 * two existing, narrower ones already in this codebase:
 *   - offleaseSla.service.js's applySla()/SLA_MS — generic "previous stage's
 *     own status column" walk, feeds the Container History tab's SLA column.
 *     Different (smaller, stale) budgets, no Stage 6/6A/6B/6C coverage.
 *   - offlease.service.js's attachStageTat/_attachTransportGateInTat — feeds
 *     the per-stage pending-queue pages (StagePageBase.jsx). Same
 *     Stage-8/9/10-for-Transportation and Stage-10-for-Gate-In sourcing this
 *     file reuses, but scoped to one stage's queue at a time, not a whole
 *     record's 11-stage history, and again no Stage 6/6A/6B/6C coverage.
 * Both stay exactly as they are; this file is additive.
 *
 * CHAINING RULE (explicit spec, Hindi follow-up 2026-11-04 — "Previous stage
 * ka actual completion time hi next stage ka entry time hona chahiye"): a
 * stage's Entry time is the PREVIOUS stage's own Actual completion time,
 * walked in display order 1 -> 1A -> 2 -> 3 -> 4 -> 5 -> 6 -> 6A -> 6B -> 6C
 * -> 7 — with ONE deliberate exception, confirmed directly against a live
 * screenshot the same day ("Tarnsportion stage 10 fetch the Vehicle Reached
 * at Site Date... this date and gate in timestamp and calculate the dely"):
 * Stage 3 (Gate In)'s entry is STAGE-10's own "vehicle reached at site"
 * timestamp, NOT Stage 2 (Transportation)'s actual completion — this matches
 * _attachTransportGateInTat's own, already-debugged reasoning (see its doc
 * comment: Transportation and Gate In must never both read "running"
 * simultaneously, and Gate In needs a real signal of its own rather than
 * borrowed time).
 */
import { getSheetDataFromMongo } from './mongoSheetData.service.js';
import { SHEETS } from '../config/sheets.config.js';
import { safeStr } from '../utils/format.js';
import { normKey } from '../utils/normalize.js';
import { OL_STAGE_INFO, _findOlColumnMulti, _offLeaseAccessGate } from './offlease.service.js';
import { parseStamp, humanize } from './offleaseSla.service.js';
import { getGateFormForContainer, isGatedIn } from './stage3Form.service.js';
import { getMatchedFmsForContainer } from './stage8.service.js';
import { getRefundEntries } from './refunds.service.js';
import { STAGE_OWNERS } from './offLeaseStageDigest.service.js';

const OL_SHEET = SHEETS.OFF_LEASE_TRACKING;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const TAT_STAGE_ORDER = ['1', '1A', '2', '3', '4', '5', '6', '6A', '6B', '6C', '7'];

export const TAT_STAGE_LABELS = {
  '1': 'Off-Lease Intimation',
  '1A': 'Intimation Approval',
  '2': 'Transportation',
  '3': 'Gate In',
  '4': 'Inspection Checklist',
  '5': 'Final Billing',
  '6': 'SD Refund Form',
  '6A': 'HOD Approval',
  '6B': 'Accounts Approval',
  '6C': 'CEO Approval',
  '7': 'Payment Status'
};

// Budgets — explicit spec 2026-11-04, with two corrections the same day
// ("stage 4 tat 3 hours stage 5 tat 3 hours"): Stage 4 raised from the
// original spec's 2 Hours to 3 Hours, and Stage 5 (originally "Track TAT"
// only, no fixed duration) given a real 3-Hour budget too.
const TAT_BUDGETS_MS = {
  '1': 1 * DAY,
  '1A': 3 * HOUR,
  '2': 7 * DAY,
  '3': 2 * HOUR,
  '4': 3 * HOUR,
  '5': 3 * HOUR,
  '6': 3 * DAY,
  '6A': 2 * HOUR,
  '6B': 2 * HOUR,
  '6C': 2 * HOUR,
  '7': 4 * DAY
};

function budgetLabel(ms) {
  if (!ms) return '';
  if (ms % DAY === 0) return `${ms / DAY} Day${ms / DAY === 1 ? '' : 's'}`;
  return `${Math.round(ms / HOUR)} Hour${Math.round(ms / HOUR) === 1 ? '' : 's'}`;
}

/* Every refund entry, indexed for O(1) lookup by this report's per-row loop
   below — same composite container+Lease-ID scoping (falling back to
   container-only ONLY when a container has exactly one entry) established
   this same week for the identical cross-lease data-contamination bug class
   in StageDetailModal.jsx/ContainerDetailPage.jsx/OrderBookView.jsx/
   PipelineDashboard.jsx — a container can legitimately be re-leased, so
   matching a refund entry by container number alone risks attaching one
   lease's SD Refund timeline to a different lease's TAT row. Best-effort:
   a caller with none of the refund permissions still gets the other 8
   stages rather than losing the whole report (getRefundEntries throws on
   zero matching grants — see its own _assertCanViewRefunds). */
async function _buildRefundIndex(callerEmail) {
  let entries = [];
  try {
    entries = await getRefundEntries(callerEmail);
  } catch (e) {
    return { byComposite: new Map(), byContainerSingle: new Map(), countByContainer: new Map() };
  }
  const countByContainer = new Map();
  for (const e of entries) {
    const k = normKey(e.containerNo);
    if (!k) continue;
    countByContainer.set(k, (countByContainer.get(k) || 0) + 1);
  }
  const byComposite = new Map();
  const byContainerSingle = new Map();
  for (const e of entries) {
    const ck = normKey(e.containerNo);
    if (!ck) continue;
    if (e.offLeaseId) byComposite.set(`${ck}|${normKey(e.offLeaseId)}`, e);
    if (!byContainerSingle.has(ck)) byContainerSingle.set(ck, e);
  }
  return { byComposite, byContainerSingle, countByContainer };
}

/* BUG FOUND AND FIXED 2026-11-04 (confirmed live on TRIU6617353, caught by
   this file's own verification script before this ever shipped): the
   original fallback here only checked "exactly one REFUND entry for this
   container" — but TRIU6617353 has exactly one refund entry (Zenfold's,
   OF0090) AND two Off-Lease Tracking rows for the same container (Kirloskar/
   OF0048, which has never even submitted an SD Refund, and Zenfold/OF0090,
   which has). That single refund entry's own offLeaseId didn't match
   OF0048's leaseId, so the exact-match branch correctly skipped it — but the
   old fallback then wrongly re-attached it anyway, because it only asked "is
   there exactly one refund row", not "is there exactly one LEASE this
   refund could possibly belong to". Same root-cause pattern already found
   and fixed FOUR other times this same week (StageDetailModal.jsx,
   ContainerDetailPage.jsx, OrderBookView.jsx, PipelineDashboard.jsx) — the
   fallback must count Off-Lease Tracking ROWS per container, not refund
   entries, before trusting an unscoped match. `olRowCountByContainer` is
   built once from the SAME OL_SHEET rows this report already reads. */
function _matchRefundEntry(refundIndex, olRowCountByContainer, container, leaseId) {
  const ck = normKey(container);
  if (!ck) return null;
  const lk = normKey(leaseId);
  if (lk) {
    const exact = refundIndex.byComposite.get(`${ck}|${lk}`);
    if (exact) return exact;
  }
  const onlyOneRefund = (refundIndex.countByContainer.get(ck) || 0) === 1;
  const onlyOneLease = (olRowCountByContainer.get(ck) || 0) === 1;
  if (onlyOneRefund && onlyOneLease) {
    return refundIndex.byContainerSingle.get(ck) || null;
  }
  return null;
}

/** Deployed sheet's "Update" column, where Status reads Off-Lease — Stage 1's
 *  own entry anchor. Built ONCE for the whole report (same data
 *  attachStageTat's own entryByContainer map reads, duplicated here rather
 *  than calling getOffLeaseEntryStamp per container — that function does its
 *  own full-sheet scan per call, which doesn't scale to a multi-record
 *  report; this file already needs the Deployed sheet in memory once). */
async function _buildEntryStampIndex() {
  const { headers, rows } = await getSheetDataFromMongo(SHEETS.DEPLOYED);
  const updCol = _findOlColumnMulti(headers, ['update']);
  const stsCol = _findOlColumnMulti(headers, ['status']);
  const map = new Map();
  if (updCol < 0) return map;
  for (const r of rows) {
    if (stsCol >= 0 && !/off[\s-]?lease/i.test(safeStr(r[stsCol]))) continue;
    const k = normKey(r[0]);
    if (k && !map.has(k)) map.set(k, safeStr(r[updCol]).trim());
  }
  return map;
}

/** One OL_SHEET row's generic "Timestamp" cell for a given internal stage —
 *  statusCol-2, per OL_STAGE_INFO's own write convention (statusCol=Status,
 *  statusCol-1=User, statusCol-2=Timestamp, statusCol-3=Remark — confirmed
 *  against saveOffLeaseStage's write block and olHeaders.generated.js, not
 *  the header TEXT, which is stale for several of these). Returns '' unless
 *  the stage's own Status cell is actually non-blank (a blank status means
 *  this stage has never been submitted, regardless of what garbage a
 *  pre-existing timestamp cell might hold from a reused row). */
function _genericStageTimestamp(row, internalStage) {
  const info = OL_STAGE_INFO[internalStage];
  if (!info) return '';
  const status = safeStr(row[info.statusCol]).trim();
  if (!status) return '';
  return safeStr(row[info.statusCol - 2]).trim();
}

/**
 * Builds the full 11-stage Entry/Planned/Actual/Delay breakdown for ONE
 * Off-Lease Tracking row. `row` is the raw OL_SHEET row (container=row[0],
 * Lease ID=row[1], client=row[5] — see getOffLeaseContainerDetail's own
 * usage, the authoritative reference for this sheet's real column layout).
 */
async function _buildRecordStages({ row, apStatusCol, apTsCol, entryStampIndex, refundIndex, olRowCountByContainer }) {
  const container = safeStr(row[0]).trim();
  const leaseId = safeStr(row[1]).trim();
  const client = safeStr(row[5]).trim();

  const actual = {}; // stage key -> Date|null
  const by = {};
  const skipped = {};

  // Stage 1 — Off-Lease Intimation.
  const s1Ts = _genericStageTimestamp(row, 1);
  actual['1'] = parseStamp(s1Ts) || null;
  by['1'] = s1Ts ? safeStr(row[OL_STAGE_INFO[1].statusCol - 1]) : '';

  // Stage 1A — Intimation Approval gate (not in OL_STAGE_INFO — header-matched).
  const apStatus = apStatusCol >= 0 ? safeStr(row[apStatusCol]).trim().toLowerCase() : '';
  actual['1A'] = (apStatus === 'approved' && apTsCol >= 0) ? parseStamp(row[apTsCol]) : null;

  // Stage 2 — Transportation. Own status column is virtually never written
  // (see _attachTransportGateInTat's doc comment) — sourced from STAGE-8
  // (movement booked) and STAGE-9 (transported), the later of the two,
  // exactly as that function already does.
  let fms = null;
  try { fms = await getMatchedFmsForContainer(container, client); } catch (e) { fms = null; }
  const movementAt = parseStamp(fms?.movement?.timestamp);
  const transportAt = parseStamp(fms?.transport?.lastUpdated);
  const stage89At = (movementAt && transportAt)
    ? (movementAt.getTime() >= transportAt.getTime() ? movementAt : transportAt)
    : (movementAt || transportAt || null);
  actual['2'] = (fms?.movement && fms?.transport) ? stage89At : null;
  // "By" shows the stage OWNER's email (same STAGE_OWNERS table the Off-Lease
  // digest emails use), not the generic "Auto — FMS Stage 8 · 9" label —
  // explicit request 2026-11-04 ("this is automaticlly emails id fetch for
  // transportion kshirod.khatua@crystalgroup.in gate in mum.depot@...
  // auto fethc"): nobody manually clicked anything for an auto-completed
  // stage, so this isn't "who did it", it's "whose stage this is" — kept
  // the "Auto —" prefix so it still reads as system-detected, not a real
  // person's own action.
  by['2'] = actual['2'] ? `Auto — ${STAGE_OWNERS[2]?.email || 'FMS Stage 8 · 9'}` : '';

  // Stage 3 — Gate In. Entry anchored at STAGE-10's own "vehicle reached at
  // site" timestamp (NOT Stage 2's actual — see this file's own header
  // comment), actual = the Stage 3 Gate-In form's own "Inward" timestamp.
  const stage10At = fms?.delivery ? parseStamp(fms.delivery.timestamp) : null;
  const gfRow = getGateFormForContainer(container, client);
  const gatedIn = isGatedIn(gfRow);
  actual['3'] = gatedIn ? parseStamp(gfRow?.timestamp) : null;
  by['3'] = actual['3'] ? `Auto — ${STAGE_OWNERS[3]?.email || 'Gate-In Form'}` : '';

  // Stage 4 — Inspection Checklist. BUG FOUND AND FIXED 2026-11-04, TWICE
  // the same day:
  //  1st (live on HNKU6063239/OF0002): a Gate-In form saying "Repair
  //     Required? = No" must never override a Stage 4 that actually WAS
  //     completed — the row's own status column is the ground truth.
  //  2nd (live on TITU9930006/OF0040, and 4 of 6 real records in the same
  //     Inspection Checklist queue): isRepairNotRequired must never mark
  //     Stage 4 Skipped AT ALL, even when the status column is blank —
  //     offlease.service.js's own getOffLeaseData explicitly stopped
  //     treating repair-not-required as a Stage 4 bypass on 2026-09-04
  //     ("CHANGED 2026-09-04, explicit request: Inspection Checklist...no
  //     longer drops a repair-not-required container from its queue —
  //     every gated-in container now waits here for Inspection to actually
  //     be completed, whether or not the Gate-In form marked Repair
  //     Required as No. isRepairNotRequired/repairSkip is no longer read in
  //     this function at all"). This file's own Skipped branch was built
  //     from that function's stale doc comment, not its actual, already-
  //     corrected behavior — confirmed live: 5 of 6 containers in the real
  //     Inspection Checklist queue have "Repair Required = No" on their
  //     Gate-In form yet are genuinely, currently sitting at Stage 4, not
  //     skipped. `skipped['4']` and `isRepairNotRequired` are no longer
  //     used by this function at all — Stage 4 now follows the exact same
  //     plain "read the real status column" pattern every other generic
  //     stage here does.
  const s4Ts = _genericStageTimestamp(row, 3);
  actual['4'] = parseStamp(s4Ts) || null;
  by['4'] = s4Ts ? safeStr(row[OL_STAGE_INFO[3].statusCol - 1]) : '';

  // Stage 5 — Final Billing. No budget (spec: "Track TAT" only).
  const s5Ts = _genericStageTimestamp(row, 5);
  actual['5'] = parseStamp(s5Ts) || null;
  by['5'] = s5Ts ? safeStr(row[OL_STAGE_INFO[5].statusCol - 1]) : '';

  // Stage 6 — SD Refund Form (the submission itself, not its approvals).
  // Sourced from the Refunds sheet's own entry, lease-scoped — see this
  // file's own _matchRefundEntry doc comment.
  const refund = _matchRefundEntry(refundIndex, olRowCountByContainer, container, leaseId);
  actual['6'] = refund ? parseStamp(refund.timestamp) : null;
  by['6'] = refund ? (refund.user || refund.userEmail || '') : '';

  // Stage 6A/6B/6C — HOD / Accounts / CEO approval, from that SAME refund
  // entry. 6C is SKIPPED (not Delayed/Pending) when the bill's amount didn't
  // require CEO review at all (refund.ceoRequired === false) — matches the
  // Stage 6 Approval Workflow spec already shipped this week (CEO must never
  // be treated as "late" for a bill it was never going to review).
  actual['6A'] = refund && refund.hodStatus === 'Approved' ? parseStamp(refund.hodDate) : null;
  by['6A'] = refund?.hodApprover || '';
  actual['6B'] = refund && refund.accountsStatus === 'Approved' ? parseStamp(refund.accountsDate) : null;
  by['6B'] = refund?.accountsApprover || '';
  if (refund && refund.ceoRequired === false) {
    skipped['6C'] = true;
    actual['6C'] = null;
  } else {
    actual['6C'] = refund && refund.ceoStatus === 'Approved' ? parseStamp(refund.ceoDate) : null;
    by['6C'] = refund?.ceoApprover || '';
  }

  // Stage 7 — Payment Status (UTR submitted).
  const s7Ts = _genericStageTimestamp(row, 8);
  actual['7'] = parseStamp(s7Ts) || null;
  by['7'] = s7Ts ? safeStr(row[OL_STAGE_INFO[8].statusCol - 1]) : '';

  // ---- Entry times: previous stage's own actual, chained in display order,
  // skipping over any SKIPPED stage so the next real stage still gets a
  // real entry time instead of inheriting a blank. Stage 1's entry is the
  // Deployed-sheet off-lease stamp; Stage 3's entry is the STAGE-10
  // exception noted in this file's header comment.
  const entry = {};
  entry['1'] = parseStamp(entryStampIndex.get(normKey(container)) || '');
  entry['1A'] = actual['1'];
  entry['2'] = actual['1A'];
  entry['3'] = stage10At; // deliberate exception — see header comment
  // Stage 4's entry: Gate-In form's own timestamp when available (same
  // reasoning as attachStageTat's own needsGateInFallback — Stage 3's own
  // status column is as unreliable as Transportation's), else Stage 3's
  // resolved actual.
  entry['4'] = (gatedIn && parseStamp(gfRow?.timestamp)) || actual['3'];
  // Stage 5's entry: previous REAL stage's actual — Stage 4's, unless Stage
  // 4 was skipped, in which case it's whatever fed Stage 4 (the Gate-In
  // timestamp) directly.
  entry['5'] = actual['4'];
  entry['6'] = actual['5'];
  entry['6A'] = actual['6'];
  entry['6B'] = actual['6A'];
  // Stage 6C's entry is Stage 6B's actual regardless of whether 6C itself
  // ends up skipped (it still needs a well-defined "would-be" entry so
  // Stage 7 below has somewhere real to chain from).
  entry['6C'] = actual['6B'];
  entry['7'] = skipped['6C'] ? actual['6B'] : actual['6C'];

  // ---- Planned/status/delay per stage.
  const now = Date.now();
  const stages = TAT_STAGE_ORDER.map((key) => {
    if (skipped[key]) {
      return { key, label: TAT_STAGE_LABELS[key], status: 'Skipped', entryAt: null, plannedAt: null, actualAt: null, budgetMs: null, budgetLabel: '', delayMs: null, delayLabel: '', backdated: false, by: '' };
    }
    const entryAt = entry[key];
    const actualAt = actual[key];
    const budgetMs = TAT_BUDGETS_MS[key];
    if (!entryAt) {
      return { key, label: TAT_STAGE_LABELS[key], status: 'Pending', entryAt: null, plannedAt: null, actualAt: null, budgetMs, budgetLabel: budgetLabel(budgetMs), delayMs: null, delayLabel: '', backdated: false, by: '' };
    }
    /* `backdated` (actualAt before entryAt) is flagged but NO LONGER hides
       the real number — REVERSED 2026-11-04 ("why this not dely show pls
       chcek trasnpotion fetch"), same day it was added: on HNKU6063239
       (OF0002), Transportation's FMS completion (18-Jul) genuinely predates
       its own Intimation Approval (20-Jul 1A gate) — not bad data, this is
       the SAME "paperwork catching up to physical reality" pattern
       offlease.service.js's getOffLeaseContainerDetail already documents as
       normal for this business (physical ops can finish before the
       approval paperwork is signed off) — see that file's own comment on
       why the FMS match is deliberately NOT bounded to start after this
       lease's own Stage 1 timestamp. Hiding the number behind "Data out of
       order" was answering a question nobody asked; the actual Early/Delay
       figure (computed against Planned exactly as any other stage) is what
       was wanted — `backdated` stays on the object for anyone who wants to
       know WHY a number looks unusually large, without blocking it. */
    const backdated = !!(actualAt && actualAt.getTime() < entryAt.getTime());
    const plannedAt = budgetMs ? new Date(entryAt.getTime() + budgetMs) : null;
    let status; let delayMs = null; let delayLabel = '';
    if (actualAt) {
      status = 'Completed';
      if (plannedAt) {
        const diff = actualAt.getTime() - plannedAt.getTime();
        if (diff > 0) { status = 'Delayed'; delayMs = diff; delayLabel = `${humanize(diff)} Delay`; }
        else if (diff < 0) { delayLabel = `${humanize(-diff)} Early`; }
        else delayLabel = 'On Time';
      }
    } else {
      status = 'In Progress';
      if (plannedAt && now > plannedAt.getTime()) {
        status = 'Delayed';
        delayMs = now - plannedAt.getTime();
        delayLabel = `${humanize(delayMs)} Delay (ongoing)`;
      } else if (plannedAt) {
        delayLabel = 'On Time';
      }
    }
    return {
      key, label: TAT_STAGE_LABELS[key], status,
      entryAt: entryAt.toISOString(),
      plannedAt: plannedAt ? plannedAt.toISOString() : null,
      actualAt: actualAt ? actualAt.toISOString() : null,
      budgetMs, budgetLabel: budgetLabel(budgetMs),
      delayMs, delayLabel, backdated,
      by: by[key] || ''
    };
  });

  const plannedTotalMs = stages.reduce((sum, s) => sum + (s.budgetMs || 0), 0);
  const actualTotalMs = (() => {
    const first = stages.find((s) => s.entryAt);
    if (!first) return null;
    const lastDone = [...stages].reverse().find((s) => s.actualAt);
    const endMs = lastDone ? new Date(lastDone.actualAt).getTime() : now;
    return Math.max(0, endMs - new Date(first.entryAt).getTime());
  })();

  return {
    containerNo: container,
    leaseId,
    clientName: client,
    stages,
    plannedTotalMs,
    plannedTotalLabel: humanize(plannedTotalMs),
    actualTotalMs,
    actualTotalLabel: actualTotalMs == null ? '' : humanize(actualTotalMs),
    overdueStageCount: stages.filter((s) => s.status === 'Delayed').length
  };
}

/**
 * The new TAT Tracking page's own data — every Off-Lease Tracking row (or
 * one, when containerNo/leaseId are given), each with its full 11-stage
 * Entry/Planned/Actual/Delay breakdown. `user` is the logged-in caller (same
 * object every other Off-Lease read takes) — scoped through
 * _offLeaseAccessGate exactly like getOffLeaseEfficiencyReport, so a
 * Sale-Person-restricted login sees only its own clients' TAT data, not the
 * whole desk's. `user.email` is also passed to the Refunds-sheet permission
 * check (see _buildRefundIndex).
 */
export async function getOffLeaseTatReport({ containerNo, leaseId, user } = {}) {
  const { headers, rows } = await getSheetDataFromMongo(OL_SHEET);
  const apStatusCol = _findOlColumnMulti(headers, ['intimation approval status', 'intimation appt status', 'approval status']);
  const apTsCol = _findOlColumnMulti(headers, ['intimation approval timestamp', 'intimation appt timestamp']);

  const [entryStampIndex, refundIndex, gate] = await Promise.all([
    _buildEntryStampIndex(),
    _buildRefundIndex(user?.email),
    _offLeaseAccessGate(user)
  ]);

  // How many Off-Lease Tracking ROWS exist for each container, across the
  // WHOLE sheet (not just the filtered subset below) — see _matchRefundEntry's
  // own doc comment for why this must gate the refund-matching fallback.
  const olRowCountByContainer = new Map();
  for (const row of rows) {
    const k = normKey(row[0]);
    if (!k) continue;
    olRowCountByContainer.set(k, (olRowCountByContainer.get(k) || 0) + 1);
  }

  const wantContainer = containerNo ? normKey(containerNo) : null;
  const wantLease = leaseId ? safeStr(leaseId).trim().toLowerCase() : null;

  const targetRows = rows.filter((row) => {
    if (!safeStr(row[0]).trim()) return false;
    if (wantContainer && normKey(row[0]) !== wantContainer) return false;
    if (wantLease && safeStr(row[1]).trim().toLowerCase() !== wantLease) return false;
    if (gate && !gate(safeStr(row[5]))) return false;
    return true;
  });

  const records = [];
  for (const row of targetRows) {
    records.push(await _buildRecordStages({ row, apStatusCol, apTsCol, entryStampIndex, refundIndex, olRowCountByContainer }));
  }
  return { records, stageOrder: TAT_STAGE_ORDER, stageLabels: TAT_STAGE_LABELS };
}
