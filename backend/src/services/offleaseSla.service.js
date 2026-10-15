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

/**
 * Computes the SAME SLA figures the Container Lookup screen shows, for one
 * container, from ONE place — used by both offlease.controller.js's
 * getContainerDetail and slaEscalation.service.js's scanner, so the numbers
 * an escalation email quotes always match what a human looking the
 * container up sees. (Issue #55, "L7 TAT, backups, escalation": "Extract
 * the lookup's SLA block ... used by both the controller and the scanner so
 * the figures match the screen.")
 *
 * This is exactly the block that used to live inline in the controller
 * (~lines 419-432): fetch the entry stamp, then applySla(detail.stages, ...).
 *
 * @param containerNo
 * @param opts.leaseId   optional — picks one record when a container has
 *                        more than one off-lease cycle (see
 *                        getOffLeaseContainerDetail's own doc comment).
 * @param opts.user       optional — req.user for scope-gated callers (the
 *                        controller). Omitted (undefined) by the scanner, the
 *                        same "unscoped, every row" convention
 *                        leaseExpiryDigest.service.js/monthlyReport.service.js
 *                        already use for their own whole-company background
 *                        reads.
 * @param opts.detail     optional — an ALREADY-FETCHED detail object (what
 *                        the controller has from its own
 *                        getOffLeaseContainerDetail call, a few lines above
 *                        where this used to be inlined). Passing it avoids a
 *                        second Mongo-mirror read and — critically — means
 *                        the `.sla` this function attaches to each stage
 *                        lands on the SAME object the controller already
 *                        holds, not a throwaway copy. The scanner has no
 *                        pre-fetched detail, so it omits this and the
 *                        function fetches its own.
 *
 * getOffLeaseContainerDetail/getOffLeaseEntryStamp are imported with a
 * dynamic import() rather than a static one at the top of this file:
 * offlease.service.js already has a STATIC `import { SLA_MS, parseStamp,
 * humanize, budgetLabel } from './offleaseSla.service.js'` (line 89) — a
 * static import back the other way would make the two files load each
 * other, and this file's own exports are read by offlease.service.js at
 * MODULE-EVALUATION time (e.g. `const approvalBudget = SLA_MS.approval;` at
 * its line 5959, outside any function). A dynamic import here only resolves
 * the far side when computeContainerSla actually RUNS, after both modules
 * have finished loading, so the cycle never has to resolve synchronously.
 * Same escape hatch offlease.controller.js's own getOutstanding handler
 * already uses for accountsApi.service.js.
 */
export async function computeContainerSla(containerNo, opts = {}) {
  const { leaseId, user, detail: providedDetail } = opts;

  let detail = providedDetail;
  if (!detail) {
    const { getOffLeaseContainerDetail } = await import('./offlease.service.js');
    detail = await getOffLeaseContainerDetail(containerNo, leaseId, user);
  }

  const result = {
    found: !!detail?.found,
    multiple: !!detail?.multiple,
    detail,
    approvalSla: null,
    delayedCount: 0,
    anyDelayed: false
  };
  if (!detail?.found || detail?.multiple) return result;

  try {
    const { getOffLeaseEntryStamp } = await import('./offlease.service.js');
    const entryStamp = await getOffLeaseEntryStamp(containerNo);
    const sla = applySla(detail.stages || [], {
      entryStamp: entryStamp || detail.deployedDate,
      approvalStatus: detail.approvalStatus,
      approvalDate: detail.approvalDate
    });
    result.approvalSla = sla.approvalSla;
    result.delayedCount = sla.delayedCount;
    result.anyDelayed = sla.anyDelayed;
  } catch (e) { /* timers are additive — never fail the lookup over them */ }

  return result;
}

/* =====================================================================
   L7 — SLA ESCALATION ROUTING (Issue #55)

   Who gets told when a stage breaches its SLA_MS budget, keyed the SAME way
   as SLA_MS so every stage that has a budget also has a routing row: 1,
   'approval', 6, 7, 3, 5, 8.

   STAGE_OWNERS (offleaseEfficiency.service.js, ~line 107) has owner NAMES
   per stage but no email addresses, and there is no existing name->email
   map for off-lease stage owners anywhere in this codebase (confirmed —
   salePersonAccess.service.js's map is for sales reps' Lease Expiry
   assignments, a different population entirely). Every address below is a
   PLACEHOLDER — TODO-owner-stage<N>@crystalgroup.in / -backup- / -manager- —
   until someone supplies the real inboxes. Swap them in `_runtime_config`
   (below) or edit the defaults here; either way nothing else in this file
   needs to change.
===================================================================== */

