/**
 * STAGE 3 GATE-IN FORM (Google Form response log, "Stage 3 " tab — note the
 * trailing space in the live sheet's own name, confirmed against the
 * spreadsheet's own metadata, not a typo here).
 *
 * Gate/depot staff fill out a Google Form for every container gate movement,
 * which lands here — completely independent of this app. It duplicates
 * everything the app's own Stage 3 (internal 7, "Gate In") form used to ask
 * for by hand (Gate Status, Date, Location, Transporter, Container Photos,
 * Repair Required). Reverted 2026-08-24 at the user's request: the app's own
 * Gate Entry form was removed entirely, and Stage 3 (Gate In) is now a
 * fully automatic pass-through — a container is treated as gated in the
 * moment this sheet shows "Inward (Gate-In)" for it, no manual save needed.
 *
 * Mirrors stage8.service.js's cache + disk-fallback pattern exactly, so a
 * quota hiccup degrades to a stale-but-present read instead of a blank
 * screen (see that file's header comment for the full rationale).
 */
import fs from 'node:fs';
import path from 'node:path';
import { getSheetData } from './googleSheets.service.js';
import { safeStr } from '../utils/format.js';
import { cacheGet, cachePut } from '../utils/memoryCache.js';
import { clientMatches } from './stage8.service.js';

/* Exact tab name, including the trailing space — getSheetData's range
   builder wraps this in quotes verbatim, and a mismatched name (even by one
   character) fails the whole read with "Unable to parse range". Confirmed
   2026-08-24 by listing the live spreadsheet's own sheet metadata. */
const S3_TAB = 'Stage 3 ';

/* Fixed column positions, confirmed against the live sheet's header row:
   ["Timestamp","Email address","Status","Date (Inward/Outward)",
   "Container No","Type","Size","Customer Name","Location","Transporter
   Name","Transporter Number","Vehicle Number","LR Copy","Left Side","Right
   Side","Back View","Inside – Front","Inside – Rear","Roof","Floor","Door
   Lock","Container Number (Close-up)","Repair Required?","Estimated repair
   budget (optional)","Remarks","Photo_Merge_Pdf"] */
const S3 = {
  TIMESTAMP: 0, STATUS: 2, DATE: 3, CONTAINER: 4, TYPE: 5, SIZE: 6,
  CUSTOMER: 7, LOCATION: 8, TRANSPORTER_NAME: 9, TRANSPORTER_NUMBER: 10,
  VEHICLE_NUMBER: 11, LR_COPY: 12, PHOTO_LEFT: 13, PHOTO_RIGHT: 14,
  PHOTO_BACK: 15, PHOTO_INSIDE_FRONT: 16, PHOTO_INSIDE_REAR: 17,
  PHOTO_ROOF: 18, PHOTO_FLOOR: 19, PHOTO_DOOR_LOCK: 20, PHOTO_CLOSEUP: 21,
  REPAIR_REQUIRED: 22, REPAIR_BUDGET: 23, REMARKS: 24, PHOTO_MERGE_PDF: 25
};

const INWARD_STATUS = 'inward (gate-in)';

const normContainer = (v) => safeStr(v).toUpperCase().replace(/[^A-Z0-9]/g, '');

const CACHE_KEY = 'offlease:stage3form:v1';
/* Same ceiling-not-only-path reasoning as stage8.service.js: refreshStage3FormCache()
   is registered on the same 5-minute job (jobs/index.js), so in practice this
   TTL rarely matters — it only protects against that job being disabled or
   falling behind. */
const CACHE_TTL_SECONDS = 30 * 60;

/* LAST GOOD RESULT — memory + disk, survives a restart and a quota outage.
   Shares the same rationale as stage8.service.js's identical mechanism:
   stale gate-in data is worth far more than none. */
