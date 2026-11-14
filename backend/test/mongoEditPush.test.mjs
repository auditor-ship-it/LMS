import test from 'node:test';
import assert from 'node:assert/strict';
const { planPush, hashRow } = await import('../src/jobs/mongoEditPush.js');

const snap = (rows) => new Map(Object.entries(rows).map(([k, r]) => [k, hashRow(r)]));
const sheetOf = (rows) => new Map(Object.entries(rows).map(([k, r], i) => [k, { row: r, rowNum: i + 2 }]));

test('no baseline yet: nothing is pushed', () => {
  const r = planPush({ mongo: new Map([['row_0', ['a', 'X']]]), sheet: sheetOf({ row_0: ['a', 'b'] }), snapshot: null });
  assert.equal(r.edits.length, 0); assert.equal(r.noBaseline, true);
});

test('manual Mongo edit with untouched Sheet is pushed cell by cell', () => {
  const base = { row_0: ['a', 'b', 'c'], row_1: ['d', 'e', 'f'] };
  const r = planPush({ mongo: new Map([['row_0', ['a', 'B2', 'c']], ['row_1', ['d', 'e', 'f']]]), sheet: sheetOf(base), snapshot: snap(base) });
  assert.equal(r.edits.length, 1);
  assert.deepEqual(r.edits[0].cells, [{ col: 1, value: 'B2' }]);
  assert.equal(r.edits[0].rowNum, 2);
});

test('both sides changed: Sheet wins, nothing pushed', () => {
  const base = { row_0: ['a', 'b'] };
  const r = planPush({ mongo: new Map([['row_0', ['a', 'M']]]), sheet: sheetOf({ row_0: ['a', 'S'] }), snapshot: snap(base) });
  assert.equal(r.edits.length, 0); assert.equal(r.conflicts, 1);
});

test('app write already replayed to the Sheet (Mongo == Sheet) is not pushed again', () => {
  const base = { row_0: ['a', 'b'] };
  const r = planPush({ mongo: new Map([['row_0', ['a', 'NEW']]]), sheet: sheetOf({ row_0: ['a', 'NEW'] }), snapshot: snap(base) });
  assert.equal(r.edits.length, 0); assert.equal(r.conflicts, 0);
});

test('Sheet-only edit is left to the normal reconcile', () => {
  const base = { row_0: ['a', 'b'] };
  const r = planPush({ mongo: new Map([['row_0', ['a', 'b']]]), sheet: sheetOf({ row_0: ['a', 'S'] }), snapshot: snap(base) });
  assert.equal(r.edits.length, 0);
});

test('rows missing on one side and blank/trailing-empty differences are ignored', () => {
  const base = { row_0: ['a', ''] };
  const r = planPush({ mongo: new Map([['row_0', ['a']], ['row_9', ['x']]]), sheet: sheetOf(base), snapshot: snap(base) });
  assert.equal(r.edits.length, 0);
});

test('more edits than the limit is flagged', () => {
  const base = {}, m = new Map();
  for (let i = 0; i < 30; i++) { base['row_' + i] = ['a']; m.set('row_' + i, ['z']); }
  const r = planPush({ mongo: m, sheet: sheetOf(base), snapshot: snap(base), max: 25 });
  assert.equal(r.tooMany, true);
});
