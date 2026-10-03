/**
 * Optional secrets loaded from Mongo instead of the server's own .env — a
 * deliberate escape hatch for when nobody currently has shell/SSH access to
 * the production box to add a new .env line (confirmed live 2026-10-03:
 * REFUND_REVIEW_SECRET was needed on production with no one on the team
 * holding a working SSH key or hosting-provider login at the time).
 *
 * A real .env value always wins — this only fills in whatever env.js left
 * blank (see each `if (!env.X)` check below), so a later .env edit by
 * someone who does get server access silently takes back over with no code
 * change needed here.
 *
 * Collection "_runtime_config", one document (id 'secrets'). Deliberately
 * never committed to git (unlike .env, this lives only in the same private,
 * access-controlled MongoDB Atlas cluster every other write in this app
 * already goes through) — set directly via a one-off script run with this
 * app's own Mongo credentials, which requires no production server access at
 * all, only the same MONGODB_URI already in this developer's local .env.
 */
import { getCollection } from '../services/mongo.service.js';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

const RUNTIME_SECRETS_ID = 'secrets';

export async function loadRuntimeSecretsFromMongo() {
  try {
    const doc = await getCollection('_runtime_config').findOne({ _id: RUNTIME_SECRETS_ID });
    if (!doc) return;
    if (!env.refundReviewSecret && doc.REFUND_REVIEW_SECRET) {
      env.refundReviewSecret = doc.REFUND_REVIEW_SECRET;
      logger.info('[env] REFUND_REVIEW_SECRET loaded from Mongo runtime config (no .env value set on this server).');
    }
  } catch (e) {
    // Best-effort — a failure here must not stop the server from starting;
    // it just means these optional features stay in their already-documented
    // degraded mode (see env.js's own warnings) until this is retried.
    logger.error('[env] Could not load runtime secrets from Mongo (non-fatal):', e?.message || e);
  }
}
