/**
 * Periodic Sheets -> Mongo reconciliation — catches direct manual edits made
 * in the live spreadsheet (outside the app) and keeps the Mongo backup
 * mirror in step. Runs on a cron schedule (jobs/index.js), gated behind
 * ENABLE_SHEETS_SYNC.
 *
 * Scope note: this pass only reconciles the sheets listed in
 * config/mongoSheetMapping.js (the ones the dashboard/tasks/roles domains
 * actually read from Mongo now) — not all 35 tabs. The original one-time
 * drop-and-recreate script (sheets-mongo-sync/syncSheetsToMongo.js) is left
 * untouched as a separate disaster-recovery tool; this job supersedes it
 * only for the sheets it covers, using incremental upserts instead of a
 * full wipe, per the "avoid dropping collections every time" requirement.
 *
 * SHEETS-FIRST (reverted 2026-08-21) — every write in the app now lands on
 * Sheets directly; Mongo is a read-only backup mirror this job refreshes
 * one direction only (Sheets -> Mongo). The outbox worker and its
 * in-flight-write bookkeeping (resurrectDeadEntries/resurrectStuckProcessing/
 * inFlightDocIds) existed only to protect Mongo-first writes still in
 * transit to Sheets — with no such writes left to protect, they were removed
 * along with writeThrough.service.js and jobs/outboxWorker.js.
 */
import { getSheetData } from '../services/googleSheets.service.js';
import { getCollection, withTransaction } from '../services/mongo.service.js';
import { MONGO_SHEET_MAPPING, normalizeKey } from '../config/mongoSheetMapping.js';
import { logger } from '../utils/logger.js';

const META_ID = '__meta__';

/** No reliable natural key exists for this sheet (verified — see
 *  mongoSheetMapping.js) and it has no write-through path in this pass, so
 *  there's nothing to lose by fully replacing its collection each cycle.
 *  Strictly more correct than a key-based upsert that would collapse rows
 *  sharing a duplicate key value.
 *
 *  Delete+insert run inside a single Mongo transaction — this sheet's
 *  collection is shared with the other independent apps' backends, each
 *  running this exact same reconciliation on their own schedule (see
 *  splendid-rolling-candy.md). Without the transaction, two processes'
 *  deleteMany/insertMany calls can interleave (A deletes, B deletes+inserts,
 *  A inserts) and leave the collection with double the real row count —
 *  confirmed 2026-07-31 via a doubled Lease Expiry "Overdue" KPI (302 instead
 *  of 151). Wrapping both calls in one transaction makes each process's
 *  refresh atomic, so concurrent runs serialize instead of interleaving. */
async function reconcileSheetFullRefresh(sheetName, headers, rows) {
  const col = getCollection(sheetName);
  const now = new Date();

  if (!rows.length) {
    // A genuinely empty sheet is essentially impossible for anything mapped
    // as fullRefresh here (Deployed sheet, New Lease, Operation sheet all
    // carry live, ongoing business data) — a 0-row read is far more likely a
    // transient Sheets API hiccup (quota, timeout, a malformed response that
    // didn't throw) than reality. Wiping the mirror on that basis deletes
    // every row the whole app reads from while the real spreadsheet is
    // completely untouched — confirmed 2026-08-21, this exact path zeroed
    // out all three collections during a period of heavy quota pressure.
    // Skip the refresh entirely rather than risk it; the next successful
    // cycle (5 min later) re-syncs normally.
    logger.error(`[SYNC] Refusing to full-refresh ${sheetName}: fetched 0 rows — treating as a failed read, not a genuinely empty sheet. Mirror left untouched.`);
    return { sheetName, imported: 0, updated: 0, skippedBlankKey: 0, totalRows: 0, skippedEmptyGuard: true };
  }

  await withTransaction(async (session) => {
    await col.deleteMany({ _id: { $ne: META_ID } }, { session });
    await col.insertMany(rows.map((row, i) => ({ key: `row_${i}`, row, deletedAt: null, createdAt: now, updatedAt: now })), { session });
  });
  logger.info(`[SYNC] Inserted: ${rows.length}`);
  logger.info(`[SYNC] Updated: 0`);
  logger.info(`[SYNC] Skipped: 0`);
  return { sheetName, imported: rows.length, updated: 0, skippedBlankKey: 0, totalRows: rows.length };
}

