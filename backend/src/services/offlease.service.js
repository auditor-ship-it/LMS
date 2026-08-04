/**
 * Port of LMS.js lines 6180-7924: the Off-Lease 8-stage workflow (Pending
 * Approval -> Intimation -> Lifting/Arrival -> Inspection -> Quotation/Order
 * -> Billing Reconciliation -> Transportation -> Get In -> FMS Closure),
 * tracking-sheet bootstrap/repair tools, and the container-detail lookup
 * used by the Dashboard.
 *
 * Ported functions: restoreOffLeaseHeaderRowFromLatestBackup,
 * dumpOffLeaseTrackingHeaders, fixQuotationEmailMarkedCollision,
 * reorderOffLeaseTrackingColumns, _findOlColumn, _findOlColumnMulti,
 * _ensureOffLeaseSheet, fixOffLeaseStageHeaders, addToOffLeaseTracking,
 * getOffLeaseData, _formatLeaseId, _peekNextLeaseIdNum, getNextLeaseId,
 * saveOffLeaseStage, _sendOffLeaseQuotationEmail, getOffLeaseStageDetail,
 * _orderScanCols, _splitContainersLoose, _scanSheetForLeaseInfo,
 * _findLeaseInfoForContainer, _findOrderNosForContainer,
 * debugOrderNosForContainer, traceOrderNo, whatFeedsNewLeaseReff,
 * whatFeedsAllSheets, _fillBlanksFromDeployed, getOffLeaseContainerDetail,
 * getOffLeaseApprovalData, saveOffLeaseApprovalAction,
 * _syncOffLeaseRowToMaster, _cellKey, _deployedKey, copyApprovedData.
 * (`_colLetter` is NOT redefined here — `colLetter` from googleSheets.service.js
 * is reused instead, per porting instructions.)
 *
 * NOT PORTED (in-range by line number but out of scope for this slice — see
 * final report): generateMonthlyInvoice, _genInvoiceForMonth,
 * updateOffLeaseData, resyncApprovedOffLeaseToMaster (LMS.js ~7706-7924+).
 * These were not in the assigned function list (a different pipeline:
 * monthly invoicing + the hourly Master-Sheet sync trigger, not the 8-stage
 * UI workflow) and the line range's upper bound (7924) cuts off mid-signature
 * of resyncApprovedOffLeaseToMaster, confirming the boundary was deliberate.
 *
 * DATE HANDLING: googleSheets.service.js reads values with
 * dateTimeRenderOption 'FORMATTED_STRING', so date-typed sheet cells arrive
 * as already-locale-formatted strings, not JS Date objects (same situation
 * documented in dashboard.service.js). Two distinct patterns in the original
 * are preserved distinctly here:
 *   - Where the original called `formatDateVal(x)` directly (no instanceof
 *     check) — e.g. _fillBlanksFromDeployed, most of getOffLeaseContainerDetail's
 *     base fields — this port calls `formatDateVal(x)` directly too (it already
 *     no-ops gracefully on a plain string).
 *   - Where the original did `val instanceof Date ? Utilities.formatDate(val,...)
 *     : safeStr(val)` (getOffLeaseData's col_N fields, getOffLeaseStageDetail,
 *     getOffLeaseContainerDetail's per-stage `fields[]`, getOffLeaseApprovalData's
 *     date columns) this port uses the local `fmtCell()` helper: `parseDate(val)`
 *     truthy -> `formatDateVal(parsed)`, else `safeStr(val)` — the same
 *     substitution dashboard.service.js's header comment documents.
 *
 * DATE-WRITE NOTE: like verify.service.js, there is no equivalent of Apps
 * Script's typed-Date cell write over the Sheets values API. Frontend date
 * inputs ("yyyy-MM-dd") are parsed via local Y/M/D components (not
 * `new Date(string)`, which parses as UTC and can roll a day on
 * positive-UTC-offset servers) and written as "dd/MM/yyyy" text via safeStr().
 *
 * IDENTITY NOTE: exactly like verify.service.js, saveOffLeaseStage's and
 * saveOffLeaseApprovalAction's permission check uses the SAME `userEmail`
 * value that gets written to the sheet as "who did this" (the original's
 * `checkActionPermission(type, arguments[arguments.length - 1])` reads the
 * last positional argument, which for both functions IS the userEmail
 * param). The controller passes req.user.email as that value.
 */
import {
  getSheetData,
  getRange,
  updateRange,
  updateCell,
  batchUpdateValues,
  appendRow,
  appendRows,
  insertSheetIfMissing,
  colLetter,
  getSheetsClient,
  getSheetId,
  clearSheetIdCache
} from './googleSheets.service.js';
import { SHEETS, EXTERNAL_SPREADSHEETS } from '../config/sheets.config.js';
import { env } from '../config/env.js';
import { safeStr, safeAmt, formatDateVal, parseDate } from '../utils/format.js';
import { normKey } from '../utils/normalize.js';
import { withSheetLock } from '../utils/sheetMutex.js';
import { AppError } from '../utils/AppError.js';
import { checkActionPermission } from './permissions.service.js';
import { sendMail } from './email.service.js';
import { runAutoApproval } from './approve.service.js';
import { getSheetDataFromMongo } from './mongoSheetData.service.js';

/* =============================================
   OFF-LEASE WORKFLOW — 8 STAGES (LMS.js lines 5987-6135)
============================================= */
const OL_SHEET = SHEETS.OFF_LEASE_TRACKING;

export const OL_HEADERS = [
  'Container No', 'Lease ID', 'Size', 'Type', 'Client Code', 'Client Name', 'Location',
  'Deployed Date', 'Valid Upto', 'Rate',
  'OL Intimation Date', 'OL Date', 'Email Notification URL', 'Final Billing Date',
  'Stage 1 Remark', 'Stage 1 Timestamp', 'Stage 1 User', 'Stage 1 Status',
  'Lifting Date', 'Arrival Date', 'Stage 2 Remark', 'Stage 2 Timestamp', 'Stage 2 User', 'Stage 2 Status',
  'Container Received Date', 'Internal Cleaning', 'External Cleaning', '18m Wire Intact',
  'Dents Checked', 'Paint Condition', 'Logo Visibility', 'Reefer Machine Cleaned',
  'Keypad Display Visible', 'Short PTI Done', 'Estimation Work Pending', 'Technician Checked',
  'Checklist Drawing', 'Estimate If Any', 'Estimate Cost', 'Stage 3 Remark',
  'Stage 3 Timestamp', 'Stage 3 User', 'Stage 3 Status',
  'Rentals Billed Till Date', 'Outstanding Amount', 'Date Billed Till', 'Est Repair Charges Billed',
  'Transport Cost Billed', 'Adjust Security Deposit', 'Security Deposit Amount', 'Last Date Of Billing',
  'Accrued Rental Amount', 'Accrued Rental Date', 'Reconcile Billing Cycle', 'Approval From',
  'Stage 5 Remark', 'Stage 5 Timestamp', 'Stage 5 User', 'Stage 5 Status',
  'Quotation Number', 'Order Received Number', 'Delivery Order Required',
  'Stage 4 Remark', 'Stage 4 Timestamp', 'Stage 4 User', 'Stage 4 Status',
  'User', 'Vehicle Placed By', 'Quotation Number', 'Order Received Number', 'DO Number',
  'Vehicle No', 'Cash Memo Number', 'Cash Memo Date', 'Cash Memo Received Date',
  'Vehicle Reached at Pick-up', 'Loading City', 'Destination City', 'Loading Date',
  'Transit Days', 'Km', 'Expected Delivery Date', 'Size', 'Container Type',
  'Quantity', 'Vehicle Type', 'Movement Type', 'Transportation Type',
  'Container Number', 'WT', 'Pick-up Address', 'Delivery Address', 'Delivery Pin Code',
  'Customer Name', 'Driver Photo', 'Payment Type', 'Payment Terms',
  'Immediate Payment', 'Payment Due Date', 'Other Charges', 'Detention Charge',
  'Less Late Delivery', 'Crane/Hydra Charge', 'Unloading Labour', 'Cleaning Charge',
  'Collection Memo', 'LR Scanned Copy', 'Vehicle Name Plate', 'Container Photo',
  'Door Photo', 'Inside Full View', 'Machine Photo', 'Full Video',
  'Bill', 'Driving Licence', 'RC Book', 'Transporter Name', 'Freight Cost',
  'Stage 6 Remark', 'Stage 6 Timestamp', 'Stage 6 User', 'Stage 6 Status',
  'Billing & Filing', 'FMS Closure', 'All Docs Uploaded to FMS',
  'Stage 8 Remark', 'Stage 8 Timestamp', 'Stage 8 User', 'Stage 8 Status',
  'Intimation Approval Status', 'Intimation Approval Timestamp', 'Intimation Approval User', 'Intimation Approval Remarks',
  'Stage 3 Photo: Left Side', 'Stage 3 Photo: Right Side', 'Stage 3 Photo: Back View',
  'Stage 3 Photo: Inside Front', 'Stage 3 Photo: Inside Rear', 'Stage 3 Photo: Roof',
  'Stage 3 Photo: Floor', 'Stage 3 Photo: Door Lock', 'Stage 3 Photo: Container Close Up',
  'Gate Status', 'Gate Date', 'Gate Location', 'Gate Transporter Name', 'Gate Transporter Number',
  'Gate Vehicle Number', 'Gate LR Copy', 'Gate Photo: Left Side', 'Gate Photo: Right Side',
  'Gate Photo: Back View', 'Gate Photo: Inside Front', 'Gate Photo: Inside Rear', 'Gate Photo: Roof',
  'Gate Photo: Floor', 'Gate Photo: Door Lock', 'Gate Photo: Container Close Up',
  'Gate Repair Required', 'Gate Est Budget', 'Stage 7 Remark', 'Stage 7 Timestamp', 'Stage 7 User', 'Stage 7 Status',
  'Quotation Created?', 'Quotation File', 'Quotation Amount', 'Quotation Email'
];

