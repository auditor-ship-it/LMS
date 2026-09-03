/**
 * OFF-LEASE EFFICIENCY REPORT
 *
 * A single aggregate view over the whole Off-Lease Tracking sheet — per-stage
 * turnaround vs. SLA budget, which stage is the current bottleneck, monthly
 * throughput, and the same broken down by stage owner. Nothing here writes;
 * this is read-only reporting, safe to serve from the Mongo mirror.
 *
 * BUG FOUND AND FIXED 2026-09-02: this file used to walk each row's stage
 * status columns in isolation (see the old header comment this replaced,
 * "an efficiency report only cares about stages that have a REAL recorded
 * timestamp... not which external signal might imply a stage further back
 * was skipped"). That reasoning was wrong — Transportation's own status
 * column (internal stage 6) is essentially NEVER written, because it is
 * released by the STAGE-10 delivery signal, the Gate-In form, or a manual
 * move, not a form submission (see offlease.service.js's OL_STAGE2_INTERNAL
 * bypass comments). Treating "status column blank" as "still running THIS
 * stage" meant every container that had genuinely bypassed Transportation
 * and moved on to Gate In or Billing was still counted as stuck at
 * Transportation — confirmed live: this report showed Gate In and Billing
 * Reconciliation both at 0 running/0 completed (rendering "—" on the
 * Stage-Wise Overdue % chart) while their REAL queues (getOffLeaseStageCounts)
 * showed 5 and 20 pending respectively, and Transportation's own "50
 * running" was actually a blend of all three (25 genuine + 5 Gate In + 20
 * Billing). Now reuses _classifyOffLeaseStages — the SAME bypass-aware
 * classifier the real Dashboard uses (gatedIn/repairSkip/delivered signals,
 * plus its own "implied done" backward pass) — as the single source of
 * truth for which stage a row is REALLY at, so this report can never drift
 * out of sync with the real queues the way two independent reimplementations
 * of the same bypass rules always eventually do (the exact class of bug
 * documented repeatedly in that classifier's own history).
 */
import { getSheetDataFromMongo } from './mongoSheetData.service.js';
import { SHEETS } from '../config/sheets.config.js';
import { OL_STAGE_INFO, OL_ACTIVE_STAGE_NUMS, _findOlColumnMulti, _classifyOffLeaseStages } from './offlease.service.js';
import { getGateFormIndexSync, pickGateFormForClient, isGatedIn, isRepairNotRequired } from './stage3Form.service.js';
import { getDeliveredKeys, isDeliveredSince } from './stage8.service.js';
import { SLA_MS, parseStamp, humanize, budgetLabel } from './offleaseSla.service.js';
import { safeStr } from '../utils/format.js';
import { normKey } from '../utils/normalize.js';

/** Container key for the bypass-signal lookups (gate form index, delivered
 *  map) — must stay identical to offlease.service.js's own _containerKey and
 *  stage8.service.js's normContainer (not exported from either, so this is
 *  the same one-liner duplicated a third time, same convention as
 *  RENEWAL_LOG_HEADERS being duplicated between expiry/verify.service.js). */
const _containerKey = (v) => safeStr(v).toUpperCase().replace(/[^A-Z0-9]/g, '');

const OL_SHEET = SHEETS.OFF_LEASE_TRACKING;

/** Mirrors constants/stages.js's ALL_STAGES owner assignments — duplicated
 *  here rather than shared with the frontend, same as RENEWAL_LOG_HEADERS is
 *  already duplicated between expiry.service.js and verify.service.js. */
const STAGE_META = {
  1: { label: 'Off-Lease Intimation', owner: 'Christopher' },
  approval: { label: 'Intimation Approval', owner: 'Pushpa Maam' },
  6: { label: 'Transportation', owner: 'Kshirod Khatua' },
  7: { label: 'Gate In', owner: 'Pritam' },
  3: { label: 'Inspection Checklist', owner: 'Sitaram' },
  5: { label: 'Billing Reconciliation', owner: 'Shivani Maam' },
  8: { label: 'FMS Closure', owner: 'Unassigned' }
};

/** "01/09/2026" -> 2026-09, for grouping into a month bucket. Stage timestamps
 *  are written "dd/MM/yyyy HH:mm:ss" (dmyTime) — parseStamp already handles
 *  that format and the ISO one, so this just re-keys whatever it returns. */
