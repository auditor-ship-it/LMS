import { isGoogleQuotaError } from './errorHandler.js';
import { tripGlobalQuotaLock } from '../utils/quotaLock.js';

/**
 * MONGO-FIRST READS (restored 2026-08-26) — this used to ALSO pre-emptively
 * short-circuit every authenticated request with a 429 the moment the global
 * quota lock was tripped anywhere, regardless of whether THIS request would
 * ever call Sheets. That was correct under the prior SHEETS-FIRST
 * architecture (every GET hit Sheets live, so blocking everything during a
 * lockout genuinely prevented pile-on) — but it became a straight regression
 * once most display/list reads moved back to the Mongo mirror
 * (mongoSheetData.service.js): a single live-Sheets hiccup from an unrelated
 * write, or from the background reconcile job, tripped the lock and then
 * blocked EVERY page — including ones that no longer touch Sheets at all —
 * for the full LOCKOUT_SECONDS window. Confirmed 2026-08-26: the background
 * sync job alone tripped it right after a restart, and Lease Expiry (fully
 * Mongo-backed by then) still 429'd for the next five minutes with nothing
 * left to retry.
 *
 * The pre-emptive block is removed. The lock itself is still the right
 * mechanism — it just now belongs solely to the code path that actually
 * calls Google: googleSheets.service.js's withQuotaRetry already checks it
 * before every live attempt (failing fast without even trying) and trips it
 * on the first real quota error. That naturally protects exactly the
 * requests that still touch Sheets (writes, and the handful of read paths
 * that must stay live) without penalizing everything else. This file now
 * does exactly one thing: a defense-in-depth trip for any quota error that
 * somehow reaches a JSON response without going through withQuotaRetry.
 */

export function responseCache(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode === 429 || isGoogleQuotaError({ message: body?.error })) {
      tripGlobalQuotaLock();
    }
    return originalJson(body);
  };
  next();
}
