import { getCollection } from './mongo.service.js';
import { logger } from '../utils/logger.js';
import { cacheGetOrLoad } from '../utils/memoryCache.js';

const META_ID = '__meta__';

/**
 * MONGO-FIRST READS (restored 2026-08-26) — the live-Sheets-for-every-read
 * architecture (SHEETS-FIRST, 2026-08-21) turned out to make the app
 * unusably fragile against the shared project-wide Sheets quota: every page
 * load, poll, and open tab meant a live read, and any burst of traffic
 * (several tabs, several users, the background reconcile job) tripped the
 * "Google Sheets API rate limit" circuit breaker for everyone, repeatedly,
 * confirmed by the user across Off-Lease, My Task, Approve Lease and Lease
 * Expiry the same day. Reverting to reading the Mongo mirror for
 * display/list reads removes those pages from the live quota entirely.
 *
 * Only call sites already proven safe (no write derives a row NUMBER from
 * this read — see each call site's own comment, and
 * offlease.service.js's copyApprovedData for the one place that must NOT
 * use this) were switched. Writes still land on Sheets directly and patch
 * the mirror immediately after (patchMongoMirrorRow / inline getCollection
 * updates below), so the app's own actions still show up on the very next
 * read; only edits made directly in the raw spreadsheet, outside the app,
 * wait for the next scheduled reconcile cycle to appear.
 *
 * Drop-in replacement for googleSheets.service.js's getSheetData(sheetName),
 * reading from the Mongo mirror instead of the live spreadsheet. Returns the
 * exact same { headers, rows, values } shape so existing index-based
 * business logic (row[0], row[26], ...) needs zero changes — only the
 * import at the top of a service file changes.
 *
 * Each doc in the collection is either the one `_id: '__meta__'` header doc
 * ({ headers }) or a row doc ({ key, row, deletedAt? }) written by
 * jobs/sheetsReconcile.job.js (Sheets -> Mongo) or a write-side mirror patch
 * (patchMongoMirrorRow / inline getCollection updates). Soft-deleted rows
 * (deletedAt set) are excluded, same as if the row had actually been
 * removed from the sheet.
 *
 * `key: { $exists: true }` — every doc our own reconcile job writes always
 * gets a `key` (a real business key for by-key sheets, a synthetic `row_N`
 * for fullRefresh sheets). Docs with no `key` at all are foreign to this
 * pipeline and excluded as a defensive backstop.
 */
/**
 * Same rows as getSheetDataFromMongo, but keeping each row's Mongo `key`
 * alongside it — needed by the Mongo-first write path (offlease.service.js's
 * *Fast functions etc.) to target the exact doc to patch. Sorted by the
 * numeric suffix of `row_N` keys where present, so a container with more
 * than one row (Off-Lease Tracking's container numbers are not unique) is
 * scanned in the same order a live sheet read would see them, rather than
 * whatever order Mongo's own find() happens to return — that order isn't
 * guaranteed to match sheet position and picking the wrong duplicate would
 * patch the wrong row's data. Not a guarantee (an external edit since the
 * last reconcile can still reorder the real sheet) — just a best-effort
 * match; the authoritative background replay always re-resolves the row
 * itself from a fresh live read and corrects anything this got wrong.
 */
export async function getMongoRowsWithKeys(sheetName) {
  const col = getCollection(sheetName);
  const docs = await col.find({ _id: { $ne: META_ID }, deletedAt: null, key: { $exists: true } }).toArray();
  return docs
    .map((d) => ({ key: d.key, row: d.row || [] }))
    .sort((a, b) => {
      const na = parseInt(String(a.key).replace(/^row_/, ''), 10);
      const nb = parseInt(String(b.key).replace(/^row_/, ''), 10);
      const fa = Number.isFinite(na) ? na : Number.MAX_SAFE_INTEGER;
      const fb = Number.isFinite(nb) ? nb : Number.MAX_SAFE_INTEGER;
      return fa - fb;
    });
}

/* PERFORMANCE FIX 2026-08-28: this was completely uncached — every single
 * call did its own full-collection Mongo scan, no matter how many times the
 * SAME sheet was read within one request or across near-simultaneous
 * requests. Fine for a single call site, but this function is now called
 * from dozens of places across the app (today's whole Mongo-first read
 * migration), and some real request paths call it for the SAME large sheet
 * more than once — getOffLeaseContainerDetail alone triggers 4-5 of these,
 * including Operation sheet (1233 docs), which confirmed at ~4.3s for ONE
 * read alone. The combined, uncached total pushed some requests past 15-20s,
 * which the frontend then showed as a generic "quota exhausted" failure —
 * a performance regression, not an actual Sheets/quota problem.
 *
 * Short TTL (8s), no explicit write-side busting: this is a broad,
 * general-purpose cache for the many lower-stakes/diagnostic/report call
 * sites that don't already have their own dedicated cache. Call sites where
 * "write, then read, must show it instantly" actually matters already have
 * — and keep — their own purpose-built cache with explicit busting
 * (_deployedRawValues, getApproveData, getOffLeaseDashboardData, ...); nothing
 * about those changes. 8s bounds the staleness this adds to everything else
 * to something far smaller than the multi-second delay it removes. */