const lastGood = new Map();
const DISK_DIR = path.join(process.cwd(), '.cache');
function diskPath(key) { return path.join(DISK_DIR, `${key.replace(/[^a-z0-9]+/gi, '_')}.json`); }
function readDisk(key) {
  try { return JSON.parse(fs.readFileSync(diskPath(key), 'utf8')); } catch { return null; }
}
function writeDisk(key, data) {
  try {
    fs.mkdirSync(DISK_DIR, { recursive: true });
    fs.writeFileSync(diskPath(key), JSON.stringify(data));
  } catch (e) { console.warn('[STAGE3-FORM-CACHE] could not persist', key, e?.message || e); }
}
function getLastGood(key) {
  if (lastGood.has(key)) return lastGood.get(key);
  const fromDisk = readDisk(key);
  if (fromDisk) lastGood.set(key, fromDisk);
  return fromDisk;
}
function setLastGood(key, data) { lastGood.set(key, data); writeDisk(key, data); }

async function readStage3FormRows(force = false) {
  const hit = !force && cacheGet(CACHE_KEY);
  if (hit) return hit;

  const { rows } = await getSheetData(S3_TAB);
  const out = rows
    .map((r) => ({
      containerNo: safeStr(r[S3.CONTAINER]).trim(),
      status: safeStr(r[S3.STATUS]).trim(),
      date: safeStr(r[S3.DATE]).trim(),
      customer: safeStr(r[S3.CUSTOMER]).trim(),
      location: safeStr(r[S3.LOCATION]).trim(),
      transporterName: safeStr(r[S3.TRANSPORTER_NAME]).trim(),
      transporterNumber: safeStr(r[S3.TRANSPORTER_NUMBER]).trim(),
      vehicleNumber: safeStr(r[S3.VEHICLE_NUMBER]).trim(),
      lrCopy: safeStr(r[S3.LR_COPY]).trim(),
      photos: {
        left: safeStr(r[S3.PHOTO_LEFT]).trim(),
        right: safeStr(r[S3.PHOTO_RIGHT]).trim(),
        back: safeStr(r[S3.PHOTO_BACK]).trim(),
        insideFront: safeStr(r[S3.PHOTO_INSIDE_FRONT]).trim(),
        insideRear: safeStr(r[S3.PHOTO_INSIDE_REAR]).trim(),
        roof: safeStr(r[S3.PHOTO_ROOF]).trim(),
        floor: safeStr(r[S3.PHOTO_FLOOR]).trim(),
        doorLock: safeStr(r[S3.PHOTO_DOOR_LOCK]).trim(),
        closeup: safeStr(r[S3.PHOTO_CLOSEUP]).trim(),
        mergedPdf: safeStr(r[S3.PHOTO_MERGE_PDF]).trim()
      },
      repairRequired: safeStr(r[S3.REPAIR_REQUIRED]).trim(),
      repairBudget: safeStr(r[S3.REPAIR_BUDGET]).trim(),
      remarks: safeStr(r[S3.REMARKS]).trim(),
      timestamp: safeStr(r[S3.TIMESTAMP]).trim()
    }))
    .filter((r) => r.containerNo);

  cachePut(CACHE_KEY, out, CACHE_TTL_SECONDS);
  setLastGood(CACHE_KEY, out);
  return out;
}

/** Cache/disk only, never a live read — same reasoning as
 *  stage8.service.js's getFmsForContainer/getDeliveredKeys: this runs on
 *  every stage-list load and must never itself trigger a Sheets call. */
function currentRows() {
  return cacheGet(CACHE_KEY) || getLastGood(CACHE_KEY) || [];
}

/** Every row for one container, in sheet order (oldest first) — a container
 *  can be gated in/out more than once across its lifetime, sometimes under
 *  different clients entirely (see pickForClient below). */
function rowsForContainer(rows, containerNo) {
  const key = normContainer(containerNo);
  if (!key) return [];
  return rows.filter((r) => normContainer(r.containerNo) === key);
}

