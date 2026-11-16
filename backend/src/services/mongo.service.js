import { getDb, getMongoClient } from '../config/db.js';
import { isCentral, isSheetMirrorName, centralMirrorCollection } from './centralSheets.service.js';

/** Singleton collection accessor — every domain service should go through this
 *  instead of holding its own reference, so there's exactly one connection. */
export function getCollection(name) {
  // DATA_SOURCE=central: the old Sheets-mirror collections are the central `lease` tables.
  // Every other collection (sessions, api keys, outbox, flags, ...) stays on Mongo for now.
  if (isCentral() && isSheetMirrorName(name)) return centralMirrorCollection(name);
  return getDb().collection(name);
}

/**
 * Runs `fn(session)` inside a Mongo multi-document transaction (Atlas
 * replica sets, including the free/shared tiers, support this). Used by
 * writeThrough so "the app's Mongo write" and "the outbox entry recording
 * that a Sheets push is owed" either both commit or neither does — the
 * outbox can never silently fail to be created for a write that succeeded.
 */
export async function withTransaction(fn) {
  const session = getMongoClient().startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
