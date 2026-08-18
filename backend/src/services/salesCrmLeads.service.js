/**
 * Company -> salesperson, sourced LIVE from the Sales CRM.
 *
 * WHY THIS EXISTS
 * The Deployed sheet carries its own "Sale Person" column (index 9), but it
 * is a hand-maintained copy that drifts: when an admin reassigns a company
 * to a different salesperson in the Sales CRM, nothing updates that column.
 * The CRM's `existing_leads` collection is the authority — one document per
 * company, `assignedTo` naming the current owner, with `assignmentHistory` /
 * `_reassignedAt` recording each handover. Lease Expiry (and Renew &
 * Document, which shares the same backend read) now shows THAT value.
 *
 * ★★★ READ-ONLY. ★★★ Reassignment happens in the Sales CRM and nowhere else.
 * This app never inserts, updates or deletes anything in that cluster — see
 * config/salesCrmDb.js, which exposes a projected find() and nothing more.
 *
 * MATCHING
 * The two systems name companies by hand, so they never match byte-for-byte.
 * Two passes, strictest first:
 *   1. EXACT — case/punctuation-insensitive equality, after stripping the
 *      CRM's "(New)"/"(Added)" provenance marker (stripProvenance below).
 *   2. FUZZY — normClientName() (drops "c/o ..." tails, "unit N", corporate
 *      suffixes), and ONLY when that key resolves to exactly ONE salesperson
 *      across the whole CRM. Covers a further 8 rows ("LAURUS LABS LIMITED"
 *      vs "Laurus Labs Ltd"). A fuzzy key naming two different salespeople
 *      is dropped rather than guessed — the same measurement found zero such
 *      keys today, but a future lead could create one.
 * Anything still unmatched keeps the sheet's own value, so the column never
 * goes blank because of this feature. That is 4 of 354 rows today — one
 * customer the CRM spells differently enough that only a human can call it
 * ("ORBITTAL ... ENGINEERING PROJECTS PVT LTD" vs the CRM's "Orbittal ...
 * Engineering Project Pvt"), where both systems happen to name the same
 * owner anyway.
 */
import { findLeads, isSalesCrmConfigured } from '../config/salesCrmDb.js';
import { env } from '../config/env.js';
import { normClientName } from '../utils/normalize.js';
import { logger } from '../utils/logger.js';
import { AppError } from '../utils/AppError.js';

/**
 * The CRM records how a lead ENTERED the system by appending a marker to the
 * company name: "(New)" (98 leads today) and "(Added)" (21). That is
 * provenance, not identity — "KPN FARM FRESH PRIVATE LIMITED (New)" is the
 * same customer the Deployed sheet calls "KPN FARM FRESH PRIVATE LIMITED",
 * and leaving the marker in the key is exactly what kept that container
 * showing its stale sheet owner ("Pushpalata") after the lead had been
 * reassigned to Gauri.
 *
 * ONLY these two, and only in trailing position. Every other trailing
 * parenthetical this collection uses is identifying and must be preserved:
 * "(SEZ)", "(EOU)", "(Unit VI)", "(Karnataka)", "(Hyderabad)" distinguish
 * real sites of one company that can belong to DIFFERENT salespeople —
 * Dr Reddy's alone has eleven such leads. Stripping parentheticals in
 * general would merge them and start attributing containers to whichever
 * site's owner happened to sort last.
 */
const LEAD_PROVENANCE_SUFFIX = /\s*\((?:new|added)\)\s*$/i;

function stripProvenance(name) {
  return String(name == null ? '' : name).replace(LEAD_PROVENANCE_SUFFIX, '');
}

/** Corporate suffixes that carry no identity — same list normClientName
 *  drops, needed separately here to test an initialism against the words
 *  that actually name the company. */
const NAME_STOPWORDS = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'company', 'co', 'corporation', 'corp', 'inc', 'and', 'the']);

/**
 * Drops a trailing "(ABC)" ONLY when ABC is the initialism of the words
 * before it — "Hatsun Agro Product Ltd (HAP)" is the same customer the
 * Deployed sheet calls "HATSUN AGRO PRODUCT LIMITED".
 *
 * The rule is self-validating, which is the whole point of shaping it this
 * way rather than keeping a list of abbreviations to strip: "(SEZ)", "(EOU)",
 * "(India)", "(Karnataka)" are not initialisms of the names they follow, so
 * they survive untouched and the site-level leads they distinguish stay
 * distinct. It fires on exactly one lead in the collection today.
 */
function stripInitialism(name) {
  const m = String(name).trim().match(/^(.*?)\s*\(([A-Za-z]{2,6})\)$/);
  if (!m) return String(name);
  const words = m[1].toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !NAME_STOPWORDS.has(w));
  return words.map((w) => w[0]).join('') === m[2].toLowerCase() ? m[1] : String(name);
}

/** The company name reduced to the parts that actually identify the customer,
 *  before either matching pass keys off it. */
function canonicalName(name) {
  return stripInitialism(stripProvenance(name));
}

/** Case/punctuation-insensitive company key. Deliberately stricter than
 *  fuzzyKey: it keeps "Cipla Unit 1" distinct from "Cipla Unit 2", which are
 *  separate leads with potentially separate owners. */
