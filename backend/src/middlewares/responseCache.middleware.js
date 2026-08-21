import { cacheGet, cachePut } from '../utils/memoryCache.js';
import { isGoogleQuotaError } from './errorHandler.js';

/**
 * RAW app <-> sheet, no response caching (removed 2026-08-21 at the user's
 * explicit, repeated request). Every GET reads Sheets live; every write
 * lands on Sheets directly. This file now does exactly one thing: a GLOBAL
 * quota-error circuit breaker — the moment ANY request gets a real quota
 * error from Google, every other GET across the whole app immediately
 * short-circuits with a friendly 429 (no further calls to Google at all)
 * for LOCKOUT_SECONDS, instead of letting every other page's request pile
 * on and keep failing individually. The 429 body includes
 * `retryAfterSeconds` so the frontend can show a live countdown.
 *
 * This is NOT a caching mechanism and does not serve stale data — it only
 * ever activates in response to a genuine error Google's API already
 * returned, and it always tells the truth about what state it's in (a 429,
 * not a silently-reused old response). The response-caching half that used
 * to live here was removed entirely: it caused four distinct hard-to-
 * diagnose staleness bugs in one day (an Express ETag conflict, a cache-
 * repopulation race, a wrong-resource cache-bust from a req.path read after
 * Express's sub-router rewrote it, and — the one that ended this — a manual
 * spreadsheet edit being invisible to the app for up to 90s because nothing
 * outside the app's own write path ever busted it). None of that risk is
 * worth trading for "revisit a page is free" now that every write already
 * goes straight to Sheets and every read does too.
 */

const LOCKOUT_SECONDS = Number(process.env.SHEETS_QUOTA_LOCKOUT_SECONDS) || 300;
const GLOBAL_LOCK_KEY = 'httplock:global';
const SKIP_PREFIXES = ['/api/auth', '/api/uploads', '/api/health', '/api/public', '/api/api-keys'];

export function responseCache(req, res, next) {
  if (SKIP_PREFIXES.some((p) => req.path.startsWith(p))) return next();
  if (!req.user) return next(); // unauthenticated — never touches the lockout state, let requireAuth handle it downstream

  const lock = cacheGet(GLOBAL_LOCK_KEY);
  if (lock) {
    const retryAfterSeconds = Math.max(1, Math.ceil((lock.expiresAt - Date.now()) / 1000));
    return res.status(429).json({
      error: `Google Sheets API rate limit was recently hit. Please wait ${retryAfterSeconds}s and try again.`,
      retryAfterSeconds,
      quotaLocked: true
    });
  }

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode === 429 || isGoogleQuotaError({ message: body?.error })) {
      cachePut(GLOBAL_LOCK_KEY, { expiresAt: Date.now() + LOCKOUT_SECONDS * 1000 }, LOCKOUT_SECONDS);
    }
    return originalJson(body);
  };
  next();
}
