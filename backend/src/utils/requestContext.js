/**
 * Correlates deep, un-threaded calls (a service three layers down calling
 * googleSheets.service.js or mongo.service.js) back to the HTTP request that
 * triggered them, without passing `req` through every function signature.
 * Used so the [API] finish log can truthfully say "Source: MongoDB" /
 * "Source: Google Sheets" / "Source: MongoDB + Google Sheets" for whatever
 * actually got touched while handling that specific request — not a guess
 * based on which route it was.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

export function runInRequestContext(meta, fn) {
  return als.run({ ...meta, sources: new Set() }, fn);
}

export function getRequestContext() {
  return als.getStore() || null;
}

/** source: 'mongo' | 'sheets' — called from db.js / googleSheets.service.js whenever either is actually touched. */
export function touchSource(source) {
  const ctx = als.getStore();
  if (ctx) ctx.sources.add(source);
}

export function describeSources() {
  const ctx = als.getStore();
  if (!ctx || ctx.sources.size === 0) return 'none';
  return [...ctx.sources].map((s) => (s === 'mongo' ? 'MongoDB' : 'Google Sheets')).join(' + ');
}