export const OL_STAGE_INFO = {
  1: { statusCol: 17, startCol: 10, endCol: 17, label: 'Off-Lease Intimation' },
  2: { statusCol: 23, startCol: 18, endCol: 23, label: 'Lifting / Arrival' },
  3: { statusCol: 42, startCol: 24, endCol: 42, label: 'Inspection Checklist' },
  4: { statusCol: 65, startCol: 59, endCol: 65, label: 'Quotation / Order' },
  5: { statusCol: 58, startCol: 43, endCol: 58, label: 'Billing Reconciliation' },
  6: { statusCol: 121, startCol: 66, endCol: 121, label: 'Transportation' },
  7: { statusCol: 163, startCol: 142, endCol: 163, label: 'Get In' },
  8: { statusCol: 128, startCol: 122, endCol: 128, label: 'FMS Closure' }
};
/* 133/134/135 deliberately excluded -- confirmed via the live sheet those
   columns are the Marked sync flag / Email ID / Mail Status feature, not
   Stage 3 photos. */
const OL_STAGE3_EXTRA_COLS = [136, 137, 138, 139, 140, 141];
const OL_STAGE4_EXTRA_COLS = [164, 165, 166, 167];

/* FIXED, not derived — see LMS.js's long comment on this constant. A prior
   derived value (OL_HEADERS.length + 1) collided with real data whenever a
   field was added. Do not change this back to a derived value. */
export const OL_MARKED_COL_1BASED = 250;

const OL_LEASE_ID_PREFIX = 'LEASE';
const OL_LEASE_ID_START = 28; // first new Lease ID = LEASE0028
const OL_LEASE_ID_PAD = 4;

const OL_STAGE_LABELS = {
  1: 'Off-Lease Intimation', 2: 'Lifting / Arrival', 3: 'Inspection Checklist',
  4: 'Quotation / Order', 5: 'Billing Reconciliation', 6: 'Transportation', 7: 'Get In',
  8: 'FMS Closure'
};

/* The real home of Order No and Client Name is "New Lease" only (see LMS.js
   comment: scanning "New lease reff"/"Operation sheet" too caused a wrong
   Order No to be picked for a reused container number). */
const OL_ORDER_SHEETS = [SHEETS.NEW_LEASE];

