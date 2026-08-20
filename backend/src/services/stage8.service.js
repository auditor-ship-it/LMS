/**
 * STAGE-8 MOVEMENT LOOKUP (external FMS workbook)
 *
 * Stage 2 of the off-lease module is a read-only view: it lists the containers
 * pending transportation and enriches each one with the matching Offlease
 * movement recorded in the FMS "STAGE-8" tab. Nothing here writes.
 *
 * Only Movement Type = Offlease is considered. STAGE-8 holds every movement
 * the business makes — Sale, Lease, Inward, Internal Movement, Trading, Spare
 * and blanks — and 90 of its 1,138 rows are Offlease.
 *
 * QUOTA: this is a live read of a 1,138-row external sheet, and the project
 * already exhausts the Sheets per-minute read quota. It is cached, and Stage 2
 * is the only caller.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getSheetData, getRange } from './googleSheets.service.js';
import { EXTERNAL_SPREADSHEETS } from '../config/sheets.config.js';
import { safeStr } from '../utils/format.js';
import { cacheGet, cachePut } from '../utils/memoryCache.js';

/** The FMS workbook is already configured for its Consolidate tab; STAGE-8
 *  lives in the same spreadsheet, so the ID is reused rather than re-declared. */
const S8_SSID = EXTERNAL_SPREADSHEETS.CONSOLIDATE.ssId;
const S8_TAB = 'STAGE-8';

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
const S9_TAB = 'STAGE-9';
const S9 = {
  TIMESTAMP: 2, DO_NUMBER: 16, LOADING_DATE: 17, VEHICLE: 18, LR_NO: 19, DEST_CITY: 22,
  MOVEMENT_TYPE: 29, CONTAINER: 31, CLIENT: 36, TRANSPORTER: 8
};

const OFFLEASE = 'offlease';
/* Keys are versioned: the cached objects ARE the shape this module returns, so
   changing that shape must not let a live process keep serving the old one for
   another five minutes. Bump the suffix whenever the mapped fields change. */
const CACHE_KEY = 'offlease:stage8-movements:v7';
const S9_CACHE_KEY = 'offlease:stage9-movements:v8';
/* This is the CEILING on staleness, not the only path to freshness:
   refreshFmsCaches() (below) is run every 1 minute by jobs/index.js, so in
   practice a change in the FMS workbook is visible within a minute without
   anyone opening Stage 2. This TTL only matters if that job is disabled or
   falls behind — a stale-but-present value beats a failed read on a quota
   that is currently exhausted.

   In SECONDS: cachePut takes a TTL in seconds and multiplies by 1000 itself.
   This was written `30 * 60 * 1000`, which asked for 1.8 million seconds
   (~21 days) — STAGE-8/9/10 were read once per process and then frozen, so no
   FMS change reached Stage 2 until the server restarted. */
const CACHE_TTL_SECONDS = 30 * 60;

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
function clientMatches(a, b) {
  const x = normClient(a);
  const y = normClient(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;

  const shortest = Math.min(x.length, y.length);
  if (shortest < 5) return false;
  return editDistance(x, y, shortest >= 8 ? 2 : 1) <= (shortest >= 8 ? 2 : 1);
}

/**
 * The whole sheet row as [header, value] pairs, using the tab's own header
 * text. Empty cells are dropped — these tabs are wide (32 and 78 columns) and
 * most are blank on any given row, so listing them would bury the few that
 * carry anything.
 */
/* "Delivery Order" (column G) is a link in the sheet, but values.get returns
   only its display text, "View DO". The URL lives in the cell's formula, so
   that ONE column is re-read with FORMULA rendering — a narrow read, because
   under FORMULA every date would come back as a serial number. */
const S8_DO_COL_A1 = 'G2:G';
const HYPERLINK_RE = /^\s*=\s*HYPERLINK\(\s*"([^"]+)"/i;

