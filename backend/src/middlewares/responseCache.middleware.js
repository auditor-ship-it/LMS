import { cacheGet, cachePut, cacheRemoveByPrefix } from '../utils/memoryCache.js';
import { isGoogleQuotaError } from './errorHandler.js';

/**
 * Global HTTP response cache + quota-lockout guard, added to stop the app
 * from repeatedly hitting Google's Sheets API "Read requests per minute"
 * quota. Two mechanisms:
 *
 * 1. Per-user, per-endpoint GET cache (SUCCESS_TTL_SECONDS, default 90s).
 *    Every GET a given logged-in employee makes to the same endpoint+query
 *    within that window is served from memory, not from the Sheets API.
 *    This is what makes "revisit a page" / "switch tabs back and forth"
 *    effectively free instead of re-reading the spreadsheet every time.
 *
 * 2. A GLOBAL lockout: the moment ANY request gets a real quota error from
 *    Google, every other GET across the whole app immediately short-circuits
 *    with a friendly 429 (no further calls to Google at all) for
 *    LOCKOUT_SECONDS, instead of letting every other page's request pile on
 *    and keep failing individually. The 429 body includes
 *    `retryAfterSeconds` so the frontend can show a live countdown.
 *
 * Cached only for authenticated requests (req.user set by the global
 * optionalAuth middleware in app.js) — an unauthenticated request never
 * reads or writes this cache, so it can't piggyback on another user's
 * cached (and possibly permission-gated) response; it always falls through
 * to the route's own requireAuth, which 401s it as before.
 *
 * Any successful (2xx) non-GET request (a save/approve/upload/etc.) busts the
 * cached GET entries for the resource it touches AND every resource coupled to
 * it, FOR ALL USERS, so a follow-up reload reflects the change immediately
 * rather than serving stale pre-mutation data.
 *
 * Both of those were once narrower, and both were wrong:
 *
 *  - Busting only the writer's own entries left every OTHER user looking at a
 *    pre-mutation list for the full 90s. The underlying sheets are shared, so
 *    a cache of them cannot be invalidated per-user.
 *  - Busting only the written path meant a write to one domain never cleared
 *    the domains that read the SAME sheets. Marking a container off-lease
 *    (POST /api/offlease/tracking) cleared /api/offlease but not /api/expiry,
 *    so the container stayed on the Lease Expiry list for up to 90s after the
 *    spreadsheet had already been updated — reported as "the sheet updates
 *    instantly but the other panel takes time".
 */

const SUCCESS_TTL_SECONDS = Number(process.env.SHEETS_CACHE_TTL_SECONDS) || 90;
const LOCKOUT_SECONDS = Number(process.env.SHEETS_QUOTA_LOCKOUT_SECONDS) || 300;
const GLOBAL_LOCK_KEY = 'httplock:global';

/**
 * resource prefix -> Date.now() of the most recent bust. Guards against a
 * cache-repopulation race: a GET that started BEFORE a write (queued up
 * behind Sheets/Mongo latency, or one of KeepAlivePages' other mounted
 * pages reacting to the same dataBus invalidate) can still be in flight
 * when that write's bust runs, then finish AFTER it and write its own
 * (now-stale, pre-write) body back into the cache via cachePut below —
 * silently re-poisoning the exact entry the bust just cleared. Confirmed
 * 2026-08-21: a reload fired immediately after a successful Renew action
 * kept coming back without that action reflected, even though the write
 * itself was already committed and directly-verified correct — an older,
 * slower in-flight GET was repopulating the cache after the bust. A
 * request's own response is unaffected by this (the client still gets
 * whatever THAT request actually read); this only stops that read from
 * being cached and handed to OTHER requests as if it were current.
 */
const lastBustAt = new Map();
// SHEETS-FIRST (reverted 2026-08-21) — /api/dashboard, /api/tasks,
// /api/roles were previously exempted here because they were Mongo-backed
// and carried no Sheets quota risk; they're back on live Sheets reads now
// (dashboard.service.js/tasks.service.js/roles.service.js), so they need
// this cache's quota protection exactly like every other domain and are no
// longer exempt. Do not re-add a domain here without confirming it's
// actually Mongo-only for reads AND writes.
// /api/public is unauthenticated by design (X-Api-Key, not a session) and
// would never populate req.user anyway, so it already falls through this
// cache untouched — listed here only to document that explicitly rather
// than leave a new reader to work it out from the req.user gate below.
// /api/api-keys is the low-traffic admin screen managing those keys; no
// Sheets quota reason to cache it.
const SKIP_PREFIXES = ['/api/auth', '/api/uploads', '/api/health', '/api/public', '/api/api-keys'];

