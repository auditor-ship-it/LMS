import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATA_SOURCE;
process.env.CENTRAL_DATABASE_URL = 'postgres://unused@127.0.0.1:1/none';
const svc = await import('../src/services/centralSheets.service.js');

test('dual-write is a no-op while CENTRAL_DUAL_WRITE is off', async () => {
  delete process.env.CENTRAL_DUAL_WRITE;
  let ran = false;
  assert.equal(svc.dualWriteToCentral(), false);
  svc.mirrorToCentral('x', async () => { ran = true; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ran, false);
});

test('dual-write failures are counted and never thrown', async () => {
  process.env.CENTRAL_DUAL_WRITE = 'on';
  assert.equal(svc.dualWriteToCentral(), true);
  const before = svc.dualWriteStats().failures;
  assert.doesNotThrow(() => svc.mirrorToCentral('x', async () => {}));
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(svc.dualWriteStats().failures, before + 1); // central DB unreachable in this test
});

test('dual-write is off in central mode and inside the Google bypass', () => {
  process.env.CENTRAL_DUAL_WRITE = 'on';
  process.env.DATA_SOURCE = 'central';
  assert.equal(svc.dualWriteToCentral(), false);
  delete process.env.DATA_SOURCE;
  assert.equal(svc.dualWriteToCentral(), true);
});
