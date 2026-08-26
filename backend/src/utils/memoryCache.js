/**
 * Node equivalent of Apps Script's CacheService.getScriptCache(), used for
 * sessions, OTPs, roles cache, and rate-limit counters. Plain in-memory Map
 * with expiry — same single-process caveat as sheetMutex.js.
 */

const store = new Map();

export function cacheGet(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

export function cachePut(key, value, ttlSeconds) {
  store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

export function cacheRemove(key) {
  store.delete(key);
  inFlight.delete(key);
}

/* IN-FLIGHT DE-DUPLICATION — a "cache stampede" guard. Without this, the
   instant a cached value expires, every request that arrives before the
   first one's refill completes independently calls `loader` (a live
   Google Sheets read) — confirmed 2026-08-26: Team Accounts and Sidebar
   Access are read on essentially every authenticated request, cached for
   5 minutes, and several concurrent requests landing right at that 5-minute
   boundary each fired their own live re-read, part of a burst that tipped
   the whole app into a "Read requests per minute" quota lockout. This
   collapses concurrent callers for the SAME key onto one in-flight promise,
   so a cache miss costs exactly one live read no matter how many requests
   are waiting on it — the cache's freshness behaviour (TTL, staleness) is
   completely unchanged, this only removes the redundant simultaneous
   re-fetches. */
const inFlight = new Map();

/* LAST-GOOD, for graceful degradation on a Sheets quota error — added
   2026-08-26. Separate from the TTL store above (which enforces freshness):
   this one is intentionally kept around past expiry, indefinitely, purely
   as a fallback of last resort. Without it, a request landing during a
   quota lockout got a hard 429 and a blank/broken screen even though this
   exact data had been read successfully moments before — "slightly stale"
   is a far better failure mode than "broken" for a page whose whole point
   is a live count. */
const lastGood = new Map();

/** Same substring check errorHandler.js's isGoogleQuotaError and
 *  googleSheets.service.js's isQuotaError use — duplicated rather than
 *  imported for the same reason as those: a 2-line check isn't worth a
 *  cross-layer dependency. Only quota errors degrade; a genuine bug (bad
 *  range, auth failure, malformed data) must still surface as a real error,
 *  not be silently masked by serving old data forever. */
function isQuotaError(err) {
  const status = err?.code || err?.response?.status;
  const message = String(err?.message || err?.response?.data?.error?.message || '');
  return status === 429 || /quota exceeded/i.test(message);
}

/** Cache-or-load with stampede protection: returns the cached value if
 *  fresh, otherwise runs `loader()` — but only ONCE even if called
 *  concurrently for the same key — caches its result for `ttlSeconds`, and
 *  returns it to every concurrent caller. `loader` must be an async
 *  function with no arguments (close over whatever it needs).
 *
 *  opts.degradeOnError: if `loader` fails with a Sheets quota error AND a
 *  previous successful result for this key exists (however old), that
 *  stale result is returned instead of throwing, tagged with `_stale: true`
 *  and `_staleSince` (epoch ms) — spread onto the returned object, so this
 *  only works when `loader` resolves to a plain object (every current
 *  caller does: {headers, data}-shaped responses). A non-quota error, or a
 *  quota error with nothing to fall back to, still throws as before. */
export async function cacheGetOrLoad(key, ttlSeconds, loader, opts = {}) {
  const hit = cacheGet(key);
  if (hit !== null) return hit;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const value = await loader();
      cachePut(key, value, ttlSeconds);
      if (opts.degradeOnError) lastGood.set(key, { value, at: Date.now() });
      return value;
    } catch (e) {
      if (opts.degradeOnError && isQuotaError(e) && lastGood.has(key)) {
        const { value, at } = lastGood.get(key);
        console.warn(`[CACHE] ${key} load failed (${e?.message || e}) — serving last-good from ${new Date(at).toISOString()}`);
        return { ...value, _stale: true, _staleSince: at };
      }
      throw e;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
}

export function cacheRemoveAll(keys) {
  keys.forEach((k) => store.delete(k));
}

/** Removes every cached key starting with `prefix` — used to bust the HTTP
 *  response cache for a resource after a mutation touches it. */
export function cacheRemoveByPrefix(prefix) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}
