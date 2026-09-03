/**
 * STAGE-8/9/10 MOVEMENT LOOKUP (external FMS workbook)
 *
 * Stage 2 of the off-lease module is a read-only view: it lists the containers
 * pending transportation and enriches each one with the matching Offlease
 * movement recorded in the FMS "STAGE-8"/"STAGE-9"/"STAGE-10" tabs. Nothing
 * here writes.
 *
 * Only Movement Type = Offlease is considered. STAGE-8 holds every movement
 * the business makes — Sale, Lease, Inward, Internal Movement, Trading, Spare
 * and blanks — and roughly 90 of its 1,100+ rows are Offlease.
 *
 * MONGO-MIRRORED (2026-08-28) — this used to be a live read of a large
 * external sheet on every cache-miss, with its own 30-min in-memory TTL and
 * a disk-persisted "last good" fallback for when the shared Sheets quota was
 * exhausted (which, on this project, was routinely). Explicit request: mirror
 * these three tabs into Mongo the same way every sheet in the main
 * lease-management spreadsheet already is (see mongoSheetData.service.js's
 * header note), so this file never touches live Sheets at all — reads always
 * come from Mongo, kept in sync by the same jobs/sheetsReconcile.job.js cron
 * that already handles the other 9 sheets (see mongoSheetMapping.js's
 * FMS_STAGE8/9/10 entries, which carry their own `ssId` since this is a
 * completely different spreadsheet from the main one). A change made
 * directly in the FMS workbook is visible here within one reconcile cycle
 * (~5 min), same freshness guarantee as everything else — not instant, but
 * never a quota failure either.
 *
 * This also means the old "undefined = could not read, quota exhausted" UI
 * state this module used to produce (see fmsState in StageDetailModal.jsx)
 * should no longer trigger in practice — a Mongo read failure is a genuine
 * infrastructure problem, not a routine, expected occurrence the way a
 * shared-project Sheets quota hit was.
 */
import { getSheetDataFromMongo } from './mongoSheetData.service.js';
import { SHEETS } from '../config/sheets.config.js';
import { safeStr } from '../utils/format.js';
import { parseStamp } from './offleaseSla.service.js';
import { cacheGetOrLoad, cacheRemove } from '../utils/memoryCache.js';

/* getSheetDataFromMongo's own cache is only 8s (right, for sheets this app
   writes to directly and needs to reflect promptly) — far shorter than these
   three tabs can ever actually change, since nothing here writes and the
   reconcile job that refreshes their Mongo mirror only runs every 5 minutes
   (see this file's header comment). That mismatch meant every Stage 2 tab
   switch re-triggered a full, multi-second Mongo read of 1000+ rows across
   three collections for data that was, at most, 8 seconds stale to begin
   with — Off-Lease's own reported "switching stages feels slow" bug, found
   2026-09-01. A second cache layer here, TTL just under the reconcile
   cadence, means repeat navigation within that window is instant while still
   never lagging behind the mirror itself. */
/* Longer than the 5-minute gap between warmFmsCache cron runs (jobs/index.js),
   not shorter — TTL < warm interval leaves a real window where the cache has
   already expired but the next warm cycle hasn't run yet, and a user's tab
   switch lands on a genuine cold 17s read right in that gap. 330s keeps every
   entry alive until the NEXT warm cycle refills it, so there is no gap at all
   under normal operation; this TTL is really only a safety net for a missed
   cron tick, not the primary freshness mechanism. */
const FMS_CACHE_TTL_SECS = 330;
function cachedFmsRead(tab, loader) {
  return cacheGetOrLoad(`stage8_fms_read_v1:${tab}`, FMS_CACHE_TTL_SECS, loader);
}

/**
 * Forces this cache to re-fill right after the reconcile job updates these
 * three tabs' Mongo mirror, so the ~15-20s cold read (confirmed 2026-09-01 —
 * STAGE-9 alone took 17s for 595 rows) happens on a cron tick nobody is
 * waiting on, not on whichever user's tab switch happens to land on an
 * expired cache. Registered in jobs/index.js a couple minutes after
 * runSheetsReconciliation, giving that job time to actually finish writing
 * before this re-reads it. Explicit cacheRemove first — without it,
 * cacheGetOrLoad would just hand back the still-valid old entry and this
 * would warm nothing.
 */
