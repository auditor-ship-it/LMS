/**
 * Periodic Sheets -> Mongo reconciliation — the "bridge" the user asked for:
 * catches direct manual edits made in the live spreadsheet (outside the
 * app), and resurrects any outbox entry that exhausted its retries instead
 * of silently dropping it. Runs on a cron schedule (jobs/index.js), gated
 * behind ENABLE_SHEETS_SYNC.
 *
 * Scope note: this pass only reconciles the sheets listed in
 * config/mongoSheetMapping.js (the ones the dashboard/tasks/roles domains
 * actually read from Mongo now) — not all 35 tabs. The original one-time
 * drop-and-recreate script (sheets-mongo-sync/syncSheetsToMongo.js) is left
 * untouched as a separate disaster-recovery tool; this job supersedes it
 * only for the sheets it covers, using incremental upserts instead of a
 * full wipe, per the "avoid dropping collections every time" requirement.
 *
 * Never deletes a Mongo doc just because its sheet row disappeared — a
 * still-in-flight outbox delete looks the same from here, so deciding "the
 * row is really gone" is left to the outbox delete handler completing, not
 * to this job noticing an absence.
 */
import { getSheetData } from '../services/googleSheets.service.js';
import { getCollection, withTransaction } from '../services/mongo.service.js';
import { MONGO_SHEET_MAPPING, normalizeKey } from '../config/mongoSheetMapping.js';
import { logger } from '../utils/logger.js';

const META_ID = '__meta__';
const OUTBOX_COLLECTION = '_sync_outbox';

async function resurrectDeadEntries() {
  const now = new Date();
  const res = await getCollection(OUTBOX_COLLECTION).updateMany(
    { status: 'dead' },
    { $set: { status: 'pending', attempts: 0, nextAttemptAt: now, lastError: null, updatedAt: now } }
  );
  if (res.modifiedCount) {
    logger.warn(`[SYNC] Resurrected ${res.modifiedCount} dead outbox entr${res.modifiedCount === 1 ? 'y' : 'ies'}`);
  }
}

// outboxWorker.js's claimBatch marks an entry 'processing' BEFORE running its
// handler — if the process restarts between those two steps (this backend
// restarts often during active development, e.g. every code edit under
// `node --watch`), that entry is orphaned: claimBatch only ever re-claims
// 'pending'/'failed', never 'processing', so it would sit there forever,
// permanently un-pushed to Sheets, with nothing in the logs to say so.
// Confirmed 2026-08-08: 68 entries stuck this way, some over a week old.
// Reset to 'pending' at its ORIGINAL createdAt (already in the past, so
// immediately due) rather than "now", so claimBatch's nextAttemptAt-ascending
// sort replays multiple stuck writes to the same cell in their original
// order — the last one replayed is the same final value Mongo already holds.
const STUCK_PROCESSING_MS = 3 * 60 * 1000; // generous vs. a single Sheets push's normal ~1s
async function resurrectStuckProcessing() {
  const cutoff = new Date(Date.now() - STUCK_PROCESSING_MS);
  const col = getCollection(OUTBOX_COLLECTION);
  const stuck = await col.find({ status: 'processing', updatedAt: { $lt: cutoff } }).toArray();
  if (!stuck.length) return;
  const now = new Date();
  for (const entry of stuck) {
    await col.updateOne(
      { _id: entry._id, status: 'processing' },
      { $set: { status: 'pending', nextAttemptAt: entry.createdAt, updatedAt: now } }
    );
  }
  logger.warn(`[SYNC] Resurrected ${stuck.length} stuck 'processing' outbox entr${stuck.length === 1 ? 'y' : 'ies'} (backend likely restarted mid-push)`);
}

/** documentId strings (as string, to match ObjectId#toString) with a
 *  not-yet-finished outbox push targeting this sheet — reconciliation must
 *  never overwrite these, or it would clobber a Mongo-first write that
 *  hasn't reached Sheets yet with the (still old) value it just read. */
async function inFlightDocIds(sheetName) {
  const entries = await getCollection(OUTBOX_COLLECTION)
    .find({ targetSheet: sheetName, status: { $in: ['pending', 'processing', 'failed'] } }, { projection: { documentId: 1 } })
    .toArray();
  return new Set(entries.map((e) => String(e.documentId)));
}

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
  await withTransaction(async (session) => {
    await col.deleteMany({ _id: { $ne: META_ID } }, { session });
    if (rows.length) {
      await col.insertMany(rows.map((row, i) => ({ key: `row_${i}`, row, deletedAt: null, createdAt: now, updatedAt: now })), { session });
    }
  });
  logger.info(`[SYNC] Inserted: ${rows.length}`);
  logger.info(`[SYNC] Updated: 0`);
  logger.info(`[SYNC] Skipped: 0`);
  return { sheetName, imported: rows.length, updated: 0, skippedInFlight: 0, skippedBlankKey: 0, totalRows: rows.length };
}

async function reconcileSheetByKey(sheetName, mapping, rows) {
  const col = getCollection(sheetName);
  const now = new Date();

  const [existingDocs, inFlight] = await Promise.all([
    col.find({ _id: { $ne: META_ID } }, { projection: { key: 1 } }).toArray(),
    inFlightDocIds(sheetName)
  ]);
  const existingKeyToId = new Map(existingDocs.map((d) => [d.key, String(d._id)]));

  let imported = 0, updated = 0, skippedInFlight = 0, skippedBlankKey = 0;
  const ops = [];

  for (const row of rows) {
    const rawKey = row[mapping.naturalKeyColumn];
    if (rawKey == null || String(rawKey).trim() === '') { skippedBlankKey++; continue; }
    const key = normalizeKey(sheetName, rawKey);

    const existingId = existingKeyToId.get(key);
    if (existingId && inFlight.has(existingId)) { skippedInFlight++; continue; }

    ops.push({
      updateOne: {
        filter: { key },
        update: { $set: { key, row, updatedAt: now, deletedAt: null }, $setOnInsert: { createdAt: now } },
        upsert: true
      }
    });
    if (existingId) updated++; else imported++;
  }

  if (ops.length) await col.bulkWrite(ops, { ordered: false });
  const skipped = skippedInFlight + skippedBlankKey;
  logger.info(`[SYNC] Inserted: ${imported}`);
  logger.info(`[SYNC] Updated: ${updated}`);
  logger.info(`[SYNC] Skipped: ${skipped}`);
  return { sheetName, imported, updated, skippedInFlight, skippedBlankKey, totalRows: rows.length };
}

async function reconcileSheet(sheetName) {
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

export async function runSheetsReconciliation() {
  const cycleStart = Date.now();
  logger.info('[SYNC] Starting sync cycle');
  await resurrectDeadEntries();
  await resurrectStuckProcessing();
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
    // A small gap between sheets — 9 back-to-back full-sheet reads can burn
    // through the "requests per minute" cap on their own, even with nothing
    // else contending for it (confirmed 2026-08-08: this exact cycle hit the
    // wall on sheet 8 of 9). Skip the wait after the last sheet.
    if (i < sheetNames.length - 1) await sleep(1500);
  }
  logger.info(`[SYNC] Sync cycle completed in ${((Date.now() - cycleStart) / 1000).toFixed(1)}s`);
  return results;
}