/* =============================================
   SMALL LOCAL HELPERS
============================================= */
function pad2(n) { return String(n).padStart(2, '0'); }
/** "dd/MM/yyyy HH:mm:ss" — matches verify.service.js's dmyTime() convention for Timestamp-type fields. */
function dmyTime(d) {
  return `${safeStr(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
/** "dd-MM-yyyy HH:mm" — the exact format the original used for the rejection remark line. */
function fmtDMYHM(d) {
  return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
/** Substitutes for the original's `val instanceof Date ? Utilities.formatDate(val,...) : safeStr(val)` — see DATE HANDLING note above. */
function fmtCell(val) {
  const d = parseDate(val);
  return d ? formatDateVal(d) : safeStr(val);
}
/** Frontend date inputs send "yyyy-MM-dd"; build via local Y/M/D components rather than
 *  `new Date(string)` (UTC parse -> possible day-roll). Falls back to a raw Date parse,
 *  then to null (caller keeps the raw string) if nothing parses. */
function parseFormDate(val) {
  const parts = String(val).split('-');
  if (parts.length === 3) {
    const y = parseInt(parts[0], 10), m = parseInt(parts[1], 10) - 1, d = parseInt(parts[2], 10);
    const dt = new Date(y, m, d);
    if (!isNaN(dt.getTime())) return dt;
  }
  const dt2 = new Date(val);
  return isNaN(dt2.getTime()) ? null : dt2;
}
function padWidth(arr, width) {
  const out = (arr || []).slice(0, width);
  while (out.length < width) out.push('');
  return out;
}
function trimTrailingBlanks(arr) {
  let end = arr.length;
  while (end > 0 && (arr[end - 1] === '' || arr[end - 1] == null)) end--;
  return arr.slice(0, end);
}

/** Raw formula read (no equivalent in googleSheets.service.js's wrapper functions,
 *  which all use UNFORMATTED_VALUE). Returns null if the sheet/range can't be read. */
async function getFormulasRange(sheetName, a1Range, ssId = env.googleSheetId) {
  try {
    const sheets = getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: ssId,
      range: `'${sheetName}'!${a1Range}`,
      valueRenderOption: 'FORMULA'
    });
    return res.data.values || [];
  } catch (e) {
    return null;
  }
}

/* =============================================
   TRACKING SHEET BOOTSTRAP / DYNAMIC COLUMN FINDER
============================================= */

/** Adapted from the original's (sheet, headerName) signature to (headers, headerName) —
 *  callers already have `headers` in hand from getSheetData, so no extra round trip per lookup. */
export function _findOlColumn(headers, headerName) {
  for (let h = 0; h < headers.length; h++) {
    if (headers[h] && String(headers[h]).trim().toLowerCase() === headerName) return h;
  }
  return -1;
}

export function _findOlColumnMulti(headers, names) {
  for (const n of names) {
    const col = _findOlColumn(headers, n);
    if (col >= 0) return col;
  }
  return -1;
}

/** Locates a row by container number (col A) rather than a client-cached row
 *  number, so a stale/differently-ordered list read (e.g. from the Mongo
 *  mirror) can never cause a write to land on the wrong row — see
 *  splendid-rolling-candy.md Phase 1a. Returns the 1-based sheet row number,
 *  or -1 if not found. Shared by getOffLeaseStageDetail / saveOffLeaseStage /
 *  saveOffLeaseApprovalAction, the three OL_SHEET write-adjacent reads that
 *  used to trust a passed-in rowNum directly. */
function _findOlRowByContainer(rows, containerNo) {
  const want = normKey(containerNo);
  if (!want) return -1;
  for (let i = 0; i < rows.length; i++) {
    if (normKey(rows[i][0]) === want) return i + 2;
  }
  return -1;
}

let sheetEnsured = false;
/** Ensures the Off-Lease Tracking sheet exists with (at least) OL_HEADERS.length
 *  header columns, growing the header row if OL_HEADERS has grown since the
 *  sheet was created — mirrors the original's _ensureOffLeaseSheet(). Cached
 *  per-process after the first successful check (OL_HEADERS is a fixed
 *  constant for the life of a deployment, so re-checking every call is
 *  wasted round trips). */
export async function _ensureOffLeaseSheet() {
  if (sheetEnsured) return;
  await insertSheetIfMissing(OL_SHEET, OL_HEADERS);
  const wide = (await getRange(OL_SHEET, `A1:${colLetter(OL_HEADERS.length + 50)}1`))[0] || [];
  if (wide.length < OL_HEADERS.length) {
    const toWrite = [];
    for (let c = wide.length; c < OL_HEADERS.length; c++) toWrite.push(OL_HEADERS[c] || `Col ${c + 1}`);
    if (toWrite.length) {
      await updateRange(OL_SHEET, `${colLetter(wide.length)}1:${colLetter(OL_HEADERS.length - 1)}1`, [toWrite]);
    }
  }
  sheetEnsured = true;
}

/* ==================== ADMIN / DIAGNOSTIC / ONE-TIME MAINTENANCE TOOLS ====================
   All exposed as admin-only endpoints (ROLES_ADMIN_EMAILS gate, enforced in
   the controller) rather than dropped, per porting instructions — these were
   meant to be run once from the Apps Script editor, but are real tools that
   may be needed again. */

export async function restoreOffLeaseHeaderRowFromLatestBackup() {
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: env.googleSheetId });
  const allSheets = meta.data.sheets || [];
  const mainMeta = allSheets.find((s) => s.properties.title === OL_SHEET);
  if (!mainMeta) return `No '${OL_SHEET}' sheet found.`;

  let backupName = null;
  for (let i = allSheets.length - 1; i >= 0; i--) {
    if (allSheets[i].properties.title.indexOf('Off-Lease Tracking BACKUP ') === 0) { backupName = allSheets[i].properties.title; break; }
  }
  if (!backupName) return "No sheet named 'Off-Lease Tracking BACKUP ...' found — nothing to restore from.";

  const wideBackup = (await getRange(backupName, 'A1:ZZZ1'))[0] || [];
  const headerRow = trimTrailingBlanks(wideBackup);
  await updateRange(OL_SHEET, `A1:${colLetter(Math.max(headerRow.length - 1, 0))}1`, [headerRow]);

  const wideMain = (await getRange(OL_SHEET, 'A1:ZZZ1'))[0] || [];
  const mainW = wideMain.length;
  if (mainW > headerRow.length) {
    await updateRange(OL_SHEET, `${colLetter(headerRow.length)}1:${colLetter(mainW - 1)}1`, [new Array(mainW - headerRow.length).fill('')]);
  }

  return `Restored header row from '${backupName}' (${headerRow.length} columns). ` +
    "Data rows were never touched by the failed run, so they're untouched and fine. " +
    'Next: run dumpOffLeaseTrackingHeaders() and send its full output before trying the reorder again.';
}

export async function dumpOffLeaseTrackingHeaders() {
  const wide = (await getRange(OL_SHEET, 'A1:ZZZ1'))[0] || [];
  const out = wide.map((h, i) => `${i}: ${h == null ? '' : String(h).trim()}`);
  const msg = out.join('\n');
  console.log('[OL-HEADERS-DUMP]', msg);
  return msg;
}

export async function fixQuotationEmailMarkedCollision() {
  const { rows } = await getSheetData(OL_SHEET);
  if (!rows.length) return 'No data rows.';

  const SCAN_FROM_1BASED = 168;
  const SCAN_TO_1BASED = OL_MARKED_COL_1BASED - 1; // 249
  const fromIdx0 = SCAN_FROM_1BASED - 1;
  const toIdx0 = SCAN_TO_1BASED - 1;

  let fixedRows = 0, cellsCleared = 0;
  const updates = [];
  for (let i = 0; i < rows.length; i++) {
    const rn = i + 2;
    let foundInRow = false;
    for (let c = fromIdx0; c <= toIdx0; c++) {
      const v = String(rows[i][c] == null ? '' : rows[i][c]).trim();
      if (v.toLowerCase() !== 'marked') continue;
      updates.push({ range: `'${OL_SHEET}'!${colLetter(c)}${rn}`, values: [['']] });
      cellsCleared++;
      foundInRow = true;
    }
    if (foundInRow) {
      updates.push({ range: `'${OL_SHEET}'!${colLetter(OL_MARKED_COL_1BASED - 1)}${rn}`, values: [['Marked']] });
      fixedRows++;
    }
  }
  if (updates.length) await batchUpdateValues(updates);
  const msg = `Scanned columns ${SCAN_FROM_1BASED}-${SCAN_TO_1BASED}. Fixed ${fixedRows} row(s), cleared ${cellsCleared} stray 'Marked' cell(s), consolidated to column ${OL_MARKED_COL_1BASED}.`;
  console.log('[OL-EMAIL-COLLISION-FIX]', msg);
  return msg;
}

export async function fixOffLeaseStageHeaders() {
  await _ensureOffLeaseSheet();
  await updateRange(OL_SHEET, `A1:${colLetter(OL_HEADERS.length - 1)}1`, [OL_HEADERS]);
  return `OK — header row updated (${OL_HEADERS.length} columns).`;
}

/** ONE-TIME MIGRATION — physically reorders every column of the Off-Lease
 *  Tracking sheet to Stage1->Stage8->Approval order. See LMS.js's long
 *  comment on the original for the full behavioral spec. Idempotent (guard
 *  at the top) and makes a full hidden backup copy before writing anything. */
export async function reorderOffLeaseTrackingColumns() {
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: env.googleSheetId });
  const sheetMeta = (meta.data.sheets || []).find((s) => s.properties.title === OL_SHEET);
  if (!sheetMeta) return `No '${OL_SHEET}' sheet found — nothing to migrate.`;
  const sheetId = sheetMeta.properties.sheetId;

  const wideHeader = (await getRange(OL_SHEET, 'A1:ZZZ1'))[0] || [];
  const curHeaders = trimTrailingBlanks(wideHeader.map((h) => String(h == null ? '' : h).trim()));

  const { rows: dataRows } = await getSheetData(OL_SHEET, undefined, 'A1:ZZZ');
  const lastRow = dataRows.length + 1;
  const lastCol = Math.max(curHeaders.length, 1, ...dataRows.map((r) => r.length));
  if (lastRow < 1 || lastCol < 1) return 'Sheet is empty — nothing to migrate.';

  if (curHeaders.length > 163 && curHeaders[52] === 'Quotation Created?' && curHeaders[163] === 'Intimation Approval Status') {
    return 'Already in the new column order (checked columns 53 and 164) — nothing to do.';
  }

  const hasStage4Extras = curHeaders.length >= 167 &&
    curHeaders[164] === 'Quotation Created?' && curHeaders[165] === 'Quotation File' && curHeaders[166] === 'Quotation Amount';
  if (curHeaders.length > 164 && !hasStage4Extras) {
    return `ABORTED — the sheet has ${curHeaders.length} columns but they don't match the expected ` +
      "Stage 4 extra headers at 165-167 ('Quotation Created?'/'Quotation File'/'Quotation Amount'). " +
      'This migration doesn\'t recognize this layout, so nothing was changed. Header row logged for review.';
  }
  const oldWidth = hasStage4Extras ? 167 : 164;

  const anchors = {
    0: 'Container No', 24: 'Container Received Date', 59: 'Quotation Number',
    66: 'User', 122: 'Billing & Filing', 129: 'Intimation Approval Status',
    141: 'Stage 3 Photo: Container Close Up', 142: 'Gate Status'
  };
  for (const a of Object.keys(anchors)) {
    const ai = parseInt(a, 10);
    if (ai >= curHeaders.length || curHeaders[ai] !== anchors[a]) {
      console.log('[OL-REORDER] Current header row:', JSON.stringify(curHeaders));
      return `ABORTED — header mismatch at column ${ai + 1}: expected '${anchors[a]}', found '${curHeaders[ai] || '(blank)'}'. Nothing was changed — see server log for the full header row.`;
    }
  }
  console.log('[OL-REORDER] Current header row (pre-migration):', JSON.stringify(curHeaders));

  const map = {};
  function block(oldStart, oldEnd, newStart) { for (let o = oldStart; o <= oldEnd; o++) map[o] = newStart + (o - oldStart); }
  for (let b0 = 0; b0 <= 38; b0++) map[b0] = b0;
  block(39, 42, 48);
  block(43, 58, 62);
  map[59] = 53; map[60] = 54; map[61] = 57;
  block(62, 65, 58);
  block(66, 121, 78);
  block(122, 128, 156);
  block(129, 132, 163);
  // index 133 is the Marked-flag / Stage-3-photo collision cell — handled per-row below.
  block(134, 141, 40);
  block(142, 163, 134);
  if (hasStage4Extras) { map[164] = 52; map[165] = 55; map[166] = 56; }

  const newWidth = OL_HEADERS.length;

  // ---- Safety backup — full copy of the sheet before any write ----
  const stamp = new Date().toISOString().replace('T', ' ').replace(/\..+/, '').replace(/:/g, '-');
  const copyRes = await sheets.spreadsheets.sheets.copyTo({
    spreadsheetId: env.googleSheetId,
    sheetId,
    requestBody: { destinationSpreadsheetId: env.googleSheetId }
  });
  const backupSheetId = copyRes.data.sheetId;
  const backupName = `Off-Lease Tracking BACKUP ${stamp}`.substring(0, 100);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: env.googleSheetId,
    requestBody: {
      requests: [{ updateSheetProperties: { properties: { sheetId: backupSheetId, title: backupName, hidden: true }, fields: 'title,hidden' } }]
    }
  });
  clearSheetIdCache();
  console.log(`[OL-REORDER] Backup created: ${backupName}`);

  const readWidth = Math.max(lastCol, oldWidth);
  const oldRows = dataRows.map((r) => padWidth(r, readWidth));

  let markedRecovered = 0, photoKept = 0;
  const markedFlags = [];
  const newRows = oldRows.map((oldRow) => {
    const out = new Array(newWidth).fill('');
    let marked = '';
    for (let oi = 0; oi < oldRow.length; oi++) {
      const val = oldRow[oi];
      if (oi === 133) {
        if (String(val == null ? '' : val).trim().toLowerCase() === 'marked') {
          marked = 'Marked';
          markedRecovered++;
        } else if (val !== '' && val != null) {
          out[39] = val; // Stage 3 Photo: Left Side, new position
          photoKept++;
        }
        continue;
      }
      const ni = map[oi];
      if (ni === undefined) continue;
      out[ni] = val;
    }
    markedFlags.push([marked]);
    return out;
  });

  // ---- Write: new header row, then every row at its new position ----
  await updateRange(OL_SHEET, `A1:${colLetter(newWidth - 1)}1`, [OL_HEADERS]);
  if (newRows.length) {
    await updateRange(OL_SHEET, `A2:${colLetter(newWidth - 1)}${newRows.length + 1}`, newRows);
    await updateRange(OL_SHEET, `${colLetter(OL_MARKED_COL_1BASED - 1)}2:${colLetter(OL_MARKED_COL_1BASED - 1)}${markedFlags.length + 1}`, markedFlags);
  }

  // If the old sheet was somehow wider than the new layout, blank the leftover columns.
  if (lastCol > newWidth) {
    const blankRow = new Array(lastCol - newWidth).fill('');
    const blankRows = new Array(Math.max(lastRow, 1)).fill(blankRow);
    await updateRange(OL_SHEET, `${colLetter(newWidth)}1:${colLetter(lastCol - 1)}${Math.max(lastRow, 1)}`, blankRows);
  }

  const msg = `OL-REORDER DONE. Rows migrated: ${newRows.length} | Marked-flag recovered to column ${OL_MARKED_COL_1BASED}: ${markedRecovered} | ` +
    `Stage 3 Photo: Left Side data kept: ${photoKept} | Backup sheet: '${backupName}' (hidden — unhide via the Sheets UI to inspect; delete once verified).`;
  console.log('[OL-REORDER]', msg);
  return msg;
}

/* =============================================
   ORDER NO / CLIENT LOOKUP HELPERS
============================================= */

function _orderScanCols(headers) {
  let contCol = -1, ordCol = -1;
  for (let h = 0; h < headers.length; h++) {
    const hd = String(headers[h] || '').trim().toLowerCase();
    if (contCol === -1 && hd.indexOf('container') !== -1 && hd.indexOf('no. of') === -1 && hd.indexOf('no of') === -1 && hd.indexOf('link') === -1) contCol = h;
    if (ordCol === -1 && hd.indexOf('order') !== -1 && hd.indexOf('no') !== -1) ordCol = h;
  }
  return {
    contCol: contCol === -1 ? 0 : contCol,
    ordCol: ordCol === -1 ? 3 : ordCol,
    contFallback: contCol === -1,
    ordFallback: ordCol === -1
  };
}

/** Multi-container cell split — comma/semicolon/slash/newline, NEVER space
 *  ("Site Cabin 73" is a single name). Genuinely differs from
 *  utils/normalize.js's splitContainers (no slash there), so kept as its
 *  own local helper per porting instructions. */
