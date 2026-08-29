/**
 * STAGE 2 "MOVE TO STAGE" / "SEND BACK" AUDIT TRAIL
 *
 * Append-only, in its own sheet, same pattern as offleaseRemarks.service.js
 * (Off-Lease Remarks) and Stage 9's own movement log: a record accumulates
 * events, nothing is ever overwritten or deleted, so a container's full
 * movement history survives a Send Back even though offlease.service.js
 * clears the live Off-Lease Tracking row's own move-state columns on one —
 * this sheet is the only place that history still exists afterward.
 *
 * Keyed on container + lease ID, like the remarks thread — a container can
 * be off-leased under two leases at once and their histories must not merge.
 */
import { getSheetData, appendRow, insertSheetIfMissing } from './googleSheets.service.js';
import { SHEETS } from '../config/sheets.config.js';
import { safeStr } from '../utils/format.js';
import { withSheetLock } from '../utils/sheetMutex.js';
import { cacheGet, cachePut, cacheRemove } from '../utils/memoryCache.js';

const H_SHEET = SHEETS.OFF_LEASE_MOVE_HISTORY;

export const H_HEADERS = [
  'Timestamp', 'Container No', 'Lease ID', 'Client Name', 'Event',
  'Reason', 'Comment / Type', 'Remarks', 'Date', 'From Stage', 'To Stage', 'By'
];

const isMissingSheet = (e) => String(e?.message || '').includes('Unable to parse range');

const pad2 = (n) => String(n).padStart(2, '0');
const dmyTime = (d) => `${safeStr(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

const key = (container, leaseId) =>
  `${safeStr(container).trim().toUpperCase()}::${safeStr(leaseId).trim().toUpperCase()}`;

/* Cached the same way the remarks thread is — one read serves both the
 * "show history in this record's modal" caller and any future index view,
 * dropped on every write so a just-logged event is reflected at once. */
const ROWS_CACHE_KEY = 'offlease:move-history-rows';
const ROWS_TTL_SECONDS = 60;

function invalidate() { cacheRemove(ROWS_CACHE_KEY); }

async function readAll() {
  try {
    const { rows } = await getSheetData(H_SHEET);
    return rows
      .map((r) => ({
        timestamp: safeStr(r[0]),
        containerNo: safeStr(r[1]),
        leaseId: safeStr(r[2]),
        clientName: safeStr(r[3]),
        event: safeStr(r[4]),
        reason: safeStr(r[5]),
        commentType: safeStr(r[6]),
        remarks: safeStr(r[7]),
        date: safeStr(r[8]),
        fromStage: safeStr(r[9]),
        toStage: safeStr(r[10]),
        by: safeStr(r[11])
      }))
      .filter((r) => r.containerNo.trim() !== '');
  } catch (e) {
    if (isMissingSheet(e)) return [];
    throw e;
  }
}

async function readAllCached() {
  const hit = cacheGet(ROWS_CACHE_KEY);
  if (hit) return hit;
  const rows = await readAll();
  cachePut(ROWS_CACHE_KEY, rows, ROWS_TTL_SECONDS);
  return rows;
}

/** The full history for one record, newest first. */
export async function getMoveHistory(containerNo, leaseId) {
  const k = key(containerNo, leaseId);
  return (await readAllCached()).filter((r) => key(r.containerNo, r.leaseId) === k).reverse();
}

/**
 * Appends one event. Called from inside offlease.service.js's
 * saveOffLeaseMoveToStage(Fast)/saveOffLeaseSendBack(Fast), themselves
 * already holding the Off-Lease Tracking sheet lock — this appends to a
 * DIFFERENT sheet, so it takes its own lock rather than reusing that one.
 * Best-effort by design of the caller (never allowed to fail the move
 * itself) — see those functions' own try/catch around this call.
 */
export async function addMoveHistoryEntry({ containerNo, leaseId, clientName, event, reason, commentType, remarks, date, fromStage, toStage, by }) {
  const row = [
    dmyTime(new Date()), safeStr(containerNo).trim().toUpperCase(), safeStr(leaseId).trim(), safeStr(clientName).trim(),
    safeStr(event).trim(), safeStr(reason).trim(), safeStr(commentType).trim(), safeStr(remarks).trim(),
    safeStr(date).trim(), safeStr(fromStage).trim(), safeStr(toStage).trim(), safeStr(by || '').trim()
  ];

  return withSheetLock(H_SHEET, async () => {
    /* Append first, create only on failure — same reasoning as the remarks
       thread: creating eagerly costs a full spreadsheets.get per save. */
    try {
      await appendRow(H_SHEET, row);
    } catch (e) {
      if (!isMissingSheet(e)) throw e;
      await insertSheetIfMissing(H_SHEET, H_HEADERS);
      await appendRow(H_SHEET, row);
    }
    invalidate();
  });
}
