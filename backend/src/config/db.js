import dns from 'node:dns';
import tls from 'node:tls';
import { MongoClient } from 'mongodb';
import { env } from './env.js';
import { logger } from '../utils/logger.js';
import { touchSource } from '../utils/requestContext.js';

// This machine's configured DNS server (often 127.0.0.1 behind a VPN/proxy)
// fails to resolve the `mongodb+srv://` SRV record even though the OS
// resolver works fine. Point Node at a public resolver so the SRV lookup
// mongodb+srv:// depends on succeeds. Confirmed necessary while building
// sheets-mongo-sync/syncSheetsToMongo.js against this same cluster.
dns.setServers(['8.8.8.8', '1.1.1.1']);

// This network's TLS 1.3 handshake to the Atlas shards gets killed with a
// tlsv1 alert internal_error (a firewall/middlebox quirk with TLS 1.3 on
// this specific route) — TLS 1.2 to the same hosts completes cleanly.
tls.DEFAULT_MAX_VERSION = 'TLSv1.2';

let client = null;
let db = null;

// Command names the driver fires constantly for connection-pool housekeeping
// (heartbeats, auth, cursor cleanup) — not queries the app cares about seeing.
const NOISE_COMMANDS = new Set(['hello', 'ismaster', 'ping', 'endSessions', 'saslStart', 'saslContinue']);

function collectionOf(commandName, command) {
  // getMore's own field holds the cursor id, not a collection name — the
  // actual collection is in `command.collection` for that one command.
  if (commandName === 'getMore') return command?.collection || '(unknown)';
  return command?.[commandName] || command?.collection || '(unknown)';
}

/** Best-effort record count from the raw server reply — accurate for
 *  insert/update/delete (server reports `n` directly); for find/aggregate
 *  this is just the first batch (Mongo's default page size, ~101 docs) —
 *  see mongoSheetData.service.js/writeThrough.service.js for the accurate
 *  full-count logs on the two funnels essentially all app traffic goes
 *  through today. */
function describeReply(commandName, reply) {
  if (!reply) return null;
  if (reply.cursor) return (reply.cursor.firstBatch || reply.cursor.nextBatch || []).length;
  if (typeof reply.n === 'number') return reply.n;
  return null;
}

export async function connectMongo() {
  if (db) return db;
  logger.info('[DB] Connecting to MongoDB...');
  client = new MongoClient(env.mongoUri, { monitorCommands: true });

  // commandSucceeded/commandFailed don't carry the original command — only
  // commandStarted does — so stash what we need per requestId and consume it
  // when the matching succeeded/failed event fires.
  const pending = new Map();

  client.on('commandStarted', (event) => {
    if (NOISE_COMMANDS.has(event.commandName)) return;
    touchSource('mongo');
    pending.set(event.requestId, { collection: collectionOf(event.commandName, event.command) });
  });

  client.on('commandSucceeded', (event) => {
    if (NOISE_COMMANDS.has(event.commandName)) return;
    const info = pending.get(event.requestId);
    pending.delete(event.requestId);
    const count = describeReply(event.commandName, event.reply);
    logger.debug(
      `[DB] Collection: ${info?.collection || '(unknown)'} | Operation: ${event.commandName} | ` +
      (count != null ? `Returned/Affected: ${count} | ` : '') +
      `Duration: ${event.duration}ms`
    );
  });

  client.on('commandFailed', (event) => {
    if (NOISE_COMMANDS.has(event.commandName)) return;
    const info = pending.get(event.requestId);
    pending.delete(event.requestId);
    logger.error(`[ERROR] MongoDB query failed | Collection: ${info?.collection || '(unknown)'} | Operation: ${event.commandName} | ${event.failure?.message || event.failure}`);
  });

  await client.connect();
  db = client.db(env.mongoDbName);
  logger.info(`[DB] MongoDB connected successfully (db: ${env.mongoDbName})`);
  return db;
}

export function getDb() {
  if (!db) throw new Error('Mongo not connected yet — call connectMongo() at boot before using getDb()');
  return db;
}

export function getMongoClient() {
  if (!client) throw new Error('Mongo not connected yet — call connectMongo() at boot before using getMongoClient()');
  return client;
}