function _splitContainersLoose(raw) {
  return (raw == null ? '' : raw).toString().split(/[,;/\n]+/);
}

async function _scanSheetForLeaseInfo(sheetName, want) {
  const info = { orders: [], clientCode: '', clientName: '' };
  const seen = {};
  try {
    const { headers, rows } = await getSheetData(sheetName);
    if (!rows.length) return info;
    const cols = _orderScanCols(headers);

    let ccCol = -1, cnCol = -1;
    for (let h = 0; h < headers.length; h++) {
      const hd = String(headers[h] || '').trim().toLowerCase();
      if (ccCol === -1 && hd.indexOf('client') !== -1 && hd.indexOf('code') !== -1) ccCol = h;
      if (cnCol === -1 && hd.indexOf('client') !== -1 && hd.indexOf('name') !== -1) cnCol = h;
    }
    if (ccCol === -1) ccCol = 1;
    if (cnCol === -1) cnCol = 2;

    for (const row of rows) {
      const raw = row[cols.contCol];
      if (!raw || String(raw).trim() === '') continue;
      const parts = _splitContainersLoose(raw);
      let hit = false;
      for (const p of parts) { if (normKey(p) === want) { hit = true; break; } }
      if (!hit) continue;

      const o = safeStr(row[cols.ordCol]).trim();
      if (o && !seen[o]) { seen[o] = true; info.orders.push(o); }
      if (!info.clientCode) info.clientCode = safeStr(row[ccCol]).trim();
      if (!info.clientName) info.clientName = safeStr(row[cnCol]).trim();
    }
  } catch (e) { console.error(`[OL-LOOKUP] lease scan ${sheetName}:`, e?.message || e); }
  return info;
}

async function _findLeaseInfoForContainer(want) {
  const info = { orders: [], clientCode: '', clientName: '' };
  const seen = {};

  for (const sheetName of OL_ORDER_SHEETS) {
    const r1 = await _scanSheetForLeaseInfo(sheetName, want);
    for (const o of r1.orders) if (!seen[o]) { seen[o] = true; info.orders.push(o); }
    if (!info.clientCode) info.clientCode = r1.clientCode;
    if (!info.clientName) info.clientName = r1.clientName;
  }

  /* Safety-net fallback: only fires when Operation sheet gives EXACTLY ONE
     distinct Order No for this container — any ambiguity, stay blank (see
     original's SZLU9901527 comment for why). */
  if (!info.orders.length) {
    const fb = await _scanSheetForLeaseInfo(SHEETS.OPERATION, want);
    if (fb.orders.length === 1) {
      info.orders = fb.orders;
      if (!info.clientCode) info.clientCode = fb.clientCode;
      if (!info.clientName) info.clientName = fb.clientName;
    }
  }
  return info;
}

async function _findOrderNosForContainer(want) {
  return (await _findLeaseInfoForContainer(want)).orders;
}

/* ==================== DIAGNOSTICS (admin-only) ==================== */

export async function debugOrderNosForContainer(containerNo) {
  const want = normKey(containerNo);
  if (!want) return 'Enter a container number.';
  const out = [`Container: '${safeStr(containerNo)}'   (normalized: '${want}')`, ''];

  for (const name of OL_ORDER_SHEETS) {
    let headers, rows;
    try { ({ headers, rows } = await getSheetData(name)); } catch (e) { out.push(`${name}: SHEET NOT FOUND`); out.push(''); continue; }
    if (!rows.length) { out.push(`${name}: empty`); out.push(''); continue; }

    const cols = _orderScanCols(headers);
    out.push(`${name}:`);
    out.push(`   container col = ${colLetter(cols.contCol)}  header '${safeStr(headers[cols.contCol])}'${cols.contFallback ? '   ← FALLBACK, header not found!' : ''}`);
    out.push(`   order col     = ${colLetter(cols.ordCol)}  header '${safeStr(headers[cols.ordCol])}'${cols.ordFallback ? '   ← FALLBACK, header not found!' : ''}`);

    let hits = 0;
    const hitLines = [];
    for (let r = 0; r < rows.length; r++) {
      const raw = rows[r][cols.contCol];
      if (!raw || String(raw).trim() === '') continue;
      const parts = _splitContainersLoose(raw);
      let hit = false;
      for (const p of parts) if (normKey(p) === want) { hit = true; break; }
      if (!hit) continue;
      hits++;
      if (hits <= 25) hitLines.push(`   row ${r + 2}  order='${safeStr(rows[r][cols.ordCol])}'   containerCell='${safeStr(raw)}'`);
    }
    out.push(...hitLines);
    if (hits === 0) out.push('   no matching row');
    else if (hits > 25) out.push(`   ... +${hits - 25} more matching rows`);
    out.push('');
  }

  out.push(`Lookup card would show: ${(await _findOrderNosForContainer(want)).join(', ') || '(none)'}`);
  const msg = out.join('\n');
  console.log('[OL-DEBUG]', msg);
  return msg;
}

export async function traceOrderNo(containerNo) {
  const want = normKey(containerNo);
  if (!want) return 'Enter a container number.';
  const out = [`Container: '${safeStr(containerNo)}'`, ''];

  async function scan(name) {
    let headers, rows;
    try { ({ headers, rows } = await getSheetData(name)); } catch (e) { out.push(`${name}: NOT FOUND`); return; }
    if (!rows.length) { out.push(`${name}: empty`); return; }
    const cols = _orderScanCols(headers);
    const hits = [];
    for (let r = 0; r < rows.length; r++) {
      const raw = rows[r][cols.contCol];
      if (!raw || String(raw).trim() === '') continue;
      const parts = _splitContainersLoose(raw);
      let hit = false;
      for (const p of parts) if (normKey(p) === want) { hit = true; break; }
      if (!hit) continue;
      const ord = safeStr(rows[r][cols.ordCol]).trim();
      hits.push(`row ${r + 2}  order=${ord || '(BLANK)'}`);
    }
    out.push(`${name}  [container col ${colLetter(cols.contCol)}, order col ${colLetter(cols.ordCol)}]: ${hits.length ? `${hits.length} row(s)` : 'no match'}`);
    for (let h = 0; h < hits.length && h < 40; h++) out.push(`   ${hits[h]}`);
  }

  await scan('New lease reff'); out.push('');
  await scan(SHEETS.NEW_LEASE); out.push('');
  await scan(SHEETS.OPERATION); out.push('');
  out.push('SOURCE CHAIN:');
  out.push('  New lease reff (col D) --splitContainerRows--> New Lease (col D)');
  out.push('  New Lease (col D) --moveApprovednewleaseData--> Operation sheet (col D)');
  out.push('  generateMonthlyInvoice ALSO appends Operation-sheet rows, but from the');
  out.push('  Deployed sheet which has NO Order No -> those rows are BLANK by design.');

  const msg = out.join('\n');
  console.log('[OL-TRACE]', msg);
  return msg;
}

export async function whatFeedsNewLeaseReff() {
  const names = ['New lease reff', 'New Lease reff', 'New lease ref', 'New Lease Reff'];
  let used = '', block = null;
  for (const n of names) {
    const f = await getFormulasRange(n, 'A1:Z2');
    if (f !== null) { used = n; block = f; break; }
  }
  if (block === null) return 'New lease reff sheet not found.';

  const { rows } = await getSheetData(used).catch(() => ({ rows: [] }));
  const lr = rows.length + 1;
  const lc = Math.max((rows[0] || []).length, (block[0] || []).length, 1);
  const out = [`Sheet: '${used}'   (${lr} rows, ${lc} cols)`, ''];

  let anyFormula = false;
  const importRanges = [];
  out.push('Formulas found (anchor cell holds the QUERY/IMPORTRANGE; spilled cells are blank):');
  for (let rr = 0; rr < block.length; rr++) {
    for (let c = 0; c < block[rr].length; c++) {
      const f = String(block[rr][c] || '').trim();
      if (f !== '') {
        anyFormula = true;
        out.push(`  ${colLetter(c)}${rr + 1}  =  ${f.length > 400 ? `${f.substring(0, 400)} ...` : f}`);
        const im = f.match(/importrange\s*\(\s*"([^"]+)"/i);
        if (im) importRanges.push(im[1]);
      }
    }
  }

  out.push('');
  if (!anyFormula) {
    out.push('=> NO formulas in row 2. The data is TYPED / PASTED directly into this');
    out.push('   sheet (static). It is NOT pulled from another sheet automatically.');
  } else {
    out.push('=> The formula(s) above are the source of the data.');
    if (importRanges.length) {
      out.push('   IMPORTRANGE found -> data comes from ANOTHER spreadsheet:');
      importRanges.forEach((r) => out.push(`      ${r}`));
    } else {
      out.push('   No IMPORTRANGE -> likely QUERY/FILTER from another TAB in THIS file;');
      out.push('   the source range is written inside the formula above.');
    }
  }

  const msg = out.join('\n');
  console.log('[OL-DIAG]', msg);
  return msg;
}

export async function whatFeedsAllSheets() {
  const names = ['New lease reff', SHEETS.NEW_LEASE, SHEETS.OPERATION, SHEETS.DEPLOYED, SHEETS.BILLING_SALES, SHEETS.RECEIVABLES];
  const out = [];
  for (const name of names) {
    const block = await getFormulasRange(name, 'A1:Z2');
    if (block === null) { out.push(`${name}: NOT FOUND`); out.push(''); continue; }
    const { rows } = await getSheetData(name).catch(() => ({ rows: [] }));
    const lr = rows.length + 1;
    const lc = Math.max((rows[0] || []).length, (block[0] || []).length, 1);
    out.push(`${name}   (${lr} rows, ${lc} cols)`);
    if (lr < 1) { out.push('   empty'); out.push(''); continue; }

    let found = false;
    for (let rr = 0; rr < block.length; rr++) {
      for (let c = 0; c < block[rr].length; c++) {
        const f = String(block[rr][c] || '').trim();
        if (f !== '') { found = true; out.push(`   ${colLetter(c)}${rr + 1}  =  ${f.length > 220 ? `${f.substring(0, 220)} ...` : f}`); }
      }
    }
    out.push(found
      ? '   ^^ LIVE MIRROR -> recalculates from the source in the formula above.'
      : '   NO formula -> STATIC rows (script-written or typed). Filling another sheet will NOT flow here.');
    out.push('');
  }
  const msg = out.join('\n');
  console.log('[OL-DIAG]', msg);
  return msg;
}

