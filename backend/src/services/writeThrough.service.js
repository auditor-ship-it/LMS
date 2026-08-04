import { getCollection, withTransaction } from './mongo.service.js';
import { logger } from '../utils/logger.js';

const OUTBOX_COLLECTION = '_sync_outbox';
const DEFAULT_MAX_ATTEMPTS = 8;

/**
 * Mongo-first write helper: does the Mongo write and enqueues the matching
 * Sheets-push outbox entry in a single transaction, so a write can never
 * succeed in Mongo with no corresponding outbox entry to mirror it to
 * Sheets. Returns immediately once Mongo has committed — the actual Sheets
 * push happens later, asynchronously, via jobs/outboxWorker.js.
 *
 * mode: 'insert' | 'update' | 'upsert' | 'delete' (soft — sets deletedAt,
 * never removes the doc, so a still-pending delete-push is never confused
 * with "row came back").
 *
 * sheetPush.handler is a lookup key into jobs/outboxHandlers.js, resolved
 * later by the outbox worker — writeThrough itself never touches Sheets.
 */
export async function writeThrough({ collection, filter, update, mode, actor, sheetPush }) {
  if (!sheetPush || !sheetPush.targetSheet || !sheetPush.operation || !sheetPush.handler) {
    throw new Error('writeThrough: sheetPush.{targetSheet,operation,handler} are required');
  }
  const start = process.hrtime.bigint();

  const result = await withTransaction(async (session) => {
    const col = getCollection(collection);
    const now = new Date();
    let id;
    let doc;
    let matched = true;

    if (mode === 'insert') {
      const toInsert = { ...update, createdAt: now, updatedAt: now };
      const res = await col.insertOne(toInsert, { session });
      id = res.insertedId;
      doc = { _id: id, ...toInsert };
    } else if (mode === 'update' || mode === 'upsert') {
      const mergedUpdate = { ...update, $set: { ...(update.$set || {}), updatedAt: now } };
      doc = await col.findOneAndUpdate(filter, mergedUpdate, {
        session,
        upsert: mode === 'upsert',
        returnDocument: 'after'
      });
      if (!doc) matched = false;
      else id = doc._id;
    } else if (mode === 'delete') {
      doc = await col.findOneAndUpdate(
        filter,
        { $set: { deletedAt: now, updatedAt: now } },
        { session, returnDocument: 'after' }
      );
      if (!doc) matched = false;
      else id = doc._id;
    } else {
      throw new Error(`writeThrough: unknown mode '${mode}'`);
    }

    if (!matched) return { id: null, doc: null, matched: false };

    await getCollection(OUTBOX_COLLECTION).insertOne({
      targetSheet: sheetPush.targetSheet,
      documentId: id,
      operation: sheetPush.operation,
      handler: sheetPush.handler,
      payload: sheetPush.payload || {},
      actor: actor || null,
      status: 'pending',
      attempts: 0,
      maxAttempts: sheetPush.maxAttempts || DEFAULT_MAX_ATTEMPTS,
      nextAttemptAt: now,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null
    }, { session });

    return { id, doc, matched: true };
  });

  const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
  logger.debug(
    `[DB] Collection: ${collection} | Operation: ${mode} (write-through) | ` +
    `Matched: ${result.matched} | Duration: ${durationMs.toFixed(1)}ms | ` +
    `Outbox: ${result.matched ? `enqueued (${sheetPush.handler})` : 'skipped (no match)'}`
  );
  return result;
}