async function reconcileSheetByKey(sheetName, mapping, rows) {
  const col = getCollection(sheetName);
  const now = new Date();

  const existingDocs = await col.find({ _id: { $ne: META_ID }, deletedAt: null }, { projection: { key: 1 } }).toArray();
  const existingKeys = new Set(existingDocs.map((d) => d.key));

  let imported = 0, updated = 0, skippedBlankKey = 0;
  const ops = [];
  const currentKeys = new Set();

  for (const row of rows) {
    const rawKey = row[mapping.naturalKeyColumn];
    if (rawKey == null || String(rawKey).trim() === '') { skippedBlankKey++; continue; }
    const key = normalizeKey(sheetName, rawKey);
    currentKeys.add(key);

    ops.push({
      updateOne: {
        filter: { key },
        update: { $set: { key, row, updatedAt: now, deletedAt: null }, $setOnInsert: { createdAt: now } },
        upsert: true
      }
    });
    if (existingKeys.has(key)) updated++; else imported++;
  }

  /* Soft-delete Mongo docs whose key no longer appears in the live sheet —
   * a row removed directly from the spreadsheet must stop being visible to
   * the app too. deletedAt (not a hard delete) matches the filter
   * getSheetDataFromMongo already reads through (deletedAt: null) and keeps
   * the doc recoverable if the removal was a mistake.
   *
   * BUG FOUND AND FIXED 2026-08-26: this function previously only ever
   * upserted rows found in the CURRENT sheet read — nothing here ever
   * noticed a key that used to exist and no longer does, so a manually
   * deleted row became a permanent "ghost" Mongo doc that the app kept
   * reading/showing forever once reads went Mongo-first (a removed lease
   * still listed in Verify Lease, a removed team member keeping their
   * permissions, etc.). The fullRefresh sheets (Deployed, Off-Lease
   * Tracking, Operation, ...) never had this problem — reconcileSheetFullRefresh
   * above wipes and rebuilds the whole collection every cycle, which
   * naturally drops anything no longer in the sheet. */
  const removedKeys = [...existingKeys].filter((k) => !currentKeys.has(k));
  let removed = 0;
  if (removedKeys.length) {
    const res = await col.updateMany({ key: { $in: removedKeys }, deletedAt: null }, { $set: { deletedAt: now, updatedAt: now } });
    removed = res.modifiedCount || 0;
  }

  if (ops.length) await col.bulkWrite(ops, { ordered: false });
  logger.info(`[SYNC] Inserted: ${imported}`);
  logger.info(`[SYNC] Updated: ${updated}`);
  logger.info(`[SYNC] Skipped: ${skippedBlankKey}`);
  if (removed) logger.info(`[SYNC] Removed (deleted from sheet): ${removed}`);
  return { sheetName, imported, updated, skippedBlankKey, removed, totalRows: rows.length };
}

export async function reconcileSheet(sheetName) {
  const mapping = MONGO_SHEET_MAPPING[sheetName];
  if (!mapping || (mapping.naturalKeyColumn == null && !mapping.fullRefresh)) return { sheetName, skipped: true };

  logger.info(`[SYNC] Fetching sheet: ${sheetName}`);
  const { headers, rows } = await getSheetData(sheetName);
  logger.info(`[SYNC] Read ${rows.length} rows`);
  const col = getCollection(sheetName);
  const now = new Date();

  logger.info(`[SYNC] Updating collection: ${sheetName}`);
  await col.updateOne({ _id: META_ID }, { $set: { headers, updatedAt: now } }, { upsert: true });

  const result = mapping.fullRefresh
    ? await reconcileSheetFullRefresh(sheetName, headers, rows)
    : await reconcileSheetByKey(sheetName, mapping, rows);

  logger.info(`[SYNC] Completed sheet: ${sheetName}`);
  return result;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Guards against two overlapping cycles racing the SAME collection. Under
// quota pressure a single sheet's read can retry for 20-30+ seconds (5
// attempts, exponential backoff), so a full cycle across every mapped sheet
// can run long enough to still be in progress when the next 5-minute cron
// tick fires. node-cron does not serialize registrations — a second
// runSheetsReconciliation() would start concurrently, and two overlapping
// full-refresh transactions on the same fullRefresh collection (each its
// own delete-then-insert) can commit out of order: whichever finishes LAST
// wins, even if its own read was the slower/staler one. Confirmed
// 2026-08-21: Deployed sheet was found wiped to 0 documents mid-session
// with no error logged and no single reconcile run showing an empty read —
// consistent with exactly this race, not a bug in any one cycle's own logic.
let cycleInProgress = false;

export async function runSheetsReconciliation() {
  if (cycleInProgress) {
    logger.warn('[SYNC] Skipping sync cycle — a previous cycle is still running (likely quota-retry backlog).');
    return [];
  }
  cycleInProgress = true;
  const cycleStart = Date.now();
  try {
    logger.info('[SYNC] Starting sync cycle');
    const sheetNames = Object.keys(MONGO_SHEET_MAPPING);
    const results = [];
    for (let i = 0; i < sheetNames.length; i++) {
      const sheetName = sheetNames[i];
      try {
        const r = await reconcileSheet(sheetName);
        results.push(r);
      } catch (err) {
        logger.error(`[SYNC ERROR] Failed to fetch sheet ${sheetName}`);
        logger.error(`[SYNC ERROR] Reason: ${err?.message || err}`);
      }
      // A gap between sheets — 9 back-to-back full-sheet reads can burn
      // through the "requests per minute" cap on their own, even with nothing
      // else contending for it (confirmed 2026-08-08: this exact cycle hit the
      // wall on sheet 8 of 9; confirmed AGAIN 2026-08-26 that 1.5s wasn't
      // enough — this job alone, plus the FMS refresh two minutes later in
      // the same cycle, was tripping the GLOBAL quota lockout roughly every
      // 5 minutes, all day, independent of any real user traffic). Widened
      // to 4s: spreads these 9 reads over ~32s instead of ~12s, so fewer of
      // them land inside any single 60-second lookback window. Skip the
      // wait after the last sheet.
      if (i < sheetNames.length - 1) await sleep(4000);
    }
    logger.info(`[SYNC] Sync cycle completed in ${((Date.now() - cycleStart) / 1000).toFixed(1)}s`);
    return results;
  } finally {
    cycleInProgress = false;
  }
}