function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

export async function getOffLeaseEfficiencyData() {
  const { headers, rows } = await getSheetDataFromMongo(OL_SHEET);

  const apTsCol = _findOlColumnMulti(headers, ['intimation approval timestamp', 'intimation appt timestamp']);
  const apStatusCol = _findOlColumnMulti(headers, ['intimation approval status', 'intimation appt status', 'approval status']);

  /* Stage 1's clock starts when the container actually ENTERED the off-lease
     pipeline — the Deployed sheet's own "Update" timestamp, set the moment
     addToOffLeaseTracking creates the row (the "Off-Lease" button click) —
     NOT col_10 (OL Intimation Date), which is a date the user TYPES INTO
     the Stage 1 form itself and can be set to anything, unrelated to real
     elapsed queue time. Same source attachStageTat uses for the live TAT
     column, so this report agrees with what the app already shows per row. */
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

  // Same bypass signals the real Dashboard/queues resolve once up front —
  // see this file's header comment for why a row's blank status column can
  // no longer be trusted as "still pending here" on its own.
  const gfIndex = getGateFormIndexSync();
  const deliveredKeys = await getDeliveredKeys();

  /* AUTO-CALIBRATED BUDGETS — 2026-09-02, explicit request: the fixed
   * SLA_MS budgets (1h "desk work" for almost every stage, 2d for
   * Transportation) are hours/days while this process's own REAL average
   * turnaround runs 12-36+ days per stage — comparing real elapsed time
   * against a 1-hour target meant essentially every completed or in-progress
   * instance was mathematically "overdue", pinning overduePct near 100%
   * everywhere and making the score useless for telling good performance
   * from bad. Each stage's budget is instead set to the MEDIAN of its own
   * genuinely-completed durations (a real, human-written status with a real
   * timestamp — never a bypass-inferred one, which has no duration to offer)
   * — so roughly half of past completions land "on time" by construction,
   * and the score actually discriminates. Falls back to the fixed SLA_MS
   * value only for a stage with zero completed history yet (Gate In, Billing
   * Reconciliation, FMS Closure, as of this fix — nothing has finished there
   * yet to calibrate from); `budgetSource`/`sampleSize` on each stage row
   * say which case applies, so a still-near-100% stage reads as "no history
   * yet", not as another unexplained anomaly.
   *
   * A first, lightweight pass over the SAME rows — real completions only, no
   * bypass classification needed (a bypass-completed stage has no real
   * duration to sample in the first place). The main loop below reuses these
   * medians instead of SLA_MS for every "is this late" decision. */
  const completionSamples = {};
  for (const s of OL_ACTIVE_STAGE_NUMS) completionSamples[s] = [];
  completionSamples.approval = [];
  for (const row of rows) {
    if (!row[0] || safeStr(row[0]).trim() === '') continue;
    let lastDone = parseStamp(entryByContainer.get(normKey(row[0])) || '');
    for (let i = 0; i < OL_ACTIVE_STAGE_NUMS.length; i++) {
      const s = OL_ACTIVE_STAGE_NUMS[i];
      const info = OL_STAGE_INFO[s];
      const statusVal = safeStr(row[info.statusCol]).trim();
      const doneAt = statusVal !== '' ? parseStamp(row[info.statusCol - 2]) : null;
      let start = lastDone;
      if (i === 1) {
        const apStatus = apStatusCol >= 0 ? safeStr(row[apStatusCol]).trim().toLowerCase() : '';
        start = (apStatus === 'approved' && apTsCol >= 0) ? (parseStamp(row[apTsCol]) || null) : null;
      }
      if (i === 0 && doneAt) {
        const apStatus = apStatusCol >= 0 ? safeStr(row[apStatusCol]).trim().toLowerCase() : '';
        if (apStatus === 'approved' && apTsCol >= 0) {
          const apDoneAt = parseStamp(row[apTsCol]);
          if (apDoneAt) {
            const apElapsed = apDoneAt.getTime() - doneAt.getTime();
            if (apElapsed >= 0) completionSamples.approval.push(apElapsed);
          }
        }
      }
      if (doneAt) {
        if (start) {
          const elapsed = doneAt.getTime() - start.getTime();
          if (elapsed >= 0) completionSamples[s].push(elapsed);
        }
        lastDone = doneAt;
      }
    }
  }
  function median(arr) {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  /** `arr` must already be sorted ascending — used for the bottleneck
   *  drill-down's "90th percentile" / worst-case metrics below. */
  function percentileOfSorted(sorted, p) {
    if (!sorted.length) return null;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
  }
  const AUTO_BUDGET = {};
  const BUDGET_SOURCE = {};
  const BUDGET_SAMPLES = {};
  for (const s of [...OL_ACTIVE_STAGE_NUMS, 'approval']) {
    const m = median(completionSamples[s]);
    AUTO_BUDGET[s] = m ?? SLA_MS[s];
    BUDGET_SOURCE[s] = m != null ? 'auto' : 'default';
    BUDGET_SAMPLES[s] = completionSamples[s].length;
  }

  const now = Date.now();

  // Per-stage accumulators
  const perStage = {};
  for (const s of OL_ACTIVE_STAGE_NUMS) {
    perStage[s] = { stage: s, ...STAGE_META[s], completedCount: 0, totalElapsedMs: 0, delayedCompletedCount: 0, runningCount: 0, runningOverdueCount: 0, records: [] };
  }
  // The Approval gate isn't in OL_ACTIVE_STAGE_NUMS (it has no OL_STAGE_INFO
  // entry — it's not a numbered form stage) but it IS a real step with its
  // own SLA budget (SLA_MS.approval) sitting between Stage 1 and Transportation,
  // so it gets the same accumulator shape tracked alongside the others.
  perStage.approval = { stage: 'approval', ...STAGE_META.approval, completedCount: 0, totalElapsedMs: 0, delayedCompletedCount: 0, runningCount: 0, runningOverdueCount: 0, records: [] };

  // Monthly throughput — keyed by the month FMS Closure (stage 8) completed.
  const throughputByMonth = new Map();

  // One entry per container — the per-stage pipeline (done-on-time/done-late/
  // current/future) a row-level table needs, distinct from perStage's
  // aggregates above. Built in the SAME pass so the two never disagree.
  const containers = [];

  let containersConsidered = 0;

  for (const row of rows) {
    if (!row[0] || safeStr(row[0]).trim() === '') continue;
    containersConsidered++;

    // Entry point for Stage 1's own clock — see entryByContainer's comment above.
    const entryStamp = parseStamp(entryByContainer.get(normKey(row[0])) || '');

    // Bypass-aware classification — the same one getOffLeaseDashboardData
    // uses, so "which stage is this row REALLY at" can never disagree with
    // what the Dashboard/queues show for it. See this file's header comment.
    const containerKey = _containerKey(row[0]);
    const gfRow = pickGateFormForClient(gfIndex.get(containerKey) || [], row[5]);
    const gatedIn = isGatedIn(gfRow);
    const repairSkip = isRepairNotRequired(gfRow);
    const delivered = isDeliveredSince(deliveredKeys, containerKey, null);
    const classified = _classifyOffLeaseStages(headers, row, gatedIn, repairSkip, delivered);
    // Index within OL_ACTIVE_STAGE_NUMS of the row's TRUE current stage:
    //  - 'stage'    -> that stage's own index
    //  - 'done'     -> past the end, so every index counts as "behind" it
    //  - 'approval'/'rejected' -> -1, nothing beyond Stage 1 is done or current
    const trueCurrentIdx = classified.stageClass === 'stage'
      ? OL_ACTIVE_STAGE_NUMS.indexOf(classified.currentStageNum)
      : classified.stageClass === 'done'
        ? OL_ACTIVE_STAGE_NUMS.length
        : -1;

    const pipeline = [];
    let anyPastOverdue = false;
    let currentStageNum = null;
    let currentOverdue = false;

    // First pass: every stage that has a REAL timestamp, regardless of gaps
    // before it. This workflow bypasses stages via external signals (Gate In
    // via the FMS form, Billing via a repair-not-required Inspection, etc.),
    // so a LATER stage can genuinely be done while an EARLIER one's own
    // status column stays blank — confirmed live on CICU4881946 (Inspection
    // done, Transportation/Gate In both blank). Stopping at the first blank
    // stage under-counted every stage after the first gap in every row that
    // ever used a bypass — effectively every row, since bypasses are the
    // normal path here, not the exception. `lastDone` carries forward across
    // a blank stage instead of resetting, so the stage AFTER a bypassed one
    // still measures its elapsed time from the last real timestamp, not from
    // a blank one that was never going to be filled.
    let lastDone = entryStamp;
    let firstBlankIdx = -1;
    let startOfFirstBlank = null;
    for (let i = 0; i < OL_ACTIVE_STAGE_NUMS.length; i++) {
      const s = OL_ACTIVE_STAGE_NUMS[i];
      const info = OL_STAGE_INFO[s];
      const statusVal = safeStr(row[info.statusCol]).trim();
      const tsVal = row[info.statusCol - 2];
      const doneAt = statusVal !== '' ? parseStamp(tsVal) : null;

      // The Approval gate sits between Stage 1 and whatever follows it — that
      // next stage's clock starts at approval, not at Stage 1's own
      // completion (mirrors applySla's identical rule). BUG FOUND AND FIXED
      // 2026-09-02: this used to fall back to lastDone (Stage 1's own
      // completion) whenever approval wasn't granted yet, which started
      // Transportation's clock the moment Stage 1 finished regardless of
      // whether approval had actually happened — every container still
      // waiting on approval was counted as "running Transportation" from
      // Stage 1's completion onward, showing 50/50 overdue there when most
      // of those containers hadn't actually started Transportation at all.
      // Not approved = the clock genuinely has not started -> null, exactly
      // like applySla's own approvalDone/start logic.
      let start = lastDone;
      if (i === 1) {
        const apStatus = apStatusCol >= 0 ? safeStr(row[apStatusCol]).trim().toLowerCase() : '';
        start = (apStatus === 'approved' && apTsCol >= 0) ? (parseStamp(row[apTsCol]) || null) : null;
      }

      const budget = AUTO_BUDGET[s];
      if (doneAt) {
        if (start && budget) {
          const elapsed = doneAt.getTime() - start.getTime();
          if (elapsed >= 0) {
            perStage[s].completedCount++;
            perStage[s].totalElapsedMs += elapsed;
            const delayed = elapsed > budget;
            if (delayed) { perStage[s].delayedCompletedCount++; anyPastOverdue = true; }
            perStage[s].records.push({
              container: safeStr(row[0]),
              leaseId: safeStr(row[1]),
              clientName: safeStr(row[5]),
              status: delayed ? 'Completed (Late)' : 'Completed (On Time)',
              startedAt: start.toISOString(),
              elapsed: humanize(elapsed),
              elapsedMs: elapsed,
              overdue: delayed
            });
            pipeline.push({ stage: s, label: STAGE_META[s].label, status: delayed ? 'done-late' : 'done-on-time', elapsed: humanize(elapsed) });
          } else {
            pipeline.push({ stage: s, label: STAGE_META[s].label, status: 'done-on-time', elapsed: null });
          }
        } else {
          pipeline.push({ stage: s, label: STAGE_META[s].label, status: 'done-on-time', elapsed: null });
        }
        lastDone = doneAt;
      } else if (i === trueCurrentIdx) {
        // The row's TRUE current stage (bypass-aware, from `classified`) —
        // not necessarily the first blank status column encountered; a
        // status column stays blank forever once an external signal has
        // bypassed it. Snapshot `start` HERE so a later stage's completion
        // (carried into `lastDone`) never overwrites the time THIS stage
        // actually became actionable.
        firstBlankIdx = i;
        startOfFirstBlank = start;
        // Placeholder — overwritten below once we know if it's overdue. Kept
        // here so `pipeline` stays in stage order even though we haven't
        // finished computing this one yet.
        pipeline.push({ stage: s, label: STAGE_META[s].label, status: 'current', elapsed: null });
      } else if (i < trueCurrentIdx) {
        // Blank status column, but genuinely bypassed — the row has moved
        // past this stage via an external signal (STAGE-10 delivery, the
        // Gate-In form, repair-not-required) and simply never wrote its own
        // status. No real timestamp exists to compute elapsed from, so this
        // contributes no completedCount/turnaround, only a "done" pipeline
        // entry — an honest "nothing timed here" rather than a fabricated
        // duration.
        pipeline.push({ stage: s, label: STAGE_META[s].label, status: 'done-on-time', elapsed: null });
      } else {
        pipeline.push({ stage: s, label: STAGE_META[s].label, status: 'future', elapsed: null });
      }

      // Approval gate — inserted right after Stage 1 (i === 0), same spot it
      // sits in the real workflow, between Off-Lease Intimation and
      // Transportation. Mirrors applySla's own rule: the gate's clock starts
      // when Stage 1 completes and only "approved" counts as decided (a
      // container still pending, or rejected, has no completion timestamp
      // here — same convention applySla already uses for the live per-row TAT).
      if (i === 0) {
        const apBudget = AUTO_BUDGET.approval;
        // Sourced from `classified` (the same bypass-aware classifier),
        // not a second ad-hoc apStatus check — a rejected row used to fall
        // through to the "still pending approval" branch below (apStatus
        // !== 'approved' is also true for 'rejected'), showing it as a live,
        // ever-growing overdue approval wait it will never actually resolve.
        const apDoneAt = (classified.approvalStatus?.trim().toLowerCase() === 'approved' && apTsCol >= 0)
          ? parseStamp(row[apTsCol]) : null;
        if (!doneAt) {
          // Stage 1 itself isn't done yet — the gate hasn't been reached.
          pipeline.push({ stage: 'approval', label: STAGE_META.approval.label, status: 'future', elapsed: null });
        } else if (classified.stageClass === 'rejected') {
          // Decided (rejected) — a real outcome, just not one that proceeds
          // further. Not "pending", not counted toward the gate's overdue
          // stats (no meaningful "was this decision late" question once the
          // container isn't advancing anyway).
          pipeline.push({ stage: 'approval', label: STAGE_META.approval.label, status: 'done-on-time', elapsed: null });
        } else if (apDoneAt) {
          const elapsed = apDoneAt.getTime() - doneAt.getTime();
          if (elapsed >= 0 && apBudget) {
            perStage.approval.completedCount++;
            perStage.approval.totalElapsedMs += elapsed;
            const delayed = elapsed > apBudget;
            if (delayed) { perStage.approval.delayedCompletedCount++; anyPastOverdue = true; }
            perStage.approval.records.push({
              container: safeStr(row[0]), leaseId: safeStr(row[1]), clientName: safeStr(row[5]),
              status: delayed ? 'Completed (Late)' : 'Completed (On Time)',
              startedAt: doneAt.toISOString(), elapsed: humanize(elapsed), elapsedMs: elapsed, overdue: delayed
            });
            pipeline.push({ stage: 'approval', label: STAGE_META.approval.label, status: delayed ? 'done-late' : 'done-on-time', elapsed: humanize(elapsed) });
          } else {
            pipeline.push({ stage: 'approval', label: STAGE_META.approval.label, status: 'done-on-time', elapsed: null });
          }
        } else {
          // Stage 1 done, decision not yet taken — this IS the container's
          // current stage (Transportation's own clock hasn't started either,
          // since it waits on this same approval — see the i === 1 block above).
          const elapsed = now - doneAt.getTime();
          const overdue = apBudget ? elapsed > apBudget : false;
          perStage.approval.runningCount++;
          if (overdue) perStage.approval.runningOverdueCount++;
          perStage.approval.records.push({
            container: safeStr(row[0]), leaseId: safeStr(row[1]), clientName: safeStr(row[5]),
            status: overdue ? 'Running (Overdue)' : 'Running (On Time)',
            startedAt: doneAt.toISOString(), elapsed: humanize(elapsed), elapsedMs: elapsed, overdue
          });
          pipeline.push({ stage: 'approval', label: STAGE_META.approval.label, status: overdue ? 'current-overdue' : 'current-on-time', elapsed: humanize(elapsed) });
          currentStageNum = 'approval';
          currentOverdue = overdue;
        }
      }
    }

    // Second pass: "currently running" only applies to the container's TRUE
    // current stage — the first blank one in sequence. Every OTHER blank
    // stage after it hasn't been reached yet (or never will be, if it gets
    // bypassed) and isn't "stuck" in any meaningful sense — counting all of
    // them would multiply-count a single container across several stages.
    if (firstBlankIdx !== -1) {
      const s = OL_ACTIVE_STAGE_NUMS[firstBlankIdx];
      const budget = AUTO_BUDGET[s];
      if (startOfFirstBlank && budget) {
        const elapsed = now - startOfFirstBlank.getTime();
        const overdue = elapsed > budget;
        perStage[s].runningCount++;
        if (overdue) perStage[s].runningOverdueCount++;
        perStage[s].records.push({
          container: safeStr(row[0]),
          leaseId: safeStr(row[1]),
          clientName: safeStr(row[5]),
          status: overdue ? 'Running (Overdue)' : 'Running (On Time)',
          startedAt: startOfFirstBlank.toISOString(),
          elapsed: humanize(elapsed),
          elapsedMs: elapsed,
          overdue
        });
        currentStageNum = s;
        currentOverdue = overdue;
        pipeline[firstBlankIdx] = { stage: s, label: STAGE_META[s].label, status: overdue ? 'current-overdue' : 'current-on-time', elapsed: humanize(elapsed) };
      } else {
        // Blank, but its clock hasn't actually started yet (e.g. waiting on
        // approval) — genuinely nothing to report, not "current".
        pipeline[firstBlankIdx] = { stage: s, label: STAGE_META[s].label, status: 'not-started', elapsed: null };
      }
    }

    containers.push({
      container: safeStr(row[0]),
      leaseId: safeStr(row[1]),
      clientName: safeStr(row[5]),
      currentStage: currentStageNum,
      currentStageLabel: currentStageNum
        ? STAGE_META[currentStageNum].label
        : classified.stageClass === 'rejected' ? 'Rejected' : (classified.stageClass === 'done' ? 'Completed' : null),
      currentOverdue,
      anyPastOverdue,
      pipeline
    });

    // Throughput: the month Stage 8 (FMS Closure) completed — a full cycle.
    const stage8Info = OL_STAGE_INFO[8];
    const stage8Status = safeStr(row[stage8Info.statusCol]).trim();
    if (stage8Status !== '') {
      const doneAt = parseStamp(row[stage8Info.statusCol - 2]);
      if (doneAt) {
        const key = monthKey(doneAt);
        throughputByMonth.set(key, (throughputByMonth.get(key) || 0) + 1);
      }
    }
  }

  const buildStageRow = (s) => {
    const a = perStage[s];
    const avgMs = a.completedCount ? Math.round(a.totalElapsedMs / a.completedCount) : null;
    // Overdue-running first (most actionable), then everything else newest
    // first — a stage with 40 completions still leads with what needs
    // attention right now, not buried under history.
    const records = [...a.records].sort((x, y) => {
      if (x.overdue !== y.overdue) return x.overdue ? -1 : 1;
      return y.startedAt.localeCompare(x.startedAt);
    });
    // Overdue % — "how many times overdue happened, against every container
    // that has ever been through (or is currently sitting in) this stage",
    // explicitly requested as the headline number instead of on-time rate:
    // completed-late + currently-overdue-in-progress, over completed +
    // currently-in-progress. Distinct from onTimeRate (100 - onTimeRate is
    // NOT the same number) — onTimeRate only ever looks at completed
    // instances, this also counts a container sitting overdue RIGHT NOW even
    // though it hasn't finished the stage yet.
    const totalSeen = a.completedCount + a.runningCount;
    const totalOverdue = a.delayedCompletedCount + a.runningOverdueCount;
    const budgetMs = AUTO_BUDGET[s];

    /* BOTTLENECKS — who/what this stage's overrun (time PAST budget, not raw
     * elapsed) is concentrated in, grouped by client. Ranked by TOTAL overrun
     * contributed rather than by count: one client with a few very long
     * delays should outrank one with many barely-late visits, matching "time
     * lost" as the thing that actually costs the business. Explicit
     * 2026-09-02 request, modeled on a reference dashboard's stage -> owner/
     * vendor drill-down. This app has one FIXED owner per whole stage (not
     * per job-order, unlike that reference), so client is the meaningful
     * per-instance breakdown available here — the stage's own single owner
     * is already shown alongside the stage itself.
     */
    const byClient = new Map();
    if (budgetMs) {
      for (const r of a.records) {
        const name = r.clientName || 'Unknown';
        if (!byClient.has(name)) byClient.set(name, { clientName: name, count: 0, lateCount: 0, elapsed: [], overrun: [] });
        const c = byClient.get(name);
        c.count++;
        if (r.overdue) c.lateCount++;
        if (Number.isFinite(r.elapsedMs)) c.elapsed.push(r.elapsedMs);
        if (r.overdue && Number.isFinite(r.elapsedMs)) c.overrun.push(r.elapsedMs - budgetMs);
      }
    }
    const stageTotalOverrunMs = [...byClient.values()].reduce((sum, c) => sum + c.overrun.reduce((x, y) => x + y, 0), 0);
    const bottlenecks = [...byClient.values()]
      .filter((c) => c.lateCount > 0)
      .map((c) => {
        const sortedElapsed = [...c.elapsed].sort((x, y) => x - y);
        const totalOverrunMs = c.overrun.reduce((x, y) => x + y, 0);
        const avgOverrunMs = c.overrun.length ? Math.round(totalOverrunMs / c.overrun.length) : null;
        const avgMsHere = sortedElapsed.length ? Math.round(sortedElapsed.reduce((x, y) => x + y, 0) / sortedElapsed.length) : null;
        const medianMsHere = median(sortedElapsed);
        const p90MsHere = percentileOfSorted(sortedElapsed, 90);
        const worstMsHere = sortedElapsed.length ? sortedElapsed[sortedElapsed.length - 1] : null;
        return {
          name: c.clientName,
          role: 'client',
          count: c.count,
          lateCount: c.lateCount,
          totalOverrunMs,
          totalOverrun: humanize(totalOverrunMs),
          contributionPct: stageTotalOverrunMs ? Math.round((totalOverrunMs / stageTotalOverrunMs) * 1000) / 10 : 0,
          metrics: {
            avgMs: avgMsHere, avgTime: avgMsHere != null ? humanize(avgMsHere) : null,
            medianMs: medianMsHere, medianTime: medianMsHere != null ? humanize(medianMsHere) : null,
            p90Ms: p90MsHere, p90Time: p90MsHere != null ? humanize(p90MsHere) : null,
            worstMs: worstMsHere, worstTime: worstMsHere != null ? humanize(worstMsHere) : null,
            avgOverrunMs, avgOverrun: avgOverrunMs != null ? humanize(avgOverrunMs) : null,
            totalOverrunMs, totalOverrun: humanize(totalOverrunMs),
            targetMs: budgetMs, target: budgetLabel(budgetMs)
          }
        };
      })
      .sort((x, y) => y.totalOverrunMs - x.totalOverrunMs);

    return {
      stage: s,
      label: a.label,
      owner: a.owner,
      budget: budgetLabel(AUTO_BUDGET[s]),
      // 'auto' = this stage's own historical median (real completions only);
      // 'default' = no completions yet to calibrate from, still the fixed
      // SLA_MS fallback — surfaced so a still-near-100% stage reads as "no
      // history yet" rather than another unexplained anomaly.
      budgetSource: BUDGET_SOURCE[s],
      budgetSampleSize: BUDGET_SAMPLES[s],
      completedCount: a.completedCount,
      avgTurnaround: avgMs != null ? humanize(avgMs) : null,
      avgTurnaroundMs: avgMs,
      delayedCompletedCount: a.delayedCompletedCount,
      onTimeRate: a.completedCount ? Math.round(((a.completedCount - a.delayedCompletedCount) / a.completedCount) * 100) : null,
      overduePct: totalSeen ? Math.round((totalOverdue / totalSeen) * 100) : null,
      runningCount: a.runningCount,
      runningOverdueCount: a.runningOverdueCount,
      // "Late X of Y" and cumulative time lost — the stage-modal header.
      lateCount: totalOverdue,
      totalCount: totalSeen,
      timeLostMs: stageTotalOverrunMs,
      timeLost: humanize(stageTotalOverrunMs),
      bottlenecks,
      records
    };
  };

  // The Approval gate sits between Stage 1 and Transportation in the real
  // workflow (OL_ACTIVE_STAGE_NUMS[0] is always 1, [1] is always the stage
  // that waits on it), so it's spliced into that exact position rather than
  // appended — every stage the page shows, in true pipeline order, not just
  // the ones that have their own OL_STAGE_INFO column range.
  const numberedStages = OL_ACTIVE_STAGE_NUMS.map(buildStageRow);
  const stages = [numberedStages[0], buildStageRow('approval'), ...numberedStages.slice(1)];

  // "All Stages" — one blended number across the whole pipeline, not a
  // stage in its own right (no owner, no single SLA budget), so it's kept
  // separate from `stages` rather than spliced in: the bottleneck table,
  // owner grouping, and per-container "current stage" matching below all
  // assume every entry in `stages` is a real, clickable, ownable step, and
  // an aggregate doesn't fit any of those without special-casing them.
  const overallTotals = stages.reduce((acc, s) => ({
    completedCount: acc.completedCount + s.completedCount,
    runningCount: acc.runningCount + s.runningCount,
    delayedCompletedCount: acc.delayedCompletedCount + s.delayedCompletedCount,
    runningOverdueCount: acc.runningOverdueCount + s.runningOverdueCount,
    totalElapsedMs: acc.totalElapsedMs + (s.avgTurnaroundMs != null ? s.avgTurnaroundMs * s.completedCount : 0)
  }), { completedCount: 0, runningCount: 0, delayedCompletedCount: 0, runningOverdueCount: 0, totalElapsedMs: 0 });
  const overallSeen = overallTotals.completedCount + overallTotals.runningCount;
  const overallOverdue = overallTotals.delayedCompletedCount + overallTotals.runningOverdueCount;
  const overall = {
    label: 'All Stages',
    completedCount: overallTotals.completedCount,
    runningCount: overallTotals.runningCount,
    delayedCompletedCount: overallTotals.delayedCompletedCount,
    runningOverdueCount: overallTotals.runningOverdueCount,
    onTimeRate: overallTotals.completedCount ? Math.round(((overallTotals.completedCount - overallTotals.delayedCompletedCount) / overallTotals.completedCount) * 100) : null,
    overduePct: overallSeen ? Math.round((overallOverdue / overallSeen) * 100) : null,
    avgTurnaround: overallTotals.completedCount ? humanize(Math.round(overallTotals.totalElapsedMs / overallTotals.completedCount)) : null
  };

  // Bottleneck ranking — most currently-overdue-in-progress first, ties
  // broken by worst historical on-time rate. "Where delays concentrate
  // RIGHT NOW", not just a historical average.
  const bottlenecks = [...stages]
    .filter((s) => s.runningCount > 0 || s.completedCount > 0)
    .sort((a, b) => {
      if (b.runningOverdueCount !== a.runningOverdueCount) return b.runningOverdueCount - a.runningOverdueCount;
      const aRate = a.onTimeRate ?? 100;
      const bRate = b.onTimeRate ?? 100;
      return aRate - bRate;
    });

  // Owner performance — same per-stage numbers, grouped by who owns each
  // stage (a stage number maps to exactly one owner, so this is a straight
  // re-key, not a second pass over the rows).
  const byOwner = {};
  for (const s of stages) {
    if (!byOwner[s.owner]) byOwner[s.owner] = { owner: s.owner, stages: [], completedCount: 0, delayedCompletedCount: 0, runningOverdueCount: 0, totalElapsedMs: 0 };
    const o = byOwner[s.owner];
    o.stages.push(s.label);
    o.completedCount += s.completedCount;
    o.delayedCompletedCount += s.delayedCompletedCount;
    o.runningOverdueCount += s.runningOverdueCount;
    o.totalElapsedMs += s.avgTurnaroundMs != null ? s.avgTurnaroundMs * s.completedCount : 0;
  }
  const owners = Object.values(byOwner).map((o) => ({
    owner: o.owner,
    stages: o.stages,
    completedCount: o.completedCount,
    onTimeRate: o.completedCount ? Math.round(((o.completedCount - o.delayedCompletedCount) / o.completedCount) * 100) : null,
    avgTurnaround: o.completedCount ? humanize(Math.round(o.totalElapsedMs / o.completedCount)) : null,
    runningOverdueCount: o.runningOverdueCount
  })).sort((a, b) => (a.onTimeRate ?? 100) - (b.onTimeRate ?? 100));

  const throughput = [...throughputByMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12) // last 12 months with any completions
    .map(([key, count]) => ({ month: key, label: monthLabel(key), count }));

  // Containers table — bottleneck-relevant ones first (currently overdue, or
  // carrying a past-overdue stage on its record), then the rest by container
  // number so the list is at least stable across reloads.
  containers.sort((a, b) => {
    const aFlag = (a.currentOverdue ? 2 : 0) + (a.anyPastOverdue ? 1 : 0);
    const bFlag = (b.currentOverdue ? 2 : 0) + (b.anyPastOverdue ? 1 : 0);
    if (bFlag !== aFlag) return bFlag - aFlag;
    return a.container.localeCompare(b.container);
  });

  return {
    containersConsidered,
    overall,
    stages,
    bottlenecks,
    owners,
    throughput,
    containers
  };
}