const MONGO_RAW_CACHE_TTL_SECS = 8;

export async function getSheetDataFromMongo(sheetName) {
  return cacheGetOrLoad(`mongo_raw_v1:${sheetName}`, MONGO_RAW_CACHE_TTL_SECS, async () => {
    const start = process.hrtime.bigint();
    const col = getCollection(sheetName);
    const [metaDoc, docs] = await Promise.all([
      col.findOne({ _id: META_ID }),
      col.find({ _id: { $ne: META_ID }, deletedAt: null, key: { $exists: true } }).toArray()
    ]);
    const headers = metaDoc?.headers || [];
    const rows = docs.map((d) => d.row || []);
    const values = headers.length ? [headers, ...rows] : rows;
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    logger.debug(`[DB] Collection: ${sheetName} | Operation: find (full read) | Returned: ${rows.length} documents | Duration: ${durationMs.toFixed(1)}ms`);
    return { headers, rows, values };
  });
}

function _colIndexFromLetter(letter) {
  let idx = 0;
  for (const ch of letter) idx = idx * 26 + (ch.charCodeAt(0) - 64);
  return idx - 1; // 0-based
}

/**
 * Keeps the Mongo mirror in step with a direct-to-Sheets write, RIGHT AWAY,
 * instead of waiting for the next scheduled reconciliation (up to 5 minutes
 * — jobs/sheetsReconcile.job.js).
 *
 * Two sheet-keying shapes exist (see mongoSheetMapping.js), and the caller
 * must pass the right handle for whichever one `sheetName` is:
 *   - `fullRefresh` sheets with no reliable natural key (e.g. SHEETS.DEPLOYED)
 *     — key off row POSITION (`row_<i>`). Pass `targetRow`, the exact 1-based
 *     sheet row the caller already resolved from a fresh read (the same
 *     value used to build `updates`); leave `opts.key` unset.
 *   - `naturalKeyColumn` (by-key) sheets (e.g. SHEETS.NEW_LEASE) — key off
 *     that column's value. Pass `opts.key` (normalizeKey(sheetName, id)) —
 *     `targetRow` is still needed to match `updates`' ranges, but is NOT
 *     used to derive the Mongo key in this mode.
 *
 * `updates` is the SAME {range, values} array already sent to
 * batchUpdateValues/updateRange — the Mongo patch is parsed OUT of it rather
 * than built separately, so it can never drift from what was actually
 * written to Sheets. Anything not a single-cell `'Sheet'!COLtargetRow` range
 * (e.g. a header-widening range) is ignored rather than guessed at.
 *
 * Added 2026-08-20 for the "Renew & Document should reflect instantly"
 * request — these writes (renewLeaseWithAgreement, updateLeasePeriod,
 * completeDocStage, completeDocumentStage, saveExpiryAction,
 * uploadAndSaveDeployedDocument, updateVerifyLeaseFields) go straight to
 * Sheets with no Mongo-first path, so a GET reading the mirror used to show
 * stale data until the next reconciliation cycle caught up.
 *
 * Best-effort: a failure here must not fail the write that already
 * succeeded in Sheets — the scheduled reconciliation still catches up
 * regardless, just not instantly.
 */
export async function patchMongoMirrorRow(sheetName, targetRow, updates, opts = {}) {
  try {
    const re = new RegExp(`^'?${sheetName}'?!([A-Z]+)${targetRow}(?::[A-Z]+${targetRow})?$`);
    const patch = {};
    for (const u of updates || []) {
      const m = String(u?.range || '').match(re);
      if (!m) continue;
      const idx = _colIndexFromLetter(m[1]);
      const val = u.values?.[0]?.[0];
      patch[`row.${idx}`] = val == null ? '' : val;
    }
    if (!Object.keys(patch).length) return;

    const key = opts.key ?? `row_${targetRow - 2}`;
    const res = await getCollection(sheetName).updateOne({ key }, { $set: { ...patch, updatedAt: new Date() } });
    logger.debug(`[DB] Collection: ${sheetName} | Operation: update (mirror patch) | Key: ${key} | Cells: ${Object.keys(patch).length} | Matched: ${res.matchedCount}`);
  } catch (e) {
    logger.error(`[MIRROR-PATCH] ${sheetName} row ${targetRow} patch failed (non-fatal — scheduled reconcile will catch up within 5 min):`, e?.message || e);
  }
}
