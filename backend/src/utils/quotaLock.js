/**
 * Single source of truth for the global Google Sheets quota circuit
 * breaker — shared between googleSheets.service.js (which trips it the
 * MOMENT a quota error is first seen, before burning through its own retry
 * attempts) and responseCache.middleware.js (which reads it to short-circuit
 * every other request instantly instead of letting each one independently
 * discover the same quota exhaustion the slow way).
 *
 * Tripping this as early as possible matters: a burst of N concurrent
 * requests that all hit the API around the same moment used to each run
 * their own 5-attempt exponential-backoff retry (up to ~15s and 5 more
 * quota-consuming attempts EACH) before any of them reported failure and
 * set this lock — meaning the burst that exhausted the quota kept hammering
 * it for another 15+ seconds afterward, which is exactly the kind of
 * self-inflicted pile-on that turns a brief spike into a full lockout.
 * Tripping it on the FIRST quota error lets every other in-flight/queued
 * request bail out immediately instead.
 */
import { cacheGet, cachePut } from './memoryCache.js';

export const LOCKOUT_SECONDS = Number(process.env.SHEETS_QUOTA_LOCKOUT_SECONDS) || 300;
export const GLOBAL_LOCK_KEY = 'httplock:global';

export function tripGlobalQuotaLock() {
  cachePut(GLOBAL_LOCK_KEY, { expiresAt: Date.now() + LOCKOUT_SECONDS * 1000 }, LOCKOUT_SECONDS);
}

export function getGlobalQuotaLock() {
  return cacheGet(GLOBAL_LOCK_KEY);
}
