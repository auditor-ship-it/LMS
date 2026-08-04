/**
 * Node equivalent of Apps Script's LockService.getScriptLock(), used ~50
 * places in the original to serialize read-modify-write sequences against a
 * sheet (append a row, then recompute a running total, etc.).
 *
 * Single-process only — matches the original's single-instance Apps Script
 * execution model. Not safe across multiple Node instances/load balancers.
 */

const chains = new Map();

/**
 * Runs `fn` exclusively with respect to any other call using the same `key`
 * (typically a sheet name). Calls with different keys run concurrently.
 */
export function withSheetLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const run = prev.then(fn, fn); // run fn regardless of whether prev resolved or rejected
  // Keep the chain alive but never let a rejection break future locks.
  chains.set(key, run.catch(() => {}));
  return run;
}