/** Row index -> URL, for rows whose Delivery Order cell is a hyperlink. */
async function readDeliveryOrderLinks() {
  try {
    const cells = await getRange(S8_TAB, S8_DO_COL_A1, S8_SSID, 'FORMULA');
    return cells.map((c) => {
      const m = HYPERLINK_RE.exec(safeStr(c?.[0]));
      return m ? m[1] : '';
    });
  } catch (e) {
    /* The text still shows without it — a missing link is a degraded card,
       not a broken one. */
    console.error('[STAGE-8] delivery-order links unavailable:', e?.message || e);
    return [];
  }
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

/** Every Offlease row in STAGE-8, newest last as the sheet holds them. */
/**
 * LAST GOOD RESULT, kept for the life of the process and never expired.
 *
 * The TTL cache decides when to REFRESH; this decides what to serve when that
 * refresh fails. On a quota-exhausted project a read fails often, and throwing
 * away a perfectly good copy of a sheet that changes a few times a day — only
 * to show the user an error — is the wrong trade every time. Stale movement
 * data is worth immeasurably more than no movement data.
 */
const lastGood = new Map();

/* ...and mirrored to disk, so it survives a restart.
 *
 * An in-memory copy is lost every time nodemon reloads, and on a quota-dead
 * project the next read fails — so the screen goes blank again and stays blank
 * until quota frees up, which may be hours. Persisting means these sheets need
 * to be read successfully ONCE, ever, and the data keeps showing regardless of
 * quota. Freshness still comes from the normal TTL refresh whenever a read
 * does succeed; this is purely the floor beneath it. */
const DISK_DIR = path.join(process.cwd(), '.cache');

function diskPath(key) {
  return path.join(DISK_DIR, `${key.replace(/[^a-z0-9]+/gi, '_')}.json`);
}

function readDisk(key) {
  try {
    return JSON.parse(fs.readFileSync(diskPath(key), 'utf8'));
  } catch {
    return null;   // absent or unreadable is simply "no floor yet"
  }
}

function writeDisk(key, data) {
  try {
    fs.mkdirSync(DISK_DIR, { recursive: true });
    fs.writeFileSync(diskPath(key), JSON.stringify(data));
  } catch (e) {
    console.warn('[FMS-CACHE] could not persist', key, e?.message || e);
  }
}

/** Last good copy: memory first, then disk. */
function getLastGood(key) {
  if (lastGood.has(key)) return lastGood.get(key);
  const fromDisk = readDisk(key);
  if (fromDisk) lastGood.set(key, fromDisk);
  return fromDisk;
}

function setLastGood(key, data) {
  lastGood.set(key, data);
  writeDisk(key, data);
}

async function readOffleaseRows(force = false) {
  const hit = !force && cacheGet(CACHE_KEY);
  if (hit) return hit;

  const [{ headers, rows }, doLinks] = await Promise.all([
    getSheetData(S8_TAB, S8_SSID, 'A1:AZ'),
    readDeliveryOrderLinks()
  ]);
  /* Both reads start at sheet row 2, so index i is the same row in each. */
  const out = rows
    .map((r, i) => (doLinks[i] ? Object.assign([...r], { [S8.DELIVERY_ORDER]: doLinks[i] }) : r))
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

  cachePut(CACHE_KEY, out, CACHE_TTL_SECONDS);
  setLastGood(CACHE_KEY, out);
  return out;
}

/* STAGE-10 is site delivery/unloading. It holds NO container number, so it is
   joined by DO number rather than by container + client like the other tabs.

   Which STAGE-8 field carries that DO number is genuinely ambiguous: STAGE-10's
   "DO Number" column holds values like "QAS 549", which matches the FORMAT of
   STAGE-8's Booking Order Number ("QAS 841A") rather than its Delivery Order
   Number ("1003020"), despite the column NAMES saying the opposite. Both are
   therefore offered as candidates and whichever matches wins; `matchedOn`
   records which, so this can be tightened once the data says. */
const S10_TAB = 'STAGE-10';
const S10 = { DO_NUMBER: 3 };
const S10_CACHE_KEY = 'offlease:stage10-delivery:v2';

/** DO numbers are written inconsistently ("QAS 549", "QAS-549", "qas549"), so
 *  they are compared on alphanumerics, upper-cased. */
const normDo = (v) => safeStr(v).toUpperCase().replace(/[^A-Z0-9]/g, '');

async function readStage10Rows(force = false) {
  const hit = !force && cacheGet(S10_CACHE_KEY);
  if (hit) return hit;

  const { headers, rows } = await getSheetData(S10_TAB, S8_SSID, 'A1:BZ');
  /* `keys` is EVERY cell in the row, normalised. The DO number is not reliably
     in the "DO Number" column — that column carries values like "QAS 549"
     while the number we join on (1003020) sits elsewhere in the row. Rather
     than guess which column, the whole row is searched. A DO number is a
     distinctive 7-digit value, so a false hit against some other cell is
     vanishingly unlikely, and matching nothing was the certain alternative. */
  const out = rows
    .map((r) => ({
      doNumber: safeStr(r[S10.DO_NUMBER]).trim(),
      keys: r.map(normDo).filter(Boolean),
      fields: allFields(headers, r)
    }))
    .filter((r) => r.keys.length);

  cachePut(S10_CACHE_KEY, out, CACHE_TTL_SECONDS);
  setLastGood(S10_CACHE_KEY, out);
  return out;
}

/** Last STAGE-10 row whose DO number matches any of the candidate keys. */
function matchByDo(rows, candidates) {
  const wanted = (candidates || []).map(normDo).filter(Boolean);
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
async function readStage9OffleaseRows(force = false) {
  const hit = !force && cacheGet(S9_CACHE_KEY);
  if (hit) return hit;

  const { headers, rows } = await getSheetData(S9_TAB, S8_SSID, 'A1:BZ');
  const out = rows
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

  cachePut(S9_CACHE_KEY, out, CACHE_TTL_SECONDS);
  setLastGood(S9_CACHE_KEY, out);
  return out;
}

/** Last row for this container, ignoring client. See the note in
 *  getFmsForContainer on why client name is not a usable key here. */
function matchByContainer(rows, containerNo) {
  const key = normContainer(containerNo);
  if (!key) return null;
  let found = null;
  for (const r of rows) {
    if (normContainer(r.containerNo) === key) found = r;   // later rows are more recent
  }
  return found;
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
 * does, for the container-detail screen. Shares the cache and the stale
 * fallback, so opening a container costs no extra Sheets read.
 */
export async function getFmsForContainer(containerNo, clientName) {
  /* CACHE AND DISK ONLY — this never triggers a live read.
   *
   * The container-detail endpoint already reads several sheets live; adding
   * three more pushed it past the quota circuit breaker and took the whole
   * modal down with it. The Stage 2 grid is what refreshes these sheets, and
   * the snapshot it leaves on disk is what this reads. Worst case a container
   * detail shows slightly older transport data — infinitely better than
   * failing the page. */
  const pick = (key) => cacheGet(key) || getLastGood(key);

  const rows8 = pick(CACHE_KEY);
  const rows9 = pick(S9_CACHE_KEY);
  const rows10 = pick(S10_CACHE_KEY);

  /* CONTAINER ONLY, matching getDeliveredKeys.
   *
   * Client name is not a usable key across these sheets: STAGE-8 records
   * GSOU6384240 under "Dr Reddy C JNPT" where the tracking sheet says
   * "Dr Reddy's Laboratories Ltd CTO3" — the same customer under a site alias,
   * which no normalisation or edit distance can bridge. A container number is
   * globally unique and the rows are already filtered to Movement Type =
   * Offlease, so the container alone identifies the record.
   *
   * This also removes a real inconsistency: progression used container-only
   * while these cards used container + client, so a container could be
   * released to Stage 3 while its own panel reported "No record". */
  const movement = rows8 ? (matchByContainer(rows8, containerNo) || null) : undefined;
  const transport = rows9 ? (matchByContainer(rows9, containerNo) || null) : undefined;
  const doKeys = [movement?.deliveryOrderNo, movement?.bookingOrderNo, transport?.doNumber].filter(Boolean);
  const delivery = rows10 ? (matchByDo(rows10, doKeys) || null) : undefined;

  return { movement, transport, delivery };
}

/**
 * "CONTAINER|client" keys for every container whose SITE DELIVERY is recorded
 * in STAGE-10 — the signal that its Stage 2 transport leg is finished and it
 * belongs in Stage 3 (Gate In).
 *
 * STAGE-10 carries no container number, so the chain is: STAGE-8 (or STAGE-9)
 * gives the container its DO number, and a STAGE-10 row against that DO means
 * delivered. Cache and disk only — this runs on every stage-list load and must
 * never trigger a live read.
 */
export async function getDeliveredKeys() {
  const pick = (key) => cacheGet(key) || getLastGood(key);
  const rows8 = pick(CACHE_KEY);
  const rows9 = pick(S9_CACHE_KEY);
  const rows10 = pick(S10_CACHE_KEY);
  const keys = new Set();
  /* ALL THREE tabs are required, so all three must have been read. Releasing
     on a partial view would complete Stage 2 for a container whose missing leg
     simply had not loaded. */
  if (!rows8 || !rows9 || !rows10) return keys;

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
  const in8 = new Set((rows8 || []).map((r) => normContainer(r.containerNo)).filter(Boolean));
  const in9 = new Set((rows9 || []).map((r) => normContainer(r.containerNo)).filter(Boolean));

  for (const src of [rows8, rows9]) {
    for (const r of src) {
      const k = normContainer(r.containerNo);
      if (!k || keys.has(k)) continue;
      if (!in8.has(k) || !in9.has(k)) continue;          // must be in BOTH 8 and 9
      const dos = [r.deliveryOrderNo, r.bookingOrderNo, r.doNumber].filter(Boolean);
      if (!dos.length) continue;
      if (!matchByDo(rows10, dos)) continue;              // ...and delivered in 10
      keys.add(k);
    }
  }
  return keys;
}

/**
 * Appends STAGE-8 movement columns to a getOffLeaseData() result, in place.
 *
 * Rows with no matching Offlease movement keep the record but show blanks —
 * dropping them would hide containers that are genuinely pending transport
 * simply because FMS has not logged the movement yet.
 *
 * Best-effort: STAGE-8 is an external sheet on an exhausted quota, and Stage 2
 * must still list its containers if that read fails.
 */
/**
 * Proactively re-reads STAGE-8, STAGE-9 and STAGE-10 and refreshes their
 * caches, regardless of whether the current TTL has expired.
 *
 * Without this, a row added to the FMS workbook only appears here once
 * someone happens to open Stage 2 (or a container lookup) AFTER the 30-minute
 * TTL has lapsed — until then it is invisible even though the source data is
 * already correct. Confirmed 2026-08-19: a STAGE-10 delivery entered at
 * 18:18 still showed "No record" in the Stage 2 card an hour later, because
 * nothing had triggered a re-read since the last cache fill.
 *
 * Run on a schedule (jobs/index.js, every 5 minutes) rather than on-demand,
 * so freshness does not depend on user traffic. The three reads are
 * independent — one failing (e.g. a transient quota hit) must not stop the
 * other two from refreshing, so they are awaited separately rather than with
 * Promise.all, and each already falls back to its own last-good/disk copy on
 * failure (see readOffleaseRows/readStage9OffleaseRows/readStage10Rows).
 */
export async function refreshFmsCaches() {
  const results = await Promise.allSettled([
    readOffleaseRows(true),
    readStage9OffleaseRows(true),
    readStage10Rows(true)
  ]);
  const [s8, s9, s10] = results;
  const summary = {
    stage8: s8.status === 'fulfilled' ? s8.value.length : null,
    stage9: s9.status === 'fulfilled' ? s9.value.length : null,
    stage10: s10.status === 'fulfilled' ? s10.value.length : null
  };
  for (const [tab, r] of [['STAGE-8', s8], ['STAGE-9', s9], ['STAGE-10', s10]]) {
    if (r.status === 'rejected') console.error(`[FMS-SYNC] ${tab} refresh failed:`, r.reason?.message || r.reason);
  }
  return summary;
}

export async function enrichWithStage8Movements(result) {
  /* Attached as OBJECTS on each row, not appended as grid columns. Ten extra
     columns made the table unreadable and most of them are blank for any row
     FMS has not logged yet — they belong in the record's own view, which is
     where a reader goes for detail. */
  /* allSettled, not all: the two tabs are independent, and on an exhausted
     quota one read routinely fails while the other succeeds. Promise.all threw
     both away, so a STAGE-9 timeout silently cost the user their STAGE-8 data
     as well. */
  const [r8, r9, r10] = await Promise.allSettled([
    readOffleaseRows(), readStage9OffleaseRows(), readStage10Rows()
  ]);

  /* On failure fall back to the last good copy. Only when there has never been
     one does the caller get nothing — which on a fresh process means the very
     first read has to land, but every read after that is protected. */
  const settle = (res, key, tab) => {
    if (res.status === 'fulfilled') return { rows: res.value, stale: false };
    console.error(`[${tab}]`, res.reason?.message || res.reason);
    const kept = getLastGood(key);
    if (kept) {
      console.warn(`[${tab}] read failed — serving last good copy (${kept.length} rows)`);
      return { rows: kept, stale: true };
    }
    return { rows: null, stale: false };
  };

  const s8 = settle(r8, CACHE_KEY, S8_TAB);
  const s9 = settle(r9, S9_CACHE_KEY, S9_TAB);
  const s10 = settle(r10, S10_CACHE_KEY, S10_TAB);
  const rows8 = s8.rows;
  const rows9 = s9.rows;
  const rows10 = s10.rows;

  for (const item of result.data || []) {
    const container = item.row?.[0];
    const client = item.row?.[4];
    /* null means "looked, found nothing"; undefined means "could not look".
       The UI shows a different message for each — reporting a failed lookup as
       "no record found" told the user their data did not exist when in fact it
       had not been read. */
    item.movement = rows8 ? (matchRow(rows8, container, client) || null) : undefined;
    item.transport = rows9 ? (matchRow(rows9, container, client) || null) : undefined;
    /* STAGE-10 hangs off the STAGE-8 row's DO number, so it can only be
       reached for containers that matched STAGE-8 in the first place. */
    /* Every DO-ish number we know for this container, from either tab. The
       three sheets do not agree on which one they carry, so all are offered
       and whichever hits wins. */
    const doKeys = [
      item.movement?.deliveryOrderNo,
      item.movement?.bookingOrderNo,
      item.transport?.doNumber
    ].filter(Boolean);
    item.delivery = rows10 ? (matchByDo(rows10, doKeys) || null) : undefined;
  }

  result.movementSource = `${S8_TAB} + ${S9_TAB} (Movement Type = Offlease)`;
  result.movementMatched = (result.data || []).filter((i) => i.movement).length;
  result.transportMatched = (result.data || []).filter((i) => i.transport).length;
  if (!rows8) result.movementError = r8.reason?.message || `Could not read ${S8_TAB}`;
  if (!rows9) result.transportError = r9.reason?.message || `Could not read ${S9_TAB}`;
  result.deliveryMatched = (result.data || []).filter((i) => i.delivery).length;
  if (!rows10) result.deliveryError = r10.reason?.message || `Could not read ${S10_TAB}`;
  result.movementStale = s8.stale || s9.stale || s10.stale;
  return result;
}
