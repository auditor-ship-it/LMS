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
  ensureColumnCount,
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
import { getCollection } from './mongo.service.js';
import { getSheetDataFromMongo, getMongoRowsWithKeys } from './mongoSheetData.service.js';
import { enqueueSheetReplay } from './outbox.service.js';
import { SLA_MS, parseStamp, humanize, budgetLabel } from './offleaseSla.service.js';
import { salePersonScopeFor, matchesSalePersonScope } from './salePersonAccess.service.js';
import { getSalePersonResolver } from './salesCrmLeads.service.js';
import { getGateFormIndexSync, pickGateFormForClient, isGatedIn, isRepairNotRequired, getGateFormForContainer } from './stage3Form.service.js';
import { getDeliveredKeys, isDeliveredSince, getAllOffleaseMovementRows, clientMatches, getMatchedFmsForContainer } from './stage8.service.js';
import { addMoveHistoryEntry } from './offleaseMoveHistory.service.js';
import { sanitizeRemarkHtml } from './offleaseRemarks.service.js';
import { cacheGetOrLoad } from '../utils/memoryCache.js';

/* =============================================
   OFF-LEASE WORKFLOW — 8 STAGES (LMS.js lines 5987-6135)
============================================= */
const OL_SHEET = SHEETS.OFF_LEASE_TRACKING;

/* ---- Stage 3 Machine Check, indices 212..253 (columns HE..IT) ------------
   Ten reefer machine points, each Status / Estimate / Photo / Remark.

   The bases are an explicit list rather than 212 + i*4 because index 249
   (column 250) is the legacy stray documented on OL_MARKED_COL_1BASED: it
   carries no header but DOES hold the value "Marked" in 24 live rows.
   Mapping a field onto it would surface that string as if it were inspection
   data, so the tenth item jumps it and lands at 250..253. 248 and 249 are
   labelled but never read or written by this feature.

   Verified against the live sheet 2026-08-10: 249 is the ONLY occupied cell
   at or beyond index 212. */
const OL_MACHINE_ITEMS = [
  'Compressor', 'Condenser Coil', 'Evaporator Coil', 'Condenser Fan', 'Evaporator Fan',
  'Controller / Microprocessor', 'Power Cable & Plug', 'Refrigerant Gas Charge',
  'Temperature Sensors / Probes', 'Defrost System'
];
const OL_MACHINE_BASES = [180, 184, 188, 192, 196, 200, 204, 208, 212, 218];
const OL_MACHINE_FIRST = 212;
const OL_MACHINE_LAST = 253;

/** Row-1 labels for 212..253, with the two skipped cells named for what they
 *  actually are so nobody maps a field onto them later. */
const OL_MACHINE_HEADER_BLOCK = (() => {
  const out = new Array(OL_MACHINE_LAST - OL_MACHINE_FIRST + 1).fill('');
  const put = (idx, val) => { out[idx - OL_MACHINE_FIRST] = val; };
  OL_MACHINE_ITEMS.forEach((item, i) => {
    const b = OL_MACHINE_BASES[i];
    put(b, `Machine ${item} Status`);
    put(b + 1, `Machine ${item} Estimate`);
    put(b + 2, `Machine ${item} Photo`);
    put(b + 3, `Machine ${item} Remark`);
  });
  put(248, 'Unused (reserved)');
  put(249, 'Marked (legacy, unused)');
  return out;
})();

import { OL_HEADERS } from './olHeaders.generated.js';
export { OL_HEADERS };


/**
 * Re-derived 2026-08-11 from the live header row after 33 columns were deleted
 * from the sheet by hand, which shifted 231 others left. Every range below was
 * resolved by locating that stage's first field and its "... Status" column in
 * row 1 — see olHeaders.generated.js.
 *
 * Stage 4 (Quotation / Order) is gone entirely: it was retired, and its columns
 * were among those deleted. It therefore has no entry here.
 *
 * The status-quad HEADERS still carry the old mislabelling — Billing's quad
 * reads "Stage 4 ...", Get In's reads "Stage 8 ...". The indices are what
 * matter and they are correct; the text is cosmetic.
 */
export const OL_STAGE_INFO = {
  1: { statusCol: 17, startCol: 10, endCol: 17, label: 'Off-Lease Intimation' },   // K..R
  2: { statusCol: 23, startCol: 18, endCol: 23, label: 'Lifting / Arrival' },      // S..X
  3: { statusCol: 28, startCol: 24, endCol: 28, label: 'Inspection Checklist' },   // Y..AC
  5: { statusCol: 44, startCol: 29, endCol: 44, label: 'Billing Reconciliation' }, // AD..AS
  6: { statusCol: 99, startCol: 45, endCol: 99, label: 'Transportation' },         // AT..CV
  7: { statusCol: 135, startCol: 114, endCol: 135, label: 'Gate In' },             // DK..EF
  8: { statusCol: 106, startCol: 100, endCol: 106, label: 'FMS Closure' }          // CW..DC
};
/* 133/134/135 deliberately excluded -- confirmed via the live sheet those
   columns are the Marked sync flag / Email ID / Mail Status feature, not
   Stage 3 photos. */
/* 136..141 = the Stage 3 photo columns. 168..200 = the inspection checklist
   (11 points x Status/Estimate/Photo) and 201..211 = one Remark per point,
   both appended to OL_HEADERS above — listed here so
   getOffLeaseStageDetail() pre-fills them and getOffLeaseContainerDetail()
   reports them. */

/**
 * The 11 Stage 3 inspection points and the column each of their four values
 * lives in. Derived from the header block above: Status/Estimate/Photo run
 * 168 + n*3, Remarks were appended later at 201 + n.
 *
 * Mirrors INSPECTION_POINTS in frontend/src/pages/stages/stageFields.js —
 * the two lists must name the same items in the same order.
 */
/**
 * The inspection points, IN DISPLAY ORDER — array position sets the number the
 * user sees, `status`/`remark` set where the values live. The two are
 * deliberately independent: Gasket Door was added later and displays as point
 * 9, but its columns sit at the end (254..257) so inserting it did not shift
 * Curtain / Tube Light / Mantrap off their existing columns.
 *
 * Columns are therefore listed explicitly, never derived from the index.
 * `reeferOnly` points are hidden for Dry containers, which have no such
 * fittings.
 */
const OL_INSPECTION_DEFS = [
  // Re-derived 2026-08-11 from row 1 after the manual column deletions.
  { item: 'Outside / Undercarriage', status: 136, remark: 169 },   // EG / FN
  { item: 'Inside and Outside Doors', status: 139, remark: 170 },  // EJ / FO
  { item: 'Right Side', status: 142, remark: 171 },                // EM / FP
  { item: 'Left Side', status: 145, remark: 172 },                 // EP / FQ
  { item: 'Front Wall', status: 148, remark: 173 },                // ES / FR
  { item: 'Ceiling / Roof', status: 151, remark: 174 },            // EV / FS
  { item: 'Floor (Inside)', status: 154, remark: 175 },            // EY / FT
  { item: 'Contamination', status: 157, remark: 176 },             // FB / FU
  { item: 'Gasket Door', status: 222, remark: 225 },               // HO / HR
  { item: 'Curtain', status: 160, remark: 177, reeferOnly: true }, // FE / FV
  { item: 'Tube Light', status: 163, remark: 178, reeferOnly: true }, // FH / FW
  { item: 'Mantrap', status: 166, remark: 179, reeferOnly: true }  // FK / FX
];

export const OL_INSPECTION_POINTS = OL_INSPECTION_DEFS.map((d, i) => ({
  n: i + 1,
  item: d.item,
  status: d.status,
  estimate: d.status + 1,
  photo: d.status + 2,
  remark: d.remark,
  reeferOnly: !!d.reeferOnly
}));

/**
 * Machine Check points IN DISPLAY ORDER, with explicit columns. The first ten
 * keep the bases allocated in OL_MACHINE_BASES; the four added later sit at
 * 258+ so nothing shifted. Four consecutive columns each
 * (status / estimate / photo / remark).
 */
const OL_MACHINE_DEFS = [
  ...OL_MACHINE_ITEMS.map((item, i) => ({ item, status: OL_MACHINE_BASES[i] })),
  // Re-derived 2026-08-11 after the manual column deletions.
  { item: 'Cable 4 Core 4mm 18Mtr', status: 226 },  // HS
  { item: 'Motor Condition', status: 230 },         // HW
  { item: 'Contractor', status: 234 },              // IA
  { item: 'ISO Plug', status: 238 }                 // IE
];

export const OL_MACHINE_POINTS = OL_MACHINE_DEFS.map((d, i) => ({
  n: i + 1,
  item: d.item,
  status: d.status,
  estimate: d.status + 1,
  photo: d.status + 2,
  remark: d.status + 3
}));

/** True for any inspection/machine status meaning a fault was recorded — same
 *  rule as frontend/src/pages/stages/stageFields.js's isFaultStatus (Good/OK/
 *  Not Required/blank are sound, everything else — Damage, Rusty, Cut,
 *  Missing, Noisy, Short, Faulty — is a fault). Kept in step with that file. */
function _olIsFaultStatus(status) {
  const s = safeStr(status).trim().toLowerCase();
  return s !== '' && s !== 'good' && s !== 'ok' && s !== 'not required';
}

/**
 * Sums the Stage 4 Inspection Checklist's own per-item "Estimate Value"
 * cells (Container Inspection + Machine Check, 26 points total) for whichever
 * points were actually marked as a fault — mirrors StageDetailModal.jsx's own
 * ChecklistTable, which only shows/populates the Estimate column for a
 * damaged row.
 *
 * Returns null, not 0, when nothing usable was found — either no point was
 * marked as a fault (nothing to estimate) or every faulted point's Estimate
 * cell is still blank (recorded but not costed yet). Both cases mean "no
 * figure exists", which the Billing Reconciliation cost-reference card shows
 * as "—" rather than a misleading ₹0. Callers should NOT fall back to the
 * Gate-In form's free-text budget guess unless this returns null — this is
 * the app's own structured, numeric-typed data and takes priority over a
 * hand-typed note that is "NA" for the overwhelming majority of containers.
 */
function _olInspectionEstimateTotal(row) {
  let total = 0;
  let has = false;
  for (const p of [...OL_INSPECTION_POINTS, ...OL_MACHINE_POINTS]) {
    if (!_olIsFaultStatus(row[p.status])) continue;
    const raw = safeStr(row[p.estimate]).trim();
    if (raw === '') continue;
    const n = Number(raw.replace(/,/g, ''));
    if (Number.isFinite(n)) { total += n; has = true; }
  }
  return has ? total : null;
}

/**
 * Site Cabin fittings inventory, in printed-sheet order. `qty` is the expected
 * count per cabin size — a spec, so it lives here rather than in the sheet;
 * only the count actually found is stored, at `col`.
 *
 * 20FT quantities are from the supplied cabin sheet. Sizes without an entry
 * render with a blank expected quantity until their spec is supplied.
 */
export const OL_CABIN_ITEMS = [
  { item: 'Fan', col: 244, qty: { '20FT': 3 } },
  { item: 'LED', col: 245, qty: { '20FT': 4 } },
  { item: '5 Amp Switch', col: 246, qty: { '20FT': 2 } },
  { item: 'Window', col: 247, qty: { '20FT': 2 } },
  { item: '15A Switch', col: 248, qty: { '20FT': 1 } },
  { item: 'Bulkhead', col: 249, qty: { '20FT': 1 } },
  { item: 'AC point', col: 250, qty: { '20FT': 1 } },
  { item: 'MCB', col: 251, qty: { '20FT': 1 } },
  { item: 'Manager Table', col: 252, qty: { '20FT': 1 } },
  { item: 'Table', col: 253, qty: { '20FT': 4 } },
  { item: 'Overhead Storage', col: 254, qty: { '20FT': 4 } },
  { item: 'Chair', col: 255, qty: { '20FT': 7 } },
  { item: 'Partition', col: 256, qty: { '20FT': 1 } }
];

/** Expected quantity for an item at a given container size, or '' if that
 *  size's spec has not been supplied. */
export function cabinExpectedQty(entry, size) {
  const key = String(size || '').trim().toUpperCase().replace(/\s+/g, '');
  return entry.qty[key] ?? '';
}

/** Technician labour — hours entered by the inspector, cost derived. */
export const OL_TECHNICIAN_RATE_PER_HOUR = 1000;
export const OL_TECHNICIAN_HOURS_COL = 242;
export const OL_TECHNICIAN_COST_COL = 243;

const OL_STAGE3_INSPECTION_COLS = OL_INSPECTION_POINTS
  .flatMap((p) => [p.status, p.estimate, p.photo, p.remark]);
const OL_STAGE3_MACHINE_COLS = [
  ...OL_MACHINE_POINTS.flatMap((p) => [p.status, p.estimate, p.photo, p.remark]),
  OL_TECHNICIAN_HOURS_COL,
  OL_TECHNICIAN_COST_COL
];
const OL_STAGE3_CABIN_COLS = OL_CABIN_ITEMS.map((c) => c.col);
const OL_INSPECTION_COL_SET = new Set([
  ...OL_STAGE3_INSPECTION_COLS, ...OL_STAGE3_MACHINE_COLS, ...OL_STAGE3_CABIN_COLS
]);

const OL_STAGE3_EXTRA_COLS = [
  136, 137, 138, 139, 140, 141,
  ...OL_STAGE3_INSPECTION_COLS,
  ...OL_STAGE3_MACHINE_COLS,
  ...OL_STAGE3_CABIN_COLS
];
const OL_STAGE4_EXTRA_COLS = [164, 165, 166, 167];

/**
 * Billing Reconciliation's (internal Stage 5) own data fields. NOT part of
 * OL_STAGE_INFO[5]'s startCol..endCol range (29..44) — that range's LAST four
 * columns (41-44) are Stage 5's own auto-written Remark/Timestamp/User/Status
 * quad (see saveOffLeaseStage's cellUpdates for statusCol/-1/-2/-3), and
 * every other stage's own field list correctly stops before that quad
 * (Stage 1's Remark sits at col_14 = 17-3, Stage 2's at col_20 = 23-3, by
 * design). Stage 5's field list used to claim col_43 ("Check if rentals
 * billed") and col_44 ("Outstanding Amount") — the SAME cells as its own
 * User/Status stamps, silently overwritten by "Completed"/the saver's email
 * on every single save — and col_45-55 for the rest, which collide with
 * Stage 6 (Transportation)'s own startCol:45. Found 2026-08-31 while chasing
 * "this field never shows what I saved" reports; zero rows had ever
 * accumulated real data in either colliding range, so nothing needed
 * recovering. Relocated here, mirroring how the Inspection Checklist/Cabin/
 * Technician fields were similarly appended once they outgrew a contiguous
 * block — see OL_STAGE_INFO's own header comment for that precedent. */
const OL_STAGE5_EXTRA_COLS = [305, 306, 307, 308, 309, 310, 311, 312, 313, 314, 315, 316];

/* FIXED, not derived — see LMS.js's long comment on this constant. A prior
   derived value (OL_HEADERS.length + 1) collided with real data whenever a
   field was added. Do not change this back to a derived value (a formula
   like OL_HEADERS.length + 1) — that's what this warning is about.
   The VALUE itself was wrong, though: 250 has no header at all (a stray,
   unused column) — confirmed 2026-08-08 against the live sheet, "Marked"
   was silently landing there while the real, documented column (134 = ED
   = "Move to Container master", see the comment on OL_STAGE3_EXTRA_COLS
   above) stayed blank. 134 is still a fixed literal, not a derived one. */
export const OL_MARKED_COL_1BASED = 134;

/* Switched from 'LEASE' 2026-09-01 — new records are now typed "OF00xx"
   directly into the sheet (OF0056..OF0062 confirmed live), so the
   auto-generator follows suit rather than minting a LEASE-prefixed ID nobody
   else is using anymore. Existing LEASE00xx rows are untouched (go-forward
   only) — see _peekNextLeaseIdNum, which reads across BOTH prefixes so the
   counter keeps counting up from whichever is higher, not restarting at
   OL_LEASE_ID_START just because the prefix changed. */
const OL_LEASE_ID_PREFIX = 'OF';
const OL_LEASE_ID_START = 28; // first-ever new Lease ID was LEASE0028
const OL_LEASE_ID_PAD = 4;

/**
 * Stages retired from the workflow. Stage 4 (Quotation / Order) was removed
 * 2026-08-10: a container now goes straight from Stage 3 (Inspection
 * Checklist) to Stage 5 (Billing Reconciliation).
 *
 * Retired, not deleted — OL_STAGE_INFO[4] and its columns are untouched, so
 * rows that already completed Stage 4 keep their data and it still shows in
 * the container lookup and its PDF. What changes is that Stage 4 is no longer
 * offered for entry and is skipped when working out which stage a container
 * is currently sitting at.
 *
 * NOTE: the Stage 4 quotation email (_sendOffLeaseQuotationEmail) fired on a
 * Stage 4 save, so retiring the stage stops those client emails.
 */
/**
 * The live workflow, IN ORDER:
 *   1 Intimation -> Approval gate -> 2 Transportation -> 3 Gate In
 *   -> 4 Inspection -> 5 Billing Reconciliation -> 6 FMS Closure
 *
 * These are INTERNAL stage numbers and the array order IS the workflow order —
 * it no longer ascends. Internal numbers stay fixed because they select the
 * sheet column range; only the sequence and the displayed number change.
 *
 * Get In (internal 7) and Inspection (internal 3) swapped on 2026-08-12: a
 * container is now inspected AFTER it has been received, not before.
 *
 * Retired: 2 (Lifting / Arrival) and 4 (Quotation / Order, whose columns were
 * deleted from the sheet). Their data is preserved and still reported.
 */
export const OL_ACTIVE_STAGE_NUMS = [1, 6, 7, 3, 5, 8];
const OL_RETIRED_STAGES = new Set([2, 4]);

/* Internal numbers for the two stages the STAGE-10 hand-off moves between:
   the tab shown as "Stage 2 (Transportation)" and the one shown as
   "Stage 3 (Gate In)". Named because the display numbers are not the internal
   ones and reading `6` or `7` inline invites the wrong assumption. */
const OL_STAGE2_INTERNAL = 6;
const OL_STAGE3_INTERNAL = 7;

/** Container key for cross-sheet lookups — upper-cased alphanumerics only, so
 *  spacing and punctuation differences between sheets cannot miss. Must stay
 *  identical to normContainer() in stage8.service.js. */
const _containerKey = (v) => safeStr(v).toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Stage numbers shown to users, so the workflow reads 1..7 with no gap where
 * a retired stage used to be. Billing Reconciliation is internally stage 5
 * and displays as "Stage 4".
 *
 * DISPLAY ONLY. The internal number is the stage's identity — it selects the
 * column range in OL_STAGE_INFO, the offlease1..8 permission key and the API
 * route. Renumbering those would write data into another stage's columns.
 * Never map a display number back to a column.
 *
 * A retired stage has no display number: it is not part of the sequence, and
 * reusing its old number would collide with whichever stage now occupies that
 * position.
 */
/**
 * The stage that must be completed before `stage` can be worked — the nearest
 * ACTIVE stage before it, skipping retired ones. Returns null for the first
 * stage. Never use `stage - 1` for this: a retired stage's status column can
 * never be filled, so anything gated on it would stay empty forever.
 */
function _prevActiveStage(stage) {
  /* By POSITION in the workflow, not by numeric value — the sequence is
     1 -> 6 -> 7 -> 3 -> 5 -> 8, so "the previous stage" is the element before
     this one, which numeric comparison would get wrong. */
  const i = OL_ACTIVE_STAGE_NUMS.indexOf(Number(stage));
  if (i > 0) return OL_ACTIVE_STAGE_NUMS[i - 1];
  if (i === 0) return null;
  // A retired stage: gate on whatever precedes it in workflow order.
  return null;
}

const OL_STAGE_DISPLAY = new Map(OL_ACTIVE_STAGE_NUMS.map((s, i) => [s, i + 1]));
const displayStageNum = (s) => OL_STAGE_DISPLAY.get(s) ?? null;
/** "Stage 4 · Billing Reconciliation", or "Quotation / Order (retired)". */
const stageCaption = (s) => {
  const d = displayStageNum(s);
  return d ? `Stage ${d} · ${OL_STAGE_LABELS[s]}` : `${OL_STAGE_LABELS[s]} (retired)`;
};

