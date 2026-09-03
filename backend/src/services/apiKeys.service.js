/**
 * Public API key management. A key is a standing bearer credential — anyone
 * holding the raw string can call /api/public/v1/* with no LMS login at all
 * — so only the SHA-256 hash is ever persisted; the raw value is returned
 * exactly once, at creation, and never again (same principle as a GitHub
 * personal access token).
 *
 * Storage is Mongo (collection `_api_keys`, same "_"-prefixed convention as
 * auth.service.js's `_auth_sessions`) — this is operational security config,
 * not business data, so it has no Sheets mirror and never will.
 *
 * SCOPE MODEL: each domain (see API_DOMAINS) can be granted at two levels —
 * `<domain>` (read) or `<domain>:write` (read+write; write always implies
 * read, so a write-scoped domain never also needs its bare read token).
 * `all`/`all:write` are the blanket equivalents across every domain.
 *
 * WRITE IS "ACTS AS", NOT AMBIENT. A write-scoped key is not its own
 * identity for permission purposes — some internal write paths
 * (offlease.service.js's saveOffLeaseStage/saveOffLeaseApprovalAction) call
 * checkActionPermission(type, userEmail) INSIDE the service itself, against
 * a real LMS user's email, and a synthetic "api-key" identity would simply
 * fail that check. So instead, every write-scoped key names a real LMS user
 * (`actsAsEmail`) and every write it performs runs with EXACTLY that
 * person's existing permissions and audit trail — identical to them using
 * the app directly. This also means a write key can never do more than its
 * named person already could; narrowing what it can do means picking
 * someone with narrower access, not a separate scope knob.
 */
import crypto from 'crypto';
import { ObjectId } from 'mongodb';
import { getCollection } from './mongo.service.js';
import { cacheGet, cachePut } from '../utils/memoryCache.js';
import { AppError, notFound } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';

const COLLECTION = '_api_keys';
const KEY_PREFIX = 'lms_pub_';

/** The data domains a key's scope can name — see routes/public.routes.js for what each maps to.
 *  Lowercase only: normalizeScopes() below lowercases every incoming scope
 *  token before checking it against this list, so a mixed-case key here
 *  could never actually be granted. */
export const API_DOMAINS = ['leases', 'offlease', 'accounts', 'offleaseefficiency'];

/** Domains with an actual write endpoint wired in public.routes.js. `accounts`
 *  and `offleaseefficiency` are read-only everywhere in this app — the
 *  former is a proxy to the external Accounts & Collection API (LMS never
 *  writes ledger data, see sales-crm-read-only.md for the same posture on a
 *  different domain), the latter is a pure reporting aggregate
 *  (offleaseEfficiency.service.js writes nothing at all). */
export const WRITE_CAPABLE_DOMAINS = ['leases', 'offlease'];

let indexEnsured = false;
async function ensureIndex() {
  if (indexEnsured) return;
  indexEnsured = true;
  try {
    await getCollection(COLLECTION).createIndex({ keyHash: 1 }, { unique: true });
  } catch (e) { logger.error('[API-KEYS] Failed to ensure index:', e?.message || e); }
}