/* =============================================
   ADD CONTAINER TO OFF-LEASE TRACKING
============================================= */
export async function addToOffLeaseTracking(containerNo) {
  return withSheetLock(OL_SHEET, async () => {
    await _ensureOffLeaseSheet();

    const colA = await getRange(OL_SHEET, 'A2:A');
    for (const r of colA) {
      if (String(r[0]) == containerNo) return 'ALREADY_EXISTS'; // eslint-disable-line eqeqeq
    }

    const { headers: dHeaders, rows: dRows } = await getSheetData(SHEETS.DEPLOYED);
    if (!dRows.length) throw new AppError('No data in Deployed sheet');

    const colMap = {};
    for (let h = 0; h < dHeaders.length; h++) {
      const hdr = String(dHeaders[h] || '').trim().toLowerCase();
      if (hdr === '') continue;
      if (hdr.indexOf('container') !== -1 && colMap.container === undefined) colMap.container = h;
      else if ((hdr.indexOf('customer name') !== -1 || hdr.indexOf('client name') !== -1) && colMap.clientName === undefined) colMap.clientName = h;
      else if ((hdr.indexOf('client code') !== -1 || hdr.indexOf('customer code') !== -1) && colMap.clientCode === undefined) colMap.clientCode = h;
      else if (hdr.indexOf('size') !== -1 && colMap.size === undefined) colMap.size = h;
      else if (hdr.indexOf('type') !== -1 && colMap.type === undefined) colMap.type = h;
      else if (hdr.indexOf('location') !== -1 && colMap.location === undefined) colMap.location = h;
      else if (hdr.indexOf('deployed') !== -1 && hdr.indexOf('date') !== -1 && colMap.deployedDate === undefined) colMap.deployedDate = h;
      else if ((hdr.indexOf('valid') !== -1 || hdr.indexOf('agreement') !== -1) && (hdr.indexOf('upto') !== -1 || hdr.indexOf('till') !== -1 || hdr.indexOf('date') !== -1) && colMap.validUpto === undefined) colMap.validUpto = h;
      else if (hdr.indexOf('rate') !== -1 && colMap.rate === undefined) colMap.rate = h;
      else if (hdr.indexOf('lease id') !== -1 && colMap.leaseId === undefined) colMap.leaseId = h;
    }
    if (colMap.container === undefined) colMap.container = 0;
    if (colMap.clientName === undefined) colMap.clientName = 0;
    if (colMap.clientCode === undefined) colMap.clientCode = 1;
    if (colMap.size === undefined) colMap.size = 2;
    if (colMap.type === undefined) colMap.type = 3;
    if (colMap.location === undefined) colMap.location = 4;
    if (colMap.deployedDate === undefined) colMap.deployedDate = 6;
    if (colMap.validUpto === undefined) colMap.validUpto = 7;
    if (colMap.rate === undefined) colMap.rate = 13;
    if (colMap.leaseId === undefined) colMap.leaseId = 8;

    let found = null, deployedTargetRow = -1;
    for (let j = 0; j < dRows.length; j++) {
      if (dRows[j][colMap.container] && String(dRows[j][colMap.container]).trim() == containerNo) { // eslint-disable-line eqeqeq
        found = dRows[j];
        deployedTargetRow = j + 2;
        break;
      }
    }
    if (!found) throw new AppError(`Container not found: ${containerNo}`);
    console.log(`[OL-ADD] colMap.rate=${colMap.rate}, rateVal=${found[colMap.rate]}`);

    const newRow = new Array(10).fill('');
    newRow[0] = found[colMap.container] || containerNo;
    newRow[1] = safeStr(found[colMap.leaseId]);
    newRow[2] = safeStr(found[colMap.size]);
    newRow[3] = safeStr(found[colMap.type]);
    newRow[4] = safeStr(found[colMap.clientCode]);
    newRow[5] = safeStr(found[colMap.clientName]);
    newRow[6] = safeStr(found[colMap.location]);
    newRow[7] = fmtCell(found[colMap.deployedDate]);
    newRow[8] = fmtCell(found[colMap.validUpto]);
    const rateVal = found[colMap.rate];
    console.log(`[OL-ADD] Writing rate: index=${colMap.rate}, val=${rateVal}, type=${typeof rateVal}`);
    newRow[9] = typeof rateVal === 'number' ? rateVal : safeStr(rateVal);

    await appendRow(OL_SHEET, newRow);

    // Also mark the Deployed sheet — removes it from Pending
    await batchUpdateValues([
      { range: `'${SHEETS.DEPLOYED}'!V${deployedTargetRow}`, values: [[dmyTime(new Date())]] },
      { range: `'${SHEETS.DEPLOYED}'!W${deployedTargetRow}`, values: [['Off-Lease']] }
    ]);

    return 'OK';
  });
}

/* =============================================
   STAGE LIST / DETAIL
============================================= */
export async function getOffLeaseData(stage) {
  await _ensureOffLeaseSheet();
  // Display-only list read, no embedded write in this function — safe to
  // serve from the Mongo mirror (Phase 1b).
  const { headers, rows } = await getSheetDataFromMongo(OL_SHEET);
  const info = OL_STAGE_INFO[stage];
  if (!rows.length || !info) return { headers: [], data: [], stage };

  const displayIndices = [0, 1, 2, 3, 5, 6, 7, 8, 9];
  const displayHeaders = ['Container No', 'Lease ID', 'Size', 'Type', 'Client Name', 'Location', 'Deployed Date', 'Valid Upto', 'Rate'];
  const prevInfo = Number(stage) > 1 ? OL_STAGE_INFO[Number(stage) - 1] : null;
  const intApprovalCol = Number(stage) === 2
    ? _findOlColumnMulti(headers, ['intimation approval status', 'intimation appt status', 'approval status'])
    : -1;

  const finalData = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row[0] || String(row[0]).trim() === '') continue;

    const statusVal = row[info.statusCol];
    if (statusVal && String(statusVal).trim() !== '') continue;

    if (prevInfo) {
      const prevStatus = row[prevInfo.statusCol];
      if (!prevStatus || String(prevStatus).trim() === '') continue;

      if (Number(stage) === 2 && intApprovalCol >= 0) {
        const intApproval = row[intApprovalCol];
        if (!intApproval || String(intApproval).trim().toLowerCase() !== 'approved') continue;
      }
    }

    const displayRow = displayIndices.map((ci) => safeStr(row[ci]));
    const item = { row: displayRow, _rowNum: i + 2 };

    for (const bCol of displayIndices) item[`col_${bCol}`] = fmtCell(row[bCol]);
    for (let c = info.startCol; c <= info.endCol; c++) item[`col_${c}`] = fmtCell(row[c]);

    finalData.push(item);
  }
  return { headers: displayHeaders, data: finalData, stage, stageLabel: info.label, statusCol: info.statusCol };
}

export async function getOffLeaseStageDetail(containerNo, stage) {
  try {
    await _ensureOffLeaseSheet();
    const { rows } = await getSheetData(OL_SHEET);
    const rn = _findOlRowByContainer(rows, containerNo);
    if (rn === -1) {
      console.error(`[OL-DETAIL] Not found: ${containerNo}`);
      return {};
    }
    const info = OL_STAGE_INFO[stage];
    if (!info) { console.error(`[OL-DETAIL] No stage info for stage ${stage}`); return {}; }

    const row = rows[rn - 2] || [];
    const result = {};

    const baseCols = { 0: 'Container No', 1: 'Lease ID', 2: 'Size', 3: 'Type', 4: 'Client Code', 5: 'Client Name', 6: 'Location', 7: 'Deployed Date', 8: 'Valid Upto', 9: 'Rate' };
    for (const b of Object.keys(baseCols)) result[`col_${b}`] = fmtCell(row[Number(b)]);

    for (let c = info.startCol; c <= info.endCol; c++) result[`col_${c}`] = fmtCell(row[c]);

    if (Number(stage) === 3) for (const eci of OL_STAGE3_EXTRA_COLS) result[`col_${eci}`] = safeStr(row[eci]);
    if (Number(stage) === 4) for (const eci of OL_STAGE4_EXTRA_COLS) result[`col_${eci}`] = safeStr(row[eci]);

    return result;
  } catch (e) {
    console.error('[OL-DETAIL] ERROR:', e?.message || e);
    return {};
  }
}

/* =============================================
   AUTO LEASE ID — LEASE0028, LEASE0029, ...
============================================= */
function _formatLeaseId(n) {
  let s = String(n);
  while (s.length < OL_LEASE_ID_PAD) s = `0${s}`;
  return OL_LEASE_ID_PREFIX + s;
}

async function _peekNextLeaseIdNum() {
  let maxN = OL_LEASE_ID_START - 1;
  const col = await getRange(OL_SHEET, 'B2:B');
  for (const r of col) {
    const v = safeStr(r[0]).trim();
    if (!v) continue;
    const m = v.match(/^\s*lease\s*[-_ ]?\s*0*(\d+)\s*$/i);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (!isNaN(n) && n > maxN) maxN = n;
  }
  return maxN + 1;
}

