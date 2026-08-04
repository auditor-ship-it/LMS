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
