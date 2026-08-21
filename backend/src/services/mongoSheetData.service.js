import { getCollection } from './mongo.service.js';
import { logger } from '../utils/logger.js';

/**
 * SHEETS-FIRST (reverted 2026-08-21) — this file's getSheetDataFromMongo
 * (a drop-in getSheetData(sheetName) replacement reading the Mongo backup
 * mirror instead of live Sheets) was removed once every read call site in
 * the app went back to live Sheets. patchMongoMirrorRow below is the one
 * function still in active use: it keeps the Mongo backup in step with
 * each Sheets-first write, right after it happens.
 */

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