export async function getNextLeaseId() {
  try {
    await _ensureOffLeaseSheet();
    return _formatLeaseId(await _peekNextLeaseIdNum());
  } catch (e) {
    console.error('[LEASE-ID] preview fail:', e?.message || e);
    return '';
  }
}

/* =============================================
   SAVE A STAGE
============================================= */
export async function saveOffLeaseStage(containerNo, stage, data, userEmail) {
  const stageNum = parseInt(stage, 10);
  await checkActionPermission(`offlease${stageNum}`, userEmail); // per-stage access: offlease1..offlease8

  return withSheetLock(OL_SHEET, async () => {
    if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');
    await _ensureOffLeaseSheet();
    const { rows } = await getSheetData(OL_SHEET);
    const rn = _findOlRowByContainer(rows, containerNo);
    if (rn === -1) throw new AppError(`Not found: ${containerNo}`);
    const info = OL_STAGE_INFO[stage];
    if (!info) throw new AppError('Invalid stage');

    const row = rows[rn - 2] || [];
    const curStatus = row[info.statusCol];
    if (curStatus && String(curStatus).trim() !== '') return 'ALREADY_PROCESSED';

    /* STAGE 1 -> assign the Lease ID here (inside the lock = no clash). If the
       row already holds a valid Lease ID, keep it. col_1 sent by the form is
       always ignored, so nobody can force a wrong ID. */
    let assignedLeaseId = '';
    const payload = { ...(data || {}) };
    if (stageNum === 1) {
      if (Object.prototype.hasOwnProperty.call(payload, 'col_1')) delete payload.col_1;
      const curLid = safeStr(row[1]).trim(); // B
      if (curLid && /^\s*lease\s*[-_ ]?\s*0*\d+\s*$/i.test(curLid)) {
        assignedLeaseId = curLid;
      } else {
        assignedLeaseId = _formatLeaseId(await _peekNextLeaseIdNum());
        await updateCell(OL_SHEET, rn, 1, assignedLeaseId); // col B
      }
      console.log(`[LEASE-ID] row ${rn} -> ${assignedLeaseId}${curLid ? ` (was: ${curLid})` : ''}`);
    }

    // Write stage data
    const cellUpdates = [];
    for (const key of Object.keys(payload)) {
      if (key.indexOf('col_') !== 0) continue;
      const colIdx = parseInt(key.replace('col_', ''), 10);
      const val = payload[key];
      if (val === '' || val === undefined || val === null) continue;
      const colName = OL_HEADERS[colIdx] || '';
      if (colName.toLowerCase().indexOf('date') !== -1 && val && typeof val === 'string' && val.length > 0) {
        const dt = parseFormDate(val);
        cellUpdates.push({ range: `'${OL_SHEET}'!${colLetter(colIdx)}${rn}`, values: [[dt ? safeStr(dt) : val]] });
      } else {
        cellUpdates.push({ range: `'${OL_SHEET}'!${colLetter(colIdx)}${rn}`, values: [[val]] });
      }
    }
    // Status + Timestamp + User: (0-based) [statusCol-2]=Timestamp, [statusCol-1]=User, [statusCol]=Status
    cellUpdates.push({ range: `'${OL_SHEET}'!${colLetter(info.statusCol)}${rn}`, values: [['Completed']] });
    cellUpdates.push({ range: `'${OL_SHEET}'!${colLetter(info.statusCol - 2)}${rn}`, values: [[dmyTime(new Date())]] });
    cellUpdates.push({ range: `'${OL_SHEET}'!${colLetter(info.statusCol - 1)}${rn}`, values: [[userEmail || '']] });
    await batchUpdateValues(cellUpdates);

    /* Stage 4 "Quotation Create? = Yes" -> email the client. Best-effort: a
       failed send must never fail the stage save itself. */
    if (stageNum === 4 && String(payload.col_164 || '').trim().toLowerCase() === 'yes') {
      try { await _sendOffLeaseQuotationEmail(rn, payload, row); }
      catch (e) { console.error('[OL-STAGE4-EMAIL-SEND]', e?.message || e); }
    }

    if (assignedLeaseId) return `OK:${assignedLeaseId}`;
    return 'OK';
  });
}

/** `row` = the pre-write base row (cols A-F never change in a stage-4 save,
 *  so the caller's already-fetched row is safe to reuse instead of a re-read). */
async function _sendOffLeaseQuotationEmail(rn, data, row) {
  const to = safeStr(data.col_167).trim();
  if (!to) { console.log('[OL-STAGE4-EMAIL-SEND] no email address — skipped'); return; }

  const containerNo = safeStr(row[0]);
  const leaseId = safeStr(row[1]);
  const size = safeStr(row[2]);
  const type = safeStr(row[3]);
  const clientName = safeStr(row[5]);

  let orderNos = '';
  try { orderNos = (await _findLeaseInfoForContainer(normKey(containerNo))).orders.join(', '); } catch (e) { /* best-effort only */ }

  const quotationNo = safeStr(data.col_59);
  const orderReceivedNo = safeStr(data.col_60);
  const quotationFile = safeStr(data.col_165);
  const quotationAmount = safeStr(data.col_166);
  const deliveryOrderReq = safeStr(data.col_61);

  const subject = `Quotation — ${containerNo}${leaseId ? ` (${leaseId})` : ''}`;
  const lines = [];
  lines.push(`Hello${clientName ? ` ${clientName}` : ''},`);
  lines.push('');
  lines.push('Please find the quotation details for the container below:');
  lines.push('');
  lines.push(`Container No: ${containerNo}`);
  lines.push(`Lease ID: ${leaseId}`);
  lines.push(`Size / Type: ${size} / ${type}`);
  if (orderNos) lines.push(`Order No: ${orderNos}`);
  lines.push(`Quotation No: ${quotationNo}`);
  lines.push(`Order Received No: ${orderReceivedNo}`);
  if (quotationAmount) lines.push(`Quotation Amount: ${quotationAmount}`);
  lines.push(`Delivery Order Required: ${deliveryOrderReq || '-'}`);
  if (quotationFile) lines.push(`Quotation File: ${quotationFile}`);
  lines.push('');
  lines.push('Regards,');
  lines.push('Crystal Group');

  await sendMail({ to, subject, body: lines.join('\n') });
  console.log(`[OL-STAGE4-EMAIL-SEND] sent to ${to} for ${containerNo}`);
}

/* =============================================
   FILL BLANKS FROM DEPLOYED SHEET
============================================= */
async function _fillBlanksFromDeployed(res, want) {
  try {
    const { rows } = await getSheetData(SHEETS.DEPLOYED, undefined, 'A1:P');
    for (const row of rows) {
      if (normKey(row[0]) !== want) continue;
      const fill = (key, val) => {
        const cur = res[key];
        if (cur == null || String(cur).trim() === '') res[key] = val;
      };
      /* Do NOT fill Client Code / Client Name from here — the client always
         comes from Off-Lease Tracking (cols E/F); see original comment. */
      fill('size', safeStr(row[2]));
      fill('type', safeStr(row[3]));
      fill('location', safeStr(row[4]));
      fill('deployedDate', formatDateVal(row[6]));
      fill('validUpto', formatDateVal(row[7]));
      fill('rate', safeAmt(row[13]));
      return;
    }
  } catch (e) { console.error('[OL-LOOKUP] deployed fill:', e?.message || e); }
}

/** Same stage/approval classification getOffLeaseContainerDetail computes
 *  for one container's full detail view, trimmed to just what a pipeline
 *  list needs (no per-field "Filled Stage Data" — that's detail-only). */
function _classifyOffLeaseStages(headers, row) {
  const apCol = _findOlColumnMulti(headers, ['intimation approval status', 'intimation appt status', 'approval status']);
  const approval = apCol >= 0 ? safeStr(row[apCol]).trim() : '';

  const stages = [];
  for (let s = 1; s <= 8; s++) {
    const info = OL_STAGE_INFO[s];
    const st = safeStr(row[info.statusCol]).trim();
    stages.push({ stage: s, label: OL_STAGE_LABELS[s], done: st !== '', timestamp: row[info.statusCol - 2] });
  }

  const apLower = approval.toLowerCase();
  let currentStage, stageClass, currentStageNum;
  if (!stages[0].done) {
    currentStage = `Stage 1 · ${OL_STAGE_LABELS[1]}`; stageClass = 'stage'; currentStageNum = 1;
  } else if (apLower === '') {
    currentStage = 'Pending Approval'; stageClass = 'approval'; currentStageNum = null;
  } else if (apLower === 'rejected') {
    currentStage = 'Rejected — container stays on lease'; stageClass = 'rejected'; currentStageNum = null;
  } else {
    let cur = 0;
    for (let s2 = 1; s2 < 8; s2++) { if (!stages[s2].done) { cur = s2 + 1; break; } }
    if (cur === 0) { currentStage = 'Completed — container released'; stageClass = 'done'; currentStageNum = null; }
    else { currentStage = `Stage ${cur} · ${OL_STAGE_LABELS[cur]}`; stageClass = 'stage'; currentStageNum = cur; }
  }
  return { stages, approvalStatus: approval, currentStage, stageClass, currentStageNum, completed: stageClass === 'done' };
}

function _completedThisMonth(stage8) {
  try {
    // Stage timestamps are written as "dd/MM/yyyy HH:mm:ss" (dmyTime) —
    // parseDate only matches a bare date, so strip the time portion first.
    const datePart = safeStr(stage8.timestamp).trim().split(/\s+/)[0];
    const d = parseDate(datePart);
    if (!d) return false;
    const now = new Date();
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  } catch (e) { return false; }
}

/**
 * Dashboard/pipeline overview — every active off-lease container's current
 * stage in one call (KPI cards + a pipeline table row per container), so
 * the frontend doesn't need 31 individual getOffLeaseContainerDetail calls.
 * Display-only, safe to read from the Mongo mirror.
 */