/**
 * Picks the row relevant to a specific client out of one container's Stage 3
 * form rows.
 *
 * Container numbers get reused: GESU9440432 was gated IN for "PGS Global
 * Forwarding" and gated OUT to "Bongobhumi Dairy" in the same week of April
 * 2025 — two unrelated movements under the same box, over a year before
 * Bongobhumi's own off-lease cycle even started. Matching by container number
 * alone (picking whichever row happens to be latest) risks resolving to a
 * completely different client's event.
 *
 * Prefers the LATEST row whose Customer Name matches (via clientMatches —
 * the same exact/contains/edit-distance tolerance stage8.service.js uses for
 * its own cross-sheet client matching, since this column is typed by hand
 * and rarely spelled identically to the Off-Lease Tracking client name, e.g.
 * "Bongobhumi Dairy" vs "Bongobhumi Dairy Private Limited"). Falls back to
 * the latest row overall when no client match exists, so an unresolved
 * spelling still degrades to the old behaviour instead of losing the signal
 * entirely — this is a display/skip-gate convenience, not a money decision,
 * so a fallback is the right trade-off (contrast approve.service.js's
 * normClientName, deliberately exact because that gate is money).
 */
export function pickGateFormForClient(rows, clientName) {
  if (!rows.length) return null;
  if (clientName) {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (clientMatches(rows[i].customer, clientName)) return rows[i];
    }
  }
  return rows[rows.length - 1];
}

/** Re-reads the Stage 3 form log and refreshes its cache, regardless of TTL.
 *  Registered alongside refreshFmsCaches() (jobs/index.js) so a new form
 *  submission is visible within 5 minutes without anyone opening the page. */
export async function refreshStage3FormCache() {
  try {
    const rows = await readStage3FormRows(true);
    return { rows: rows.length };
  } catch (e) {
    console.error('[STAGE3-FORM-SYNC] refresh failed:', e?.message || e);
    return { rows: null };
  }
}

/** Every Stage 3 form row for one container, cache/disk only — the raw
 *  material for pickGateFormForClient. Exported so a caller resolving many
 *  containers in one request (a stage-list load) can build its own index
 *  once rather than re-filtering the whole form for each row. */
export function getGateFormRowsForContainer(containerNo) {
  return rowsForContainer(currentRows(), containerNo);
}

/** containerKey -> that container's Stage 3 form rows, built once per call.
 *  Bulk equivalent of getGateFormRowsForContainer for a stage list's worth
 *  of containers, each resolved against its OWN client via
 *  pickGateFormForClient — see that function's doc for why client matters. */
export function getGateFormIndexSync() {
  const map = new Map();
  for (const r of currentRows()) {
    const key = normContainer(r.containerNo);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}

/** True when a resolved Stage 3 form row (from pickGateFormForClient) shows
 *  "Inward (Gate-In)" — the signal that Stage 3 (Gate In) is complete. A
 *  later "Outward (Gate-Out)" row for the same client is intentionally NOT
 *  treated as still-gated-in: outward only happens after the whole
 *  off-lease workflow finishes, by which point this container is no longer
 *  in anyone's pending queue. */
export function isGatedIn(row) {
  return !!row && safeStr(row.status).trim().toLowerCase() === INWARD_STATUS;
}

/** True when a resolved Stage 3 form row is gated in AND explicitly marked
 *  "Repair Required? = No" — this container skips Stage 4 (Inspection
 *  Checklist) entirely and goes straight to Stage 5 (Billing
 *  Reconciliation). A blank or "Yes" value does NOT qualify — only an
 *  explicit "No" is treated as "no repair needed". */
export function isRepairNotRequired(row) {
  return isGatedIn(row) && safeStr(row.repairRequired).trim().toLowerCase() === 'no';
}

/** The Stage 3 form row relevant to one container + client (display only —
 *  container detail / Stage 3 read-only view), or null if never gated in
 *  under that client. */
export function getGateFormForContainer(containerNo, clientName) {
  return pickGateFormForClient(rowsForContainer(currentRows(), containerNo), clientName);
}