function exactKey(name) {
  return canonicalName(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Looser key for pass 2 — see the MATCHING note in the file header. */
function fuzzyKey(name) {
  return normClientName(canonicalName(name));
}

/** When two CRM leads collapse to the same key, the most recently touched
 *  one wins — a reassignment stamps `_reassignedAt`, and a master-sheet
 *  refresh stamps `_lastUpdatedAt`. */
function leadTimestamp(lead) {
  const a = lead?._reassignedAt ? new Date(lead._reassignedAt).getTime() : 0;
  const b = lead?._lastUpdatedAt ? new Date(lead._lastUpdatedAt).getTime() : 0;
  return Math.max(Number.isFinite(a) ? a : 0, Number.isFinite(b) ? b : 0);
}

/* Module-level cache. `inFlight` collapses concurrent builds into one CRM
   read — My Task calls getExpiryDataByFilter twice per request, and several
   employees hit these pages at the same time each morning. */
let cache = null;        // { exact: Map, fuzzy: Map, gen: number, expiresAt: number }
let inFlight = null;
let generation = 0;      // ordering tag, see commit()

async function buildIndex() {
  const gen = ++generation;
  const leads = await findLeads({}, { companyName: 1, assignedTo: 1, _reassignedAt: 1, _lastUpdatedAt: 1 });

  const exact = new Map();          // key -> { who, ts }
  const fuzzyRaw = new Map();       // key -> Map(who -> ts)

  for (const lead of leads) {
    const who = String(lead?.assignedTo == null ? '' : lead.assignedTo).trim();
    if (!who) continue;             // an unassigned lead must not blank out the sheet value
    const ts = leadTimestamp(lead);

    const ek = exactKey(lead.companyName);
    if (ek) {
      const prev = exact.get(ek);
      if (!prev || ts >= prev.ts) exact.set(ek, { who, ts });
    }

    const fk = fuzzyKey(lead.companyName);
    if (fk) {
      if (!fuzzyRaw.has(fk)) fuzzyRaw.set(fk, new Map());
      const owners = fuzzyRaw.get(fk);
      const prevTs = owners.get(who);
      if (prevTs == null || ts > prevTs) owners.set(who, ts);
    }
  }

  /* Only unambiguous fuzzy keys survive — see the MATCHING note above. */
  const fuzzy = new Map();
  let dropped = 0;
  for (const [key, owners] of fuzzyRaw) {
    if (owners.size === 1) fuzzy.set(key, owners.keys().next().value);
    else dropped++;
  }

  logger.info(`[SALES-CRM] Lead index built: ${leads.length} leads | ${exact.size} exact keys | ${fuzzy.size} fuzzy keys${dropped ? ` | ${dropped} ambiguous fuzzy keys skipped` : ''}`);
  return { exact, fuzzy, gen, expiresAt: Date.now() + env.salesCrmCacheSecs * 1000 };
}

/** Publishes a built index, UNLESS a newer build has started since — an
 *  older read that happens to finish last must not overwrite a newer one, or
 *  pressing "Sync Sale Person" could be silently undone a moment later by a
 *  concurrent page load whose CRM read began before the button was pressed. */
function commit(idx) {
  if (idx.gen === generation) cache = idx;
  return idx;
}

async function getIndex() {
  if (cache && Date.now() < cache.expiresAt) return cache;
  if (inFlight) return inFlight;
  inFlight = buildIndex()
    .then(commit)
    .finally(() => { inFlight = null; });
  return inFlight;
}

/**
 * Returns `(customerName) => salespersonName | null` — null meaning "the CRM
 * does not know this company", which callers must read as "keep whatever you
 * already had", never as "blank".
 *
 * Returns a resolver that always answers null when the CRM is unconfigured
 * or unreachable, so a caller needs no special-casing: a CRM outage silently
 * degrades to the pre-existing sheet values rather than failing the page.
 */
export async function getSalePersonResolver() {
  if (!isSalesCrmConfigured()) return () => null;
  let idx;
  try {
    idx = await getIndex();
  } catch (e) {
    logger.error(`[SALES-CRM] Lead index unavailable — falling back to the sheet's own Sale Person values. ${e?.message || e}`);
    return () => null;
  }
  return (customerName) => {
    const ek = exactKey(customerName);
    if (!ek) return null;
    const hit = idx.exact.get(ek);
    if (hit) return hit.who;
    const fk = fuzzyKey(customerName);
    return (fk && idx.fuzzy.get(fk)) || null;
  };
}

/** Drops the cached index so the next read re-queries the CRM. The TTL
 *  (env.salesCrmCacheSecs) handles the normal case on its own. */
export function invalidateSalesCrmCache() {
  cache = null;
}

/**
 * Forces an immediate re-read of the CRM collection, backing the "Sync Sale
 * Person" button on Lease Expiry. Still a pure READ — it re-runs the same
 * projected find() and rebuilds the in-memory index; nothing is written to
 * the CRM cluster.
 *
 * Returns a small summary for the button to report back, and THROWS on
 * failure: a user who pressed a button deserves to be told the sync failed,
 * unlike the passive page load, which silently falls back to sheet values.
 */
export async function refreshSalesCrmLeadIndex() {
  if (!isSalesCrmConfigured()) {
    throw new AppError('Sales CRM is not configured on this server (SALES_CRM_MONGODB_URI is unset).');
  }
  cache = null;
  inFlight = null;
  const idx = commit(await buildIndex());
  return { companies: idx.exact.size, syncedAt: new Date().toISOString() };
}
