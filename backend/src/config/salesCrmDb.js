/**
 * READ-ONLY connection to the Sales CRM Atlas cluster.
 *
 * This is a SECOND, entirely separate cluster from this app's own
 * MONGODB_URI (config/db.js — cluster0.../db "Lease"): different host,
 * different credentials, different database. It is owned by the Sales CRM
 * app, and this backend is a guest in it.
 *
 * ★★★ THIS MODULE MUST NEVER WRITE. ★★★
 * Company -> salesperson assignment is edited exclusively in the Sales CRM
 * (admin reassigns a lead there); the Lease Management app only mirrors the
 * result onto the Lease Expiry screen. Nobody reassigns a company from this
 * app. That is why this file deliberately exposes NO client, NO db and NO
 * collection handle — only `findLeads()` below, which issues a projected
 * find() and nothing else. Keep it that way: adding an insert/update/delete
 * helper here (or exporting the raw collection so a caller could add one)
 * would breach the contract this integration was built under.
 *
 * Optional by design: with SALES_CRM_MONGODB_URI unset, connect() is never
 * attempted and every caller falls back to its pre-existing behaviour.
 */
import { MongoClient } from 'mongodb';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

let client = null;
let connecting = null;

/** True when the CRM integration is configured at all. */
export function isSalesCrmConfigured() {
  return Boolean(env.salesCrmUri);
}

/**
 * Lazily connects on first use (never at boot) — the CRM being down, slow or
 * unconfigured must never stop this app from starting or from serving the
 * Lease Expiry page.
 *
 * The DNS + TLS 1.2 workarounds this network needs are process-global and
 * are applied in config/db.js, which is always loaded first (server.js calls
 * connectMongo() at boot, and every caller of this module reaches it through
 * services that import mongo.service.js). No SRV lookup is involved here in
 * any case — the CRM URI is a direct 3-host replica-set string.
 */
async function getClient() {
  if (client) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    const c = new MongoClient(env.salesCrmUri, {
      // Read-only consumer: a short selection timeout so a CRM outage
      // degrades the page in seconds (falling back to the sheet's own Sale
      // Person value) instead of hanging the request.
      serverSelectionTimeoutMS: 8000,
      // Belt-and-braces signals that this connection is not a writer.
      retryWrites: false,
      readPreference: 'primaryPreferred'
    });
    await c.connect();
    logger.info(`[SALES-CRM] Connected (read-only) to ${env.salesCrmDbName}`);
    client = c;
    connecting = null;
    return c;
  })().catch((e) => {
    connecting = null;
    throw e;
  });
  return connecting;
}

/**
 * The ONLY database access this module offers: a projected find() against
 * the leads collection. `projection` is required so a caller cannot pull the
 * whole CRM document set through here by accident.
 */
export async function findLeads(filter, projection) {
  const c = await getClient();
  return c
    .db(env.salesCrmDbName)
    .collection(env.salesCrmLeadsCollection)
    .find(filter || {}, { projection })
    .toArray();
}

/** Closes the read-only client (tests/shutdown only). */
export async function closeSalesCrm() {
  if (client) { const c = client; client = null; await c.close(); }
}
