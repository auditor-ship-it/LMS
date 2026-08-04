import { getCollection } from './mongo.service.js';
import { logger } from '../utils/logger.js';

const META_ID = '__meta__';

/**
 * Drop-in replacement for googleSheets.service.js's getSheetData(sheetName),
 * reading from the Mongo mirror instead of the live spreadsheet. Returns the
 * exact same { headers, rows, values } shape so existing index-based
 * business logic (row[0], row[26], ...) needs zero changes — only the
 * import at the top of a service file changes.
 *
 * Each doc in the collection is either the one `_id: '__meta__'` header doc
 * ({ headers }) or a row doc ({ key, row, deletedAt? }) written by
 * jobs/sheetsReconcile.job.js (Sheets -> Mongo) or writeThrough (Mongo-first
 * writes). Soft-deleted rows (deletedAt set) are excluded, same as if the
 * row had actually been removed from the sheet.
 *
 * `key: { $exists: true }` — every doc our own reconcile job writes always
 * gets a `key` (a real business key for by-key sheets, a synthetic `row_N`
 * for fullRefresh sheets). Docs with no `key` at all are foreign to this
 * pipeline (confirmed 2026-08-01: legacy bare-`_id` documents from some
 * other/older process kept reappearing in `New Lease` alongside the correct
 * keyed copy, rendering as duplicate rows in Verify Lease). Excluding them
 * here is a defensive backstop at the one shared read path every consumer
 * goes through, independent of whatever keeps recreating them. */
export async function getSheetDataFromMongo(sheetName) {
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
}