function hash(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function toPublicShape(doc) {
  const { keyHash, _id, ...rest } = doc;
  return { id: String(_id), ...rest };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeScopes(scopes) {
  const requested = Array.isArray(scopes) ? [...new Set(scopes.map((s) => String(s).trim().toLowerCase()))] : [];
  if (!requested.length) throw new AppError('Select at least one data scope for this key.', 400);

  const allowedValues = [
    ...API_DOMAINS,
    ...WRITE_CAPABLE_DOMAINS.map((d) => `${d}:write`),
    'all',
    'all:write'
  ];
  const bad = requested.filter((s) => !allowedValues.includes(s));
  if (bad.length) throw new AppError(`Unknown scope(s): ${bad.join(', ')}. "accounts" has no write endpoint — it stays read-only.`, 400);

  // Write implies read, so a bare domain token is redundant once that
  // domain's :write token is also requested — drop it rather than store
  // two tokens that mean the same thing.
  let cleanScopes = requested.filter((s) => s.endsWith(':write') || !requested.includes(`${s}:write`));

  // 'all:write' is a superset of literally everything else requested.
  if (cleanScopes.includes('all:write')) {
    cleanScopes = ['all:write'];
  } else if (cleanScopes.includes('all')) {
    // 'all' only grants read — an individual domain's :write token still adds
    // something 'all' alone doesn't, so those are kept alongside it.
    cleanScopes = ['all', ...cleanScopes.filter((s) => s.endsWith(':write'))];
  }

  const hasAnyWrite = cleanScopes.some((s) => s.endsWith(':write'));
  return { cleanScopes, hasAnyWrite };
}

export async function createApiKey({ label, scopes, actsAsEmail, createdBy }) {
  await ensureIndex();

  const cleanLabel = String(label || '').trim();
  if (!cleanLabel) throw new AppError('A label is required, so you know who this key was issued to.', 400);

  const { cleanScopes, hasAnyWrite } = normalizeScopes(scopes);

  const cleanActsAs = String(actsAsEmail || '').trim().toLowerCase();
  if (hasAnyWrite) {
    if (!cleanActsAs || !EMAIL_RE.test(cleanActsAs)) {
      throw new AppError('Write access requires a real LMS user email to act as — writes run with exactly that person\'s permissions.', 400);
    }
  }

  const raw = `${KEY_PREFIX}${crypto.randomBytes(24).toString('hex')}`;
  const doc = {
    label: cleanLabel,
    keyHash: hash(raw),
    keyPreview: `${raw.slice(0, KEY_PREFIX.length + 6)}…${raw.slice(-4)}`,
    scopes: cleanScopes,
    actsAsEmail: hasAnyWrite ? cleanActsAs : null,
    createdBy,
    createdAt: new Date(),
    revoked: false,
    revokedAt: null,
    revokedBy: null,
    lastUsedAt: null
  };
  const { insertedId } = await getCollection(COLLECTION).insertOne(doc);
  logger.info(`[API-KEYS] "${cleanLabel}" created (scopes: ${cleanScopes.join(', ')}${hasAnyWrite ? `, acts as ${cleanActsAs}` : ''}) by ${createdBy}`);
  // rawKey is returned ONLY here — it is never stored and never retrievable again.
  return { ...toPublicShape({ ...doc, _id: insertedId }), rawKey: raw };
}

/** True when `scopes` grants at least read on `domain`. Write implies read. */
export function hasReadAccess(scopes, domain) {
  return scopes.includes(domain) || scopes.includes(`${domain}:write`) || scopes.includes('all') || scopes.includes('all:write');
}

/** True when `scopes` grants write on `domain` — only meaningful for WRITE_CAPABLE_DOMAINS. */
export function hasWriteAccess(scopes, domain) {
  return scopes.includes(`${domain}:write`) || scopes.includes('all:write');
}

export async function listApiKeys() {
  await ensureIndex();
  const docs = await getCollection(COLLECTION).find({}).sort({ createdAt: -1 }).toArray();
  return docs.map(toPublicShape);
}

export async function revokeApiKey(id, revokedBy) {
  await ensureIndex();
  let objectId;
  try { objectId = new ObjectId(id); } catch { throw notFound('API key not found.'); }
  const res = await getCollection(COLLECTION).findOneAndUpdate(
    { _id: objectId, revoked: false },
    { $set: { revoked: true, revokedAt: new Date(), revokedBy } },
    { returnDocument: 'after' }
  );
  if (!res) throw notFound('API key not found, or already revoked.');
  logger.info(`[API-KEYS] "${res.label}" revoked by ${revokedBy}`);
  return toPublicShape(res);
}

/**
 * Verifies a raw key from an incoming request. Every attempt (valid or not)
 * skips straight to a Mongo lookup by hash — no per-key rate limiting lives
 * here, that's the caller's job (middlewares/publicApiAuth.middleware.js) —
 * this function only answers "is this key good, and what can it read".
 * `lastUsedAt` is bumped best-effort and never blocks/fails the caller.
 */
export async function verifyApiKey(raw) {
  if (!raw || typeof raw !== 'string' || !raw.startsWith(KEY_PREFIX)) return null;
  await ensureIndex();
  const doc = await getCollection(COLLECTION).findOne({ keyHash: hash(raw), revoked: false });
  if (!doc) return null;
  getCollection(COLLECTION)
    .updateOne({ _id: doc._id }, { $set: { lastUsedAt: new Date() } })
    .catch((e) => logger.error('[API-KEYS] lastUsedAt bump failed (non-fatal):', e?.message || e));
  return toPublicShape(doc);
}

const RATE_LIMIT_PER_MINUTE = 120;

/** Best-effort sliding-window limiter keyed per API key id, reusing the same
 *  in-process cache auth.service.js already uses for login lockouts/OTPs —
 *  see memoryCache.js's own header comment, which names "rate-limit
 *  counters" as one of its intended uses. Not distributed/exact, which is
 *  fine for a defensive abuse guard rather than a billing-grade limiter. */
export function checkPublicApiRateLimit(keyId) {
  const cacheKey = `ratelimit:pubapi:${keyId}`;
  const count = cacheGet(cacheKey) || 0;
  if (count >= RATE_LIMIT_PER_MINUTE) return false;
  cachePut(cacheKey, count + 1, 60);
  return true;
}