export async function warmFmsCache() {
  for (const tab of [S8_TAB, S9_TAB, S10_TAB]) cacheRemove(`stage8_fms_read_v1:${tab}`);
  await Promise.all([readOffleaseRows(), readStage9OffleaseRows(), readStage10Rows()]);
}

const S8_TAB = SHEETS.FMS_STAGE8;
const S9_TAB = SHEETS.FMS_STAGE9;
const S10_TAB = SHEETS.FMS_STAGE10;

/* Fixed column positions, confirmed against the live sheet's header row. */
const S8 = {
  TIMESTAMP: 2, BOOKING_ORDER_NO: 3, DELIVERY_ORDER_NO: 4, DELIVERY_ORDER: 6,
  MOVEMENT_TYPE: 12, CLIENT: 13, CITY: 14, CONTAINER: 15, SIZE_TYPE: 17
};

/* STAGE-9 is the transport-execution tab of the same workbook — 78 columns of
   freight, vehicle and document detail. It carries the same three match keys
   under different names, confirmed against its header row.

   NOTE: STAGE-9 has NO status column. The nearest thing to "where has this
   got to" is the transport detail itself — loading date, vehicle, LR number —
   plus its Timestamp, which is used as Last Updated. */
const S9 = {
  TIMESTAMP: 2, DO_NUMBER: 16, LOADING_DATE: 17, VEHICLE: 18, LR_NO: 19, DEST_CITY: 22,
  MOVEMENT_TYPE: 29, CONTAINER: 31, CLIENT: 36, TRANSPORTER: 8
};

const OFFLEASE = 'offlease';

/** Container numbers are compared on alphanumerics, case-insensitively. */
const normContainer = (v) => safeStr(v).toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Client names differ between the two systems — STAGE-8 says "DRAEGER" where
 *  Off-Lease Tracking says "Draeger India Pvt Ltd". Suffixes and punctuation
 *  are stripped so the two forms reduce to the same token, the same way
 *  accountsApi.service.js normalises Tally party names. */
const normClient = (v) => safeStr(v)
  .toLowerCase()
  .replace(/\b(private|pvt|limited|ltd|llp|inc|co|company|india)\b/g, '')
  .replace(/[^a-z0-9]/g, '');

/** Levenshtein distance, capped — only used to decide "is this the same name
 *  misspelled", so it stops caring once the answer is clearly no. */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;   // whole row already too far
    prev = cur;
  }
  return prev[b.length];
}

/**
 * True when two client names refer to the same client.
 *
 * Exact match first, then containment (STAGE-8 says "DRAEGER" where our sheet
 * says "Draeger India Pvt Ltd"), then a small edit distance — these names are
 * typed by hand into three systems and the same client is genuinely spelled
 * differently in each. STAGE-9 has "Drager India Pvt.Ltd" against STAGE-8's
 * "DRAEGER INDIA PVT LTD": one missing letter, which containment cannot bridge.
 *
 * The distance allowance is deliberately tight — 1 for short names, 2 for
 * longer ones, and only once both are at least 5 characters — so it forgives
 * a typo without merging two genuinely different clients.
 */