/** 1 working day. The issue left this as an open choice (8h vs 24h
 *  wall-clock) — 8h is picked here: every desk stage's own SLA_MS budget is
 *  1 HOUR, so a 24h grace would mean a stage can run 24x its own budget late
 *  before a backup is even told, which defeats the point of an escalation
 *  safety net for exactly the stages (1, approval, 7, 3, 5, 8) this matters
 *  most for. 8h = one working day's length also lines up with the
 *  "Sundays off" working-day calendar just below. Transportation (stage 6,
 *  budget 2 DAYS) escalates on the same 8h grace as everything else —
 *  deliberately: a 2-day stage that is ALREADY over budget losing another
 *  working day before anyone but the owner hears about it is not a smaller
 *  problem than a 1-hour desk stage doing the same. */
export const SLA_GRACE_MS = 8 * HOUR;

/** Placeholder routing, overridable via `_runtime_config` (see
 *  getSlaRouting below). `ceo` is present on every row — the shape the
 *  issue asks for — but is never selected by classifyBreachLevel: the CEO
 *  level is an explicit open question in the issue ("not activated this
 *  month") with no defined escalation threshold, so there is nothing for it
 *  to trigger on yet. Flipping `featureFlags.slaEscalationCeo` on alone does
 *  nothing until a real CEO threshold is designed and classifyBreachLevel
 *  is extended to produce it. */
export const SLA_ROUTING = {
  // Owner addresses below (2026-10-14): Christopher's confirmed directly by
  // the department owner; the rest were looked up against the login/accounts
  // system by a separate session (this one has no Mongo egress to verify
  // them itself) and spot-checked against real addresses already on record
  // in migrate-legacy-permissions.mjs (pushpa.shetty / shivani.dhall match).
  // backup/manager are NOT in any system (no owner/manager hierarchy is
  // tracked anywhere) and stay TODO until supplied from the org chart.
  1: {
    owner: 'crm@crystalgroup.in',              // Christopher
    backup: 'TODO-backup-stage1@crystalgroup.in',
    manager: 'TODO-manager-stage1@crystalgroup.in',
    ceo: null
  },
  approval: {
    owner: 'pushpa.shetty@crystalgroup.in',    // Pushpa
    backup: 'TODO-backup-approval@crystalgroup.in',
    manager: 'TODO-manager-approval@crystalgroup.in',
    ceo: null
  },
  6: {
    owner: 'kshirod.khatua@crystalgroup.in',   // Kshirod Khatua
    backup: 'TODO-backup-stage6@crystalgroup.in',
    manager: 'TODO-manager-stage6@crystalgroup.in',
    ceo: null
  },
  7: {
    owner: 'mum.depot@crystalgroup.in',        // Pritam — shared depot inbox, not personal
    backup: 'TODO-backup-stage7@crystalgroup.in',
    manager: 'TODO-manager-stage7@crystalgroup.in',
    ceo: null
  },
  3: {
    owner: 'service@crystalgroup.in',          // Sitaram — shared inbox, not personal
    backup: 'TODO-backup-stage3@crystalgroup.in',
    manager: 'TODO-manager-stage3@crystalgroup.in',
    ceo: null
  },
  5: {
    owner: 'shivani.dhall@crystalgroup.in',    // Shivani
    backup: 'TODO-backup-stage5@crystalgroup.in',
    manager: 'TODO-manager-stage5@crystalgroup.in',
    ceo: null
  },
  8: {
    // Unassigned — no owner exists anywhere (STAGE_OWNERS[8] === 'Unassigned'
    // too). Left as TODO on purpose: isPlaceholderOrMissing() will route this
    // to the admin-missing-config alert instead of emailing nobody.
    owner: 'TODO-owner-stage8@crystalgroup.in',
    backup: 'TODO-backup-stage8@crystalgroup.in',
    manager: 'TODO-manager-stage8@crystalgroup.in',
    ceo: null
  }
};

const SLA_ROUTING_COLLECTION = '_runtime_config';
const SLA_ROUTING_ID = 'slaRouting';

/**
 * SLA_ROUTING, with any `_runtime_config` override merged on top — same
 * "a real config value always wins, code default fills the rest" posture as
 * runtimeSecrets.js, applied per stage/per level instead of per top-level
 * key so overriding just one address (e.g. stage 7's backup) doesn't require
 * restating the whole table in Mongo.
 *
 * Collection "_runtime_config", one document (`_id: 'slaRouting'`),
 * shaped like SLA_ROUTING itself: `{ "7": { "backup": "real@address" } }`.
 * Never throws — a Mongo read failure here just means the code defaults
 * (TODO placeholders) are used, exactly like before this override existed.
 */
