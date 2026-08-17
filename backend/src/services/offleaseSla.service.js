/**
 * OFF-LEASE STAGE SLA / TIMERS
 *
 * Each stage has a time budget. The clock for a stage starts when the PREVIOUS
 * step finished — that is the moment the work became actionable — and stops
 * when the stage itself completes. A stage still running is measured against
 * "now", so a breach is visible while it is happening rather than only in
 * hindsight.
 *
 * Computed at READ time and never written to the sheet. Off-Lease Tracking
 * currently has 212 columns where the code expects 289, so a positional write
 * to any stage column would land in the wrong place; and an SLA is derived
 * from timestamps that are already recorded, so storing it would be a second
 * copy that can disagree with them.
 */
import { safeStr } from '../utils/format.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Budget per step, keyed by INTERNAL stage number ('approval' for the gate).
 * Internal numbers are the stage's identity; display numbers renumber.
 *
 * Transportation is the only step measured in days — a container physically
 * moves. Everything else is desk work with a one-hour turnaround.
 */
export const SLA_MS = {
  1: 1 * HOUR,          // Off-Lease Intimation
  approval: 1 * HOUR,   // Intimation Approval
  6: 2 * DAY,           // Transportation — the only multi-day step
  7: 1 * HOUR,          // Gate In
  3: 1 * HOUR,          // Inspection Checklist
  5: 1 * HOUR,          // Billing Reconciliation
  8: 1 * HOUR           // FMS Closure
};

/** "1h", "2d" — the budget itself, for a column header or a TAT cell. */
export function budgetLabel(ms) {
  if (!ms) return '';
  return ms >= DAY ? `${Math.round(ms / DAY)}d` : `${Math.round(ms / HOUR)}h`;
}

/** "dd/MM/yyyy HH:mm:ss" (and the date-only form) -> Date, or null.
 *  Parsed by component: Date() reads dd/MM as MM/dd and would silently shift
 *  every day <= 12 into another month. */
export function parseStamp(v) {
  const s = safeStr(v).trim();
  if (!s) return null;

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ]?(\d{2})?:?(\d{2})?:?(\d{2})?/);
  if (iso) {
    return new Date(+iso[1], +iso[2] - 1, +iso[3], +(iso[4] || 0), +(iso[5] || 0), +(iso[6] || 0));
  }
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const d = new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  return isNaN(d.getTime()) ? null : d;
}

/** "2h 15m", "3d 4h" — an elapsed time a person can read at a glance. */
export function humanize(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const mins = Math.floor(ms / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Attaches an `sla` object to each stage, plus the approval gate.
 *
 * @param stages  the detail endpoint's stages[] (mutated in place)
 * @param ctx.entryStamp     when the container entered Stage 1 — starts the
 *                           first clock, since nothing precedes it
 * @param ctx.approvalStatus / ctx.approvalDate   the gate
 *
 * Returns a summary so a caller can badge a row without re-walking the stages.
 */
export function applySla(stages, ctx = {}) {
  const now = Date.now();
  const order = stages.map((s) => s.stage);

  /* When each step's clock STARTS: the moment the previous step finished.
     Stage 1 has nothing before it, so it starts when the container entered. */
  const approvalDone = String(ctx.approvalStatus || '').trim().toLowerCase() === 'approved'
    ? parseStamp(ctx.approvalDate)
    : null;

  const startFor = (stage) => {
    if (stage === order[0]) return parseStamp(ctx.entryStamp);
    /* The gate sits between Stage 1 and the stage after it, so that stage
       waits on the APPROVAL, not on Stage 1's completion. */
    if (stage === order[1]) return approvalDone;
    const prev = stages[order.indexOf(stage) - 1];
    return parseStamp(prev?.timestamp);
  };

  const build = (budget, start, doneAt) => {
    if (!budget || !start) return null;                 // no budget or not started yet
    const end = doneAt || new Date(now);
    const elapsed = end.getTime() - start.getTime();
    return {
      startedAt: start.toISOString(),
      budgetMs: budget,
      elapsedMs: elapsed,
      elapsed: humanize(elapsed),
      dueAt: new Date(start.getTime() + budget).toISOString(),
      running: !doneAt,
      delayed: elapsed > budget,
      /* Overdue BY how much — "delayed" alone does not say whether it slipped
         by a minute or a week. */
      overdueBy: elapsed > budget ? humanize(elapsed - budget) : ''
    };
  };

  let delayedCount = 0;

  for (const s of stages) {
    const budget = SLA_MS[s.stage];
    s.sla = build(budget, startFor(s.stage), s.done ? parseStamp(s.timestamp) : null);
    if (s.sla?.delayed) delayedCount++;
  }

  /* The gate is not a stage, so it carries its own timer: it starts when
     Stage 1 completes and ends when the decision was taken. */
  const stage1 = stages.find((s) => s.stage === order[0]);
  const approvalSla = build(SLA_MS.approval, parseStamp(stage1?.timestamp), approvalDone);
  if (approvalSla?.delayed) delayedCount++;

  return { approvalSla, delayedCount, anyDelayed: delayedCount > 0 };
}