export async function getOffLeaseDashboardData() {
  await _ensureOffLeaseSheet();
  const { headers, rows } = await getSheetDataFromMongo(OL_SHEET);

  const items = [];
  const kpis = { active: 0, pendingApproval: 0, byStage: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 }, completedThisMonth: 0 };

  for (const row of rows) {
    if (!row[0] || String(row[0]).trim() === '') continue;
    const c = _classifyOffLeaseStages(headers, row);
    items.push({
      container: safeStr(row[0]),
      leaseId: safeStr(row[1]),
      clientName: safeStr(row[5]),
      clientCode: safeStr(row[4]),
      stages: c.stages,
      approvalStatus: c.approvalStatus,
      currentStage: c.currentStage,
      stageClass: c.stageClass,
      currentStageNum: c.currentStageNum
    });

    if (!c.completed) kpis.active++;
    if (c.stageClass === 'approval') kpis.pendingApproval++;
    if (c.currentStageNum) kpis.byStage[c.currentStageNum]++;
    if (c.completed && _completedThisMonth(c.stages[7])) kpis.completedThisMonth++;
  }

  return { kpis, items };
}

/* =============================================
   DASHBOARD — OFF-LEASE CONTAINER LOOKUP
============================================= */
export async function getOffLeaseContainerDetail(containerNo) {
  const want = normKey(containerNo);
  if (!want) return { found: false, message: 'Enter a container number.' };

  const res = { found: false, container: safeStr(containerNo), orderNos: '' };

  const leaseInfo = await _findLeaseInfoForContainer(want);
  res.orderNos = leaseInfo.orders.join(', ');

  await _ensureOffLeaseSheet();
  const { headers, rows } = await getSheetData(OL_SHEET);
  let row = null, rowNum = -1;
  for (let r = 0; r < rows.length; r++) {
    if (normKey(rows[r][0]) === want) { row = rows[r]; rowNum = r + 2; break; }
  }

  if (!row) {
    try {
      const { rows: dRows } = await getSheetData(SHEETS.DEPLOYED);
      for (const d of dRows) {
        if (normKey(d[0]) !== want) continue;
        res.found = true;
        res.inOffLease = false;
        res.container = safeStr(d[0]);
        res.clientName = safeStr(d[1]);
        res.size = safeStr(d[2]);
        res.type = safeStr(d[3]);
        res.location = safeStr(d[4]);
        res.deployedDate = formatDateVal(d[6]);
        res.validUpto = formatDateVal(d[7]);
        res.rate = safeAmt(d[13]);
        res.clientCode = safeStr(d[15]);
        res.leaseId = '';
        res.currentStage = 'Not in off-lease — still on lease';
        res.stageClass = 'none';
        res.stages = [];
        return res;
      }
    } catch (e2) { console.error('[OL-LOOKUP] deployed:', e2?.message || e2); }
    return { found: false, message: `Container not found: ${safeStr(containerNo)}` };
  }

  res.found = true;
  res.inOffLease = true;
  res._rowNum = rowNum;
  res.container = safeStr(row[0]);
  res.leaseId = safeStr(row[1]);
  res.size = safeStr(row[2]);
  res.type = safeStr(row[3]);
  res.clientCode = safeStr(row[4]);
  res.clientName = safeStr(row[5]);
  /* Off-Lease Tracking sheet's own Client Code/Name cell is sometimes blank
     at intimation time -- fall back to the lease/order sheets lookup. */
  if (!res.clientCode && leaseInfo.clientCode) res.clientCode = leaseInfo.clientCode;
  if (!res.clientName && leaseInfo.clientName) res.clientName = leaseInfo.clientName;
  res.location = safeStr(row[6]);
  res.deployedDate = formatDateVal(row[7]);
  res.validUpto = formatDateVal(row[8]);
  res.rate = safeAmt(row[9]);

  const apCol = _findOlColumnMulti(headers, ['intimation approval status', 'intimation appt status', 'approval status']);
  const apTsCol = _findOlColumnMulti(headers, ['intimation approval timestamp', 'intimation appt timestamp']);
  const apUsCol = _findOlColumnMulti(headers, ['intimation approval user', 'intimation appt user']);
  const approval = apCol >= 0 ? safeStr(row[apCol]).trim() : '';
  res.approvalStatus = approval;
  res.approvalDate = apTsCol >= 0 ? formatDateVal(row[apTsCol]) : '';
  res.approvalUser = apUsCol >= 0 ? safeStr(row[apUsCol]) : '';

  const stages = [];
  for (let s = 1; s <= 8; s++) {
    const info = OL_STAGE_INFO[s];
    const st = safeStr(row[info.statusCol]).trim();

    const fields = [];
    for (let c = info.startCol; c <= info.statusCol - 3; c++) {
      const sv = fmtCell(row[c]);
      if (sv.trim() === '') continue;
      fields.push({ label: OL_HEADERS[c] || `Col ${c + 1}`, value: sv });
    }
    if (s === 3) {
      for (const eci of OL_STAGE3_EXTRA_COLS) {
        const sv2 = fmtCell(row[eci]);
        if (sv2.trim() === '') continue;
        fields.push({ label: OL_HEADERS[eci] || `Col ${eci + 1}`, value: sv2 });
      }
    }
    if (s === 4) {
      for (const eci of OL_STAGE4_EXTRA_COLS) {
        const sv3 = fmtCell(row[eci]);
        if (sv3.trim() === '') continue;
        fields.push({ label: OL_HEADERS[eci] || `Col ${eci + 1}`, value: sv3 });
      }
    }

    stages.push({
      stage: s,
      label: OL_STAGE_LABELS[s],
      done: st !== '',
      status: st,
      timestamp: formatDateVal(row[info.statusCol - 2]),
      user: safeStr(row[info.statusCol - 1]),
      fields
    });
  }
  res.stages = stages;

  /* Fill base fields still blank in the Off-Lease sheet (Rate, Location,
     dates) from the Deployed sheet. Never the client — see helper's note. */
  await _fillBlanksFromDeployed(res, want);

  const apLower = approval.toLowerCase();
  if (!stages[0].done) {
    res.currentStage = `Stage 1 · ${OL_STAGE_LABELS[1]}`;
    res.stageClass = 'stage';
  } else if (apLower === '') {
    res.currentStage = 'Pending Approval';
    res.stageClass = 'approval';
  } else if (apLower === 'rejected') {
    res.currentStage = 'Rejected — container stays on lease';
    res.stageClass = 'rejected';
  } else {
    let cur = 0;
    for (let s2 = 1; s2 < 8; s2++) { if (!stages[s2].done) { cur = s2 + 1; break; } }
    if (cur === 0) { res.currentStage = 'Completed — container released'; res.stageClass = 'done'; }
    else { res.currentStage = `Stage ${cur} · ${OL_STAGE_LABELS[cur]}`; res.stageClass = 'stage'; }
  }

  return res;
}

/* =============================================
   PENDING APPROVAL QUEUE (between Stage 1 and Stage 2)
============================================= */
export async function getOffLeaseApprovalData() {
  await _ensureOffLeaseSheet();
  // Display-only list read — safe to serve from the Mongo mirror (Phase 1b).
  const { headers, rows } = await getSheetDataFromMongo(OL_SHEET);
  if (!rows.length) return { headers: [], data: [], count: 0 };

  const stage1StatusCol = _findOlColumn(headers, 'stage 1 status');
  const approvalStatusCol = _findOlColumnMulti(headers, ['intimation approval status', 'intimation appt status', 'approval status']);
  if (stage1StatusCol < 0 || approvalStatusCol < 0) {
    console.error(`[OL-APPROVAL] ERROR: stage1StatusCol=${stage1StatusCol} approvalStatusCol=${approvalStatusCol}`);
    return { headers: [], data: [], count: 0 };
  }

  const displayIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  const dateCols = new Set([7, 8, 10, 11, 13]);
  const displayHeaders = [
    'Container No', 'Lease ID', 'Size', 'Type', 'Client Code', 'Client Name',
    'Location', 'Deployed Date', 'Valid Upto', 'Rate',
    'OL Intimation Date', 'OL Date', 'Email Notification', 'Final Billing Date',
    'Stage 1 Remark', 'Stage 1 Completed On'
  ];

  const finalData = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row[0] || String(row[0]).trim() === '') continue;

    const s1Status = row[stage1StatusCol];
    if (!s1Status || String(s1Status).trim().toLowerCase() !== 'completed') continue;

    const apprStatus = row[approvalStatusCol];
    if (apprStatus && String(apprStatus).trim().toLowerCase() !== '') continue;

    const displayRow = displayIndices.map((ci) => (dateCols.has(ci) ? fmtCell(row[ci]) : safeStr(row[ci])));
    finalData.push({ row: displayRow, _rowNum: i + 2 });
  }

  return { headers: displayHeaders, data: finalData, count: finalData.length };
}