export async function getSlaRouting() {
  const merged = {};
  for (const key of Object.keys(SLA_ROUTING)) merged[key] = { ...SLA_ROUTING[key] };
  try {
    const { getCollection } = await import('./mongo.service.js');
    const doc = await getCollection(SLA_ROUTING_COLLECTION).findOne({ _id: SLA_ROUTING_ID });
    if (doc) {
      for (const key of Object.keys(merged)) {
        if (doc[key] && typeof doc[key] === 'object') merged[key] = { ...merged[key], ...doc[key] };
      }
    }
  } catch (e) {
    // Best-effort, same as runtimeSecrets.js — degrade to the code defaults.
  }
  return merged;
}

/** TODO-* placeholder (unconfigured) or blank/null -> treated as "missing"
 *  so TC-L7-5 (missing owner/backup config) fires instead of silently
 *  emailing a fake inbox. */
export function isPlaceholderOrMissing(address) {
  if (!address || typeof address !== 'string') return true;
  return address.trim() === '' || address.trim().toUpperCase().startsWith('TODO-');
}

/**
 * Elapsed time between two Dates, EXCLUDING any time that falls on a Sunday
 * — the "Sundays off" working-day calendar the issue's open question asks
 * for, applied by walking day-by-day and zeroing out each Sunday's own
 * contribution rather than special-casing the start/end dates. Pure, no
 * Date.now() — same testability reasoning as the rest of this file.
 */
export function workingMsBetween(start, end) {
  if (!(start instanceof Date) || !(end instanceof Date)) return 0;
  if (!(end.getTime() > start.getTime())) return 0;

  let total = 0;
  let cursor = start;
  while (cursor.getTime() < end.getTime()) {
    const dayEnd = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1, 0, 0, 0, 0);
    const segEnd = dayEnd.getTime() < end.getTime() ? dayEnd : end;
    if (cursor.getDay() !== 0) total += segEnd.getTime() - cursor.getTime(); // 0 = Sunday
    cursor = segEnd;
  }
  return total;
}

/**
 * Which escalation level (if any) a RUNNING, DELAYED stage's own `sla`
 * object (as attached by applySla) is currently at, measured in WORKING
 * time past `dueAt` (Sundays excluded — see workingMsBetween). Pure: takes
 * `now` as a parameter rather than reading Date.now() itself, exactly so it
 * can be unit tested without faking the clock.
 *
 * A stage that is done (sla.running === false) never returns a level, even
 * if it finished late (sla.delayed can still be true for a late finish) —
 * TC-L7-3: completed stages get no further reminders.
 *
 * CEO is deliberately never returned — see SLA_ROUTING's own doc comment.
 *
 * @returns {'owner'|'backup'|'manager'|null}
 */
export function classifyBreachLevel(sla, { graceMs = SLA_GRACE_MS, now = new Date() } = {}) {
  if (!sla || !sla.running || !sla.delayed) return null;
  const dueAt = new Date(sla.dueAt);
  const nowDate = now instanceof Date ? now : new Date(now);
  if (!(nowDate.getTime() > dueAt.getTime())) return null;

  const workingPastDue = workingMsBetween(dueAt, nowDate);
  if (workingPastDue >= 2 * graceMs) return 'manager';
  if (workingPastDue >= graceMs) return 'backup';
  return 'owner';
}

/** 75% of a stage's own budget elapsed, but NOT YET delayed — a different,
 *  earlier signal than a breach (see this file's own doc comment at the top
 *  of slaEscalation.service.js for why this exists: the issue's test table
 *  names a reminder the issue's "Technical approach" section never actually
 *  describes a mechanism for). Fires once per stage cycle (deduped in
 *  Mongo by startedAt, same as every other level) — TC-L7-1.
 *
 * @returns {boolean}
 */
export function isSlaReminderDue(sla, { ratio = 0.75, now = new Date() } = {}) {
  if (!sla || !sla.running || sla.delayed) return false;
  if (!Number.isFinite(sla.budgetMs) || sla.budgetMs <= 0) return false;
  const nowDate = now instanceof Date ? now : new Date(now);
  const started = new Date(sla.startedAt);
  if (isNaN(started.getTime())) return false;
  const elapsed = nowDate.getTime() - started.getTime();
  return elapsed >= ratio * sla.budgetMs;
}
