/**
 * Off-Lease Efficiency Engine — unit tests for the pure calculation
 * functions (calculateStageEfficiency, calculateCumulativeEfficiency).
 * Node's built-in test runner — no new dependency for one test file.
 *
 * Run: node --test src/services/offleaseEfficiencyEngine.test.js
 *
 * calculateContainerEfficiency/getOffLeaseEfficiencyReport are NOT unit
 * tested here — they do live I/O (Mongo-mirrored sheet reads, FMS lookups,
 * Move History) with no mocking layer in this repo, so they're verified
 * against real data instead via scripts/reconcileOffLeaseEfficiency.mjs
 * (Test 10's rework-detection logic is exercised there, against real Move
 * History entries, rather than mocked here).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateStageEfficiency, calculateCumulativeEfficiency } from './offleaseEfficiency.service.js';
import { parseStamp } from './offleaseSla.service.js';

const HOUR = 60 * 60 * 1000;
const configFor = (targetMs, id = 1) => ({ id, name: 'Test Stage', targetMs });

test('Test 1 — exact target: 60min target, 60min actual -> 100%', () => {
  const start = new Date('2026-01-01T00:00:00');
  const end = new Date(start.getTime() + HOUR);
  const r = calculateStageEfficiency({ start, end }, configFor(HOUR, 5));
  assert.equal(r.status, 'COMPLETED');
  assert.equal(r.calculationStatus, 'VALID');
  assert.equal(r.efficiencyPercentage, 100);
});

test('Test 2 — faster than target: 60min target, 30min actual -> capped at 100% (not 200%)', () => {
  const start = new Date('2026-01-01T00:00:00');
  const end = new Date(start.getTime() + HOUR / 2);
  const r = calculateStageEfficiency({ start, end }, configFor(HOUR, 5));
  assert.equal(r.efficiencyPercentageRaw, 200);
  assert.equal(r.efficiencyPercentage, 100);
});

test('Test 3 — slower than target: 60min target, 120min actual -> 50%', () => {
  const start = new Date('2026-01-01T00:00:00');
  const end = new Date(start.getTime() + HOUR * 2);
  const r = calculateStageEfficiency({ start, end }, configFor(HOUR, 5));
  assert.equal(r.efficiencyPercentage, 50);
});

test('Test 4 — Stage 2 (48h target): 2880min target, 1440min actual -> raw 200%, capped 100%', () => {
  const start = new Date('2026-01-01T00:00:00');
  const end = new Date(start.getTime() + 24 * HOUR);
  const r = calculateStageEfficiency({ start, end }, configFor(48 * HOUR, 6));
  assert.equal(r.efficiencyPercentageRaw, 200);
  assert.equal(r.efficiencyPercentage, 100);
});

test('Test 5 — missing start (start marker present but unparseable) -> MISSING_DATA', () => {
  const end = new Date('2026-01-01T01:00:00');
  const r = calculateStageEfficiency({ start: null, end, missingStart: true }, configFor(HOUR, 5));
  assert.equal(r.calculationStatus, 'MISSING_DATA');
  assert.equal(r.efficiencyPercentage, null);
});

test('Test 6 — missing completion (status marked done, timestamp unparseable) -> MISSING_DATA', () => {
  const start = new Date('2026-01-01T00:00:00');
  const r = calculateStageEfficiency({ start, end: null, missingEnd: true }, configFor(HOUR, 5));
  assert.equal(r.status, 'COMPLETED');
  assert.equal(r.calculationStatus, 'MISSING_DATA');
  assert.equal(r.efficiencyPercentage, null);
});

test('Test 7 — invalid timestamps (completion before start) -> INVALID_DATA, no invented efficiency', () => {
  const start = new Date('2026-01-01T02:00:00');
  const end = new Date('2026-01-01T01:00:00');
  const r = calculateStageEfficiency({ start, end }, configFor(HOUR, 5));
  assert.equal(r.calculationStatus, 'INVALID_DATA');
  assert.equal(r.efficiencyPercentage, null);
  assert.match(r.reason, /predates start/);
});

test('Test 8 — not-applicable stage (Repair Required = No) -> NOT_APPLICABLE, excluded from cumulative', () => {
  const r = calculateStageEfficiency({ notApplicable: true }, configFor(HOUR, 3));
  assert.equal(r.status, 'NOT_APPLICABLE');
  assert.equal(r.calculationStatus, 'VALID');
  const cumulative = calculateCumulativeEfficiency([r]);
  assert.equal(cumulative.calculationStatus, 'MISSING_DATA'); // nothing applicable to sum
  assert.equal(cumulative.totalTargetMinutes, 0);
});

test('Test 9 — Hold (Stage 1 only): no release timestamp exists, so gross elapsed is used and flagged, not invented', () => {
  const start = new Date(Date.now() - 10 * 60 * 1000); // started 10 min ago
  const r = calculateStageEfficiency({ start, end: null, onHold: true, holdAt: start }, configFor(HOUR, 1));
  assert.equal(r.status, 'HOLD');
  assert.equal(r.holdDurationMinutes, null); // never invented
  assert.match(r.dataLimitation, /hold_duration_not_tracked/);
  assert.equal(r.efficiencyPercentage, null); // not yet completed, no efficiency to report
});

test('Test 11 — timezone: parseStamp reads dd/MM/yyyy correctly, no MM/dd flip', () => {
  // 03/02/2026 is 3rd February in dd/MM/yyyy — if this were misread as
  // MM/dd it would become 2nd March instead.
  const d = parseStamp('03/02/2026 14:05:30');
  assert.ok(d);
  assert.equal(d.getDate(), 3);
  assert.equal(d.getMonth(), 1); // 0-indexed -> February
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getHours(), 14);
  assert.equal(d.getMinutes(), 5);
});

test('Test 12 — cumulative: sum-then-divide, NOT an average of stage percentages', () => {
  const start = new Date('2026-01-01T00:00:00');
  // Stage A: 1h target, 1h actual -> 100%
  const a = calculateStageEfficiency({ start, end: new Date(start.getTime() + HOUR) }, configFor(HOUR, 5));
  // Stage B: 48h target, 96h actual -> 50%
  const b = calculateStageEfficiency({ start, end: new Date(start.getTime() + 96 * HOUR) }, configFor(48 * HOUR, 6));
  const cumulative = calculateCumulativeEfficiency([a, b]);
  // Naive (WRONG) average-of-percentages would be (100+50)/2 = 75.
  // Correct sum-then-divide: (60 + 2880) / (60 + 5760) * 100 = 50.52.
  assert.notEqual(cumulative.cumulativeEfficiencyPercentage, 75);
  const expected = Math.round(((60 + 2880) / (60 + 5760)) * 100 * 100) / 100;
  assert.equal(cumulative.cumulativeEfficiencyPercentage, expected);
});