const OL_STAGE_LABELS = {
  1: 'Off-Lease Intimation', 2: 'Lifting / Arrival', 3: 'Inspection Checklist',
  4: 'Quotation / Order', 5: 'Billing Reconciliation', 6: 'Transportation', 7: 'Gate In',
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
/**
 * For money and quantity cells. These must NEVER go through fmtCell():
 * parseDate() treats a bare number as a date, so an estimate of 10000 came
 * back as "01-01-10000". Returns the number as plain text, or the raw string
 * if it isn't numeric.
 */
function fmtNumCell(val) {
  const s = safeStr(val).trim();
  if (s === '') return '';
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? String(n) : s;
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
 *  or -1 if not found. Internal to _resolveOlRow's no-knownRow branch —
 *  every real caller goes through that, not this directly, so the ambiguous-
 *  duplicate case below is never bypassed. */
function _findOlRowByContainer(rows, containerNo) {
  const want = normKey(containerNo);
  if (!want) return -1;
  for (let i = 0; i < rows.length; i++) {
    if (normKey(rows[i][0]) === want) return i + 2;
  }
  return -1;
}

/**
 * Resolves the exact Off-Lease Tracking row for a read or write, preferring
 * a caller-supplied row number (validated against containerNo) over blind
 * first-match. Container No is NOT unique in this sheet — a container
 * re-leased after an earlier cycle keeps its old row alongside the new one
 * — confirmed live 2026-08-31: TRIU6681671 has both LEASE0027/Hetero Labs
 * Limited/Kolar AND LEASE0038/63Ideas Infolabs Pvt Ltd/Krishnagiri as
 * separate rows. Every one of getOffLeaseStageDetail/saveOffLeaseStage(Fast)
 * and the whole Hold/Move-To-Stage/Send-Back/Approval family used
 * first-match-by-container alone until this fix, which is how opening a
 * specific list row's "Open" button could silently show (and a submit could
 * silently WRITE) a completely different lease's data for the same
 * container — the exact bug class already fixed for the Deployed sheet, New
 * Lease and Verify Lease earlier this session, now closed here too.
 *
 * `knownRow` is the 1-based sheet row (item._rowNum from getOffLeaseData/
 * getOffLeaseApprovalData/getOffLeaseDashboardData — whichever list the
 * caller actually clicked a row in) the caller actually acted on. Throws a
 * clear "may have changed" error if it no longer matches rather than
 * silently falling through to a different row.
 *
 * HARDENED 2026-08-31 (user directive: this class of error must never
 * recur): omitting knownRow is safe ONLY when the container genuinely has
 * one row — first-match-by-container is used in that case exactly as
 * before. The moment a SECOND row for the same container exists, silently
 * picking "whichever comes first" is exactly the bug this whole fix closes,
 * so that case now throws a clear, actionable error instead of guessing —
 * every real call site already has a row number to pass (threaded through
 * on the frontend this same day); a caller that doesn't is a bug to fix at
 * the call site, not a case to silently paper over here. */
function _resolveOlRow(rows, containerNo, knownRow) {
  if (knownRow != null) {
    const row = rows[knownRow - 2];
    if (!row || normKey(row[0]) !== normKey(containerNo)) {
      throw new AppError(`Row ${knownRow} no longer matches ${containerNo} — it may have changed. Refresh and try again.`);
    }
    return knownRow;
  }
  const want = normKey(containerNo);
  if (!want) return -1;
  let first = -1, count = 0;
  for (let i = 0; i < rows.length; i++) {
    if (normKey(rows[i][0]) !== want) continue;
    count++;
    if (first === -1) first = i + 2;
  }
  if (count > 1) {
    throw new AppError(
      `${containerNo} has ${count} Off-Lease Tracking records — open it from its own list row (not by container number alone) so the exact one can be targeted.`
    );
  }
  return first;
}

/** Mongo-first equivalent of _resolveOlRow — same reasoning (including the
 *  2026-08-31 hardening: an unspecified row is only safe when the container
 *  is genuinely unique), resolves against getMongoRowsWithKeys' row_<n>-
 *  keyed docs (OL_SHEET's mirror is fullRefresh/position-keyed, precisely
 *  because container numbers here are not unique) instead of a live-Sheets
 *  row array. Returns the matched { key, row } doc, or undefined if
 *  genuinely not found — callers already check for that. */
function _resolveOlMongoDoc(docs, containerNo, knownRow) {
  if (knownRow != null) {
    const doc = docs.find((d) => d.key === `row_${knownRow - 2}`);
    if (!doc || normKey(doc.row[0]) !== normKey(containerNo)) {
      throw new AppError(`Row ${knownRow} no longer matches ${containerNo} — it may have changed. Refresh and try again.`);
    }
    return doc;
  }
  const want = normKey(containerNo);
  const allMatches = docs.filter((d) => normKey(d.row[0]) === want);
  if (allMatches.length > 1) {
    throw new AppError(
      `${containerNo} has ${allMatches.length} Off-Lease Tracking records — open it from its own list row (not by container number alone) so the exact one can be targeted.`
    );
  }
  return allMatches[0]; // undefined when genuinely not found — callers already check for that
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
      /* The grid has to be wide enough first — values.update cannot write past
         the sheet's existing column count, it fails with "exceeds grid
         limits" rather than growing the sheet. */
      await ensureColumnCount(OL_SHEET, OL_HEADERS.length);
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
    // Read-only lookup, no write follows — also on the regular container-
    // detail path (getOffLeaseContainerDetail -> _findLeaseInfoForContainer),
    // not just the admin diagnostics below. Safe for the Mongo mirror.
    const { headers, rows } = await getSheetDataFromMongo(sheetName);
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
    try { ({ headers, rows } = await getSheetDataFromMongo(name)); } catch (e) { out.push(`${name}: SHEET NOT FOUND`); out.push(''); continue; }
    if (!rows.length) { out.push(`${name}: empty`); out.push(''); continue; }

    const cols = _orderScanCols(headers);
    out.push(`${name}:`);
    out.push(`   container col = ${colLetter(cols.contCol)}  header '${safeStr(headers[cols.contCol])}'${cols.contFallback ? '   â† FALLBACK, header not found!' : ''}`);
    out.push(`   order col     = ${colLetter(cols.ordCol)}  header '${safeStr(headers[cols.ordCol])}'${cols.ordFallback ? '   â† FALLBACK, header not found!' : ''}`);

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
    try { ({ headers, rows } = await getSheetDataFromMongo(name)); } catch (e) { out.push(`${name}: NOT FOUND`); return; }
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
/**
 * Deployed-sheet lookup shared by addToOffLeaseTracking and the FMS
 * auto-create path (_autoCreateOffLeaseFromFmsRow) — factored out 2026-08-28
 * so the new path can reuse the exact same, already-correct column-detection
 * and row-matching logic instead of a second copy that could drift from it.
 *
 * `preFetched`: an already-fetched {headers, rows}, so a caller resolving
 * MANY containers in one pass (autoCreateOffLeaseFromFms's dry-run scan)
 * reads Deployed ONCE instead of once per candidate — added 2026-08-28,
 * same "read once, share across every row" fix as getOffLeaseData's
 * opts.sheetData. Omit it (both real write-path callers do) to force a
 * fresh LIVE read, correctly, right before the write that targets
 * `targetRow` depends on it.
 */
/**
 * `targetRow` (1-based sheet row, header = row 1): when given, addresses
 * that EXACT row directly instead of searching — the container number is
 * NOT unique on this sheet (GRMU3707464, TRIU6681671 and others each have
 * more than one row — a returned lease's old row is left in place, not
 * deleted, when the container goes out again under a new client), so a
 * plain "first row matching this container number" search can silently
 * grab a stale, already-superseded row instead of the one the caller
 * actually means. Confirmed 2026-08-29: off-leasing GRMU3707464 from its
 * Lease Expiry detail page (customer "Bengaluru Co.op. Milk Union
 * Ltd.(BAMUL)", the current, active deployment) created the Off-Lease
 * Tracking row under "DR reddy CTO 6" instead — an OLDER row for the same
 * container, sitting earlier in the sheet, that the search reached first.
 * Every caller that has a specific row in hand (the Lease Expiry page,
 * which is built by reading this exact sheet) should pass it.
 *
 * `clientNameHint`: for the one caller that has NO specific row to point at
 * (the FMS auto-create path — a Stage 8 movement row only carries a
 * container number and client name, never a Deployed row reference) — used
 * as a second-best safety net, same principle as `targetRow` but weaker.
 * When given, a row matching BOTH container AND client (via the same
 * fuzzy clientMatches() stage8.service.js already uses for FMS matching)
 * is preferred over a blind first-match; falls through to the plain
 * first-match search if no row satisfies both, so an unrecognized/aliased
 * client name never turns into a hard failure. */
async function _lookupDeployedForOffLease(containerNo, preFetched, targetRow, clientNameHint) {
  const { headers: dHeaders, rows: dRows } = preFetched || await getSheetData(SHEETS.DEPLOYED);
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

  if (targetRow != null) {
    const j = targetRow - 2;
    const row = dRows[j];
    // Still verified against the container number — a stale/out-of-range
    // row reference (the sheet changed shape since the caller last read it)
    // must fail loudly, never silently write under the wrong container.
    if (!row || !row[colMap.container] || String(row[colMap.container]).trim() != containerNo) { // eslint-disable-line eqeqeq
      throw new AppError(`Deployed sheet row ${targetRow} no longer matches ${containerNo} — it may have changed. Refresh and try again.`);
    }
    return { found: row, colMap, targetRow };
  }

  if (clientNameHint) {
    for (let j = 0; j < dRows.length; j++) {
      const row = dRows[j];
      if (!row[colMap.container] || String(row[colMap.container]).trim() != containerNo) continue; // eslint-disable-line eqeqeq
      if (clientMatches(row[colMap.clientName], clientNameHint)) return { found: row, colMap, targetRow: j + 2 };
    }
    // No container+client match — fall through to the plain search below
    // rather than fail outright; an aliased/misspelled client name is a
    // known, accepted risk elsewhere in this file (see clientMatches'
    // own doc comment), not grounds to block a container that IS on the
    // Deployed sheet.
  }

  for (let j = 0; j < dRows.length; j++) {
    if (dRows[j][colMap.container] && String(dRows[j][colMap.container]).trim() == containerNo) { // eslint-disable-line eqeqeq
      return { found: dRows[j], colMap, targetRow: j + 2 };
    }
  }
  return { found: null, colMap, targetRow: -1 };
}

/** Appended columns (olHeaders.generated.js), same fixed-literal convention
 *  as Move To Stage (290-299) / Hold (300-302) — picked past the end of
 *  every real sheet column and every other bolt-on feature's own block, so
 *  none can ever collide. Captured once, at Off-Lease creation time, from
 *  the confirmation dialog (OffLeaseModal, frontend) — this row has no
 *  other narrative/free-text field until Stage 1's own form is filled in
 *  later, so without these two there was nowhere to record who initiated
 *  the off-lease or why. */
const OL_TRACKING_REMARKS_COL = 303;
const OL_TRACKING_PERSON_NAME_COL = 304;

/** `deployedRow`: optional, the specific Deployed sheet row (1-based) to
 *  off-lease — see _lookupDeployedForOffLease's doc comment for why this
 *  matters whenever a container has more than one row there. `remarks` and
 *  `personName` (OffLeaseModal, frontend): personName is who requested/
 *  handled this off-lease; remarks is optional free text. */
export async function addToOffLeaseTracking(containerNo, deployedRow, remarks = '', personName = '') {
  return withSheetLock(OL_SHEET, async () => {
    await _ensureOffLeaseSheet();

    const colA = await getRange(OL_SHEET, 'A2:A');
    for (const r of colA) {
      if (String(r[0]) == containerNo) return 'ALREADY_EXISTS'; // eslint-disable-line eqeqeq
    }

    const { found, colMap, targetRow: deployedTargetRow } = await _lookupDeployedForOffLease(containerNo, undefined, deployedRow);
    if (!found) throw new AppError(`Container not found: ${containerNo}`);
    console.log(`[OL-ADD] colMap.rate=${colMap.rate}, rateVal=${found[colMap.rate]}`);

    const newRow = new Array(10).fill('');
    newRow[0] = found[colMap.container] || containerNo;
    // Column B (Lease ID) stays blank here — Deployed sheet has no per-row
    // Lease ID to copy from at all (there's no such column; the header
    // search here never matched, so this used to silently fall back to a
    // hardcoded index that happened to land on "Agreement PDF", writing a
    // Drive link into the Lease ID column). saveOffLeaseStage already
    // generates and writes the real LEASE00XX id here itself, but only once
    // Stage 1 completes (see its "STAGE 1 -> assign the Lease ID" block) —
    // that's the single source of truth for this column, by design.
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

    const { rowNum } = await appendRow(OL_SHEET, newRow);

    // Remarks / Person Name (OffLeaseModal) — a separate write, not part of
    // newRow above: newRow is only ever 10 cells wide (appendRow leaves
    // every column past that untouched on the sheet), so a column this far
    // out (303/304) is written the same way the Deployed-sheet mark below is
    // — a targeted cell update against the row appendRow just returned.
    const rmk = safeStr(remarks).trim();
    const person = safeStr(personName).trim();
    if (rowNum) {
      await batchUpdateValues([
        { range: `'${OL_SHEET}'!${colLetter(OL_TRACKING_REMARKS_COL)}${rowNum}`, values: [[rmk]] },
        { range: `'${OL_SHEET}'!${colLetter(OL_TRACKING_PERSON_NAME_COL)}${rowNum}`, values: [[person]] }
      ]);
    }

    // Also mark the Deployed sheet — removes it from Pending
    const stamp = dmyTime(new Date());
    await batchUpdateValues([
      { range: `'${SHEETS.DEPLOYED}'!V${deployedTargetRow}`, values: [[stamp]] },
      { range: `'${SHEETS.DEPLOYED}'!W${deployedTargetRow}`, values: [['Off-Lease']] }
    ]);

    /* MIRROR BOTH WRITES INTO MONGO IMMEDIATELY.
     *
     * Every off-lease screen reads the Mongo mirror, but this function wrote
     * only to Sheets — so a container off-leased from Lease Expiry did not
     * appear under Off-Lease until the reconcile job next ran, up to five
     * minutes later. saveOffLeaseStage already does this for the same reason;
     * this path was simply missed.
     *
     * Best-effort: reconcile remains the source of truth, so a failure here
     * must never fail a write that already succeeded on the sheet. */
    try {
      /* Keyed by POSITION. Container numbers are not unique on this sheet
         (TRIU6681671 has two records), so `row_<n>` is the only safe address.
         `rowNum` is 1-based including the header, and data row 2 is row_0. */
      if (rowNum) {
        const mirrorRow = [...newRow];
        mirrorRow[OL_TRACKING_REMARKS_COL] = rmk;
        mirrorRow[OL_TRACKING_PERSON_NAME_COL] = person;
        await getCollection(OL_SHEET).updateOne(
          { key: `row_${rowNum - 2}` },
          { $set: { key: `row_${rowNum - 2}`, row: mirrorRow } },
          { upsert: true }
        );
      }
      /* Deployed's Update (V) and Status (W) too — they drive the Lease Expiry
         list and seed Stage 1's SLA clock. */
      await getCollection(SHEETS.DEPLOYED).updateOne(
        { key: `row_${deployedTargetRow - 2}` },
        { $set: { 'row.21': stamp, 'row.22': 'Off-Lease' } }
      );
    } catch (e) {
      console.error('[OL-ADD] mirror update failed (reconcile will correct):', e?.message || e);
    }

    /* Notification email moved to Stage 1 (Off-Lease Intimation) completion,
     * NOT here — a real user correction 2026-09-01: this point only creates
     * the tracking row, and Lease ID isn't assigned until Stage 1 saves (see
     * the "Column B (Lease ID) stays blank here" comment above), so a mail
     * sent from here could never carry a real Lease ID. See
     * saveOffLeaseStage's own notification block for the actual trigger. */

    return 'OK';
  });
}

/** Every base + Stage 1 column, per request 2026-09-01 ("send the all header
 *  data") — widened from the original 9-field + Status spec. `row` is the
 *  row as it stands right after Stage 1 (Off-Lease Intimation) has just
 *  saved — Lease ID is real by this point (saveOffLeaseStage assigns it
 *  before this fires), unlike at the moment the tracking row is first
 *  created (see addToOffLeaseTracking's own comment on why it moved).
 *  row[10..17] (OL Intimation Date through Stage 1 Status) are set by the
 *  caller from the just-submitted payload / this same save's own
 *  Timestamp/User/Status write, not read fresh here — see that call site's
 *  comment. The trailing literal "Status: Off-Lease" line is kept alongside
 *  the real "Stage 1 Status" column (which reads "Completed") — the original
 *  spec asked for it explicitly and a later request to add more columns
 *  didn't say to drop it. */
async function _sendOffLeaseNotification(row) {
  const fields = [
    ['Container No', safeStr(row[0])],
    ['Lease ID', safeStr(row[1])],
    ['Size', safeStr(row[2])],
    ['Type', safeStr(row[3])],
    ['Client Code', safeStr(row[4])],
    ['Client Name', safeStr(row[5])],
    ['Location', safeStr(row[6])],
    ['Deployed Date', safeStr(row[7])],
    ['Valid Upto', safeStr(row[8])],
    ['Rate', safeStr(row[9])],
    ['OL Intimation Date', safeStr(row[10])],
    ['OL Date', safeStr(row[11])],
    ['Email Notification URL', safeStr(row[12])],
    ['Final Billing Date', safeStr(row[13])],
    ['Stage 1 Remark', safeStr(row[14])],
    ['Stage 1 Timestamp', safeStr(row[15])],
    ['Stage 1 User', safeStr(row[16])],
    ['Stage 1 Status', safeStr(row[17])],
    ['Status', 'Off-Lease']
  ];

  const subject = `Off-Lease Notification – ${fields[0][1] || 'Unknown Container'}`;

  // Vertical (Field / Value per row), not the earlier horizontal layout —
  // a wide 11-column table clipped in most inboxes' preview pane; a label
  // column reads cleanly at any width.
  const body = fields.map(([label, val]) => `${label}: ${val || '-'}`).join('\n') + '\n';

  const isUrl = (s) => /^https?:\/\//i.test(s);
  const th = (s) => `<td style="padding:8px 12px;border:1px solid #ddd;background:#f4f4f4;font-weight:bold;font-size:13px;white-space:nowrap;">${s}</td>`;
  const td = (s) => `<td style="padding:8px 12px;border:1px solid #ddd;font-size:13px;">${s ? (isUrl(s) ? `<a href="${s}">${s}</a>` : s) : '-'}</td>`;
  const html = `
    <table style="border-collapse:collapse;font-family:Arial,sans-serif;">
      ${fields.map(([label, val]) => `<tr>${th(label)}${td(val)}</tr>`).join('')}
    </table>
  `;

  await sendMail({ to: 'support@crystalgroup.in', subject, body, html });
  console.log(`[OL-ADD-EMAIL] Off-Lease notification sent for ${fields[0][1]}`);
}

/* =============================================
   AUTO-CREATE OFF-LEASE STAGE 2 FROM FMS STAGE 8 (2026-08-28)

   Explicit, deliberate workflow change requested by the user: a Stage 8
   (external FMS) row with Movement Type = "Offlease" now creates an
   Off-Lease Tracking row AND completes its Stage 1 (Off-Lease Intimation)
   automatically — attributed to the system ("Auto — FMS Stage 8"), not a
   human. This is DIFFERENT from every other FMS integration in this file
   (getFmsForContainer, enrichWithStage8Movements, getDeliveredKeys), which
   only ever ENRICH a record a person already started via Stage 1 — this is
   the one place Stage 8 data creates a new record by itself.

   SAFETY: dryRun defaults to true. A dry run makes ZERO writes (to Sheets or
   Mongo) — it only reads (Mongo mirror for the dedup set, one live Deployed
   read per candidate, matching the live-read-before-write rule every other
   write path in this file follows) and reports what WOULD happen and why.
   Real writes only happen when a caller explicitly passes dryRun:false —
   this is deliberately NOT wired into the automatic 5-minute FMS refresh
   cron; it must be triggered (and reviewed) explicitly until the user is
   satisfied with dry-run output across real data.
============================================= */

/** "Source DO No" — the last column of OL_HEADERS (olHeaders.generated.js),
 *  a NEW bookkeeping column this feature added, not a live-sheet capture.
 *  Fixed literal, not derived, per this file's established convention for
 *  columns where drift would silently corrupt data (see OL_MARKED_COL_1BASED). */
const OL_SOURCE_DO_COL = 289;

const _normDoLike = (v) => safeStr(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
const OL_AUTO_FMS_MIN_DO_LEN = 5; // same threshold/reasoning as stage8.service.js's MIN_DO_LEN — excludes "NA"-style placeholders

/** Every Source DO already linked to an Off-Lease Tracking row — from the
 *  Mongo mirror (fast), used to skip Stage 8 rows already fetched in (rule:
 *  "no duplicate records"). */
async function _linkedSourceDOs() {
  const { rows } = await getSheetDataFromMongo(OL_SHEET);
  const set = new Set();
  for (const row of rows) {
    const v = _normDoLike(row[OL_SOURCE_DO_COL]);
    if (v) set.add(v);
  }
  return set;
}

/**
 * Scans every Stage 8 "Offlease" movement row (already filtered by
 * readOffleaseRows) and, for each one not yet linked, reports what would
 * happen (dryRun, default) or actually creates the Off-Lease Stage 2 record
 * (dryRun:false).
 *
 * Per-row outcome `status`:
 *   WOULD_CREATE / CREATED   — eligible, everything checks out
 *   ALREADY_LINKED           — this DO is already on an Off-Lease Tracking row
 *   SKIPPED_INVALID          — missing/unusable Container No, Client Name, or DO No
 *   SKIPPED_NOT_IN_DEPLOYED  — container isn't on the Deployed sheet (already
 *                               off-leased elsewhere, or never tracked here) —
 *                               there's no base record (size/type/location/...)
 *                               to seed a tracking row from
 *   ERROR                    — unexpected failure for this one row; never
 *                               aborts the rest of the scan
 */
export async function autoCreateOffLeaseFromFms({ dryRun = true } = {}) {
  const rows = await getAllOffleaseMovementRows();
  const linked = await _linkedSourceDOs();
  // Read once (Mongo mirror — this is a classification pass, not the write
  // itself), shared across every candidate in the scan below, instead of one
  // live Sheets read per row. The actual write, inside
  // _createOffLeaseRecordFromFmsRow, always re-does this lookup fresh and
  // live right before writing regardless of what this snapshot found, so a
  // few minutes of staleness here can only ever produce an overly-cautious
  // SKIPPED_NOT_IN_DEPLOYED at write time, never a wrong write.
  const deployedSnapshot = await getSheetDataFromMongo(SHEETS.DEPLOYED);
  const results = [];

  for (const r of rows) {
    const container = safeStr(r.containerNo).trim();
    const client = safeStr(r.clientName).trim();
    const doRaw = safeStr(r.deliveryOrderNo).trim() || safeStr(r.bookingOrderNo).trim();
    const doNorm = _normDoLike(doRaw);

    const missing = [];
    if (!container) missing.push('Container No');
    if (!client) missing.push('Client Name');
    if (doNorm.length < OL_AUTO_FMS_MIN_DO_LEN) missing.push('DO No');
    if (missing.length) {
      results.push({ container: container || '(blank)', do: doRaw || '(blank)', client, status: 'SKIPPED_INVALID', reason: `Missing/invalid: ${missing.join(', ')}` });
      continue;
    }

    if (linked.has(doNorm)) {
      results.push({ container, do: doRaw, client, status: 'ALREADY_LINKED' });
      continue;
    }

    let deployedInfo;
    try {
      deployedInfo = await _lookupDeployedForOffLease(container, deployedSnapshot, undefined, client);
    } catch (e) {
      results.push({ container, do: doRaw, client, status: 'ERROR', reason: e?.message || String(e) });
      continue;
    }
    if (!deployedInfo.found) {
      results.push({ container, do: doRaw, client, status: 'SKIPPED_NOT_IN_DEPLOYED' });
      continue;
    }

    if (dryRun) {
      results.push({
        container, do: doRaw, client,
        status: 'WOULD_CREATE',
        deployedClientName: safeStr(deployedInfo.found[deployedInfo.colMap.clientName])
      });
      continue;
    }

    try {
      const status = await _createOffLeaseRecordFromFmsRow(container, doRaw, client);
      results.push({ container, do: doRaw, client, status });
    } catch (e) {
      results.push({ container, do: doRaw, client, status: 'ERROR', reason: e?.message || String(e) });
    }
  }

  const summary = results.reduce((acc, x) => { acc[x.status] = (acc[x.status] || 0) + 1; return acc; }, {});
  return { dryRun, scanned: rows.length, summary, results };
}

/** The live-write half of autoCreateOffLeaseFromFms — everything re-checked
 *  fresh inside the lock (dedup set AND the Deployed lookup), never trusting
 *  the caller's dry-run snapshot for the actual write, same as every other
 *  write path in this file. */
async function _createOffLeaseRecordFromFmsRow(containerNo, doRaw, clientNameHint) {
  return withSheetLock(OL_SHEET, async () => {
    await _ensureOffLeaseSheet();

    const linked = await _linkedSourceDOs();
    if (linked.has(_normDoLike(doRaw))) return 'ALREADY_LINKED';

    const { found, colMap, targetRow: deployedTargetRow } = await _lookupDeployedForOffLease(containerNo, undefined, undefined, clientNameHint);
    if (!found) return 'SKIPPED_NOT_IN_DEPLOYED';

    const leaseId = _formatLeaseId(await _peekNextLeaseIdNum());
    const stamp = dmyTime(new Date());
    const s1 = OL_STAGE_INFO[1];

    const newRow = new Array(OL_HEADERS.length).fill('');
    newRow[0] = found[colMap.container] || containerNo;
    newRow[1] = leaseId;
    newRow[2] = safeStr(found[colMap.size]);
    newRow[3] = safeStr(found[colMap.type]);
    newRow[4] = safeStr(found[colMap.clientCode]);
    // Deployed's OWN client name, not the FMS row's — consistent with the
    // rest of the app (access scoping, Sales CRM matching, etc. all key off
    // this sheet's own client-name spelling), and avoids seeding a
    // differently-spelled client name that would itself fail exactly the
    // alias-matching problem this whole feature was built around.
    newRow[5] = safeStr(found[colMap.clientName]);
    newRow[6] = safeStr(found[colMap.location]);
    newRow[7] = fmtCell(found[colMap.deployedDate]);
    newRow[8] = fmtCell(found[colMap.validUpto]);
    const rateVal = found[colMap.rate];
    newRow[9] = typeof rateVal === 'number' ? rateVal : safeStr(rateVal);

    // Stage 1 (Off-Lease Intimation), auto-completed — same status-quad
    // convention saveOffLeaseStage uses (statusCol-2=timestamp,
    // statusCol-1=user, statusCol=status), attributed to the system.
    newRow[s1.startCol] = stamp.split(' ')[0];       // "OL Intimation Date"
    newRow[s1.statusCol - 2] = stamp;                // "Stage 1 Timestamp"
    newRow[s1.statusCol - 1] = 'Auto — FMS Stage 8';  // "Stage 1 User"
    newRow[s1.statusCol] = 'Completed';               // "Stage 1 Status"

    newRow[OL_SOURCE_DO_COL] = doRaw;

    const { rowNum } = await appendRow(OL_SHEET, newRow);

    const dStamp = dmyTime(new Date());
    await batchUpdateValues([
      { range: `'${SHEETS.DEPLOYED}'!V${deployedTargetRow}`, values: [[dStamp]] },
      { range: `'${SHEETS.DEPLOYED}'!W${deployedTargetRow}`, values: [['Off-Lease']] }
    ]);

    try {
      if (rowNum) {
        await getCollection(OL_SHEET).updateOne(
          { key: `row_${rowNum - 2}` },
          { $set: { key: `row_${rowNum - 2}`, row: newRow } },
          { upsert: true }
        );
      }
      await getCollection(SHEETS.DEPLOYED).updateOne(
        { key: `row_${deployedTargetRow - 2}` },
        { $set: { 'row.21': dStamp, 'row.22': 'Off-Lease' } }
      );
    } catch (e) {
      console.error('[OL-AUTO-FMS] mirror update failed (reconcile will correct):', e?.message || e);
    }

    console.log(`[OL-AUTO-FMS] Created ${containerNo} / DO ${doRaw} -> ${leaseId} (client: ${newRow[5]})`);
    return 'CREATED';
  });
}

/* =============================================
   STAGE LIST / DETAIL
============================================= */
/**
 * @param opts.deliveredKeys Set of "CONTAINER|client" that have a STAGE-10
 *   site-delivery record. Those containers are treated as finished with
 *   Stage 2 and released to Stage 3 (Gate In).
 *
 *   Stage 2 is read-only and has no form, so its status column can never be
 *   filled — without this, Gate In would gate on a column nothing can write
 *   and no container would ever reach it. STAGE-10 being filled IS the
 *   completion signal for that leg.
 *
 *   Done as a read-time rule rather than by writing "Completed" into the
 *   tracking sheet: that sheet currently has 212 columns where the code
 *   expects 289, so a positional write to a stage status column would land in
 *   the wrong place. This achieves the same movement with no write at all, and
 *   stays correct once the columns are re-synced.
 */
/**
 * When a container was marked Off-Lease on the Deployed sheet — the moment it
 * entered the off-lease workflow, and therefore when Stage 1's clock starts.
 *
 * Read from the "Update" column on the row whose "Status" is Off-Lease. Both
 * are found BY HEADER, not position: this sheet has had columns inserted
 * before, and a positional read would silently return a neighbouring column.
 *
 * Stage 1's SLA previously started from the deployed date, which is when the
 * container went out on lease — often years earlier — so every container
 * looked like a 600-day breach.
 */
export async function getOffLeaseEntryStamp(containerNo) {
  const want = normKey(containerNo);
  if (!want) return '';
  try {
    const { headers, rows } = await getSheetDataFromMongo(SHEETS.DEPLOYED);
    const updCol = _findOlColumnMulti(headers, ['update']);
    const stsCol = _findOlColumnMulti(headers, ['status']);
    if (updCol < 0) return '';

    for (const r of rows) {
      if (normKey(r[0]) !== want) continue;
      if (stsCol >= 0 && !/off[\s-]?lease/i.test(safeStr(r[stsCol]))) continue;
      const stamp = safeStr(r[updCol]).trim();
      if (stamp) return stamp;
    }
  } catch (e) {
    console.error('[OL-ENTRY-STAMP]', e?.message || e);
  }
  return '';
}

/**
 * Off-Lease's own application of the Sale-Person ownership axis (see
 * salePersonAccess.service.js's header comment for the full picture) —
 * same CRM-resolved owner as Lease Expiry/Renew & Document use, applied to
 * Off-Lease Tracking's Client Name column (row[5] everywhere in this file)
 * instead of Deployed's own "Sale Person" column, which this sheet has no
 * equivalent of.
 *
 * Returns null for an unrestricted caller (admin, or a login with no mapped
 * Sale Person identity) — every read below skips filtering entirely in that
 * case: correct for everyone but the scoped sales logins, and it avoids an
 * unnecessary Sales CRM read on every other call.
 *
 * A company the CRM does not recognise is EXCLUDED for a scoped caller (fail
 * closed) rather than shown — unlike Deployed, this sheet has no sheet-level
 * "Sale Person" value to fall back on, so there is no other signal to trust,
 * and a record with no clear owner is exactly the kind of leak this exists
 * to prevent. See the 2026-08-20 "user-wise client access" request — a
 * Sales login must never see another client's off-lease data through any
 * Off-Lease endpoint, including by guessing a container number.
 */
async function _offLeaseAccessGate(user) {
  const scope = salePersonScopeFor(user);
  if (!scope) return null;
  const resolveSalePerson = await getSalePersonResolver();
  return (clientName) => {
    const owner = resolveSalePerson(clientName);
    return !!owner && matchesSalePersonScope(owner, scope);
  };
}

/**
 * Every Client Name Off-Lease Tracking carries for a given container —
 * usually one, occasionally more (the same box off-leased by two different
 * clients at different times, e.g. TRIU6681671 — see getOffLeaseContainerDetail).
 * Falls back to the Deployed sheet when the container has no Off-Lease
 * Tracking row at all (not yet added to the workflow). Used wherever a
 * single container needs an access-gate check without pulling in the full
 * cost of getOffLeaseContainerDetail (stages, FMS, SLA, outstanding, ...) —
 * see getOutstanding's proxy to the Accounts API and offleaseRemarks
 * .service.js's getRemarkThread.
 */
export async function getOffLeaseClientNamesForContainer(containerNo) {
  const want = normKey(containerNo);
  if (!want) return [];
  const names = new Set();
  try {
    const { rows } = await getSheetDataFromMongo(OL_SHEET);
    for (const row of rows) {
      if (normKey(row[0]) !== want) continue;
      const cn = safeStr(row[5]).trim();
      if (cn) names.add(cn);
    }
  } catch (e) { console.error('[OL-ACCESS] tracking scan:', e?.message || e); }
  if (names.size) return [...names];
  try {
    const { rows } = await getSheetDataFromMongo(SHEETS.DEPLOYED);
    for (const row of rows) {
      if (normKey(row[0]) !== want) continue;
      const cn = safeStr(row[1]).trim();
      if (cn) names.add(cn);
    }
  } catch (e) { console.error('[OL-ACCESS] deployed scan:', e?.message || e); }
  return [...names];
}

/** True when `user` is unrestricted, OR the container has at least one
 *  Client Name that resolves to their Sale Person scope. A container with NO
 *  known client name at all (blank sheet cell, nothing in Deployed either)
 *  fails closed for a scoped caller — same reasoning as _offLeaseAccessGate. */
export async function isOffLeaseContainerVisibleToUser(containerNo, user) {
  const gate = await _offLeaseAccessGate(user);
  if (!gate) return true;
  const names = await getOffLeaseClientNamesForContainer(containerNo);
  return names.some((n) => gate(n));
}

/** Internal stage number for "Inspection Checklist" (displays as Stage 4) —
 *  named for the same reason as OL_STAGE2_INTERNAL/OL_STAGE3_INTERNAL above:
 *  the display number is not the internal one, and `3` read inline invites
 *  the wrong assumption. */
const OL_INSPECTION_INTERNAL = 3;
/** Internal stage number for "Billing Reconciliation" (displays as Stage 5). */
const OL_BILLING_INTERNAL = 5;

export async function getOffLeaseData(stage, opts = {}, user) {
  // Display-only list read, no embedded write in this function — safe to
  // serve from the Mongo mirror (Phase 1b), and therefore no
  // _ensureOffLeaseSheet(): see the note in getOffLeaseDashboardData.
  //
  // opts.sheetData: an already-fetched {headers, rows}, so a caller reading
  // every stage's count in one go (getOffLeaseStageCounts) reads the sheet
  // ONCE instead of once per stage — 6 stages read independently, on every
  // 60s poll, from however many browser tabs have the page open, was
  // confirmed 2026-08-26 as the actual cause of repeated
  // "Google Sheets API rate limit" lockouts across the whole app, not just
  // Off-Lease. Every other caller is unaffected: they simply don't pass it,
  // and this reads live as before.
  const { headers, rows } = opts.sheetData || await getSheetDataFromMongo(OL_SHEET);
  const info = OL_STAGE_INFO[stage];
  if (!rows.length || !info) return { headers: [], data: [], stage };

  const gate = await _offLeaseAccessGate(user);
  /* gateFormIndex: the Stage 3 (Gate In) form was removed from the app
     2026-08-24 — a container is gated in the moment the external Google
     Form log ("Stage 3 " tab, read by stage3Form.service.js) shows "Inward
     (Gate-In)" for it, no manual save needed. Repair-not-required rows
     (that SAME form row also marked "Repair Required? = No") skip Stage 4
     (Inspection Checklist) entirely and go straight to Stage 5 (Billing).
     Same "read-time rule, no write" approach as the STAGE-10 delivery
     bypass just above (see its doc comment) and for the identical reason:
     the tracking sheet's own Gate In status column (135) has nothing left
     to write it, exactly like Stage 2's never-fillable column.

     Resolved per-ROW (container + that row's own client), not by container
     number alone — the same box gets reused across different clients over
     its lifetime (GESU9440432: gated in for one client, gated out to
     another, over a year before either one's off-lease cycle), so matching
     by container only risks pulling a different client's stale event. See
     pickGateFormForClient's doc comment in stage3Form.service.js. */
  const { deliveredKeys, gateFormIndex } = opts;
  const displayIndices = [0, 1, 2, 3, 5, 6, 7, 8, 9];
  const displayHeaders = ['Container No', 'Lease ID', 'Size', 'Type', 'Client Name', 'Location', 'Deployed Date', 'Valid Upto', 'Rate'];
  /* The gate is the previous ACTIVE stage, not stage-1: with Stage 4 retired,
     Billing (stage 5) waits on Stage 3, otherwise it would wait forever on a
     status column nothing can ever fill. */
  const prevNum = _prevActiveStage(stage);
  const prevInfo = prevNum ? OL_STAGE_INFO[prevNum] : null;
  /* The Intimation Approval gate sits immediately after Stage 1, so it applies
     to whichever stage FOLLOWS Stage 1 in the workflow — currently internal 6.
     This was keyed on `stage === 2`, the RETIRED Lifting/Arrival stage, so the
     gate never fired: all 6 containers awaiting approval were also listed as
     pending at Transportation, and the tab badges summed to 43 against 37
     active records. */
  const gatedByApproval = prevNum === 1;
  /* Resolved unconditionally (not just when gatedByApproval) — the STAGE-10
     delivery bypass below also needs it, since that bypass walks around the
     gate this column normally enforces. */
  const intApprovalCol = _findOlColumnMulti(headers, ['intimation approval status', 'intimation appt status', 'approval status']);
  /* Stage 1's own Reject tab reads these straight off the SAME columns
     saveOffLeaseApprovalAction(Fast) already writes on Rejected — no new
     sheet columns needed, unlike Hold (which has nothing existing to read). */
  const intApprovalRemarkCol = _findOlColumnMulti(headers, ['intimation approval remark', 'intimation appt remark', 'approval remark']);
  const intApprovalTimestampCol = _findOlColumnMulti(headers, ['intimation approval timestamp', 'intimation appt timestamp']);
  const intApprovalUserCol = _findOlColumnMulti(headers, ['intimation approval user', 'intimation appt user']);

  const finalData = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row[0] || String(row[0]).trim() === '') continue;

    if (gate && !gate(safeStr(row[5]))) continue;

    const containerKey = _containerKey(row[0]);
    const gfRow = gateFormIndex ? pickGateFormForClient(gateFormIndex.get(containerKey) || [], row[5]) : null;
    const gatedIn = isGatedIn(gfRow);
    const repairSkip = isRepairNotRequired(gfRow);
    // Active "Move To Stage" jump (any reason) — computed once, reused
    // below both to skip stages this jump bypassed and to land the row in
    // its chosen destination stage's queue. See _jumpSkipsStage's doc comment.
    const jumpTarget = _jumpTargetInternal(row);

    const statusVal = row[info.statusCol];
    /* A rejected row's OWN Stage 1 Status stays 'Completed' forever — that
       is a prerequisite for ever having reached Stage 1A/Approval in the
       first place (see getOffLeaseApprovalData's queue-membership check) —
       so without this it could never appear in ITS OWN Reject tab below.
       Bypasses the generic statusVal gate ONLY for a genuinely rejected row
       on Stage 1's Reject view; every other case still gates on it exactly
       as before. */
    const rejected = Number(stage) === 1 && intApprovalCol >= 0
      && String(row[intApprovalCol]).trim().toLowerCase() === 'rejected';
    /* Gate In (internal 7) has no form left to fill its own status column —
       the external form confirming it IS the completion signal, so a
       gated-in container must drop out of this queue exactly as if that
       column had been written. Inspection Checklist (internal 3) similarly
       drops a repair-not-required container from ITS queue: that container
       is not "pending inspection", it was routed around inspection
       entirely and belongs in Billing's queue instead. */
    if (Number(stage) === OL_STAGE3_INTERNAL && gatedIn) continue;
    if (Number(stage) === OL_INSPECTION_INTERNAL && repairSkip) continue;
    if (!(Number(stage) === 1 && opts.filter === 'reject' && rejected)) {
      if (statusVal && String(statusVal).trim() !== '') continue;
    }
    /* This row was moved directly past `stage` via an active jump — it isn't
       genuinely pending here, it jumped straight to its chosen destination
       stage instead. */
    if (_jumpSkipsStage(jumpTarget, stage)) continue;
    /* Stage 1's Hold / Reject sub-tabs — same row, three queues:
       opts.filter selects which ONE shows; the default (no filter) view
       shows everything else (a held or rejected record disappears from the
       normal pending list the moment it's put on hold or rejected).
       Irrelevant to every other stage, so this only ever branches for
       Stage 1. */
    if (Number(stage) === 1) {
      const held = _isOnHold(row);
      if (opts.filter === 'hold') { if (!held) continue; }
      else if (opts.filter === 'reject') { if (!rejected) continue; }
      else if (held || rejected) continue;
    }

    /* Has this container's site delivery been recorded in STAGE-10? Keyed on
       container alone — see getDeliveredKeys() for why client is not used.
       REVERTED 2026-08-28: briefly bounded to "on/after this row's own
       Stage 1 completion" to stop an older, unrelated cycle's delivery from
       wrongly bypassing Stage 2 (confirmed once, MYRU4513729). Reverted the
       same day — confirmed against SZLU9446439, SZLU9915829, GESU9563904,
       CXRU1037294 and CAIU5404270 that the OPPOSITE pattern (this app's own
       Stage 1 completed AFTER the external FMS system's own delivery
       timestamp — paperwork catching up to physical reality, not the other
       way round) is the common case here, not the exception. The date bound
       blocked real, correct progression on multiple live containers — a
       bigger cost than the one narrow case it prevented. Passing sinceMs as
       null restores the original "ever delivered" behaviour via
       isDeliveredSince's own fallback. */
    const delivered = deliveredKeys ? isDeliveredSince(deliveredKeys, containerKey, null) : false;
    /* Manual "Move To Stage" closeout (saveOffLeaseMoveToStage(Fast)) — the
       same completion signal as `delivered`, for containers that never go
       through the FMS-tracked transport chain at all (a direct client-to-
       client transfer, or some other disposition). Read straight off this
       same row, no extra fetch. */
    const movedOut = _isMovedOut(row);

    /* Stage 2 (internal 6) is DONE once STAGE-10 has its delivery, or once
       it's been manually moved — drop it from that queue so it is not shown
       as still awaiting transport. Only once it has actually reached Stage
       2, though: a row still sitting at Stage 1 must stay there. */
    if (Number(stage) === OL_STAGE2_INTERNAL && (delivered || movedOut)
        && safeStr(row[OL_STAGE_INFO[1].statusCol]).trim() !== '') continue;

    if (prevInfo) {
      /* ...and released into the next stage on the same signal, regardless of
         the (unfillable) Stage 2 status column.

         Stage 1 must still be COMPLETE. The delivery signal substitutes for
         the Stage 2 gate only — it is not a licence to skip the rest of the
         chain. Without this check a container whose delivery was recorded but
         whose intimation was never completed appeared in Stage 1 and Stage 3
         at the same time, which is how 7 + 20 + 10 came to 37 against 36
         records. */
      const stage1Done = safeStr(row[OL_STAGE_INFO[1].statusCol]).trim() !== '';
      const releasedByDelivery = Number(stage) === OL_STAGE3_INTERNAL && (delivered || movedOut) && stage1Done;
      /* Gate In being confirmed says nothing about whether Transportation
         itself was ever completed — the external form only tracks physical
         gate movements, not this app's own Stage 2. A container gated in
         without Transportation done (or delivered) is the SAME "physical
         progress outran paperwork" shape as the intimation-approval check
         below, one stage earlier: MSCU9692143 showed gated in with
         Transportation still blank and no STAGE-10 delivery, and without
         this check it jumped straight into the Inspection queue while
         Transportation's own tab still correctly listed it as pending —
         two queues both claiming the same container. */
      const transportDone = safeStr(row[OL_STAGE_INFO[OL_STAGE2_INTERNAL].statusCol]).trim() !== '' || ((delivered || movedOut) && stage1Done);
      /* Same "released past a column nothing can fill" shape as the
         delivery bypass, one link further down the chain: Inspection's gate
         is normally Gate In's status column (135); a gated-in container
         releases into Inspection instead on the external form's signal.
         Billing's gate is normally Inspection's status column (28); a
         repair-not-required container releases straight into Billing on
         the SAME form's signal, skipping Inspection's column entirely. */
      const releasedByGateForm = Number(stage) === OL_INSPECTION_INTERNAL && gatedIn && !repairSkip && transportDone;
      const releasedByRepairSkip = Number(stage) === OL_BILLING_INTERNAL && repairSkip && transportDone;
      /* This row's active jump names `stage` as its actual destination — it
         must appear in this queue right now regardless of whatever normally
         gates entry to it (an intermediate stage's own status), which is
         the whole point of a direct jump. See _prepareMoveToStage/
         saveOffLeaseMoveToStage's doc comments. */
      const jumpLanded = jumpTarget != null && Number(stage) === jumpTarget && stage1Done;
      const bypassed = releasedByDelivery || releasedByGateForm || releasedByRepairSkip || jumpLanded;
      const prevStatus = row[prevInfo.statusCol];
      if (!bypassed && (!prevStatus || String(prevStatus).trim() === '')) continue;

      /* The intimation approval gate sits right after Stage 1 — normally
         only checked here when this stage directly follows Stage 1
         (gatedByApproval). The bypasses above skip straight past a stage
         that directly follows Stage 1 in various ways, walking around that
         gate entirely: a container whose physical progress outran its own
         intimation approval in this app must still wait in Pending
         Approval, not jump the queue. Found 2026-08-20 via CXRU1042578 for
         the original delivery bypass — the same risk applies to gateInKeys/
         repairNotRequiredKeys, both external signals with no idea whether
         this app's own approval step ever happened. */
      if ((gatedByApproval || bypassed) && intApprovalCol >= 0) {
        const intApproval = row[intApprovalCol];
        if (!intApproval || String(intApproval).trim().toLowerCase() !== 'approved') continue;
      }
    }

    const displayRow = displayIndices.map((ci) => safeStr(row[ci]));
    const item = { row: displayRow, _rowNum: i + 2 };

    for (const bCol of displayIndices) item[`col_${bCol}`] = fmtCell(row[bCol]);
    for (let c = info.startCol; c <= info.endCol; c++) item[`col_${c}`] = fmtCell(row[c]);

    /* Hold's own Remarks/Comment — only meaningful (and only ever
       non-blank) on Stage 1's Hold view, but cheap to attach unconditionally
       for stage 1 so the field is there whichever sub-tab reads this list. */
    if (Number(stage) === 1) {
      item.holdRemarks = safeStr(row[OL_HOLD_REMARKS_COL]);
      item.holdBy = safeStr(row[OL_HOLD_BY_COL]);
      item.holdTimestamp = safeStr(row[OL_HOLD_TIMESTAMP_COL]);
      /* Reject's own Remarks — read off the SAME Intimation Approval
         columns saveOffLeaseApprovalAction(Fast) writes on Rejected. */
      item.rejectRemarks = intApprovalRemarkCol >= 0 ? safeStr(row[intApprovalRemarkCol]) : '';
      item.rejectBy = intApprovalUserCol >= 0 ? safeStr(row[intApprovalUserCol]) : '';
      item.rejectTimestamp = intApprovalTimestampCol >= 0 ? safeStr(row[intApprovalTimestampCol]) : '';
    }

    finalData.push(item);
  }
  return { headers: displayHeaders, data: finalData, stage, stageLabel: info.label, statusCol: info.statusCol };
}

/**
 * Every active stage's pending count in one call, keyed by INTERNAL stage
 * number (1, 3, 5, 6, 7, 8) plus `approval` — running the exact same queue
 * logic (getOffLeaseData) each tab uses, with the same STAGE-10 delivery /
 * Gate-In / repair-skip bypasses, rather than a separate counting pass that
 * can silently drift from what the queues actually show.
 *
 * The single source of truth for BOTH the Off-Lease tab badges
 * (offlease.controller.js's getStageCounts) and the My Task dashboard
 * (tasks.service.js's getMyTasks) — which used to duplicate this with its
 * own much older, bypass-unaware counter (_olStageCounts, approve.service.js)
 * that walked stages 1..8 in plain NUMERIC order (not the actual workflow
 * order 1->6->7->3->5->8) and had never heard of the Gate-In form, repair
 * skip, or delivery signal. The moment a container's progress depended on
 * any of those — which is now the normal case, not the exception — that
 * counter saw its status column forever blank and stopped it dead, so My
 * Task showed 0 pending at every stage past Intimation while the real
 * queues (and this function) correctly saw 3, 11, 6, 3... (found 2026-08-25
 * comparing the two dashboards side by side).
 */
export async function getOffLeaseStageCounts(user) {
  let deliveredKeys;
  try { deliveredKeys = await getDeliveredKeys(); } catch (e) { deliveredKeys = undefined; }
  const gfIndex = getGateFormIndexSync();
  // ONE read for all 6 stages + the approval count — see getOffLeaseData's
  // opts.sheetData doc comment for why this used to be 7 separate live
  // reads of the identical sheet on every call.
  const sheetData = await getSheetDataFromMongo(OL_SHEET);

  const counts = {};
  await Promise.all(OL_ACTIVE_STAGE_NUMS.map(async (s) => {
    try {
      const d = await getOffLeaseData(s, { deliveredKeys, gateFormIndex: gfIndex, sheetData }, user);
      counts[s] = d.data.length;
    } catch (e) {
      counts[s] = null;   // null = unknown, so the caller shows no badge at all
    }
  }));

  let approval = null;
  try { approval = (await getOffLeaseApprovalData(user, sheetData)).data.length; } catch (e) { /* leave null */ }

  return { counts, approval };
}

/**
 * Later of two Dates, ignoring whichever is null. Null if both are.
 */
function _laterStamp(a, b) {
  if (a && b) return a.getTime() >= b.getTime() ? a : b;
  return a || b || null;
}

/**
 * Stage 2 (Transportation, internal 6) and Gate In (internal 7)'s TAT — special-
 * cased out of the generic attachStageTat below because neither fits its
 * "previous stage's own status column" rule:
 *
 *  - Stage 2's own status column is essentially never written (it is
 *    released by the STAGE-10 delivery signal or a manual move, not a form
 *    submission — see OL_STAGE2_INTERNAL's bypass comments in getOffLeaseData),
 *    so there was never a real completion timestamp to freeze its TAT at —
 *    the generic function only ever measured live elapsed time against
 *    Date.now(), forever, even long after the container had actually moved
 *    on. Explicit 2026-09-02 request: Stage 2's clock starts when the record
 *    enters Stage 2 (Intimation Approval — the queue's own gate already
 *    requires this, see getOffLeaseData's gatedByApproval check, so every
 *    row reaching this list has already been approved) and STOPS the moment
 *    STAGE-8 (movement booked) and STAGE-9 (transported) both have a
 *    matching Offlease row for this container — frozen at that instant, not
 *    recomputed against "now" afterward.
 *  - Gate In inherited the exact same problem one hop further down the
 *    chain: its "previous stage" (Stage 2) has no real completion timestamp
 *    either, so its clock silently fell back to the container's original
 *    off-lease entry date — weeks earlier — making it read as permanently,
 *    massively overdue. Explicit request: Gate In's clock does not start at
 *    all until STAGE-10 (site delivery) has a matching row for this
 *    container; STAGE-10 carries no date of its own (see readStage10Rows'
 *    doc comment in stage8.service.js), so the same STAGE-8/9 timestamp that
 *    closed Stage 2 is reused as "when this delivery cycle happened" — the
 *    established convention getDeliveredKeys() already uses for the same
 *    reason.
 *
 * Matched via getMatchedFmsForContainer — the SAME exact container+client
 * match (matchRow) the Stage 2 grid's own FMS status dots use, not
 * getFmsForContainer/matchByContainer. BUG FOUND 2026-09-02 via CXRU1042578:
 * matchByContainer silently drops the client check entirely when called with
 * no cycle-start bound, so it can return a completely unrelated client's old
 * movement for a reused container number — which briefly showed this Stage 2
 * TAT badge as "Completed" while the row's own FMS dots correctly showed
 * nothing matched. See getMatchedFmsForContainer's own doc comment for the
 * full account.
 */
async function _attachTransportGateInTat(result, stageNum, budget) {
  const { headers, rows } = await getSheetDataFromMongo(OL_SHEET);
  const apStatusCol = _findOlColumnMulti(headers, ['intimation approval status', 'intimation appt status', 'approval status']);
  const apTsCol = _findOlColumnMulti(headers, ['intimation approval timestamp', 'intimation appt timestamp']);

  for (const item of result.data) {
    const row = rows[item._rowNum - 2] || [];
    const container = item.row?.[0];
    const client = item.row?.[4];

    let fms = null;
    try { fms = await getMatchedFmsForContainer(container, client); } catch (e) { fms = null; }

    // "Fetched" = STAGE-8 and STAGE-9 both have a matching Offlease row for
    // this container — the moment BOTH exist is the later of their own two
    // real timestamps (a stable, recorded value — never Date.now()/page-load
    // time, so this stays identical across refreshes and re-logins).
    const stage89At = (fms?.movement && fms?.transport)
      ? _laterStamp(parseStamp(fms.movement.timestamp), parseStamp(fms.transport.lastUpdated))
      : null;

    if (stageNum === OL_STAGE2_INTERNAL) {
      const apStatus = apStatusCol >= 0 ? safeStr(row[apStatusCol]).trim().toLowerCase() : '';
      const approvedAt = (apStatus === 'approved' && apTsCol >= 0) ? parseStamp(row[apTsCol]) : null;
      // Falls back to Stage 1's own completion only if the approval columns
      // are somehow missing — every row in this queue has already passed
      // the approval gate, so this should only ever be the fallback path.
      const stage1Raw = safeStr(row[OL_STAGE_INFO[1].statusCol - 2]).trim();
      const start = approvedAt || parseStamp(stage1Raw);
      if (!start) { item.tat = null; continue; }

      if (stage89At) {
        // Frozen at the completion instant — not recomputed against "now".
        /* BACKDATED CASE, found 2026-09-02 via CXRU1042578: the external FMS
           system's own STAGE-8/9 timestamps (Feb/Mar) can predate this app's
           own Stage 2 entry (Aug approval) by months — the same "paperwork
           catching up to physical reality" pattern already documented
           extensively in stage8.service.js (matchByContainer's doc comment).
           The container was genuinely already booked+transported in FMS
           before this app's own off-lease record for it even reached
           approval, so `rawElapsed` goes negative. Clamping to 0 for the
           displayed duration is correct (there is no real "waiting time" to
           show), but "Completed · 0m" alone reads as a bug rather than what
           it is — flagged explicitly so the UI can say so instead. */
        const rawElapsed = stage89At.getTime() - start.getTime();
        const elapsed = Math.max(0, rawElapsed);
        item.tat = {
          startedAt: start.toISOString(),
          completedAt: stage89At.toISOString(),
          budget: budgetLabel(budget),
          elapsed: humanize(elapsed),
          elapsedMs: elapsed,
          delayed: elapsed > budget,
          overdueBy: elapsed > budget ? humanize(elapsed - budget) : '',
          completed: true,
          backdated: rawElapsed < 0
        };
      } else {
        const elapsed = Date.now() - start.getTime();
        item.tat = {
          startedAt: start.toISOString(),
          budget: budgetLabel(budget),
          elapsed: humanize(elapsed),
          elapsedMs: elapsed,
          delayed: elapsed > budget,
          overdueBy: elapsed > budget ? humanize(elapsed - budget) : '',
          completed: false
        };
      }
    } else {
      // Gate In — do not calculate anything until STAGE-10 (site delivery)
      // has a matching row; a container mid-transport, or not yet booked at
      // all, has simply not reached this point yet.
      if (!fms?.delivery || !stage89At) { item.tat = null; continue; }
      const elapsed = Date.now() - stage89At.getTime();
      item.tat = {
        startedAt: stage89At.toISOString(),
        budget: budgetLabel(budget),
        elapsed: humanize(elapsed),
        elapsedMs: elapsed,
        delayed: elapsed > budget,
        overdueBy: elapsed > budget ? humanize(elapsed - budget) : '',
        completed: false
      };
    }
  }
  result.tatBudget = budgetLabel(budget);
  return result;
}

/**
 * Attaches a `tat` to every row of a stage list, in place.
 *
 * The clock starts when the stage became actionable, not when the container
 * entered off-lease: for Stage 1 that is the Deployed sheet's Off-Lease stamp,
 * and for every later stage it is the previous stage's completion. Measured
 * against now, because these rows are by definition still pending.
 *
 * Stage 2 (Transportation) and Gate In are handled separately, by
 * _attachTransportGateInTat above — see its doc comment for why the rule
 * below does not fit either of them.
 *
 * The Deployed sheet is read ONCE and indexed, rather than per row — a list of
 * 20 containers would otherwise mean 20 reads of the same data.
 */
export async function attachStageTat(result, stage) {
  const stageNum = Number(stage);
  const budget = SLA_MS[stageNum];
  if (!budget || !result?.data?.length) return result;

  if (stageNum === OL_STAGE2_INTERNAL || stageNum === OL_STAGE3_INTERNAL) {
    return _attachTransportGateInTat(result, stageNum, budget);
  }

  const prevNum = _prevActiveStage(stageNum);
  const prevInfo = prevNum ? OL_STAGE_INFO[prevNum] : null;

  /* The off-lease entry stamp, ALWAYS built — not only for Stage 1.
     It is the fallback whenever the previous stage carries no timestamp, which
     is the normal case for Stage 3: those containers were released by the FMS
     delivery rule, so Stage 2's status column was never written and there is
     no completion time to start the clock from. Without this the TAT column
     rendered a dash on every row. */
  const entryByContainer = new Map();
  {
    const { headers: dh, rows: dr } = await getSheetDataFromMongo(SHEETS.DEPLOYED);
    const updCol = _findOlColumnMulti(dh, ['update']);
    const stsCol = _findOlColumnMulti(dh, ['status']);
    if (updCol >= 0) {
      for (const r of dr) {
        if (stsCol >= 0 && !/off[\s-]?lease/i.test(safeStr(r[stsCol]))) continue;
        const k = normKey(r[0]);
        if (k && !entryByContainer.has(k)) entryByContainer.set(k, safeStr(r[updCol]).trim());
      }
    }
  }

  const { rows } = await getSheetDataFromMongo(OL_SHEET);

  for (const item of result.data) {
    const row = rows[item._rowNum - 2] || [];
    const entry = entryByContainer.get(normKey(item.row?.[0])) || '';
    /* Previous stage's completion, falling back to the off-lease entry stamp
       when that stage was never stamped. */
    const startRaw = (prevInfo ? safeStr(row[prevInfo.statusCol - 2]).trim() : '') || entry;

    const start = parseStamp(startRaw);
    if (!start) { item.tat = null; continue; }

    const elapsed = Date.now() - start.getTime();
    item.tat = {
      startedAt: startRaw,
      budget: budgetLabel(budget),
      elapsed: humanize(elapsed),
      elapsedMs: elapsed,
      delayed: elapsed > budget,
      overdueBy: elapsed > budget ? humanize(elapsed - budget) : ''
    };
  }
  result.tatBudget = budgetLabel(budget);
  return result;
}

export async function getOffLeaseStageDetail(containerNo, stage, user, knownRow) {
  try {
    /* Served from the Mongo mirror, like the stage lists. It previously read
       live Sheets on every form open, which made the form slow and — once
       the per-minute read quota was exhausted — silently returned an empty
       record, so every field rendered as a dash. saveOffLeaseStage still
       reads live Sheets, because its row numbers DO target writes.

       BUG FOUND AND FIXED 2026-08-27: this comment already claimed the
       Mongo-mirror switch above, but the line below still called the LIVE
       getSheetData — never actually updated when the rest of the file's
       Mongo-first pass happened 2026-08-26. Genuinely switched now.

       BUG FOUND AND FIXED 2026-08-31: this being read-only does NOT make
       first-match-by-container safe — Container No is not unique (see
       _resolveOlRow's doc comment; TRIU6681671 confirmed live with two
       different lease rows), so opening a specific list row's "Open" could
       silently pre-fill a DIFFERENT lease's data for the same container.
       knownRow (item._rowNum from whichever list the caller opened this
       from) is now required to land on the exact row that was clicked. */
    const { rows } = await getSheetDataFromMongo(OL_SHEET);
    const rn = _resolveOlRow(rows, containerNo, knownRow);
    if (rn === -1) throw new AppError(`Not found: ${safeStr(containerNo)}`);
    const info = OL_STAGE_INFO[stage];
    if (!info) throw new AppError(`No such stage: ${safeStr(stage)}`);

    const row = rows[rn - 2] || [];

    // Same "not found" message a missing row gets — a scoped caller must not
    // be able to tell "doesn't exist" from "exists but isn't yours" apart.
    const gate = await _offLeaseAccessGate(user);
    if (gate && !gate(safeStr(row[5]))) throw new AppError(`Not found: ${safeStr(containerNo)}`);

    const result = {};

    const baseCols = { 0: 'Container No', 1: 'Lease ID', 2: 'Size', 3: 'Type', 4: 'Client Code', 5: 'Client Name', 6: 'Location', 7: 'Deployed Date', 8: 'Valid Upto', 9: 'Rate' };
    for (const b of Object.keys(baseCols)) result[`col_${b}`] = fmtCell(row[Number(b)]);

    for (let c = info.startCol; c <= info.endCol; c++) result[`col_${c}`] = fmtCell(row[c]);

    if (Number(stage) === 3) for (const eci of OL_STAGE3_EXTRA_COLS) result[`col_${eci}`] = safeStr(row[eci]);
    if (Number(stage) === 4) for (const eci of OL_STAGE4_EXTRA_COLS) result[`col_${eci}`] = safeStr(row[eci]);

    /* Billing Reconciliation's Cost Reference card: the checklist's own
       itemised Estimate Value total, computed here because only this
       function has the raw row (Billing's own column range, 29..44, never
       reaches the checklist's columns at 136-239). null when no fault point
       has a numeric estimate — the controller falls back to the Gate-In
       form's free-text figure only in that case (see _olInspectionEstimateTotal). */
    if (Number(stage) === 5) {
      // Formatted per its OWN type, not a blanket fmtCell — fmtCell's
      // parseDate() happily "parses" a bare number or a numeric-looking
      // string ("4321" -> "01-01-4321"), which is exactly the bug fmtNumCell
      // exists to avoid for money/quantity cells (see that function's doc
      // comment). Only the 3 genuine date fields get fmtCell; the rest are
      // read as plain text/number to match stageFields.js's own field types.
      const [rentalsBilled, outstanding, dateBilledTill, repairCharges, transportBilled,
        adjustDeposit, depositAmount, lastBillingDate, accruedRental, accruedRentalDate,
        reconcileCycle, remark] = OL_STAGE5_EXTRA_COLS;
      result[`col_${rentalsBilled}`] = safeStr(row[rentalsBilled]);
      result[`col_${outstanding}`] = fmtNumCell(row[outstanding]);
      result[`col_${dateBilledTill}`] = fmtCell(row[dateBilledTill]);
      result[`col_${repairCharges}`] = safeStr(row[repairCharges]);
      result[`col_${transportBilled}`] = safeStr(row[transportBilled]);
      result[`col_${adjustDeposit}`] = safeStr(row[adjustDeposit]);
      result[`col_${depositAmount}`] = fmtNumCell(row[depositAmount]);
      result[`col_${lastBillingDate}`] = fmtCell(row[lastBillingDate]);
      result[`col_${accruedRental}`] = fmtNumCell(row[accruedRental]);
      result[`col_${accruedRentalDate}`] = fmtCell(row[accruedRentalDate]);
      result[`col_${reconcileCycle}`] = safeStr(row[reconcileCycle]);
      result[`col_${remark}`] = safeStr(row[remark]);

      result._inspectionEstimateTotal = _olInspectionEstimateTotal(row);

      /* Stage 1's own intimation record (col_10-13), for reference while
         reconciling — Final Billing Date in particular is the figure Billing
         is meant to reconcile AGAINST, set back at intimation time and never
         re-surfaced on this form since. Stage 5's own column range (29..44)
         never reaches these, same reason the checklist data above needed its
         own explicit read. */
      result._stage1Data = {
        intimationDate: fmtCell(row[10]),
        offLeaseDate: fmtCell(row[11]),
        // safeStr, not fmtCell — this is a Drive URL (Email Notification
        // attachment), and fmtCell's parseDate() misreads digit-bearing
        // strings as dates (the exact bug OL_STAGE5_EXTRA_COLS's read hit).
        emailNotification: safeStr(row[12]),
        finalBillingDate: fmtCell(row[13])
      };
    }

    /* Inspection Checklist (internal 3) has no manual form to fill for a
       container the Stage 3 (Gate In) form already marked "Repair Required?
       = No" — it was routed straight to Billing, not inspected. Flagged here
       so the modal shows that fact (and the form's own repair verdict)
       instead of a blank 44-field checklist a fill would be meaningless on.
       Resolved against THIS row's own client (row[5]) — see
       pickGateFormForClient's doc comment for why container number alone
       is not enough. */
    if (Number(stage) === OL_INSPECTION_INTERNAL) {
      const gf = getGateFormForContainer(containerNo, row[5]);
      if (isRepairNotRequired(gf)) {
        result._skipped = true;
        result._skipReason = [
          gf.repairRequired ? `Repair Required: ${gf.repairRequired}` : '',
          gf.remarks ? `Remarks: ${gf.remarks}` : ''
        ].filter(Boolean).join(' · ');
      }
    }

    /* Move To Stage / Send Back state — exposed for every stage (cheap, just
       a few more already-fetched columns) so the frontend can show what was
       recorded on Stage 2's own form when reopened, and — for whichever
       stage this row was actively jumped TO — offer Send Back there. */
    const jumpTargetInternal = _jumpTargetInternal(row);
    result._move = {
      active: _isMovedOut(row),
      reason: safeStr(row[OL_MOVE_REASON_COL]),
      newClientName: safeStr(row[OL_MOVE_NEW_CLIENT_COL]),
      clientScope: safeStr(row[OL_MOVE_CLIENT_SCOPE_COL]),
      arrivalDate: safeStr(row[OL_MOVE_ARRIVAL_DATE_COL]),
      remarks: safeStr(row[OL_MOVE_REMARKS_COL]),
      commentType: safeStr(row[OL_MOVE_COMMENT_TYPE_COL]),
      date: safeStr(row[OL_MOVE_DATE_COL]),
      jumpTargetInternal,
      jumpTargetDisplay: jumpTargetInternal != null ? displayStageNum(jumpTargetInternal) : null,
      canSendBackHere: jumpTargetInternal != null && jumpTargetInternal === Number(stage)
    };

    /* Hold state — only ever meaningful on Stage 1 itself, but cheap
       (already-fetched columns) and harmless to include everywhere, same
       reasoning as _move above. */
    result._hold = {
      active: _isOnHold(row),
      timestamp: safeStr(row[OL_HOLD_TIMESTAMP_COL]),
      by: safeStr(row[OL_HOLD_BY_COL]),
      remarks: safeStr(row[OL_HOLD_REMARKS_COL])
    };

    return result;
  } catch (e) {
    /* Rethrow rather than returning {}. Swallowing this turned a transient
       quota error into a form full of dashes with no indication anything had
       failed — the caller now sees a real error and can retry. */
    console.error('[OL-DETAIL] ERROR:', e?.message || e);
    throw e instanceof AppError ? e : new AppError(`Could not load ${safeStr(containerNo)}: ${e?.message || e}`);
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
    // Matches "LEASE0055" AND "OF0062" — the counter has to see every
    // existing ID regardless of which prefix it was minted under, or it
    // would silently restart from OL_LEASE_ID_START the moment the prefix
    // switched and hand out an OF-number that collides with an old LEASE row.
    const m = v.match(/^\s*(?:lease|of)\s*[-_ ]?\s*0*(\d+)\s*$/i);
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
/**
 * Stage-level Remark/Remarks fields upgraded to the same rich-text editor the
 * off-lease dashboard's own comment thread already uses (offleaseRemarks.
 * service.js's RichTextEditor + sanitizeRemarkHtml) — col_14 (Stage 1),
 * col_118 (Stage 6/Transportation), col_316 (Stage 5/Billing Reconciliation),
 * col_125 (Stage 8/FMS Closure). Sanitized on the way in exactly like that
 * thread, since these are rendered back out as HTML too and a stored
 * <script>/onerror would otherwise execute in every viewer who opens this
 * stage. Gate In (internal 7) has no form fields at all today and Inspection
 * Checklist (internal 3) only has PER-ITEM remarks, not a stage-level one —
 * neither is in this set.
 */
const OL_RICHTEXT_COLS = new Set([14, 118, 316, 125]);
function _sanitizeRichTextPayload(payload) {
  for (const col of OL_RICHTEXT_COLS) {
    const key = `col_${col}`;
    if (Object.prototype.hasOwnProperty.call(payload, key) && payload[key] != null) {
      payload[key] = sanitizeRemarkHtml(payload[key]);
    }
  }
}

export async function saveOffLeaseStage(containerNo, stage, data, userEmail, knownRow) {
  const stageNum = parseInt(stage, 10);
  await checkActionPermission(`offlease${stageNum}`, userEmail); // per-stage access: offlease1..offlease8

  return withSheetLock(OL_SHEET, async () => {
    if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');
    await _ensureOffLeaseSheet();
    const { rows } = await getSheetData(OL_SHEET);
    const rn = _resolveOlRow(rows, containerNo, knownRow);
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
    _sanitizeRichTextPayload(payload);
    if (stageNum === 1) {
      if (Object.prototype.hasOwnProperty.call(payload, 'col_1')) delete payload.col_1;
      const curLid = safeStr(row[1]).trim(); // B
      if (curLid && /^\s*(?:lease|of)\s*[-_ ]?\s*0*\d+\s*$/i.test(curLid)) {
        assignedLeaseId = curLid;
      } else {
        assignedLeaseId = _formatLeaseId(await _peekNextLeaseIdNum());
        await updateCell(OL_SHEET, rn, 1, assignedLeaseId); // col B
      }
      console.log(`[LEASE-ID] row ${rn} -> ${assignedLeaseId}${curLid ? ` (was: ${curLid})` : ''}`);
    }

    /* Technician cost is derived, never taken from the client — hours x the
       fixed rate. Recomputed on every Stage 3 save so the two columns cannot
       drift apart, and cleared when hours are blank. */
    if (stageNum === 3) {
      const hoursRaw = payload[`col_${OL_TECHNICIAN_HOURS_COL}`];
      const hours = Number(String(hoursRaw ?? '').trim());
      payload[`col_${OL_TECHNICIAN_COST_COL}`] = (hoursRaw != null && String(hoursRaw).trim() !== '' && !Number.isNaN(hours))
        ? hours * OL_TECHNICIAN_RATE_PER_HOUR
        : '';
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
    const stamp = dmyTime(new Date());
    cellUpdates.push({ range: `'${OL_SHEET}'!${colLetter(info.statusCol)}${rn}`, values: [['Completed']] });
    cellUpdates.push({ range: `'${OL_SHEET}'!${colLetter(info.statusCol - 2)}${rn}`, values: [[stamp]] });
    cellUpdates.push({ range: `'${OL_SHEET}'!${colLetter(info.statusCol - 1)}${rn}`, values: [[userEmail || '']] });
    await batchUpdateValues(cellUpdates);

    /* Mirror the same cells into Mongo immediately.
     *
     * The stage lists (getOffLeaseData) read the Mongo mirror, but the write
     * above goes only to Sheets — so without this, a container that finished
     * Stage 3 stayed invisible on the next stage until the reconcile job ran,
     * up to 5 minutes later. Applying the same values here makes it appear at
     * once; reconcile then re-reads the sheet and agrees.
     *
     * Best-effort: reconcile is still the source of truth, so a failure here
     * must never fail a save that already succeeded on the sheet. */
    try {
      const mirrored = {};
      for (const key of Object.keys(payload)) {
        if (key.indexOf('col_') !== 0) continue;
        const ci = parseInt(key.replace('col_', ''), 10);
        const v = payload[key];
        if (v === '' || v === undefined || v === null) continue;
        mirrored[`row.${ci}`] = v;
      }
      mirrored[`row.${info.statusCol}`] = 'Completed';
      mirrored[`row.${info.statusCol - 2}`] = stamp;
      mirrored[`row.${info.statusCol - 1}`] = userEmail || '';
      if (assignedLeaseId) mirrored['row.1'] = assignedLeaseId;

      /* Keyed by POSITION, not container number. This sheet's mirror is
         configured naturalKeyColumn:null / fullRefresh:true precisely because
         container numbers are not unique here (TRIU6681671 has two records) —
         so `row_<n>` is the only safe way to address one row. `rn` is the
         1-based sheet row including the header, and data row 2 is row_0. */
      const r = await getCollection(OL_SHEET).updateOne(
        { key: `row_${rn - 2}` },
        { $set: mirrored }
      );
      if (!r.matchedCount) console.warn(`[OL-STAGE] mirror row_${rn - 2} not found for ${containerNo} — next reconcile will pick it up`);
    } catch (e) {
      console.error('[OL-STAGE] mirror update failed (reconcile will correct):', e?.message || e);
    }

    /* Stage 4 "Quotation Create? = Yes" -> email the client. Best-effort: a
       failed send must never fail the stage save itself. */
    if (stageNum === 4 && String(payload.col_164 || '').trim().toLowerCase() === 'yes') {
      try { await _sendOffLeaseQuotationEmail(rn, payload, row); }
      catch (e) { console.error('[OL-STAGE4-EMAIL-SEND]', e?.message || e); }
    }

    /* Off-Lease notification to support@crystalgroup.in — fires once, right
     * here, the moment Stage 1 (Off-Lease Intimation) is actually filled and
     * saved. Moved here 2026-09-01 (was originally on the "Off-Lease" button
     * click itself, addToOffLeaseTracking) specifically so Lease ID is real:
     * the early ALREADY_PROCESSED return above means this code is only ever
     * reached on Stage 1's genuine FIRST completion for a row, never a
     * resubmit — same duplicate-prevention shape as before, just gated on
     * the stage's own status column instead of the tracking row's existence. */
    if (stageNum === 1) {
      try {
        const notifyRow = [...row];
        notifyRow[1] = assignedLeaseId;
        // Every col_10..col_14 field (OL Intimation Date, OL Date, Email
        // Notification, Final Billing Date, Remark) is uploaded/typed as
        // PART of this same Stage 1 submission — `row` was read BEFORE this
        // save happened, so all five are still blank/stale there. Overlay
        // whatever this submission actually sent; only fall back to the
        // pre-save row for a field this particular submission left out.
        for (let c = info.startCol; c <= info.statusCol - 3; c++) {
          const key = `col_${c}`;
          if (Object.prototype.hasOwnProperty.call(payload, key)) notifyRow[c] = safeStr(payload[key]);
        }
        // The auto-written Timestamp/User/Status trio (statusCol-2/-1/0) —
        // never in payload (saveOffLeaseStage writes these itself, see the
        // cellUpdates block above), so read the same values it just used.
        notifyRow[info.statusCol - 2] = stamp;
        notifyRow[info.statusCol - 1] = userEmail || '';
        notifyRow[info.statusCol] = 'Completed';
        await _sendOffLeaseNotification(notifyRow);
      } catch (e) {
        console.error('[OL-STAGE1-EMAIL]', e?.message || e);
      }
    }

    if (assignedLeaseId) return `OK:${assignedLeaseId}`;
    return 'OK';
  });
}

/**
 * Mongo-first fast path for saveOffLeaseStage — the entry point the
 * controller calls now. Decides against Mongo (already the read source)
 * and patches the Mongo doc directly so every reader sees the change
 * instantly, then enqueues a replay of the ORIGINAL saveOffLeaseStage above
 * to make the same change on the real Google Sheet in the background
 * (env.outboxPollMs later — a few seconds, not instantly). See
 * outbox.service.js's header comment for the full design and the trade-off
 * this was an explicit, informed choice to accept.
 *
 * Stage 1 is the one exception and stays fully live/synchronous: it assigns
 * the Lease ID from a live Sheets counter (_peekNextLeaseIdNum) to guarantee
 * no duplicate is ever handed out, and the frontend needs that real ID back
 * in the response (`OK:LEASE00xx`), not a placeholder. Stage 1 is also a
 * one-time action per container, not something clicked rapidly in sequence
 * the way Stages 2 onward are — so it's the one case where the ~1-2s live
 * round trip is the right trade, not a cost worth avoiding.
 */
export async function saveOffLeaseStageFast(containerNo, stage, data, userEmail, knownRow) {
  const stageNum = parseInt(stage, 10);
  await checkActionPermission(`offlease${stageNum}`, userEmail);

  if (stageNum === 1) return saveOffLeaseStage(containerNo, stage, data, userEmail, knownRow);

  if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');
  const info = OL_STAGE_INFO[stage];
  if (!info) throw new AppError('Invalid stage');

  const docs = await getMongoRowsWithKeys(OL_SHEET);
  const found = _resolveOlMongoDoc(docs, containerNo, knownRow);
  if (!found) throw new AppError(`Not found: ${containerNo}`);

  const curStatus = found.row[info.statusCol];
  if (curStatus && String(curStatus).trim() !== '') return 'ALREADY_PROCESSED';

  // Same technician-cost derivation as the live path — pure arithmetic on
  // the caller's own payload, not a Sheets call, so duplicating it here
  // carries none of the drift risk the rest of this design avoids.
  const payload = { ...(data || {}) };
  if (stageNum === 3) {
    const hoursRaw = payload[`col_${OL_TECHNICIAN_HOURS_COL}`];
    const hours = Number(String(hoursRaw ?? '').trim());
    payload[`col_${OL_TECHNICIAN_COST_COL}`] = (hoursRaw != null && String(hoursRaw).trim() !== '' && !Number.isNaN(hours))
      ? hours * OL_TECHNICIAN_RATE_PER_HOUR
      : '';
  }

  const patch = {};
  for (const key of Object.keys(payload)) {
    if (key.indexOf('col_') !== 0) continue;
    const colIdx = parseInt(key.replace('col_', ''), 10);
    const val = payload[key];
    if (val === '' || val === undefined || val === null) continue;
    const colName = OL_HEADERS[colIdx] || '';
    if (colName.toLowerCase().indexOf('date') !== -1 && typeof val === 'string' && val.length > 0) {
      const dt = parseFormDate(val);
      patch[`row.${colIdx}`] = dt ? safeStr(dt) : val;
    } else {
      patch[`row.${colIdx}`] = val;
    }
  }
  const stamp = dmyTime(new Date());
  patch[`row.${info.statusCol}`] = 'Completed';
  patch[`row.${info.statusCol - 2}`] = stamp;
  patch[`row.${info.statusCol - 1}`] = userEmail || '';

  await getCollection(OL_SHEET).updateOne({ key: found.key }, { $set: { ...patch, updatedAt: new Date() } });
  // knownRow, not the raw caller-supplied one: the replay's own live-Sheets
  // resolution must target the SAME row this Mongo patch just did, not
  // re-derive it by first-match — otherwise the instant Mongo write and the
  // few-seconds-later Sheets write could land on two different rows.
  const resolvedRow = knownRow ?? (parseInt(found.key.replace('row_', ''), 10) + 2);
  await enqueueSheetReplay('offlease.saveOffLeaseStage', [containerNo, stage, data, userEmail, resolvedRow], { actor: userEmail });

  return 'OK';
}

/* =============================================
   MOVE TO STAGE (Stage 2 — Transportation) + SEND BACK
============================================= */

/** Appended columns (olHeaders.generated.js) — see that file's header comment
 *  for why these are hand-added rather than a live-sheet capture. Fixed
 *  literals, not derived, per this file's established convention (see
 *  OL_SOURCE_DO_COL just above). Deliberately NOT OL_STAGE_INFO[6].statusCol
 *  (99) — that column is "Other Charges [Loading/Crane/Labor]", a real
 *  financial field this action must never overwrite.
 *
 *  These 8 columns hold only the CURRENT live move state — cleared entirely
 *  by Send Back, which is what naturally reverts queue membership back to
 *  Stage 2 (see _isMovedOut/_jumpTargetInternal below). The permanent,
 *  never-cleared audit trail is a separate append-only sheet — see
 *  offleaseMoveHistory.service.js — so Send Back losing the live columns
 *  never loses the history. */
const OL_MOVE_REASON_COL = 290;
const OL_MOVE_NEW_CLIENT_COL = 291;
const OL_MOVE_REMARKS_COL = 292;
const OL_MOVE_BY_COL = 293;
const OL_MOVE_TIMESTAMP_COL = 294;
const OL_MOVE_COMMENT_TYPE_COL = 295;
const OL_MOVE_DATE_COL = 296;
const OL_MOVE_JUMP_TARGET_COL = 297;
const OL_MOVE_CLIENT_SCOPE_COL = 298;
const OL_MOVE_ARRIVAL_DATE_COL = 299;
const OL_MOVE_ALL_COLS = [
  OL_MOVE_REASON_COL, OL_MOVE_NEW_CLIENT_COL, OL_MOVE_REMARKS_COL, OL_MOVE_BY_COL,
  OL_MOVE_TIMESTAMP_COL, OL_MOVE_COMMENT_TYPE_COL, OL_MOVE_DATE_COL, OL_MOVE_JUMP_TARGET_COL,
  OL_MOVE_CLIENT_SCOPE_COL, OL_MOVE_ARRIVAL_DATE_COL
];

export const OL_MOVE_REASONS = ['Client to Client', 'Client Scope', 'Other'];

/** DISPLAY stage number (what the UI and this Move To Stage dropdown show,
 *  e.g. 3/4/5) -> INTERNAL stage number (what selects the sheet column
 *  range everywhere else in this file) — the reverse of displayStageNum. */
const OL_INTERNAL_BY_DISPLAY = new Map(OL_ACTIVE_STAGE_NUMS.map((s, i) => [i + 1, s]));

/** The only stages a "Move To Stage" jump may target — Gate In, Inspection,
 *  Billing (internal 7/3/5 — display Stage 3/4/5). Intimation (1) and FMS
 *  Closure (8) are not valid jump destinations. */
const OL_JUMP_TARGET_INTERNALS = [OL_STAGE3_INTERNAL, OL_INSPECTION_INTERNAL, OL_BILLING_INTERNAL];

/** True once a row has been moved out of Stage 2 via either Reason — the
 *  Transportation-done completion signal `getOffLeaseData`/
 *  `getOffLeaseDashboardData`/`_classifyOffLeaseStages` all check, exactly
 *  parallel to `delivered` (the STAGE-10 signal) but read directly off the
 *  row with no extra fetch. */
function _isMovedOut(row) {
  return safeStr(row[OL_MOVE_REASON_COL]).trim() !== '';
}

/** The internal stage number this row was jumped directly to via Reason =
 *  "Other", or null if not currently, actively jumped (never moved that
 *  way, moved via "Client to Client" instead, or already Sent Back). */
function _jumpTargetInternal(row) {
  const v = parseInt(safeStr(row[OL_MOVE_JUMP_TARGET_COL]).trim(), 10);
  return OL_JUMP_TARGET_INTERNALS.includes(v) ? v : null;
}

/** True when stage `s` sits strictly BETWEEN Transportation and an active
 *  jump's target, in workflow order — i.e. a stage this jump skipped over
 *  entirely, so `s`'s own pending queue must never show this row (it isn't
 *  genuinely pending there; it jumped past it). Ordered by POSITION in
 *  OL_ACTIVE_STAGE_NUMS, same reasoning as _prevActiveStage — the workflow
 *  is 1 -> 6 -> 7 -> 3 -> 5 -> 8, not numeric order. */
function _jumpSkipsStage(jumpTargetInternal, s) {
  if (jumpTargetInternal == null) return false;
  const iTransport = OL_ACTIVE_STAGE_NUMS.indexOf(OL_STAGE2_INTERNAL);
  const iTarget = OL_ACTIVE_STAGE_NUMS.indexOf(jumpTargetInternal);
  const iS = OL_ACTIVE_STAGE_NUMS.indexOf(Number(s));
  return iS > iTransport && iS < iTarget;
}

/**
 * Validates + shapes a Move To Stage payload into exactly what gets written,
 * or throws AppError. Pure (no I/O) so the live and fast save paths below
 * can share it rather than hand-duplicating this feature's branching logic
 * twice — unlike the trivial technician-cost arithmetic this file duplicates
 * elsewhere on purpose (see saveOffLeaseStageFast's own comment on why THAT
 * duplication is fine), getting one of these two branches subtly out of
 * sync would silently write inconsistent columns.
 */
function _prepareMoveToStage({ reason, newClientName, clientScope, arrivalDate, commentType, remarks, date, moveToStage }) {
  const r = safeStr(reason).trim();
  if (!OL_MOVE_REASONS.includes(r)) throw new AppError(`Reason must be one of: ${OL_MOVE_REASONS.join(', ')}`);
  const rmk = safeStr(remarks).trim();

  // All three reasons record where the container actually went: a real Date
  // and a Move To Stage destination (Gate In / Inspection / Billing) — the
  // record appears there directly, see _jumpSkipsStage's doc comment,
  // without being forced through whatever normally sits between
  // Transportation and that stage. Container No, DO No and Movement Type on
  // the original record are untouched either way.
  const d = safeStr(date).trim();
  if (!d) throw new AppError('Date is required');
  const display = parseInt(moveToStage, 10);
  const jumpTargetInternal = OL_INTERNAL_BY_DISPLAY.get(display);
  if (!OL_JUMP_TARGET_INTERNALS.includes(jumpTargetInternal)) {
    throw new AppError('Move To Stage must be one of: Stage 3, Stage 4, Stage 5');
  }

  if (r === 'Client to Client') {
    const clientName = safeStr(newClientName).trim();
    if (!clientName) throw new AppError('New Client Name is required');
    const arrival = safeStr(arrivalDate).trim();
    return {
      reason: r, newClientName: clientName, clientScope: '', arrivalDate: arrival,
      remarks: rmk, commentType: '', date: d, jumpTargetInternal
    };
  }

  if (r === 'Client Scope') {
    const scope = safeStr(clientScope).trim();
    if (!scope) throw new AppError('Scope is required');
    const arrival = safeStr(arrivalDate).trim();
    return {
      reason: r, newClientName: '', clientScope: scope, arrivalDate: arrival,
      remarks: rmk, commentType: '', date: d, jumpTargetInternal
    };
  }

  // 'Other'
  const ct = safeStr(commentType).trim();
  if (!ct) throw new AppError('Comment / Type is required');
  return {
    reason: r, newClientName: '', clientScope: '', arrivalDate: '',
    remarks: rmk, commentType: ct, date: d, jumpTargetInternal
  };
}

function _moveColumnValues(shaped, userEmail, stamp) {
  return {
    [OL_MOVE_REASON_COL]: shaped.reason,
    [OL_MOVE_NEW_CLIENT_COL]: shaped.newClientName,
    [OL_MOVE_CLIENT_SCOPE_COL]: shaped.clientScope,
    [OL_MOVE_ARRIVAL_DATE_COL]: shaped.arrivalDate,
    [OL_MOVE_REMARKS_COL]: shaped.remarks,
    [OL_MOVE_BY_COL]: userEmail || '',
    [OL_MOVE_TIMESTAMP_COL]: stamp,
    [OL_MOVE_COMMENT_TYPE_COL]: shaped.commentType,
    [OL_MOVE_DATE_COL]: shaped.date,
    [OL_MOVE_JUMP_TARGET_COL]: shaped.jumpTargetInternal != null ? String(shaped.jumpTargetInternal) : ''
  };
}

/**
 * Manual alternate-disposition move for Transportation (internal stage 6): a
 * container that never goes through Crystal's own FMS-tracked transport
 * chain (STAGE-8/9/10) — a direct client-to-client transfer, or some other
 * movement type — has no STAGE-10 delivery to bypass it out of the Stage 2
 * queue the normal way.
 *
 * All three reasons record moveToStage (a DISPLAY stage number: 3, 4 or 5) as
 * the container's real destination stage (Gate In / Inspection / Billing)
 * plus a Date, and the record appears there directly — see _jumpSkipsStage's
 * doc comment — without being forced through whatever sits between
 * Transportation and that stage in the normal sequence.
 *
 * Reason = "Client to Client" additionally captures a New Client Name and an
 * optional Arrival Date (when the container reached the new client, separate
 * from Date above, which is when the move itself was decided/recorded).
 * Reason = "Client Scope" additionally captures a free-text Scope. Reason =
 * "Other" additionally captures a free-text Comment / Type.
 *
 * LIVE path — writes the real Google Sheet and logs the audit-trail entry
 * (offleaseMoveHistory.service.js). Called directly by nothing in this app
 * except the outbox replay of the Fast path below; kept as a genuine,
 * independently-callable function (not inlined into the replay registry)
 * for the same reason saveOffLeaseStage is: this IS the source of truth the
 * fast path's Mongo patch is a preview of. The history log is written HERE,
 * not in the fast path, for the same reason saveOffLeaseStage (not its fast
 * path) sends the Stage 4 quotation email — a side effect belongs on the
 * one write the outbox guarantees runs, not on the instant preview.
 */
export async function saveOffLeaseMoveToStage(containerNo, payload = {}, userEmail, knownRow) {
  await checkActionPermission(`offlease${OL_STAGE2_INTERNAL}`, userEmail);
  const shaped = _prepareMoveToStage(payload);

  return withSheetLock(OL_SHEET, async () => {
    if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');
    await _ensureOffLeaseSheet();
    const { rows } = await getSheetData(OL_SHEET);
    const rn = _resolveOlRow(rows, containerNo, knownRow);
    if (rn === -1) throw new AppError(`Not found: ${containerNo}`);

    const row = rows[rn - 2] || [];
    if (_isMovedOut(row)) return 'ALREADY_PROCESSED';

    const stamp = dmyTime(new Date());
    const values = _moveColumnValues(shaped, userEmail, stamp);
    const cellUpdates = Object.entries(values).map(([col, val]) => ({
      range: `'${OL_SHEET}'!${colLetter(Number(col))}${rn}`, values: [[val]]
    }));
    await batchUpdateValues(cellUpdates);

    // Mirror into Mongo immediately — same best-effort reasoning as
    // saveOffLeaseStage's own mirror block just above.
    try {
      const patch = {};
      for (const [col, val] of Object.entries(values)) patch[`row.${col}`] = val;
      const r = await getCollection(OL_SHEET).updateOne({ key: `row_${rn - 2}` }, { $set: patch });
      if (!r.matchedCount) console.warn(`[OL-MOVE] mirror row_${rn - 2} not found for ${containerNo} — next reconcile will pick it up`);
    } catch (e) {
      console.error('[OL-MOVE] mirror update failed (reconcile will correct):', e?.message || e);
    }

    try {
      await addMoveHistoryEntry({
        containerNo, leaseId: safeStr(row[1]), clientName: safeStr(row[5]),
        event: 'MOVED', reason: shaped.reason, commentType: shaped.commentType, remarks: shaped.remarks, date: shaped.date,
        fromStage: stageCaption(OL_STAGE2_INTERNAL),
        toStage: stageCaption(shaped.jumpTargetInternal),
        by: userEmail
      });
    } catch (e) {
      console.error('[OL-MOVE] history log failed (non-fatal):', e?.message || e);
    }

    return 'OK';
  });
}

/**
 * Mongo-first fast path — same shape and trade-off as saveOffLeaseStageFast:
 * patches Mongo directly so the container drops out of Stage 2's queue and
 * into its chosen destination stage's queue instantly, then enqueues a
 * replay of the live function above to make the same change
 * on the real Google Sheet a few seconds later. This is the entry point the
 * controller calls. Does not itself log the audit-trail entry — see the live
 * function's doc comment for why.
 */
export async function saveOffLeaseMoveToStageFast(containerNo, payload = {}, userEmail, knownRow) {
  await checkActionPermission(`offlease${OL_STAGE2_INTERNAL}`, userEmail);
  const shaped = _prepareMoveToStage(payload);
  if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');

  const docs = await getMongoRowsWithKeys(OL_SHEET);
  const found = _resolveOlMongoDoc(docs, containerNo, knownRow);
  if (!found) throw new AppError(`Not found: ${containerNo}`);
  if (_isMovedOut(found.row)) return 'ALREADY_PROCESSED';

  const stamp = dmyTime(new Date());
  const values = _moveColumnValues(shaped, userEmail, stamp);
  const patch = {};
  for (const [col, val] of Object.entries(values)) patch[`row.${col}`] = val;

  await getCollection(OL_SHEET).updateOne({ key: found.key }, { $set: { ...patch, updatedAt: new Date() } });
  const resolvedRow = knownRow ?? (parseInt(found.key.replace('row_', ''), 10) + 2);
  await enqueueSheetReplay('offlease.saveOffLeaseMoveToStage', [containerNo, payload, userEmail, resolvedRow], { actor: userEmail });

  return 'OK';
}

/**
 * Reverses an active "Move To Stage" jump — either reason, both set a
 * destination stage now. Clears all 8 live move-state columns,
 * which is what naturally makes the record reappear in Stage 2's own
 * pending queue again (see _isMovedOut/_jumpTargetInternal) — no duplicate
 * record is created, this is the SAME row. The permanent audit trail is
 * untouched (a new SENT_BACK entry is appended alongside the earlier MOVED
 * one, neither is ever deleted).
 *
 * Permission is checked against the stage being sent back FROM (the one the
 * caller is currently looking at, since that's what they need edit rights
 * on to act from it) rather than Stage 2's own — deliberately different
 * from saveOffLeaseMoveToStage above.
 */
export async function saveOffLeaseSendBack(containerNo, userEmail, knownRow) {
  return withSheetLock(OL_SHEET, async () => {
    if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');
    await _ensureOffLeaseSheet();
    const { rows } = await getSheetData(OL_SHEET);
    const rn = _resolveOlRow(rows, containerNo, knownRow);
    if (rn === -1) throw new AppError(`Not found: ${containerNo}`);

    const row = rows[rn - 2] || [];
    const jumpTarget = _jumpTargetInternal(row);
    if (jumpTarget == null) throw new AppError('This record was not moved via Move To Stage — nothing to send back.');
    await checkActionPermission(`offlease${jumpTarget}`, userEmail);

    const priorReason = safeStr(row[OL_MOVE_REASON_COL]);
    const priorCommentType = safeStr(row[OL_MOVE_COMMENT_TYPE_COL]);
    const priorRemarks = safeStr(row[OL_MOVE_REMARKS_COL]);
    const priorDate = safeStr(row[OL_MOVE_DATE_COL]);

    const cellUpdates = OL_MOVE_ALL_COLS.map((c) => ({ range: `'${OL_SHEET}'!${colLetter(c)}${rn}`, values: [['']] }));
    await batchUpdateValues(cellUpdates);

    try {
      const patch = {};
      for (const c of OL_MOVE_ALL_COLS) patch[`row.${c}`] = '';
      const r = await getCollection(OL_SHEET).updateOne({ key: `row_${rn - 2}` }, { $set: patch });
      if (!r.matchedCount) console.warn(`[OL-MOVE] mirror row_${rn - 2} not found for ${containerNo} — next reconcile will pick it up`);
    } catch (e) {
      console.error('[OL-MOVE] mirror update failed (reconcile will correct):', e?.message || e);
    }

    try {
      await addMoveHistoryEntry({
        containerNo, leaseId: safeStr(row[1]), clientName: safeStr(row[5]),
        event: 'SENT_BACK', reason: priorReason, commentType: priorCommentType, remarks: priorRemarks, date: priorDate,
        fromStage: stageCaption(jumpTarget), toStage: stageCaption(OL_STAGE2_INTERNAL),
        by: userEmail
      });
    } catch (e) {
      console.error('[OL-MOVE] history log failed (non-fatal):', e?.message || e);
    }

    return 'OK';
  });
}

/** Mongo-first fast path for Send Back — same trade-off as the other Fast
 *  paths in this file. */
export async function saveOffLeaseSendBackFast(containerNo, userEmail, knownRow) {
  if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');

  const docs = await getMongoRowsWithKeys(OL_SHEET);
  const found = _resolveOlMongoDoc(docs, containerNo, knownRow);
  if (!found) throw new AppError(`Not found: ${containerNo}`);

  const jumpTarget = _jumpTargetInternal(found.row);
  if (jumpTarget == null) throw new AppError('This record was not moved via Move To Stage — nothing to send back.');
  await checkActionPermission(`offlease${jumpTarget}`, userEmail);

  const patch = {};
  for (const c of OL_MOVE_ALL_COLS) patch[`row.${c}`] = '';

  await getCollection(OL_SHEET).updateOne({ key: found.key }, { $set: { ...patch, updatedAt: new Date() } });
  const resolvedRow = knownRow ?? (parseInt(found.key.replace('row_', ''), 10) + 2);
  await enqueueSheetReplay('offlease.saveOffLeaseSendBack', [containerNo, userEmail, resolvedRow], { actor: userEmail });

  return 'OK';
}

/* =============================================
   HOLD (Stage 1 — Intimation) + SEND BACK TO STAGE 1
============================================= */

/** Appended columns (olHeaders.generated.js), same fixed-literal convention
 *  as the Move To Stage columns just above — picked past the end of every
 *  real sheet column (and past the Move To Stage block, 290-299) so neither
 *  feature can ever collide with real data or with each other.
 *
 *  Holding a record never touches any of its real Stage 1 fields — the
 *  status column stays blank, exactly like any other still-pending Stage 1
 *  row. These two columns are the ONLY thing that changes, which is also
 *  all Send Back To Stage 1 clears — same row, no duplicate ever created. */
const OL_HOLD_TIMESTAMP_COL = 300;
const OL_HOLD_BY_COL = 301;
const OL_HOLD_REMARKS_COL = 302;
const OL_HOLD_ALL_COLS = [OL_HOLD_TIMESTAMP_COL, OL_HOLD_BY_COL, OL_HOLD_REMARKS_COL];

function _isOnHold(row) {
  return safeStr(row[OL_HOLD_TIMESTAMP_COL]).trim() !== '';
}

/**
 * Puts an Off-Lease Stage 1 (Intimation) record on hold: it drops out of
 * Stage 1's normal pending queue and appears in that page's separate Hold
 * view instead (see getOffLeaseData's OL_STAGE1 hold-filter branch) — same
 * row, no duplicate. Send Back To Stage 1 (below) reverses it.
 *
 * LIVE path — writes the real Google Sheet. Called directly by nothing in
 * this app except the outbox replay of the Fast path below; kept as a
 * genuine, independently-callable function for the same reason
 * saveOffLeaseMoveToStage is (see that function's doc comment).
 */
export async function saveOffLeaseHold(containerNo, userEmail, remarks = '', knownRow) {
  await checkActionPermission('offlease1', userEmail);
  return withSheetLock(OL_SHEET, async () => {
    if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');
    await _ensureOffLeaseSheet();
    const { rows } = await getSheetData(OL_SHEET);
    const rn = _resolveOlRow(rows, containerNo, knownRow);
    if (rn === -1) throw new AppError(`Not found: ${containerNo}`);

    const row = rows[rn - 2] || [];
    if (_isOnHold(row)) return 'ALREADY_PROCESSED';

    const stamp = dmyTime(new Date());
    const rmk = safeStr(remarks).trim();
    const cellUpdates = [
      { range: `'${OL_SHEET}'!${colLetter(OL_HOLD_TIMESTAMP_COL)}${rn}`, values: [[stamp]] },
      { range: `'${OL_SHEET}'!${colLetter(OL_HOLD_BY_COL)}${rn}`, values: [[userEmail || '']] },
      { range: `'${OL_SHEET}'!${colLetter(OL_HOLD_REMARKS_COL)}${rn}`, values: [[rmk]] }
    ];
    await batchUpdateValues(cellUpdates);

    try {
      const r = await getCollection(OL_SHEET).updateOne(
        { key: `row_${rn - 2}` },
        { $set: { [`row.${OL_HOLD_TIMESTAMP_COL}`]: stamp, [`row.${OL_HOLD_BY_COL}`]: userEmail || '', [`row.${OL_HOLD_REMARKS_COL}`]: rmk } }
      );
      if (!r.matchedCount) console.warn(`[OL-HOLD] mirror row_${rn - 2} not found for ${containerNo} — next reconcile will pick it up`);
    } catch (e) {
      console.error('[OL-HOLD] mirror update failed (reconcile will correct):', e?.message || e);
    }

    return 'OK';
  });
}

/** Mongo-first fast path — same shape and trade-off as saveOffLeaseStageFast.
 *  This is the entry point the controller calls. */
export async function saveOffLeaseHoldFast(containerNo, userEmail, remarks = '', knownRow) {
  await checkActionPermission('offlease1', userEmail);
  if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');

  const docs = await getMongoRowsWithKeys(OL_SHEET);
  const found = _resolveOlMongoDoc(docs, containerNo, knownRow);
  if (!found) throw new AppError(`Not found: ${containerNo}`);
  if (_isOnHold(found.row)) return 'ALREADY_PROCESSED';

  const stamp = dmyTime(new Date());
  const rmk = safeStr(remarks).trim();
  await getCollection(OL_SHEET).updateOne(
    { key: found.key },
    { $set: { [`row.${OL_HOLD_TIMESTAMP_COL}`]: stamp, [`row.${OL_HOLD_BY_COL}`]: userEmail || '', [`row.${OL_HOLD_REMARKS_COL}`]: rmk, updatedAt: new Date() } }
  );
  const resolvedRow = knownRow ?? (parseInt(found.key.replace('row_', ''), 10) + 2);
  await enqueueSheetReplay('offlease.saveOffLeaseHold', [containerNo, userEmail, remarks, resolvedRow], { actor: userEmail });

  return 'OK';
}

/**
 * Reverses an active Hold: clears both hold columns, which is what naturally
 * makes the record reappear in Stage 1's own pending queue again (see
 * _isOnHold above) — no duplicate record, this is the SAME row.
 *
 * Permission checked against Stage 1 ('offlease1'), same as Hold itself —
 * unlike Move To Stage's Send Back, there is no other stage this could be
 * acted from.
 */
export async function saveOffLeaseSendBackToStage1(containerNo, userEmail, knownRow) {
  await checkActionPermission('offlease1', userEmail);
  return withSheetLock(OL_SHEET, async () => {
    if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');
    await _ensureOffLeaseSheet();
    const { rows } = await getSheetData(OL_SHEET);
    const rn = _resolveOlRow(rows, containerNo, knownRow);
    if (rn === -1) throw new AppError(`Not found: ${containerNo}`);

    const row = rows[rn - 2] || [];
    if (!_isOnHold(row)) throw new AppError('This record is not on hold — nothing to send back.');

    const cellUpdates = OL_HOLD_ALL_COLS.map((c) => ({ range: `'${OL_SHEET}'!${colLetter(c)}${rn}`, values: [['']] }));
    await batchUpdateValues(cellUpdates);

    try {
      const patch = {};
      for (const c of OL_HOLD_ALL_COLS) patch[`row.${c}`] = '';
      const r = await getCollection(OL_SHEET).updateOne({ key: `row_${rn - 2}` }, { $set: patch });
      if (!r.matchedCount) console.warn(`[OL-HOLD] mirror row_${rn - 2} not found for ${containerNo} — next reconcile will pick it up`);
    } catch (e) {
      console.error('[OL-HOLD] mirror update failed (reconcile will correct):', e?.message || e);
    }

    return 'OK';
  });
}

/** Mongo-first fast path for Send Back To Stage 1 — same trade-off as the
 *  other Fast paths in this file. */
export async function saveOffLeaseSendBackToStage1Fast(containerNo, userEmail, knownRow) {
  await checkActionPermission('offlease1', userEmail);
  if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');

  const docs = await getMongoRowsWithKeys(OL_SHEET);
  const found = _resolveOlMongoDoc(docs, containerNo, knownRow);
  if (!found) throw new AppError(`Not found: ${containerNo}`);
  if (!_isOnHold(found.row)) throw new AppError('This record is not on hold — nothing to send back.');

  const patch = {};
  for (const c of OL_HOLD_ALL_COLS) patch[`row.${c}`] = '';

  await getCollection(OL_SHEET).updateOne({ key: found.key }, { $set: { ...patch, updatedAt: new Date() } });
  const resolvedRow = knownRow ?? (parseInt(found.key.replace('row_', ''), 10) + 2);
  await enqueueSheetReplay('offlease.saveOffLeaseSendBackToStage1', [containerNo, userEmail, resolvedRow], { actor: userEmail });

  return 'OK';
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
    const { rows } = await getSheetDataFromMongo(SHEETS.DEPLOYED);
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
/* =============================================
   BILLING (Billing Sales sheet -> Off-Lease report)
============================================= */
/* Billing Sales column positions. Joined on Container No.: that sheet has no
   Lease ID column at all, so the container number is the only key available
   (verified 2026-08-11 — 117 Billing rows match an Off-Lease container, 0
   match a Lease ID). */
const BS_CONTAINER = 0, BS_CLIENT_NAME = 2, BS_BILLING_RANGE = 18,
  BS_BILL_AMOUNT = 19, BS_MONTH = 21, BS_YEAR = 22,
  BS_INVOICE_ATTACHMENT = 28, BS_INVOICE_NO = 30;

/**
 * Billing Sales rows for one container AND client, plus the billed total.
 *
 * BOTH keys are required. A container number is reused across clients over
 * time — TRIU6681671 alone appears under two different clients — so matching
 * on the container alone pulled another client's invoices onto the report.
 *
 * Falls back to container-only when the Off-Lease record has no client name,
 * since an empty client would otherwise match nothing at all.
 */
async function _findBillingForContainer(want, wantClient) {
  const empty = { records: [], count: 0, totalBilling: 0 };
  const client = safeStr(wantClient).trim().toLowerCase();
  try {
    const { rows } = await getSheetDataFromMongo(SHEETS.BILLING_SALES);
    const records = [];
    for (const r of rows) {
      if (normKey(r[BS_CONTAINER]) !== want) continue;
      if (client && safeStr(r[BS_CLIENT_NAME]).trim().toLowerCase() !== client) continue;
      records.push({
        container: safeStr(r[BS_CONTAINER]).trim(),
        clientName: safeStr(r[BS_CLIENT_NAME]).trim(),
        invoiceNo: safeStr(r[BS_INVOICE_NO]).trim(),
        amount: fmtNumCell(r[BS_BILL_AMOUNT]),
        attachment: safeStr(r[BS_INVOICE_ATTACHMENT]).trim(),
        billingRange: safeStr(r[BS_BILLING_RANGE]).trim(),
        period: [safeStr(r[BS_MONTH]).trim(), safeStr(r[BS_YEAR]).trim()].filter(Boolean).join('/')
      });
    }
    if (!records.length) return empty;
    const totalBilling = records.reduce((sum, x) => {
      const n = Number(String(x.amount).replace(/,/g, ''));
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0);
    return { records, count: records.length, totalBilling };
  } catch (e) {
    console.error('[OL-BILLING]', e?.message || e);
    return empty;
  }
}

/** Invoice numbers are written with inconsistent separators and case across
 *  systems ("QUA/APR65/26-27", "QUA-APR65-26-27", lower case). Compared on
 *  alphanumerics alone so those all match. */
const normInvoiceNo = (v) => safeStr(v).toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Invoice number -> its attachment link, from the Billing Sales sheet.
 *
 * Keyed on the INVOICE NUMBER alone, deliberately — not container + client
 * like _findBillingForContainer. An attachment belongs to the invoice, and the
 * container/client join finds nothing for most records (HNKU6063239 has three
 * invoices in the Accounts API and zero Billing Sales rows, because the two
 * systems spell the client differently: "Draeger India Pvt Ltd" vs
 * "Draeger India Pvt. Ltd."). The invoice number is the one field both sides
 * agree on, so it is the one to match on.
 */
export async function getInvoiceAttachments(invoiceNos) {
  const want = new Set((invoiceNos || []).map(normInvoiceNo).filter(Boolean));
  const out = {};
  if (!want.size) return out;

  try {
    const { rows } = await getSheetDataFromMongo(SHEETS.BILLING_SALES);
    for (const r of rows) {
      const key = normInvoiceNo(r[BS_INVOICE_NO]);
      if (!key || !want.has(key) || out[key]) continue;
      const link = safeStr(r[BS_INVOICE_ATTACHMENT]).trim();
      if (link) out[key] = link;
    }
  } catch (e) {
    console.error('[OL-INVOICE-ATTACH]', e?.message || e);
  }
  return out;
}

/** The Off-Lease sheet's own client cell is sometimes blank at intimation
 *  time; fall back to what the lease/order sheets say. */
function _clientNameFallback(leaseInfo) {
  return safeStr(leaseInfo?.clientName || '');
}

/**
 * @param gatedIn true when this container's LATEST Stage 3 (Gate In) form
 *   row shows "Inward (Gate-In)" — see stage3Form.service.js. Gate In has no
 *   status column left to fill, so this substitutes for it here exactly as
 *   it does in getOffLeaseData's queue gating; without it the dashboard
 *   would show every gated-in container permanently stuck at Stage 3 (Gate
 *   In), the same class of scorecard/queue mismatch fixed 2026-08-20 for
 *   the STAGE-10 delivery bypass.
 * @param repairSkip true when that SAME form row is also marked "Repair
 *   Required? = No" — Inspection Checklist (Stage 4) is skipped entirely,
 *   so it counts as done here too, advancing straight to Billing.
 * @param delivered true when STAGE-10 has this container's site delivery —
 *   Transportation (Stage 2) has no status column left to fill either, so
 *   this substitutes for it the same way. Applied HERE, inline with every
 *   other bypass, rather than as a one-hop "move it to whatever's next"
 *   patch after the fact — a delivered container that is ALSO gated in
 *   and/or repair-skipped needs to land on its true current stage in one
 *   pass, not get stranded one hop short at Gate In because the patch only
 *   knew how to advance past Transportation.
 *
 *   `movedOut` (computed inside, not a param — read straight off `row`)
 *   is the same completion signal for a manual "Move To Stage" closeout
 *   (saveOffLeaseMoveToStage(Fast)): a container that never goes through
 *   the FMS-tracked transport chain at all.
 */
export function _classifyOffLeaseStages(headers, row, gatedIn = false, repairSkip = false, delivered = false) {
  const apCol = _findOlColumnMulti(headers, ['intimation approval status', 'intimation appt status', 'approval status']);
  const approval = apCol >= 0 ? safeStr(row[apCol]).trim() : '';
  const stage1Done = safeStr(row[OL_STAGE_INFO[1].statusCol]).trim() !== '';
  // Manual "Move To Stage" closeout — same completion signal as `delivered`,
  // read straight off this row (see _isMovedOut's doc comment).
  const movedOut = _isMovedOut(row);
  // Active jump destination (any reason), or null — see
  // _jumpSkipsStage's doc comment.
  const jumpTarget = _jumpTargetInternal(row);

  const stages = OL_ACTIVE_STAGE_NUMS.map((s) => {
    const info = OL_STAGE_INFO[s];
    const st = safeStr(row[info.statusCol]).trim();
    /* Every stage block ends "... Remark | Timestamp | User | Status", so the
       remark is three columns before the status — the same fixed offset
       saveOffLeaseStage relies on for Timestamp (-2) and User (-1). Guarded
       by the header text rather than trusted blindly: this sheet has had
       columns deleted by hand before, and reading the wrong column would put
       another stage's data on the dashboard. */
    const remarkCol = info.statusCol - 3;
    const remark = /remark/i.test(safeStr(headers[remarkCol])) ? safeStr(row[remarkCol]).trim() : '';
    /* BUG FOUND AND FIXED 2026-08-28: this function is a SEPARATE
       reimplementation of getOffLeaseData's own bypass rules (used for the
       Off-Lease Dashboard's KPI/pipeline view instead of the actual stage
       queues) and had drifted out of sync with it — missing the Billing
       bypass entirely. Confirmed via a direct count comparison: the
       Dashboard reported 4 containers at Billing where the real Stage 5
       queue (getOffLeaseData) correctly showed 13, because a repair-skip
       container that had genuinely bypassed Inspection straight into
       Billing was never marked "done" at Inspection here, so the dashboard
       kept reporting it stuck one stage further back. Both functions must
       be kept in sync — see getOffLeaseData's own bypass block (~line 1546)
       for the source of truth this mirrors.
       CORRECTION, same day: the Billing bypass line this comment used to
       add here was a MISREADING of getOffLeaseData's releasedByRepairSkip —
       that condition describes "Inspection counts as done, for the purpose
       of releasing rows INTO Billing's queue", not "Billing itself is
       done". Applying it as a Billing-completion bypass wrongly marked
       Billing done for repair-skip containers that are still genuinely
       pending there (confirmed on HNKU6063239, HNKU6270257, SZLU2011901 —
       all showed done at Billing but still appeared in Billing's own real
       queue). Removed — Billing only completes via a real, human-filled
       status, and the "implied done" backward pass below already covers
       the actual case (an earlier stage bypassed) this was mistakenly
       trying to solve a second time. */
    // This stage sat between Transportation and an active jump's actual
    // destination — it was never genuinely pending, the row jumped past it.
    const jumpSkipped = _jumpSkipsStage(jumpTarget, s);
    const bypassDone = (s === OL_STAGE2_INTERNAL && (delivered || movedOut) && stage1Done)
      || (s === OL_STAGE3_INTERNAL && gatedIn)
      || (s === OL_INSPECTION_INTERNAL && repairSkip)
      || jumpSkipped;
    return {
      stage: s,
      displayStage: displayStageNum(s),
      label: OL_STAGE_LABELS[s],
      done: st !== '' || bypassDone,
      real: st !== '', // genuinely filled in (not just bypass-inferred) — see the backward pass below
      skipped: (s === OL_INSPECTION_INTERNAL && repairSkip) || jumpSkipped,
      movedToHere: jumpTarget != null && s === jumpTarget,
      timestamp: row[info.statusCol - 2],
      remark
    };
  });

  /* BUG FOUND AND FIXED 2026-08-28: getOffLeaseData's actual write path
   * (saveOffLeaseStage) never enforces "the previous stage must be done"
   * as a precondition for WRITING — it only checks that stage N's own
   * status is still blank. The prevStatus/bypass gating only governs
   * whether a row is SHOWN in a given stage's pending queue, at read time,
   * using whatever gatedIn/repairSkip/delivered signals hold RIGHT NOW.
   * Both together mean a stage can end up genuinely completed even though
   * an EARLIER stage's own status is blank and its bypass condition no
   * longer holds (or never did, if it was filled by hand, or the
   * gatedIn/delivered signal it relied on has since changed) — confirmed on
   * GSOU6384240, CICU4881946, CXRU1030387, CXRU1040451: Inspection shows a
   * real "Completed" status while Transportation and Gate In are both
   * blank with no active bypass. The old strict "first not-done stage,
   * scanned in order" model got stuck reporting Transportation as current
   * for all four, while the real Billing queue (getOffLeaseData) correctly
   * had them past Inspection already — it only ever checks the ONE
   * immediately preceding stage, never the whole chain.
   *
   * Fix: a stage with a REAL (non-bypass) status implies every stage before
   * it must have been satisfied at some point, even if this function can't
   * reconstruct exactly how. `impliedDone` is set on every stage up to the
   * LAST one with a real status. */
  let lastRealIdx = -1;
  stages.forEach((s, i) => { if (s.real) lastRealIdx = i; });
  stages.forEach((s, i) => { s.impliedDone = i <= lastRealIdx; });

  const apLower = approval.toLowerCase();
  let currentStage, stageClass, currentStageNum;
  const stage1 = stages.find((s) => s.stage === 1);
  if (!stage1.done) {
    currentStage = stageCaption(1); stageClass = 'stage'; currentStageNum = 1;
  } else if (apLower === '') {
    currentStage = 'Pending Approval'; stageClass = 'approval'; currentStageNum = null;
  } else if (apLower === 'rejected') {
    currentStage = 'Rejected — container stays on lease'; stageClass = 'rejected'; currentStageNum = null;
  } else {
    /* First unfinished stage after Stage 1 — "unfinished" meaning neither
       done (real or bypass) NOR implied done by a later real stage. */
    const next = stages.slice(1).find((s) => !s.done && !s.impliedDone);
    if (!next) { currentStage = 'Completed — container released'; stageClass = 'done'; currentStageNum = null; }
    else { currentStage = stageCaption(next.stage); stageClass = 'stage'; currentStageNum = next.stage; }
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
const OL_DASHBOARD_CACHE_KEY = 'offlease_dashboard_raw_v1';
const OL_DASHBOARD_TTL_SECS = 20;

export async function getOffLeaseDashboardData(user) {
  /* No _ensureOffLeaseSheet() here. It exists to create the tab and widen the
     header row before a WRITE; this function only reads, and reads from the
     Mongo mirror. Calling it made a Mongo-backed page depend on a live
     spreadsheets.get — and because `sheetEnsured` is per-process, every
     backend restart paid it again. With the read quota exhausted that turned
     into the circuit breaker refusing the whole dashboard.

     The raw sheet read is cached (20s, stampede-safe, degrades to the last
     good read on a quota error) — added 2026-08-26. Scoped ONLY to this
     dashboard, deliberately not to getOffLeaseData/getOffLeaseStageCounts
     (the actual action queues staff Save/Approve from) — those must keep
     showing a just-completed action instantly, the exact bug class fixed
     earlier this session. This function is display/KPI-only, and the
     per-user sale-person scoping below still runs fresh on every call
     against the shared raw rows, so nothing scoped is cached across users. */
  const { headers, rows, _stale, _staleSince } = await cacheGetOrLoad(OL_DASHBOARD_CACHE_KEY, OL_DASHBOARD_TTL_SECS, async () => {
    const { headers: h, rows: r } = await getSheetDataFromMongo(OL_SHEET);
    return { headers: h, rows: r };
  }, { degradeOnError: true });
  const gate = await _offLeaseAccessGate(user);
  const gateFormIndex = getGateFormIndexSync();
  /* Cache/disk-only, same as the gate form index — cheap enough to always
     resolve. Keyed on container alone (see getDeliveredKeys' own doc
     comment for why client is not used there). Best-effort: an FMS read
     failure degrades to the pre-delivery-bypass count, not a broken
     dashboard. */
  let deliveredKeys;
  try { deliveredKeys = await getDeliveredKeys(); } catch (e) { deliveredKeys = undefined; }

  /* GUARANTEED-CONSISTENT current-stage/KPI source, added 2026-08-28 after a
   * whole day of the Dashboard's own hand-approximated classifier
   * (_classifyOffLeaseStages) drifting from the real per-stage queues
   * (getOffLeaseData) in several different ways — missing bypasses, wrong
   * bypass ownership, and finally a genuine data anomaly (a later stage
   * completed while an earlier one's own gating condition never held, which
   * no single-pass "is stage N done" model can safely infer either way).
   * Rather than keep hand-fixing a second approximation of the same logic,
   * this now calls the SAME getOffLeaseData/getOffLeaseApprovalData every
   * stage tab uses, sharing the already-fetched sheetData/deliveredKeys/
   * gateFormIndex so it costs one extra pass per active stage, not one
   * extra live/Mongo read. byStage is now guaranteed to equal
   * getOffLeaseStageCounts' own counts by construction, not by staying in
   * sync by hand. `_classifyOffLeaseStages` is still used below for the
   * per-stage remarks/timestamps the pipeline modal displays — only
   * currentStage/currentStageNum/stageClass are overridden from here. */
  const sheetData = { headers, rows };
  /* Keyed by _rowNum (the actual sheet row), NOT container number — a
   * container can have more than one Off-Lease Tracking record (TRIU6681671
   * has two: LEASE0027 and LEASE0038), and keying this by container alone
   * merges their queue memberships together. BUG FOUND AND FIXED 2026-08-28:
   * confirmed LEASE0038's own pendingStages (below) wrongly included Gate In
   * (7) — LEASE0038 itself is NOT in that queue (isGatedIn is true for it,
   * which excludes it), but LEASE0027, sharing the same container number,
   * genuinely IS, and the container-keyed map handed that membership to
   * BOTH records. Same fix applied to approvalPending just below, for the
   * identical reason. */
  const pendingByRow = new Map(); // _rowNum -> Set(stage nums it's pending in)
  const byStageQueueCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 };
  await Promise.all(OL_ACTIVE_STAGE_NUMS.map(async (s) => {
    try {
      const d = await getOffLeaseData(s, { deliveredKeys, gateFormIndex, sheetData }, user);
      byStageQueueCounts[s] = d.data.length;
      for (const item of d.data) {
        if (!pendingByRow.has(item._rowNum)) pendingByRow.set(item._rowNum, new Set());
        pendingByRow.get(item._rowNum).add(s);
      }
    } catch (e) { /* leave this stage's count/containers unrepresented rather than fail the whole dashboard */ }
  }));
  let approvalPendingRows = new Set();
  try {
    approvalPendingRows = new Set((await getOffLeaseApprovalData(user, sheetData)).data.map((d) => d._rowNum));
  } catch (e) { /* leave empty — no approval-queue containers surfaced, not a broken dashboard */ }

  const items = [];
  /* byStage seeded directly from each stage's own real queue length
   * (byStageQueueCounts), NOT accumulated per-row below — a container CAN
   * legitimately be pending in more than one stage's queue at once (an
   * already-accepted property of this workflow; see the historical "tab
   * badges summed to 43 against 37 active records" comments elsewhere in
   * this file), so a one-bucket-per-container tally can never sum to match
   * every independent tab count when that happens. Counting queue
   * membership directly, exactly like getOffLeaseStageCounts does, is the
   * only way byStage stays exactly right by construction. pendingApproval
   * still accumulates per-row below since Off-Lease Tracking rows and the
   * approval queue are already known to be disjoint by definition. */
  const kpis = { active: 0, pendingApproval: 0, byStage: { ...byStageQueueCounts }, completedThisMonth: 0 };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row[0] || String(row[0]).trim() === '') continue;
    if (gate && !gate(safeStr(row[5]))) continue;
    const rowNum = i + 2; // matches getOffLeaseData/getOffLeaseApprovalData's own _rowNum (i + 2)
    const container = safeStr(row[0]);
    const containerKey = _containerKey(row[0]);
    // Client-aware match (row[5]) — see pickGateFormForClient's doc comment.
    const gfRow = pickGateFormForClient(gateFormIndex.get(containerKey) || [], row[5]);
    const delivered = deliveredKeys ? isDeliveredSince(deliveredKeys, containerKey, null) : false;
    const c = _classifyOffLeaseStages(headers, row, isGatedIn(gfRow), isRepairNotRequired(gfRow), delivered);

    // Override current-stage classification with the guaranteed-consistent
    // queue-membership result — see the doc comment above.
    let currentStage = c.currentStage, stageClass = c.stageClass, currentStageNum = c.currentStageNum, completed = c.completed;
    if (c.stages[0].done) { // Stage 1 done — otherwise leave _classifyOffLeaseStages' own "Stage 1" result as-is
      if (approvalPendingRows.has(rowNum)) {
        currentStage = 'Pending Approval'; stageClass = 'approval'; currentStageNum = null; completed = false;
      } else {
        const pending = pendingByRow.get(rowNum);
        const nextStage = OL_ACTIVE_STAGE_NUMS.slice(1).find((s) => pending?.has(s));
        if (nextStage) {
          currentStage = stageCaption(nextStage); stageClass = 'stage'; currentStageNum = nextStage; completed = false;
        } else if (c.approvalStatus.toLowerCase() === 'rejected') {
          currentStage = 'Rejected — container stays on lease'; stageClass = 'rejected'; currentStageNum = null; completed = false;
        } else {
          currentStage = 'Completed — container released'; stageClass = 'done'; currentStageNum = null; completed = true;
        }
      }
    }

    items.push({
      container,
      leaseId: safeStr(row[1]),
      clientName: safeStr(row[5]),
      clientCode: safeStr(row[4]),
      /* Identity columns, fixed positions on the tracking sheet — the same
         ones getOffLeaseData's display grid uses. Added for the order-book
         dashboard view, which shows each record's size/type/location and who
         raised it alongside the stage strip. `rate` (col 9) stays out:
         pricing is hidden from every grid system-wide. */
      size: safeStr(row[2]),
      type: safeStr(row[3]),
      location: safeStr(row[6]),
      deployedDate: fmtCell(row[7]),
      validUpto: fmtCell(row[8]),
      raisedBy: safeStr(row[OL_STAGE_INFO[1].statusCol - 1]),
      stages: c.stages,
      approvalStatus: c.approvalStatus,
      currentStage,
      stageClass,
      currentStageNum,
      /* Every stage THIS ROW is genuinely pending in right now (see the
         pendingByRow doc comment above for why this must be keyed by row,
         not container number), not just the single one currentStageNum
         picked to show as "current". A record CAN legitimately be pending
         in more than one stage's queue at once (an already-accepted
         property of this workflow — see byStage's own doc comment), and
         currentStageNum always picks just the first of those in workflow
         order for display (the MiniPipeline dot, the "Open" button's
         target tab) — a caller filtering "show me everything pending at
         stage X" (the Dashboard's own KPI-card click-through) must check
         membership in THIS array, not equality against currentStageNum, or
         a record pending elsewhere-first drops out of a filter its own KPI
         count included it in. Bug found 2026-08-28: clicking "Stage 4
         (Inspection)" (count 1) showed 0 records — the one record behind
         that count had a DIFFERENT currentStageNum, since it was also
         pending in an earlier-in-workflow-order stage. */
      pendingStages: [...(pendingByRow.get(rowNum) || [])]
    });

    if (!completed) kpis.active++;
    if (stageClass === 'approval') kpis.pendingApproval++;
    // byStage is seeded directly from each stage's own queue length above —
    // not accumulated here, see that comment for why.
    if (completed && _completedThisMonth(c.stages[7])) kpis.completedThisMonth++;
  }

  return { kpis, items, ...(_stale ? { _stale, _staleSince } : {}) };
}

/* =============================================
   DASHBOARD — OFF-LEASE CONTAINER LOOKUP
============================================= */
/**
 * @param containerNo the container to look up
 * @param leaseId     optional — picks ONE record when the container has been
 *                    off-leased more than once. Without it, a container with
 *                    several records returns the candidate list instead of
 *                    silently showing the first.
 */
export async function getOffLeaseContainerDetail(containerNo, leaseId, user) {
  const want = normKey(containerNo);
  if (!want) return { found: false, message: 'Enter a container number.' };

  const res = { found: false, container: safeStr(containerNo), orderNos: '' };

  const leaseInfo = await _findLeaseInfoForContainer(want);
  res.orderNos = leaseInfo.orders.join(', ');

  /* Read-only lookup: served from the Mongo mirror, with no
     _ensureOffLeaseSheet(). That call is a live spreadsheets.get made to widen
     the sheet before a WRITE — on this path it only added a Sheets round trip
     to a read, and on an exhausted quota it failed the whole container detail.
     Same fix already applied to the dashboard and the stage lists. */
  const { headers, rows } = await getSheetDataFromMongo(OL_SHEET);
  const gate = await _offLeaseAccessGate(user);
  /* Same Gate In / repair-skip bypass getOffLeaseData and
     getOffLeaseDashboardData use — see stage3Form.service.js and the doc
     comment on _classifyOffLeaseStages. Resolved per MATCH below (each
     match's own row[5] client), not once for the whole container — the same
     box can be gated in/out under different clients at different times (see
     pickGateFormForClient's doc comment), so a blanket container-only
     lookup risked showing one client's record with another's gate data. */
  const gateFormIndex = getGateFormIndexSync();
  const containerKey = _containerKey(containerNo);

  /* A container can appear more than once — the same box off-leased by two
     different clients at different times (e.g. TRIU6681671). Collect every
     match rather than breaking on the first, or the second client's record
     is unreachable and the first is shown as if it were the only one. */
  const matches = [];
  for (let r = 0; r < rows.length; r++) {
    if (normKey(rows[r][0]) === want) matches.push({ row: rows[r], rowNum: r + 2 });
  }

  /* Scope filter BEFORE the wantLease/multiple logic below, so a scoped
     caller's "pick one of N" prompt (or single result) only ever reflects
     records that are actually theirs — a container off-leased under two
     different clients must not even hint that a second, someone else's
     record exists. */
  const visibleMatches = gate ? matches.filter((m) => gate(safeStr(m.row[5]) || _clientNameFallback(leaseInfo))) : matches;

  const wantLease = safeStr(leaseId).trim().toLowerCase();
  let picked = visibleMatches[0] || null;
  if (wantLease) {
    picked = visibleMatches.find((m) => safeStr(m.row[1]).trim().toLowerCase() === wantLease) || null;
    if (!picked) return { found: false, message: `No record for ${safeStr(containerNo)} under lease ${safeStr(leaseId)}.` };
  } else if (visibleMatches.length > 1) {
    // Let the caller choose which record they mean.
    return {
      found: true,
      container: safeStr(visibleMatches[0].row[0]),
      multiple: true,
      matches: visibleMatches.map((m) => {
        const mClient = safeStr(m.row[5]) || _clientNameFallback(leaseInfo);
        const mGfRow = pickGateFormForClient(gateFormIndex.get(containerKey) || [], mClient);
        return {
          leaseId: safeStr(m.row[1]),
          clientName: mClient,
          clientCode: safeStr(m.row[4]),
          size: safeStr(m.row[2]),
          type: safeStr(m.row[3]),
          deployedDate: formatDateVal(m.row[7]),
          validUpto: formatDateVal(m.row[8]),
          currentStage: _classifyOffLeaseStages(headers, m.row, isGatedIn(mGfRow), isRepairNotRequired(mGfRow)).currentStage
        };
      })
    };
  }

  const row = picked ? picked.row : null;
  const rowNum = picked ? picked.rowNum : -1;

  if (!row) {
    try {
      const { rows: dRows } = await getSheetDataFromMongo(SHEETS.DEPLOYED);
      for (const d of dRows) {
        if (normKey(d[0]) !== want) continue;
        const clientName = safeStr(d[1]);
        // Not this caller's client -- keep scanning (a duplicate Deployed
        // row is unlikely but possible), otherwise falls through to not-found.
        if (gate && !gate(clientName)) continue;
        res.found = true;
        res.inOffLease = false;
        res.container = safeStr(d[0]);
        res.clientName = clientName;
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

  // This resolved record's own client — see pickGateFormForClient's doc
  // comment for why container number alone is not enough here.
  const gfRow = pickGateFormForClient(gateFormIndex.get(containerKey) || [], res.clientName);
  const gatedIn = isGatedIn(gfRow);
  const repairSkip = isRepairNotRequired(gfRow);

  const stages = [];
  /* WORKFLOW ORDER, not 1..8 ascending. Internal stage numbers do not run in
     workflow order (the sequence is 1 -> 6 -> 7 -> 3 -> 5 -> 8), so counting
     up listed the container's history as Intimation, Inspection, Billing,
     Transportation, Get In — the stages jumbled, and out of step with the
     progress board and the dashboard, which both read OL_ACTIVE_STAGE_NUMS.

     Retired stages are skipped EXCEPT when the row already has data for one —
     a container that completed Stage 2 or 4 before they were retired should
     still show that stage and its fields in the lookup and the PDF. They have
     no place in the sequence, so they follow it, labelled as retired and
     carrying their own completion date. */
  const retiredWithData = [...OL_RETIRED_STAGES].filter((s) => {
    const info = OL_STAGE_INFO[s];
    return info && safeStr(row[info.statusCol]).trim() !== '';
  }).sort((a, b) => a - b);

  for (const s of [...OL_ACTIVE_STAGE_NUMS, ...retiredWithData]) {
    const info = OL_STAGE_INFO[s];
    // Stage 4's columns were deleted from the sheet, so it has no entry at all
    // — skip rather than dereference undefined.
    if (!info) continue;
    const st = safeStr(row[info.statusCol]).trim();
    // Manual "Move To Stage" closeout — same read-straight-off-the-row signal
    // as getOffLeaseData/_classifyOffLeaseStages (see _isMovedOut/_jumpSkipsStage).
    const bypassDone = (s === OL_STAGE2_INTERNAL && _isMovedOut(row))
      || (s === OL_STAGE3_INTERNAL && gatedIn) || (s === OL_INSPECTION_INTERNAL && repairSkip)
      || _jumpSkipsStage(_jumpTargetInternal(row), s);

    const fields = [];
    for (let c = info.startCol; c <= info.statusCol - 3; c++) {
      const sv = fmtCell(row[c]);
      if (sv.trim() === '') continue;
      fields.push({ label: OL_HEADERS[c] || `Col ${c + 1}`, value: sv });
    }
    /* Stage 3's inspection columns are reported as a structured `inspection`
       table rather than 44 loose label/value fields — see below. Everything
       else in the extras (the six photo slots) stays an ordinary field. */
    let inspection = null;
    let machine = null;
    let cabin = null;
    let technician = null;
    /* Skipped when bypassDone (repair-not-required): the sheet's inspection
       columns were never filled in because inspection never happened, but a
       stray non-empty cell in one of the estimate/photo/remark columns
       (leftover from earlier manual data entry) could still make readPoints
       below report a phantom point. A container that skipped inspection has
       no inspection data to show, full stop — the real "why" lives in the
       Stage 3 form fields attached below instead. */
    if (s === 3 && !bypassDone) {
      for (const eci of OL_STAGE3_EXTRA_COLS) {
        if (OL_INSPECTION_COL_SET.has(eci)) continue;
        const sv2 = fmtCell(row[eci]);
        if (sv2.trim() === '') continue;
        fields.push({ label: OL_HEADERS[eci] || `Col ${eci + 1}`, value: sv2 });
      }

      /* safeStr, not fmtCell, for the text cells — a remark or status must not
         be reinterpreted as a date. Estimates go through fmtNumCell. */
      const readPoints = (defs) => defs.map((p) => ({
        n: p.n,
        item: p.item,
        status: safeStr(row[p.status]).trim(),
        estimate: fmtNumCell(row[p.estimate]),
        photo: safeStr(row[p.photo]).trim(),
        remark: safeStr(row[p.remark]).trim()
      })).filter((p) => p.status || p.estimate || p.photo || p.remark);

      const insp = readPoints(OL_INSPECTION_POINTS);
      if (insp.length) inspection = insp;
      const mach = readPoints(OL_MACHINE_POINTS);
      if (mach.length) machine = mach;

      const cab = OL_CABIN_ITEMS
        .map((c, i) => ({
          n: i + 1,
          item: c.item,
          qty: cabinExpectedQty(c, safeStr(row[2])), // col 2 = Size
          available: fmtNumCell(row[c.col])
        }))
        .filter((c) => c.available !== '');
      if (cab.length) cabin = cab;

      const hours = fmtNumCell(row[OL_TECHNICIAN_HOURS_COL]);
      if (hours !== '') {
        technician = { hours, rate: OL_TECHNICIAN_RATE_PER_HOUR, cost: fmtNumCell(row[OL_TECHNICIAN_COST_COL]) };
      }
    }
    if (s === 4) {
      for (const eci of OL_STAGE4_EXTRA_COLS) {
        const sv3 = fmtCell(row[eci]);
        if (sv3.trim() === '') continue;
        fields.push({ label: OL_HEADERS[eci] || `Col ${eci + 1}`, value: sv3 });
      }
    }

    /* Gate In (internal 7) and a repair-not-required Inspection Checklist
       (internal 3) both have no column of their own left to fill — the
       external "Stage 3 " form log (same tab covers both: gate movement AND
       its Repair Required verdict) IS the record for either, so a bypassed
       stage shows that form's own fields here instead of the blank sheet
       columns every other stage reads from. Without this the history table
       and the "Filled Stage Data" card both show a completed stage with
       nothing in it — technically true (nothing was written to the sheet)
       but not what "fetch the data" means. */
    let gateFormFields = fields;
    let gateFormTimestamp = formatDateVal(row[info.statusCol - 2]);
    let gateFormUser = safeStr(row[info.statusCol - 1]);
    if (bypassDone && (s === OL_STAGE3_INTERNAL || s === OL_INSPECTION_INTERNAL)) {
      // Reuse the same client-resolved row bypassDone was computed from,
      // rather than re-matching (and risking a different client's row).
      const gf = gfRow;
      if (gf) {
        gateFormTimestamp = gf.date || gf.timestamp || gateFormTimestamp;
        gateFormUser = s === OL_STAGE3_INTERNAL ? 'Auto — Gate-In Form' : 'Auto — Repair Not Required (Gate-In Form)';
        gateFormFields = (s === OL_STAGE3_INTERNAL
          ? [
            { label: 'Customer Name (Gate-In Form)', value: gf.customer },
            { label: 'Location', value: gf.location },
            { label: 'Transporter Name', value: gf.transporterName },
            { label: 'Transporter Number', value: gf.transporterNumber },
            { label: 'Vehicle Number', value: gf.vehicleNumber },
            { label: 'LR Copy', value: gf.lrCopy },
            { label: 'Left Side Photo', value: gf.photos?.left },
            { label: 'Right Side Photo', value: gf.photos?.right },
            { label: 'Back View Photo', value: gf.photos?.back },
            { label: 'Inside – Front Photo', value: gf.photos?.insideFront },
            { label: 'Inside – Rear Photo', value: gf.photos?.insideRear },
            { label: 'Roof Photo', value: gf.photos?.roof },
            { label: 'Floor Photo', value: gf.photos?.floor },
            { label: 'Door Lock Photo', value: gf.photos?.doorLock },
            { label: 'Container Number (Close-up) Photo', value: gf.photos?.closeup },
            { label: 'Container Photos (Merged PDF)', value: gf.photos?.mergedPdf },
            { label: 'Repair Required?', value: gf.repairRequired },
            { label: 'Estimated Repair Budget', value: gf.repairBudget },
            { label: 'Remarks', value: gf.remarks }
          ]
          : [
            { label: 'Repair Required?', value: gf.repairRequired },
            { label: 'Estimated Repair Budget', value: gf.repairBudget },
            { label: 'Remarks', value: gf.remarks },
            { label: 'Container Photos (Merged PDF)', value: gf.photos?.mergedPdf }
          ]
        ).filter((f) => f.value && String(f.value).trim() !== '');
      }
    }

    stages.push({
      stage: s,
      displayStage: displayStageNum(s),
      label: OL_STAGE_LABELS[s],
      done: st !== '' || bypassDone,
      /* Gate In is genuinely done (the external form confirms the physical
         event happened); Inspection Checklist bypassed by repair-skip never
         happened at all — it was routed around, not completed. Both count
         as `done` for gating the next stage, but only one should ever say
         "Completed" on screen. */
      skipped: s === OL_INSPECTION_INTERNAL && repairSkip,
      status: st,
      timestamp: gateFormTimestamp,
      user: gateFormUser,
      fields: gateFormFields,
      ...(inspection ? { inspection } : {}),
      ...(machine ? { machine } : {}),
      ...(cabin ? { cabin } : {}),
      ...(technician ? { technician } : {})
    });
  }
  res.stages = stages;

  /* Invoices for the report come from the Accounts & Collection API — the same
     call and the same response the Stage 1 panel renders, so the print view,
     PDF and Excel can never disagree with it. The Google Sheet is deliberately
     NOT consulted: no fallback, no merge. */
  try {
    const { getOutstandingForContainer } = await import('./accountsApi.service.js');
    res.outstanding = await getOutstandingForContainer(res.container || containerNo, res.clientName);
  } catch (e) {
    console.error('[OL-DETAIL] outstanding fetch failed:', e?.message || e);
    res.outstanding = null;
  }

  /* Fill base fields still blank in the Off-Lease sheet (Rate, Location,
     dates) from the Deployed sheet. Never the client — see helper's note. */
  await _fillBlanksFromDeployed(res, want);

  const apLower = approval.toLowerCase();
  const stage1 = stages.find((s) => s.stage === 1);
  if (!stage1?.done) {
    res.currentStage = stageCaption(1);
    res.stageClass = 'stage';
  } else if (apLower === '') {
    res.currentStage = 'Pending Approval';
    res.stageClass = 'approval';
  } else if (apLower === 'rejected') {
    res.currentStage = 'Rejected — container stays on lease';
    res.stageClass = 'rejected';
  } else {
    /* By stage number, not array index — `stages` above skips retired stages
       that carry no data, so the sequence has gaps. A retired stage that IS
       present (historical data) must not count as "still pending" either. */
    /* Workflow order, skipping the first entry and any retired stage that only
       appears here because it holds historical data. */
    const next = OL_ACTIVE_STAGE_NUMS.slice(1)
      .map((n) => stages.find((s) => s.stage === n))
      .find((s) => s && !s.done);
    if (!next) { res.currentStage = 'Completed — container released'; res.stageClass = 'done'; }
    else { res.currentStage = stageCaption(next.stage); res.stageClass = 'stage'; }
  }

  return res;
}

/* =============================================
   PENDING APPROVAL QUEUE (between Stage 1 and Stage 2)
============================================= */
export async function getOffLeaseApprovalData(user, preFetchedSheetData) {
  await _ensureOffLeaseSheet();
  // Display-only list read — safe to serve from the Mongo mirror (Phase 1b).
  // preFetchedSheetData: see getOffLeaseData's opts.sheetData doc comment —
  // same "read once, share across every stage + approval count" fix.
  const { headers, rows } = preFetchedSheetData || await getSheetDataFromMongo(OL_SHEET);
  if (!rows.length) return { headers: [], data: [], count: 0 };

  const gate = await _offLeaseAccessGate(user);

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

    if (gate && !gate(safeStr(row[5]))) continue;

    const s1Status = row[stage1StatusCol];
    if (!s1Status || String(s1Status).trim().toLowerCase() !== 'completed') continue;

    const apprStatus = row[approvalStatusCol];
    if (apprStatus && String(apprStatus).trim().toLowerCase() !== '') continue;

    const displayRow = displayIndices.map((ci) => (dateCols.has(ci) ? fmtCell(row[ci]) : safeStr(row[ci])));
    finalData.push({ row: displayRow, _rowNum: i + 2 });
  }

  return { headers: displayHeaders, data: finalData, count: finalData.length };
}

export async function saveOffLeaseApprovalAction(containerNo, status, userEmail, remarks = '', knownRow) {
  await checkActionPermission('offleaseapproval', userEmail);

  return withSheetLock(OL_SHEET, async () => {
    if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');
    await _ensureOffLeaseSheet();
    const { headers, rows } = await getSheetData(OL_SHEET);
    const rn = _resolveOlRow(rows, containerNo, knownRow);
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
      /* User-supplied remarks (RejectModal, same shape as Hold's) take
         priority; falls back to the old auto-generated sentence when none
         was given (e.g. the bulk-reject path, which has no per-row prompt). */
      const rmk = safeStr(remarks).trim() || `Rejected on ${fmtDMYHM(new Date())} by ${userEmail || 'unknown'}`;
      updates.push({ range: `'${OL_SHEET}'!${colLetter(remarkCol)}${rn}`, values: [[rmk]] });
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

/**
 * Mongo-first fast path for saveOffLeaseApprovalAction — same design as
 * saveOffLeaseStageFast above. Deliberately does NOT perform the Master
 * workbook sync (_syncOffLeaseRowToMaster) — that's a second live-Sheets
 * side effect on top of OL_SHEET itself, left entirely to the background
 * replay of the original function, which still runs it for real within one
 * outbox poll interval.
 */
export async function saveOffLeaseApprovalActionFast(containerNo, status, userEmail, remarks = '', knownRow) {
  await checkActionPermission('offleaseapproval', userEmail);

  if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');

  const { headers } = await getSheetDataFromMongo(OL_SHEET);
  const docs = await getMongoRowsWithKeys(OL_SHEET);
  const found = _resolveOlMongoDoc(docs, containerNo, knownRow);
  if (!found) throw new AppError(`Not found: ${containerNo}`);

  const statusCol = _findOlColumnMulti(headers, ['intimation approval status', 'intimation appt status', 'approval status']);
  const timestampCol = _findOlColumnMulti(headers, ['intimation approval timestamp', 'intimation appt timestamp']);
  const userCol = _findOlColumnMulti(headers, ['intimation approval user', 'intimation appt user']);
  const remarkCol = _findOlColumnMulti(headers, ['intimation approval remark', 'intimation appt remark', 'approval remark']);

  if (statusCol < 0 || timestampCol < 0 || userCol < 0) {
    throw new AppError('Approval columns not found in sheet. Please check headers.');
  }

  const curStatus = found.row[statusCol];
  if (curStatus && String(curStatus).trim().toLowerCase() !== '') return 'ALREADY_PROCESSED';

  const patch = {
    [`row.${statusCol}`]: status || '',
    [`row.${timestampCol}`]: dmyTime(new Date()),
    [`row.${userCol}`]: userEmail || ''
  };
  if (status && status.toLowerCase() === 'rejected' && remarkCol >= 0) {
    patch[`row.${remarkCol}`] = safeStr(remarks).trim() || `Rejected on ${fmtDMYHM(new Date())} by ${userEmail || 'unknown'}`;
  }

  await getCollection(OL_SHEET).updateOne({ key: found.key }, { $set: { ...patch, updatedAt: new Date() } });
  const resolvedRow = knownRow ?? (parseInt(found.key.replace('row_', ''), 10) + 2);
  await enqueueSheetReplay('offlease.saveOffLeaseApprovalAction', [containerNo, status, userEmail, remarks, resolvedRow], { actor: userEmail });

  return 'OK';
}

/**
 * Reverses a Rejected decision from Stage 1's own Reject tab: clears the
 * Intimation Approval Status/Timestamp/User/Remark columns AND Stage 1's
 * own status column — unlike Hold's Send Back (which only ever touches its
 * own bolt-on columns), this one deliberately also reopens Stage 1 itself,
 * not just the approval decision. A rejection means something about the
 * original intimation needs correcting, so sending it back to a blank
 * approval verdict but a still-"Completed" Stage 1 would only let it be
 * re-approved unchanged — the whole point of Send Back here is to let it be
 * revised and resubmitted. The underlying field VALUES are left exactly as
 * they were (only the status column clears), so reopening the Stage 1 form
 * shows what was there before, ready to edit rather than blank.
 *
 * Permission checked against Stage 1 ('offlease1'), same as Hold — the
 * destination is Stage 1's own pending queue, not the Approval desk.
 */
export async function saveOffLeaseSendRejectedToStage1(containerNo, userEmail, knownRow) {
  await checkActionPermission('offlease1', userEmail);
  return withSheetLock(OL_SHEET, async () => {
    if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');
    await _ensureOffLeaseSheet();
    const { headers, rows } = await getSheetData(OL_SHEET);
    const rn = _resolveOlRow(rows, containerNo, knownRow);
    if (rn === -1) throw new AppError(`Not found: ${containerNo}`);

    const statusCol = _findOlColumnMulti(headers, ['intimation approval status', 'intimation appt status', 'approval status']);
    const timestampCol = _findOlColumnMulti(headers, ['intimation approval timestamp', 'intimation appt timestamp']);
    const userCol = _findOlColumnMulti(headers, ['intimation approval user', 'intimation appt user']);
    const remarkCol = _findOlColumnMulti(headers, ['intimation approval remark', 'intimation appt remark', 'approval remark']);
    if (statusCol < 0) throw new AppError('Approval columns not found in sheet. Please check headers.');

    const row = rows[rn - 2] || [];
    if (String(row[statusCol]).trim().toLowerCase() !== 'rejected') {
      throw new AppError('This record is not rejected — nothing to send back.');
    }

    const stage1StatusCol = OL_STAGE_INFO[1].statusCol;
    const cols = [statusCol, timestampCol, userCol, remarkCol, stage1StatusCol].filter((c) => c >= 0);
    const cellUpdates = cols.map((c) => ({ range: `'${OL_SHEET}'!${colLetter(c)}${rn}`, values: [['']] }));
    await batchUpdateValues(cellUpdates);

    try {
      const patch = {};
      for (const c of cols) patch[`row.${c}`] = '';
      const r = await getCollection(OL_SHEET).updateOne({ key: `row_${rn - 2}` }, { $set: patch });
      if (!r.matchedCount) console.warn(`[OL-REJECT] mirror row_${rn - 2} not found for ${containerNo} — next reconcile will pick it up`);
    } catch (e) {
      console.error('[OL-REJECT] mirror update failed (reconcile will correct):', e?.message || e);
    }

    return 'OK';
  });
}

/** Mongo-first fast path — same trade-off as the other Fast paths in this file. */
export async function saveOffLeaseSendRejectedToStage1Fast(containerNo, userEmail, knownRow) {
  await checkActionPermission('offlease1', userEmail);
  if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');

  const { headers } = await getSheetDataFromMongo(OL_SHEET);
  const docs = await getMongoRowsWithKeys(OL_SHEET);
  const found = _resolveOlMongoDoc(docs, containerNo, knownRow);
  if (!found) throw new AppError(`Not found: ${containerNo}`);

  const statusCol = _findOlColumnMulti(headers, ['intimation approval status', 'intimation appt status', 'approval status']);
  const timestampCol = _findOlColumnMulti(headers, ['intimation approval timestamp', 'intimation appt timestamp']);
  const userCol = _findOlColumnMulti(headers, ['intimation approval user', 'intimation appt user']);
  const remarkCol = _findOlColumnMulti(headers, ['intimation approval remark', 'intimation appt remark', 'approval remark']);
  if (statusCol < 0) throw new AppError('Approval columns not found in sheet. Please check headers.');

  if (String(found.row[statusCol]).trim().toLowerCase() !== 'rejected') {
    throw new AppError('This record is not rejected — nothing to send back.');
  }

  const stage1StatusCol = OL_STAGE_INFO[1].statusCol;
  const cols = [statusCol, timestampCol, userCol, remarkCol, stage1StatusCol].filter((c) => c >= 0);
  const patch = {};
  for (const c of cols) patch[`row.${c}`] = '';

  await getCollection(OL_SHEET).updateOne({ key: found.key }, { $set: { ...patch, updatedAt: new Date() } });
  const resolvedRow = knownRow ?? (parseInt(found.key.replace('row_', ''), 10) + 2);
  await enqueueSheetReplay('offlease.saveOffLeaseSendRejectedToStage1', [containerNo, userEmail, resolvedRow], { actor: userEmail });

  return 'OK';
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
    // Rejected intimation -> leave Master Sheet completely untouched (per
    // explicit request 2026-08-08). Previously this wrote 'Lease' to L/M
    // unconditionally, which could clobber whatever the real current status
    // was if it had changed for an unrelated reason since the intimation
    // was raised. A rejection is a no-op on Master Sheet by design now —
    // only the Off-Lease Tracking row's own status/Marked flag changes.
    await updateCell(OL_SHEET, rn, OL_MARKED_COL_1BASED - 1, 'Marked');
    console.log(`[OL-SYNC] REJECTED -> Master Sheet untouched (by design) | ${container}`);
    return 'OK-REJECT-NOOP';
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

  // sourceRows MUST stay a live read: the write below (statusUpdate.push(i +
  // 2)) reuses each row's position IN THIS SAME ARRAY as the live sheet's row
  // number — a Mongo-sourced row order isn't guaranteed to match the live
  // sheet, and reusing its positions for that write would silently mark the
  // wrong row "Moved" (see [[lms_row_number_write_safety]]).
  const { rows: sourceRows } = await getSheetData(SHEETS.NEW_LEASE, undefined, 'A1:AD');
  if (!sourceRows.length) return;

  /* DUPLICATE GUARD — a contract already present in the Deployed sheet is
     skipped (still marked "Moved" so it doesn't retry every hour). Read-only
     membership check (never a row-number write target) — safe to serve from
     the Mongo mirror, halving this hourly job's live Sheets read footprint. */
  const seen = {};
  const { rows: existingRows } = await getSheetDataFromMongo(SHEETS.DEPLOYED);
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
