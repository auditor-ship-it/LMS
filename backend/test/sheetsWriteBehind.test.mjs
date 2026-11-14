import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_SOURCE = 'central';
process.env.CENTRAL_SHEETS_MIRROR = 'on';
process.env.CENTRAL_DATABASE_URL = 'postgres://unused@127.0.0.1:1/none';

const { applyOp } = await import('../src/jobs/sheetsWriteBehind.job.js');
const { isCentral, runAgainstGoogle, mirrorToSheets } = await import('../src/services/centralSheets.service.js');

const fake = () => {
  const calls = [];
  return {
    calls,
    colLetter: (i) => { let n = i + 1, s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; },
    ensureColumnCount: async (...a) => calls.push(['ensureColumnCount', ...a]),
    updateRange: async (...a) => calls.push(['updateRange', ...a]),
    appendRows: async (...a) => calls.push(['appendRows', ...a]),
    deleteRows: async (...a) => calls.push(['deleteRows', ...a])
  };
};

test('write op becomes an absolute-range update', async () => {
  const g = fake();
  await applyOp({ workbook_key: 'lease_workbook', tab: 'Deployed sheet', op: 'write', payload: { startRow: 5, startCol: 20, values: [['a', 'b'], ['c', 'd']] } }, g);
  assert.deepEqual(g.calls[1], ['updateRange', 'Deployed sheet', 'U5:V6', [['a', 'b'], ['c', 'd']], undefined]);
  assert.equal(g.calls[0][2], 22);
});

test('append and delete ops map to Google calls', async () => {
  const g = fake();
  await applyOp({ workbook_key: 'lease_workbook', tab: 'X', op: 'append', payload: { startRow: 9, values: [[1, 2]] } }, g);
  await applyOp({ workbook_key: 'lease_workbook', tab: 'X', op: 'delete', payload: { rowNums: [7, 3] } }, g);
  assert.deepEqual(g.calls, [['appendRows', 'X', [[1, 2]], undefined], ['deleteRows', 'X', [7, 3], undefined]]);
});

test('unknown op is rejected', async () => {
  await assert.rejects(() => applyOp({ workbook_key: 'lease_workbook', tab: 'X', op: 'nope', payload: {} }, fake()));
});

test('central switch is off only inside runAgainstGoogle', async () => {
  assert.equal(isCentral(), true);
  assert.equal(mirrorToSheets(), true);
  await runAgainstGoogle(async () => { await Promise.resolve(); assert.equal(isCentral(), false); });
  assert.equal(isCentral(), true);
});