export function clientMatches(a, b) {
  const x = normClient(a);
  const y = normClient(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;

  const shortest = Math.min(x.length, y.length);
  if (shortest < 5) return false;
  return editDistance(x, y, shortest >= 8 ? 2 : 1) <= (shortest >= 8 ? 2 : 1);
}

/** _APPROVER_1..3 hold a whole JSON approval object — email, name, comments,
 *  taskId, timestamp, status, hasNext. Only the status is wanted; the rest is
 *  an unreadable wall of text that overflows the card. */
const APPROVER_RE = /^_approver_\d+$/i;

/** Form-plumbing columns with no business meaning — an opaque 70-character
 *  Google Forms response ID tells a reader nothing and crowds out the fields
 *  that do. Dropped from the card entirely; the sheet is untouched. */
const HIDDEN_FIELDS = new Set(['_response_id']);

function approverStatus(value) {
  const s = value.trim();
  if (!s.startsWith('{') && !s.startsWith('[')) return value;
  try {
    const parsed = JSON.parse(s);
    const pick = (o) => safeStr(o?.status).trim();
    const status = Array.isArray(parsed)
      ? parsed.map(pick).filter(Boolean).join(' · ')
      : pick(parsed);
    // Unparseable shape or no status at all -> leave the cell as it came.
    return status || value;
  } catch {
    return value;
  }
}

/**
 * The whole sheet row as [header, value] pairs, using the tab's own header
 * text. Empty cells are dropped — these tabs are wide (32 and 78 columns) and
 * most are blank on any given row, so listing them would bury the few that
 * carry anything.
 */
function allFields(headers, row) {
  const out = [];
  for (let i = 0; i < headers.length; i++) {
    const label = safeStr(headers[i]).trim();
    const value = safeStr(row[i]).trim();
    if (!label || !value) continue;
    if (HIDDEN_FIELDS.has(label.toLowerCase())) continue;
    out.push([label, APPROVER_RE.test(label) ? approverStatus(value) : value]);
  }
  return out;
}

/** Every Offlease row in STAGE-8, newest last as the sheet holds them. The
 *  "Delivery Order" hyperlink column is already resolved to its real URL by
 *  the reconcile job (see sheetsReconcile.job.js's _enrichStage8DeliveryOrderLinks)
 *  before it ever reaches Mongo, so no second live call is needed for it here. */
async function readOffleaseRows() {
  return cachedFmsRead(S8_TAB, async () => {
  const { headers, rows } = await getSheetDataFromMongo(S8_TAB);
  return rows
    .filter((r) => safeStr(r[S8.MOVEMENT_TYPE]).trim().toLowerCase() === OFFLEASE)
    .map((r) => ({
      containerNo: safeStr(r[S8.CONTAINER]).trim(),
      clientName: safeStr(r[S8.CLIENT]).trim(),
      movementType: safeStr(r[S8.MOVEMENT_TYPE]).trim(),
      deliveryCity: safeStr(r[S8.CITY]).trim(),
      sizeType: safeStr(r[S8.SIZE_TYPE]).trim(),
      timestamp: safeStr(r[S8.TIMESTAMP]).trim(),
      /* Both candidate join keys for STAGE-10 — see the note there. */
      deliveryOrderNo: safeStr(r[S8.DELIVERY_ORDER_NO]).trim(),
      bookingOrderNo: safeStr(r[S8.BOOKING_ORDER_NO]).trim(),
      fields: allFields(headers, r)
    }))
    .filter((r) => r.containerNo);   // a movement with no container cannot be matched
  });
}

/**
 * Every STAGE-8 row with Movement Type = Offlease (readOffleaseRows already
 * filters to this — see above). Used by offlease.service.js's
 * autoCreateOffLeaseFromFms to scan for containers not yet linked into
 * Off-Lease Stage 2. Async now (Mongo-backed) — was sync/cache-only before.
 */
export async function getAllOffleaseMovementRows() {
  return readOffleaseRows();
}

/* STAGE-10 is site delivery/unloading. It holds NO container number, so it is
   joined by DO number rather than by container + client like the other tabs.

   Which STAGE-8 field carries that DO number is genuinely ambiguous: STAGE-10's
   "DO Number" column holds values like "QAS 549", which matches the FORMAT of
   STAGE-8's Booking Order Number ("QAS 841A") rather than its Delivery Order
   Number ("1003020"), despite the column NAMES saying the opposite. Both are
   therefore offered as candidates and whichever matches wins; `matchedOn`
   records which, so this can be tightened once the data says. */
const S10 = { DO_NUMBER: 3 };

/** DO numbers are written inconsistently ("QAS 549", "QAS-549", "qas549"), so
 *  they are compared on alphanumerics, upper-cased. */
const normDo = (v) => safeStr(v).toUpperCase().replace(/[^A-Z0-9]/g, '');

async function readStage10Rows() {
  return cachedFmsRead(S10_TAB, async () => {
  const { headers, rows } = await getSheetDataFromMongo(S10_TAB);
  /* `keys` is EVERY cell in the row, normalised. The DO number is not reliably
     in the "DO Number" column — that column carries values like "QAS 549"
     while the number we join on (1003020) sits elsewhere in the row. Rather
     than guess which column, the whole row is searched. A DO number is a
     distinctive 7-digit value, so a false hit against some other cell is
     vanishingly unlikely, and matching nothing was the certain alternative. */
  return rows
    .map((r) => ({
      doNumber: safeStr(r[S10.DO_NUMBER]).trim(),
      keys: r.map(normDo).filter(Boolean),
      fields: allFields(headers, r)
    }))
    .filter((r) => r.keys.length);
  });
}

/**
 * BUG FOUND AND FIXED 2026-08-27: a blank booking/DO cell is written as the
 * literal text "NA" throughout these sheets, not left empty — normDo('NA')
 * is a real, non-empty token ('NA'), so it used to survive the old
 * `.filter(Boolean)` and get searched for as if it were a genuine DO number.
 * Since STAGE-10 rows are matched by scanning EVERY cell in the row (see
 * readStage10Rows — the true DO can sit in any column), and "NA" appears
 * SOMEWHERE in most STAGE-10 rows (any other blank field), this spuriously
 * matched the LAST such row in the whole sheet — a completely unrelated
 * container's delivery data. Confirmed on CICU4881946 / August Assortments:
 * its real DO is 1002932 (correct in STAGE-8 and STAGE-9), but its
 * bookingOrderNo is blank ("NA"), so Site Delivery showed a different
 * container's row whose only real connection was an unrelated "NA" cell —
 * matchedOn: 'NA', not a real DO number at all.
 *
 * A real DO number is a distinctive several-digit code (1002932, 1003032,
 * ... — 6+ characters in every example seen); MIN_DO_LEN excludes short
 * placeholder tokens ("NA", "-", "NIL") generically, without needing an
 * exhaustive blocklist of every placeholder spelling this data uses.
 */
const MIN_DO_LEN = 5;

/** Last row whose own `field` (a clean, single-cell DO number — unlike
 *  STAGE-10, which has none, hence matchByDo's whole-row scan) matches any
 *  of the candidate keys. Used to chain STAGE-9 off STAGE-8's own DO. */
function matchByDoField(rows, candidates, field) {
  const wanted = (candidates || []).map(normDo).filter((w) => w.length >= MIN_DO_LEN);
  if (!wanted.length) return null;
  let found = null;
  for (const r of rows) {
    const v = normDo(r[field]);
    if (v && wanted.includes(v)) found = r; // later rows are more recent
  }
  return found;
}

/** Last STAGE-10 row whose DO number matches any of the candidate keys. */
function matchByDo(rows, candidates) {
  const wanted = (candidates || []).map(normDo).filter((w) => w.length >= MIN_DO_LEN);
  if (!wanted.length) return null;
  let found = null;
  for (const r of rows) {
    const hit = wanted.find((w) => r.keys.includes(w));
    if (!hit) continue;
    found = { ...r, matchedOn: hit };   // later rows are more recent
  }
  return found;
}

/** Every Offlease row in STAGE-9 — the transport-execution detail. */
async function readStage9OffleaseRows() {
  return cachedFmsRead(S9_TAB, async () => {
  const { headers, rows } = await getSheetDataFromMongo(S9_TAB);
  return rows
    .filter((r) => safeStr(r[S9.MOVEMENT_TYPE]).trim().toLowerCase() === OFFLEASE)
    .map((r) => ({
      containerNo: safeStr(r[S9.CONTAINER]).trim(),
      clientName: safeStr(r[S9.CLIENT]).trim(),
      /* STAGE-9 carries its own DO number, and it is the transport leg that
         STAGE-10's site delivery actually follows on from — so it is a
         candidate key for that join alongside STAGE-8's. */
      doNumber: safeStr(r[S9.DO_NUMBER]).trim(),
      loadingDate: safeStr(r[S9.LOADING_DATE]).trim(),
      vehicleNo: safeStr(r[S9.VEHICLE]).trim(),
      lrNo: safeStr(r[S9.LR_NO]).trim(),
      destinationCity: safeStr(r[S9.DEST_CITY]).trim(),
      transporter: safeStr(r[S9.TRANSPORTER]).trim(),
      lastUpdated: safeStr(r[S9.TIMESTAMP]).trim(),
      fields: allFields(headers, r)
    }))
    .filter((r) => r.containerNo);
  });
}

/**
 * Last row for this container. See the note in getFmsForContainer on why
 * client name ALONE is not a usable key across these sheets — used here
 * only as a tie-breaker, never as the primary filter.
 *
 * `sinceMs` + `dateField`: a container is reused across different clients
 * over its lifetime (the same "off-lease" workflow keeps reusing box
 * numbers — see e.g. TRIU6681671, GESU9440432 elsewhere in this codebase),
 * so this sheet can hold a row from a PREVIOUS, already-closed off-lease
 * cycle for the same container. Matching by container alone with no time
 * boundary picked up whichever row happened to be last in the sheet —
 * confirmed 2026-08-27 on MYRU4513729: the CURRENT cycle (client "Gujarat
 * Co-operative Milk...") showed a January STAGE-8/9 record that actually
 * belonged to an EARLIER, unrelated cycle for client "Inderdeep Infra..." —
 * wrong client shown, and Stage 2 (Transportation) auto-completed itself
 * from that stale data even though the current cycle's own transport leg
 * hadn't happened yet.
 *
 * When `sinceMs` is given: only rows on/after it (the current cycle's own
 * Stage 1 completion) are considered. Within that window, a row whose
 * client fuzzy-matches `clientName` (clientMatches — tolerant of spacing/
 * punctuation, but not of a true site alias) is preferred as an extra
 * safety check; otherwise the last in-window row is used. No in-window row
 * at all returns null — "nothing recorded yet for this cycle" is correct
 * and better than showing a stale one.
 *
 * `sinceMs == null` (boundary not known, e.g. Stage 1 timestamp missing or
 * unparsed) falls back to the original "last row overall" behaviour, so a
 * lookup failure never makes an existing working case regress.
 */
function matchByContainer(rows, containerNo, sinceMs, dateField = 'timestamp', clientName) {
  const key = normContainer(containerNo);
  if (!key) return null;
  const matches = rows.filter((r) => normContainer(r.containerNo) === key);
  if (!matches.length) return null;
  if (sinceMs == null) return matches[matches.length - 1];

  const inCycle = matches.filter((r) => {
    const ts = parseStamp(r[dateField]);
    return ts && ts.getTime() >= sinceMs;
  });

  if (inCycle.length && clientName) {
    const clientMatch = inCycle.filter((r) => clientMatches(r.clientName, clientName));
    if (clientMatch.length) return clientMatch[clientMatch.length - 1];
  }
  if (inCycle.length) return inCycle[inCycle.length - 1];

  /* FIX 2026-08-27, found while verifying the cycle-boundary fix against
     real data: this app's own Stage 1 completion timestamp and the external
     FMS workbook's own event timestamps are two INDEPENDENT systems, not
     guaranteed to agree on ordering. Confirmed on TRIU6681671 — its 63Ideas
     Infolabs off-lease cycle's own Stage 1 shows complete 07/08/2026, but
     that SAME client's STAGE-8/9 movement events are dated 03/07 and
     07/07/2026, a month EARLIER. A strict "movement must be on/after Stage 1"
     rule would wrongly hide this genuinely-correct data as "no record yet".
     A client-name match (clientMatches — tolerant, but not of a true site
     alias) is a strong enough independent signal to use as a rescue when the
     date window finds nothing, since it's the exact same disambiguator that
     already protects the container-only case elsewhere in this file. Still
     null (not "last row overall") when no client name is available to check
     — that fallback is what caused the original cross-cycle bug in the
     first place. */
  if (clientName) {
    const clientMatch = matches.filter((r) => clientMatches(r.clientName, clientName));
    if (clientMatch.length) return clientMatch[clientMatch.length - 1];
  }
  return null;
}

/** Last row matching container + client, or null. Shared by both tabs. */
function matchRow(rows, containerNo, clientName) {
  const key = normContainer(containerNo);
  if (!key) return null;
  let found = null;
  for (const r of rows) {
    if (normContainer(r.containerNo) !== key) continue;
    if (!clientMatches(r.clientName, clientName)) continue;
    found = r;   // later rows are more recent
  }
  return found;
}

/**
 * The Offlease movement for one container + client, or null.
 *
 * BOTH keys must match, as specified: a container number is reused across
 * clients over time, so the container alone would attach another client's
 * movement to this record. The LAST match wins — a container can be moved more
 * than once and the newest row is the current state.
 */
export async function findOffleaseMovement(containerNo, clientName, rows) {
  return matchRow(rows || await readOffleaseRows(), containerNo, clientName);
}

/**
 * The FMS chain for ONE container — the same three lookups the Stage 2 grid
 * does, for the container-detail screen. Reads Mongo (fast, always
 * available) rather than a live-Sheets cache, so this never fails on quota.
 *
 * `cycleStartMs`: the current off-lease cycle's own Stage 1 completion time
 * (epoch ms), if known. See matchByContainer's doc comment for why this is
 * required to avoid attaching a PREVIOUS, unrelated cycle's movement/
 * transport data to the current one.
 */
export async function getFmsForContainer(containerNo, clientName, cycleStartMs) {
  const [rows8, rows9, rows10] = await Promise.all([
    readOffleaseRows(), readStage9OffleaseRows(), readStage10Rows()
  ]);

  /* CONTAINER first (see matchByContainer's doc comment for the full
   * cycle-boundary + client-rescue logic) — client name alone is not a
   * usable key across these sheets: STAGE-8 records GSOU6384240 under
   * "Dr Reddy C JNPT" where the tracking sheet says "Dr Reddy's
   * Laboratories Ltd CTO3" — the same customer under a site alias, which
   * no normalisation or edit distance can bridge. */
  const movement = matchByContainer(rows8, containerNo, cycleStartMs, 'timestamp', clientName);

  /* STAGE-9: chained off the MOVEMENT's own DO number once Stage 8 has
   * identified the shipment, instead of independently re-matching
   * container+client here too. Confirmed 2026-08-27/28 (GSOU6384240,
   * CICU4881946) that when Stage 8 and Stage 9 are genuinely the same
   * shipment, they always carry the identical DO — so once Stage 8 resolves,
   * a DO lookup on Stage 9 is exact and unambiguous, with no alias risk left
   * to fail on. Falls back to the old independent container+client match
   * when Stage 8 itself didn't resolve or carries no usable DO. */
  const moveDoKeys = [movement?.deliveryOrderNo, movement?.bookingOrderNo].filter(Boolean);
  const chained = moveDoKeys.length ? matchByDoField(rows9, moveDoKeys, 'doNumber') : null;
  const transport = chained || matchByContainer(rows9, containerNo, cycleStartMs, 'lastUpdated', clientName);

  const doKeys = [movement?.deliveryOrderNo, movement?.bookingOrderNo, transport?.doNumber].filter(Boolean);
  const delivery = matchByDo(rows10, doKeys);

  return { movement, transport, delivery };
}

/**
 * Container -> every delivery-qualifying event's timestamp (epoch ms) it has
 * ever had. A Map of arrays, not a flat Set — see isDeliveredSince below for
 * why a bare "has this container ever been delivered" is unsafe: a
 * container reused across off-lease cycles (e.g. MYRU4513729 — see
 * getFmsForContainer's doc comment for the full account, found 2026-08-27)
 * would read as permanently "delivered" off ITS OLDEST cycle's event,
 * wrongly bypassing Stage 2 for every LATER cycle too, even one whose own
 * transport leg hadn't happened yet.
 */
export async function getDeliveredKeys() {
  const [rows8, rows9, rows10] = await Promise.all([
    readOffleaseRows(), readStage9OffleaseRows(), readStage10Rows()
  ]);
  const map = new Map();

  /* Keyed on CONTAINER ONLY, not container + client.
   *
   * Client names are demonstrably unreliable across these sheets — STAGE-9
   * spells the same customer "Drager India Pvt.Ltd" where the tracking sheet
   * has "Draeger India Pvt Ltd" — and requiring both matched nothing at all.
   * A delivery is a physical event for the box, so the container is the right
   * granularity, and the rows are already filtered to Movement Type = Offlease.
   */
  /* Stage 2 completes only when the container has an Offlease record in
     STAGE-8 *and* STAGE-9 *and* a STAGE-10 site delivery — the movement was
     booked, transported and delivered. Previously any one of 8 or 9 plus a
     STAGE-10 hit was enough, which released containers whose transport leg had
     not been recorded and let Stage 3 open too early. */
  const in8 = new Set(rows8.map((r) => normContainer(r.containerNo)).filter(Boolean));
  const in9 = new Set(rows9.map((r) => normContainer(r.containerNo)).filter(Boolean));

  /* STAGE-10 itself carries no date of its own (see readStage10Rows) — the
     matching STAGE-8/STAGE-9 row's own timestamp is used as this delivery
     event's date, which is sound: STAGE-10 only ever confirms a movement
     that STAGE-8/9 already recorded, so that movement's own date is when
     this delivery cycle happened. */
  for (const [src, dateField] of [[rows8, 'timestamp'], [rows9, 'lastUpdated']]) {
    for (const r of src) {
      const k = normContainer(r.containerNo);
      if (!k) continue;
      if (!in8.has(k) || !in9.has(k)) continue;          // must be in BOTH 8 and 9
      const dos = [r.deliveryOrderNo, r.bookingOrderNo, r.doNumber].filter(Boolean);
      if (!dos.length) continue;
      if (!matchByDo(rows10, dos)) continue;              // ...and delivered in 10
      const ts = parseStamp(r[dateField]);
      if (!ts) continue;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(ts.getTime());
    }
  }
  return map;
}

/**
 * Was this container delivered ON/AFTER `sinceMs` (its CURRENT off-lease
 * cycle's own Stage 1 completion)? `sinceMs == null` (boundary not known)
 * falls back to "ever delivered at all" — the original behaviour — so a
 * missing boundary never makes an existing working case regress.
 */
export function isDeliveredSince(deliveredMap, containerKey, sinceMs) {
  const arr = deliveredMap?.get ? deliveredMap.get(containerKey) : null;
  if (!arr || !arr.length) return false;
  if (sinceMs == null) return true;
  return arr.some((t) => t >= sinceMs);
}

/**
 * The FMS chain for ONE container + client, using the exact same
 * container+client match (matchRow) enrichWithStage8Movements uses per row
 * for the Stage 2 grid's FMS status dots — so anything that GATES on this
 * (e.g. offlease.service.js's Stage 2/Gate In TAT) can never disagree with
 * what those dots show on screen for the same row.
 *
 * Deliberately NOT getFmsForContainer/matchByContainer: that function drops
 * the client check ENTIRELY when no cycle-start bound is given (see
 * matchByContainer's `sinceMs == null` branch, which returns "the last row
 * for this container number, any client") — acceptable for a best-effort
 * historical reference panel, wrong for anything deciding "is this actually
 * done". BUG FOUND 2026-09-02 via CXRU1042578 (client "Hatsun Agro Product
 * Ltd"): the new Stage 2 TAT badge showed "Completed" off a STAGE-8 row
 * belonging to "Crystal Warehouse Kolkata" and a STAGE-9 row belonging to
 * "Qwik Supply Chain Pvt Ltd" — two entirely unrelated clients that merely
 * reused the same container number — while the row's own FMS dots correctly
 * showed nothing matched for THIS client. Same failure class already
 * documented for MYRU4513729/GESU9440432/TRIU6681671 elsewhere in this file,
 * just reached through the one lookup here that skips the client check.
 */
export async function getMatchedFmsForContainer(containerNo, clientName) {
  const [rows8, rows9, rows10] = await Promise.all([
    readOffleaseRows(), readStage9OffleaseRows(), readStage10Rows()
  ]);
  const movement = matchRow(rows8, containerNo, clientName);
  const transport = matchRow(rows9, containerNo, clientName);
  const doKeys = [movement?.deliveryOrderNo, movement?.bookingOrderNo, transport?.doNumber].filter(Boolean);
  const delivery = matchByDo(rows10, doKeys);
  return { movement, transport, delivery };
}

/**
 * Appends STAGE-8/9/10 movement columns to a getOffLeaseData() result, in
 * place. Rows with no matching Offlease movement keep the record but show
 * blanks — dropping them would hide containers that are genuinely pending
 * transport simply because FMS has not logged the movement yet.
 */
export async function enrichWithStage8Movements(result) {
  const [rows8, rows9, rows10] = await Promise.all([
    readOffleaseRows(), readStage9OffleaseRows(), readStage10Rows()
  ]);

  for (const item of result.data || []) {
    const container = item.row?.[0];
    const client = item.row?.[4];
    item.movement = matchRow(rows8, container, client);
    item.transport = matchRow(rows9, container, client);
    /* STAGE-10 hangs off the STAGE-8/9 row's DO number, so it can only be
       reached for containers that matched one of those first. Every DO-ish
       number we know for this container, from either tab, is offered as a
       candidate — the three sheets do not agree on which one they carry. */
    const doKeys = [
      item.movement?.deliveryOrderNo,
      item.movement?.bookingOrderNo,
      item.transport?.doNumber
    ].filter(Boolean);
    item.delivery = matchByDo(rows10, doKeys);
  }

  result.movementSource = `${S8_TAB} + ${S9_TAB} (Movement Type = Offlease)`;
  result.movementMatched = (result.data || []).filter((i) => i.movement).length;
  result.transportMatched = (result.data || []).filter((i) => i.transport).length;
  result.deliveryMatched = (result.data || []).filter((i) => i.delivery).length;
  return result;
}
