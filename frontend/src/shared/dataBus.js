/**
 * Cross-page "this data changed" broadcaster. KeepAlivePages.jsx keeps every
 * visited page mounted forever and only fetches once per session (by
 * design — re-fetching on every sidebar click would hit the backend/Sheets
 * quota on every navigation, which this app has already been burned by
 * once). That means a write on one page (e.g. Lease Expiry's "Renew") never
 * reaches another already-mounted page reading the same underlying sheet
 * (Renew & Document) on its own — this bus is the deliberate, narrow
 * exception: a page that just wrote something announces it, and any other
 * page that cares refetches, either immediately if it's the one currently
 * on screen or the next time it's navigated to (see useAutoRefresh.js).
 *
 * Domains are plain strings, not enumerated here — callers agree on a name
 * (e.g. 'deployed-sheet') the same way backend/responseCache.middleware.js's
 * COUPLED_RESOURCES do for the equivalent HTTP-layer problem.
 */
const listeners = new Map(); // domain -> Set<() => void>

export function invalidate(domain) {
  const set = listeners.get(domain);
  if (!set) return;
  for (const fn of set) fn();
}

export function subscribe(domain, fn) {
  if (!listeners.has(domain)) listeners.set(domain, new Set());
  listeners.get(domain).add(fn);
  return () => listeners.get(domain)?.delete(fn);
}