export async function saveOffLeaseApprovalAction(containerNo, status, userEmail) {
  await checkActionPermission('offleaseapproval', userEmail);

  return withSheetLock(OL_SHEET, async () => {
    if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');
    await _ensureOffLeaseSheet();
    const { headers, rows } = await getSheetData(OL_SHEET);
    const rn = _findOlRowByContainer(rows, containerNo);
    if (rn === -1) throw new AppError(`Not found: ${containerNo}`);

    const statusCol = _findOlColumnMulti(headers, ['intimation approval status', 'intimation appt status', 'approval status']);
    const timestampCol = _findOlColumnMulti(headers, ['intimation approval timestamp', 'intimation appt timestamp']);
    const userCol = _findOlColumnMulti(headers, ['intimation approval user', 'intimation appt user']);
    const remarkCol = _findOlColumnMulti(headers, ['intimation approval remark', 'intimation appt remark', 'approval remark']);

    if (statusCol < 0 || timestampCol < 0 || userCol < 0) {
      console.error(`[OL-APPROVAL] ERROR: statusCol=${statusCol} timestampCol=${timestampCol} userCol=${userCol}`);
      throw new AppError('Approval columns not found in sheet. Please check headers.');
    }

    const row = rows[rn - 2] || [];
    const curStatus = row[statusCol];
    if (curStatus && String(curStatus).trim().toLowerCase() !== '') return 'ALREADY_PROCESSED';

    const updates = [
      { range: `'${OL_SHEET}'!${colLetter(statusCol)}${rn}`, values: [[status || '']] },
      { range: `'${OL_SHEET}'!${colLetter(timestampCol)}${rn}`, values: [[dmyTime(new Date())]] },
      { range: `'${OL_SHEET}'!${colLetter(userCol)}${rn}`, values: [[userEmail || '']] }
    ];
    if (status && status.toLowerCase() === 'rejected' && remarkCol >= 0) {
      const remarks = `Rejected on ${fmtDMYHM(new Date())} by ${userEmail || 'unknown'}`;
      updates.push({ range: `'${OL_SHEET}'!${colLetter(remarkCol)}${rn}`, values: [[remarks]] });
    }
    await batchUpdateValues(updates);
    console.log(`[OL-APPROVAL] Saved: rn=${rn} status=${status} user=${userEmail}`);

    /* INSTANT SYNC — update only this container in Master the moment approve/reject happens */
    try {
      const syncRes = await _syncOffLeaseRowToMaster(rn, status);
      console.log(`[OL-APPROVAL] instant sync result: ${syncRes}`);
    } catch (e) {
      console.error('[OL-APPROVAL] instant sync FAIL:', e?.message || e);
    }

    return 'OK';
  });
}

/** INSTANT single-row sync: one OL Tracking row -> Master Sheet (a SEPARATE
 *  spreadsheet, EXTERNAL_SPREADSHEETS.MASTER_WORKBOOK), immediately.
 *  APPROVED -> L/M = "Offlease" + AC = date + container_master_logs row.
 *  REJECTED -> L/M = "Lease" (stays on lease). AC/logs/Deployed untouched.
 *  In both cases ED = "Marked" so the hourly job (out of this port's scope)
 *  does not reprocess it. */
export async function _syncOffLeaseRowToMaster(rn, status) {
  const isApproved = String(status).trim().toLowerCase() === 'approved';
  const ssId = EXTERNAL_SPREADSHEETS.MASTER_WORKBOOK.ssId;

  const olRow = (await getRange(OL_SHEET, `A${rn}:L${rn}`))[0] || [];
  const container = String(olRow[0] || '').trim(); // A
  if (!container) return 'NO_CONTAINER';

  try { await getSheetId(SHEETS.MASTER_SHEET, ssId); } catch (e) { throw new AppError('Master Sheet not found'); }

  const want = normKey(container);
  const colA = await getRange(SHEETS.MASTER_SHEET, 'A2:A', ssId);
  let masterRow = -1;
  for (let i = 0; i < colA.length; i++) {
    if (normKey(colA[i][0]) === want) { masterRow = i + 2; break; }
  }

  if (masterRow === -1) {
    console.log(`[OL-SYNC] NO MATCH for '${container}'`);
    if (!isApproved) await updateCell(OL_SHEET, rn, OL_MARKED_COL_1BASED - 1, 'Marked');
    return 'NO_MASTER_MATCH';
  }
  console.log(`[OL-SYNC] MATCH '${container}' -> Master row ${masterRow}`);

  if (!isApproved) {
    await batchUpdateValues([
      { range: `'${SHEETS.MASTER_SHEET}'!L${masterRow}`, values: [['Lease']] },
      { range: `'${SHEETS.MASTER_SHEET}'!M${masterRow}`, values: [['Lease']] }
    ], ssId);
    await updateCell(OL_SHEET, rn, OL_MARKED_COL_1BASED - 1, 'Marked');
    console.log(`[OL-SYNC] REJECTED -> Master L/M = Lease | ${container}`);
    return 'OK-REJECT-LEASE';
  }

  const size = olRow[2]; // C
  const type = olRow[3]; // D
  const cCode = olRow[4]; // E
  const cName = olRow[5]; // F
  /* OFF-LEASE DATE: prefer "OL Date" (L); if blank use "OL Intimation Date" (K) */
  let olDate = olRow[11];
  if (olDate === '' || olDate == null) olDate = olRow[10];

  const lm = (await getRange(SHEETS.MASTER_SHEET, `L${masterRow}:M${masterRow}`, ssId))[0] || [];
  const mStatus = String(lm[0] || '').trim().toLowerCase();
  const mCurrent = String(lm[1] || '').trim().toLowerCase();

  /* If Master already shows "Stock" in both Status and Current, the
     container is physically in stock — approving Off-Lease intimation must
     NOT flip Status/Current to "Offlease" there; only AC is recorded. */
  if (mStatus === 'stock' && mCurrent === 'stock') {
    await updateCell(SHEETS.MASTER_SHEET, masterRow, 28, olDate, ssId); // AC
    await updateCell(OL_SHEET, rn, OL_MARKED_COL_1BASED - 1, 'Marked');
    console.log(`[OL-SYNC] STOCK -> Status/Current left as Stock, date only | ${container}`);
    return 'OK-OFFLEASE-STOCK';
  }

  await batchUpdateValues([
    { range: `'${SHEETS.MASTER_SHEET}'!L${masterRow}`, values: [['Offlease']] },
    { range: `'${SHEETS.MASTER_SHEET}'!M${masterRow}`, values: [['Offlease']] },
    { range: `'${SHEETS.MASTER_SHEET}'!AC${masterRow}`, values: [[olDate]] }
  ], ssId);

  // Log — only if container_master_logs actually exists (mirrors original's `if (logSheet)` guard).
  // NOTE: intentionally NOT wrapped in its own try/catch — like the original, a failed
  // log append here aborts before the Marked flag is set below, so the row is retried
  // by the hourly job even though L/M/AC were already written (preserved quirk).
  let logExists = true;
  try { await getSheetId(SHEETS.CONTAINER_MASTER_LOGS, ssId); } catch (e) { logExists = false; }
  if (logExists) {
    const logRow = new Array(16).fill('');
    logRow[0] = dmyTime(new Date());
    logRow[2] = 'Offlease';
    logRow[3] = container;
    logRow[4] = type;
    logRow[5] = size;
    logRow[6] = `${String(cCode || '')} ${String(cName || '')}`.trim();
    logRow[7] = type;
    logRow[14] = 'Offlease';
    logRow[15] = 'Offlease';
    await appendRow(SHEETS.CONTAINER_MASTER_LOGS, logRow, ssId);
  }

  await updateCell(OL_SHEET, rn, OL_MARKED_COL_1BASED - 1, 'Marked');
  return 'OK-OFFLEASE';
}

/* =============================================
   NEW LEASE (Approved) -> DEPLOYED SHEET
============================================= */

/** Turn a cell into a compare-safe key (Date -> timestamp, else trim + lowercase). */
export function _cellKey(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return String(v.getTime());
  return (v == null ? '' : v).toString().trim().toLowerCase();
}

/** A contract in the Deployed sheet is identified by Container + Deployed
 *  Date (G) + Valid Upto (H) — cannot dedup on container alone, since the
 *  same container may be re-leased later with different dates. */
export function _deployedKey(container, deployedDate, validUpto) {
  return normKey(container) + '|' + _cellKey(deployedDate) + '|' + _cellKey(validUpto);
}

export async function copyApprovedData() {
  // persist auto-approve (getApproveData is read-only on load; this runs from the hourly trigger)
  try { await runAutoApproval(); } catch (e) { console.error('copyApprovedData->runAutoApproval:', e?.message || e); }

  const { rows: sourceRows } = await getSheetData(SHEETS.NEW_LEASE, undefined, 'A1:AD');
  if (!sourceRows.length) return;

  /* DUPLICATE GUARD — a contract already present in the Deployed sheet is
     skipped (still marked "Moved" so it doesn't retry every hour). */
  const seen = {};
  const { rows: existingRows } = await getSheetData(SHEETS.DEPLOYED, undefined, 'A1:H');
  for (const r of existingRows) {
    const ec = r[0];
    if (!ec || String(ec).trim() === '') continue;
    seen[_deployedKey(ec, r[6], r[7])] = true; // G, H
  }

  const output = [];
  const statusUpdate = [];
  let skipped = 0;

  sourceRows.forEach((row, i) => {
    if (row[26] === 'Approved' && row[29] !== 'Moved') { // AA = Approved AND AD not Moved
      const key = _deployedKey(row[0], row[12], row[13]); // Deployed G<-New Lease M, H<-New Lease N
      if (seen[key]) { statusUpdate.push(i + 2); skipped++; return; }
      seen[key] = true;

      output.push([
        row[0],  // A
        row[2],  // C
        row[10], // K
        row[11], // L
        row[9],  // J
        '',      // Blank
        row[12], // M
        row[13], // N
        row[14], // O
        row[8],  // I
        row[15], // P
        row[7],  // H
        row[16], // Q
        row[6],  // G
        row[17]  // R
      ]);
      statusUpdate.push(i + 2);
    }
  });

  if (output.length) await appendRows(SHEETS.DEPLOYED, output);

  // Mark AD = Moved (copied rows AND skipped duplicates)
  if (statusUpdate.length) {
    const updates = statusUpdate.map((r) => ({ range: `'${SHEETS.NEW_LEASE}'!AD${r}`, values: [['Moved']] }));
    await batchUpdateValues(updates);
  }

  console.log(`[COPY-APPROVED] deployed ${output.length} | skipped duplicate ${skipped}`);
}
