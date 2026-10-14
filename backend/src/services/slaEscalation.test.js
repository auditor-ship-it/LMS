/**
 * L7 SLA Escalation — unit tests for the PURE calculation/config functions
 * (classifyBreachLevel, isSlaReminderDue, workingMsBetween,
 * isPlaceholderOrMissing from offleaseSla.service.js; buildAlertDoc,
 * resolveRecipients from slaEscalation.service.js). Node's built-in test
 * runner — no new dependency for one test file, same house style as
 * offleaseEfficiencyEngine.test.js.
 *
 * Run: node --test src/services/slaEscalation.test.js
 *
 * runSlaEscalation/computeContainerSla themselves are NOT unit tested here —
 * they do live I/O (Mongo mirror reads, SMTP sends, Mongo inserts) with no
 * mocking layer in this repo, exactly the same reasoning
 * offleaseEfficiencyEngine.test.js's own header gives for punting
 * calculateContainerEfficiency/getOffLeaseEfficiencyReport to a
 * reconciliation script instead of a unit test. In particular, TC-L7-4's
 * "no duplicate sends across 3 runs" is a Mongo UNIQUE INDEX behavior
 * (insertOne on _sla_alerts either succeeds once or throws E11000 on every
 * repeat) — this file tests that the dedup KEY fed into that insert is
 * stable/deterministic for unchanged input (buildAlertDoc), not the actual
 * insert-rejection, which needs a real MongoDB connection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SLA_MS,
  SLA_GRACE_MS,
  SLA_ROUTING,
  classifyBreachLevel,
  isSlaReminderDue,
  isPlaceholderOrMissing,
  workingMsBetween
} from './offleaseSla.service.js';
import { buildAlertDoc, resolveRecipients } from './slaEscalation.service.js';

const HOUR = 60 * 60 * 1000;

// A fixed Monday, so grace-period math below never has to think about
// Sunday — workingMsBetween's own Sunday-skip is tested separately below.
const MONDAY = new Date(2026, 0, 5, 9, 0, 0, 0); // 2026-01-05 09:00, confirmed Monday
assert.equal(MONDAY.getDay(), 1, 'sanity check: 2026-01-05 must be a Monday for the rest of this file\'s assumptions to hold');

function runningDelayedSla({ dueAt, startedAt, budgetMs = HOUR }) {
  return { running: true, delayed: true, dueAt: dueAt.toISOString(), startedAt: (startedAt || dueAt).toISOString(), budgetMs, elapsedMs: budgetMs + 1, overdueBy: '1m' };
}

// ---------------------------------------------------------------------
// TC-L7-1 — owner gets exactly one reminder at 75% of TAT (not delayed)
//
// The issue's own test table names this reminder, but its "Technical
// approach" section only ever designs owner/backup/manager-AT-BREACH
// levels — there is no described mechanism for a pre-breach reminder at
// all. That is an inconsistency in the issue as written. Resolved by
// building isSlaReminderDue as a separate, earlier signal (NOT a 4th
// breach level) rather than dropping TC-L7-1 or stretching
// classifyBreachLevel to also cover "not yet late".
// ---------------------------------------------------------------------
test('TC-L7-1 — isSlaReminderDue fires at 75% of budget elapsed, not before, never once delayed', () => {
  const budgetMs = HOUR;
  const startedAt = new Date(MONDAY.getTime() - Math.round(budgetMs * 0.75));
  const at75 = { running: true, delayed: false, startedAt: startedAt.toISOString(), budgetMs };
  assert.equal(isSlaReminderDue(at75, { now: MONDAY }), true);

  const just74 = { running: true, delayed: false, startedAt: new Date(MONDAY.getTime() - Math.round(budgetMs * 0.75) + 60000).toISOString(), budgetMs };
  assert.equal(isSlaReminderDue(just74, { now: MONDAY }), false);

  // Already delayed -> this is a breach, not a reminder; isSlaReminderDue
  // must defer entirely to classifyBreachLevel for that case.
  const delayed = { running: true, delayed: true, startedAt: startedAt.toISOString(), budgetMs };
  assert.equal(isSlaReminderDue(delayed, { now: MONDAY }), false);

  // "Exactly one" is enforced by the Mongo unique index on
  // (containerNo, offLeaseId, stage, startedAt, level) — not re-provable
  // without a real Mongo connection, but the dedup KEY fed into that index
  // must itself be identical across repeat calls for the identical input,
  // which IS provable here:
  const docA = buildAlertDoc({ containerNo: 'ABCU1234567', offLeaseId: 'LEASE0001', stage: 1, startedAt: startedAt.toISOString(), level: 'reminder', to: 'owner@example.com' });
  const docB = buildAlertDoc({ containerNo: 'ABCU1234567', offLeaseId: 'LEASE0001', stage: 1, startedAt: startedAt.toISOString(), level: 'reminder', to: 'owner@example.com' });
  assert.deepEqual(
    { containerNo: docA.containerNo, offLeaseId: docA.offLeaseId, stage: docA.stage, startedAt: docA.startedAt, level: docA.level },
    { containerNo: docB.containerNo, offLeaseId: docB.offLeaseId, stage: docB.stage, startedAt: docB.startedAt, level: docB.level }
  );
});

// ---------------------------------------------------------------------
// TC-L7-2 — breach -> owner, then backup once past one grace period, then
// manager once past a second grace period (cumulative escalation chain).
// ---------------------------------------------------------------------
test('TC-L7-2 — owner at breach, backup after SLA_GRACE_MS, manager after 2x SLA_GRACE_MS', () => {
  const dueAt = MONDAY;

  const justBreached = runningDelayedSla({ dueAt, startedAt: new Date(dueAt.getTime() - HOUR) });
  assert.equal(classifyBreachLevel(justBreached, { now: new Date(dueAt.getTime() + 60000) }), 'owner');

  const pastOneGrace = runningDelayedSla({ dueAt, startedAt: new Date(dueAt.getTime() - HOUR) });
  assert.equal(classifyBreachLevel(pastOneGrace, { now: new Date(dueAt.getTime() + SLA_GRACE_MS) }), 'backup');

  // One minute before the grace boundary is still 'owner', not 'backup'.
  const justBeforeGrace = runningDelayedSla({ dueAt, startedAt: new Date(dueAt.getTime() - HOUR) });
  assert.equal(classifyBreachLevel(justBeforeGrace, { now: new Date(dueAt.getTime() + SLA_GRACE_MS - 60000) }), 'owner');

  const pastTwoGrace = runningDelayedSla({ dueAt, startedAt: new Date(dueAt.getTime() - HOUR) });
  assert.equal(classifyBreachLevel(pastTwoGrace, { now: new Date(dueAt.getTime() + 2 * SLA_GRACE_MS) }), 'manager');

  // Distinct dedup keys per level -> each escalation step is a SEPARATE
  // _sla_alerts row (so the owner alert already sent is never clobbered by
  // the later backup/manager alert — all three can coexist for one stage
  // cycle, which is exactly the "owner+backup, then manager" progression).
  const startedAtIso = new Date(dueAt.getTime() - HOUR).toISOString();
  const ownerDoc = buildAlertDoc({ containerNo: 'X', offLeaseId: 'L', stage: 7, startedAt: startedAtIso, level: 'owner', to: 'a' });
  const backupDoc = buildAlertDoc({ containerNo: 'X', offLeaseId: 'L', stage: 7, startedAt: startedAtIso, level: 'backup', to: 'b' });
  const managerDoc = buildAlertDoc({ containerNo: 'X', offLeaseId: 'L', stage: 7, startedAt: startedAtIso, level: 'manager', to: 'c' });
  const keys = new Set([ownerDoc, backupDoc, managerDoc].map((d) => `${d.containerNo}|${d.offLeaseId}|${d.stage}|${d.startedAt}|${d.level}`));
  assert.equal(keys.size, 3);
});

// ---------------------------------------------------------------------
// TC-L7-3 — completed stage -> no further reminders, however late it
// finished.
// ---------------------------------------------------------------------
test('TC-L7-3 — a DONE stage (running: false) never escalates, even if it finished late', () => {
  const dueAt = MONDAY;
  const completedLate = {
    running: false, // the stage is done
    delayed: true,  // ...but it finished AFTER its own budget
    dueAt: dueAt.toISOString(),
    startedAt: new Date(dueAt.getTime() - HOUR).toISOString(),
    budgetMs: HOUR
  };
  assert.equal(classifyBreachLevel(completedLate, { now: new Date(dueAt.getTime() + 5 * SLA_GRACE_MS) }), null);

  // Not running and not delayed either (finished on time) -> also null,
  // the ordinary case.
  const completedOnTime = { running: false, delayed: false, dueAt: dueAt.toISOString(), startedAt: dueAt.toISOString(), budgetMs: HOUR };
  assert.equal(classifyBreachLevel(completedOnTime, { now: new Date(dueAt.getTime() + 5 * SLA_GRACE_MS) }), null);
});

// ---------------------------------------------------------------------
// TC-L7-4 — 3 consecutive runs, no change -> no duplicate sends.
// Pure-logic slice: classifyBreachLevel is deterministic for unchanged
// input (same level each run) AND the dedup key it would be inserted
// under is byte-identical across repeats — together, that's exactly what
// lets the Mongo unique index block every repeat after the first. The
// actual blocking (an E11000 on the 2nd/3rd insertOne) needs a live Mongo
// connection and is NOT exercised here — see this file's header.
// ---------------------------------------------------------------------
test('TC-L7-4 — identical sla/now across 3 calls yields the identical level and the identical dedup key', () => {
  const dueAt = MONDAY;
  const startedAt = new Date(dueAt.getTime() - HOUR);
  const now = new Date(dueAt.getTime() + SLA_GRACE_MS + HOUR);

  const levels = [1, 2, 3].map(() => classifyBreachLevel(runningDelayedSla({ dueAt, startedAt }), { now }));
  assert.deepEqual(levels, ['backup', 'backup', 'backup']);

  const keys = [1, 2, 3].map(() => {
    const d = buildAlertDoc({ containerNo: 'MSCU7654321', offLeaseId: 'LEASE0099', stage: 3, startedAt: startedAt.toISOString(), level: 'backup', to: 'x@example.com' });
    return `${d.containerNo}|${d.offLeaseId}|${d.stage}|${d.startedAt}|${d.level}`;
  });
  assert.equal(new Set(keys).size, 1, 'the same (containerNo, offLeaseId, stage, startedAt, level) tuple must be produced every run, or the unique index could not dedup it');
});

// ---------------------------------------------------------------------
// TC-L7-5 — missing owner/backup config -> detected, never crashes.
// resolveRecipients returning null is what runSlaEscalation's own loop
// (slaEscalation.service.js) uses to log an error and queue ONE admin
// alert, then `continue` to the next stage/container rather than throw.
// ---------------------------------------------------------------------
test('TC-L7-5 — resolveRecipients returns null for an unconfigured stage or a still-placeholder address', () => {
  // Stage key not present in the routing table at all.
  assert.equal(resolveRecipients({}, 7, 'owner'), null);

  // Stage present, but this level's address was never swapped from the
  // TODO-* placeholder (the default shipped state of every real row today).
  const placeholderRouting = { 7: { owner: 'TODO-owner-stage7@crystalgroup.in', backup: 'TODO-backup-stage7@crystalgroup.in', manager: 'TODO-manager-stage7@crystalgroup.in', ceo: null } };
  assert.equal(resolveRecipients(placeholderRouting, 7, 'owner'), null);
  assert.equal(resolveRecipients(placeholderRouting, 7, 'backup'), null);

  // A real address configured -> resolves normally, with the owner cc'd
  // once escalation reaches backup/manager.
  const realRouting = { 7: { owner: 'pritam@crystalgroup.in', backup: 'backup7@crystalgroup.in', manager: 'manager7@crystalgroup.in', ceo: null } };
  assert.deepEqual(resolveRecipients(realRouting, 7, 'owner'), { to: 'pritam@crystalgroup.in', cc: [] });
  assert.deepEqual(resolveRecipients(realRouting, 7, 'backup'), { to: 'backup7@crystalgroup.in', cc: ['pritam@crystalgroup.in'] });
  assert.deepEqual(resolveRecipients(realRouting, 7, 'manager'), { to: 'manager7@crystalgroup.in', cc: ['pritam@crystalgroup.in', 'backup7@crystalgroup.in'] });
});

test('SLA_ROUTING covers every SLA_MS stage key with owner/backup/manager/ceo slots (every address a TODO placeholder today)', () => {
  for (const key of Object.keys(SLA_MS)) {
    const row = SLA_ROUTING[key];
    assert.ok(row, `SLA_ROUTING is missing stage "${key}"`);
    assert.ok(isPlaceholderOrMissing(row.owner), `expected a TODO placeholder for stage ${key} owner until real addresses are supplied`);
    assert.ok(isPlaceholderOrMissing(row.backup));
    assert.ok(isPlaceholderOrMissing(row.manager));
    assert.equal(row.ceo, null, 'CEO level is an open question, not activated this month — see offleaseSla.service.js\'s own doc comment');
  }
});

test('workingMsBetween — Sunday contributes zero elapsed working time (the "Sundays off" calendar choice)', () => {
  // Saturday 00:00 -> the following Monday 00:00 is 48h of wall-clock time,
  // but only 24h of it (Saturday) is a working day before Sunday; Monday
  // hasn't started yet at the end point, so it contributes 0 too.
  const sat = new Date(2026, 0, 3, 0, 0, 0, 0); // 2026-01-03 — confirmed Saturday
  assert.equal(sat.getDay(), 6);
  const mon = new Date(2026, 0, 5, 0, 0, 0, 0); // 2026-01-05 — Monday
  assert.equal(workingMsBetween(sat, mon), 24 * HOUR);

  // A same-day (Tuesday) span excludes nothing.
  const tueMorning = new Date(2026, 0, 6, 9, 0, 0, 0);
  const tueEvening = new Date(2026, 0, 6, 17, 0, 0, 0);
  assert.equal(workingMsBetween(tueMorning, tueEvening), 8 * HOUR);

  // end <= start -> 0, never negative.
  assert.equal(workingMsBetween(tueEvening, tueMorning), 0);
});