function topResourcePath(originalPath) {
  // "/api/verify/12/action" -> "/api/verify" — the shared prefix every GET
  // "list this resource" endpoint for the same domain also starts with.
  const parts = originalPath.split('/').filter(Boolean); // ['api','verify','12','action']
  return '/' + parts.slice(0, 2).join('/');
}

/**
 * Domains that read the SAME underlying sheets, so a write to any one of them
 * can change what the others return.
 *
 * All four are views over the Deployed sheet and the workflow sheets hanging
 * off it: a container leaving Lease Expiry for Off-Lease is one write that
 * changes two lists. They are invalidated as a group rather than by a pairwise
 * map, which would need editing every time a service starts reading one more
 * sheet — and would silently go stale when nobody remembered to.
 */
const COUPLED_RESOURCES = ['/api/verify', '/api/approve', '/api/expiry', '/api/offlease'];

/** Every resource whose cached GETs a write to `resource` invalidates. */
function resourcesToBust(resource) {
  return COUPLED_RESOURCES.includes(resource) ? COUPLED_RESOURCES : [resource];
}

export function responseCache(req, res, next) {
  if (SKIP_PREFIXES.some((p) => req.path.startsWith(p))) return next();
  if (!req.user) return next(); // unauthenticated — never touches the cache, let requireAuth handle it downstream

  const lock = cacheGet(GLOBAL_LOCK_KEY);
  if (lock) {
    const retryAfterSeconds = Math.max(1, Math.ceil((lock.expiresAt - Date.now()) / 1000));
    return res.status(429).json({
      error: `Google Sheets API rate limit was recently hit. Please wait ${retryAfterSeconds}s and try again.`,
      retryAfterSeconds,
      quotaLocked: true
    });
  }

  if (req.method !== 'GET') {
    // Bust this user's cached reads for the resource this write touches, once the write succeeds.
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        /* Trailing ':' so the prefix matches the resource segment exactly and
           cannot spill into a longer resource name that starts the same way. */
        const bustedAt = Date.now();
        for (const r of resourcesToBust(topResourcePath(req.path))) {
          cacheRemoveByPrefix(`httpcache:${r}:`);
          lastBustAt.set(r, bustedAt);
        }
      } else if (res.statusCode === 429 || isGoogleQuotaError({ message: body?.error })) {
        cachePut(GLOBAL_LOCK_KEY, { expiresAt: Date.now() + LOCKOUT_SECONDS * 1000 }, LOCKOUT_SECONDS);
      }
      return originalJson(body);
    };
    return next();
  }

  /* Resource FIRST, then the user: the entries for one resource have to be
     removable across every user in a single prefix sweep. With the user first
     that was impossible, which is why invalidation used to be per-user. The
     response body is still cached per user — permission-gated endpoints return
     different data per employee, so entries can never be SHARED between
     users, only invalidated together. */
  const resource = topResourcePath(req.path);
  const cacheKey = `httpcache:${resource}:${req.user.empId}:${req.originalUrl}`;
  const forceRefresh = req.query.refresh === '1';
  if (!forceRefresh) {
    const hit = cacheGet(cacheKey);
    if (hit) return res.status(hit.status).json(hit.body);
  }

  // Captured BEFORE this request's own work runs, so it reflects when the
  // GET actually started — see the lastBustAt comment above.
  const requestStartedAt = Date.now();
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode === 200) {
      const bustedAt = lastBustAt.get(resource) || 0;
      if (requestStartedAt >= bustedAt) {
        cachePut(cacheKey, { status: 200, body }, SUCCESS_TTL_SECONDS);
      }
      // else: a write to this resource landed WHILE this GET was already in
      // flight — its result may be stale, so it's returned to this caller
      // as-is but never cached for anyone else.
    } else if (res.statusCode === 429 || isGoogleQuotaError({ message: body?.error })) {
      cachePut(GLOBAL_LOCK_KEY, { expiresAt: Date.now() + LOCKOUT_SECONDS * 1000 }, LOCKOUT_SECONDS);
    }
    return originalJson(body);
  };
  next();
}
