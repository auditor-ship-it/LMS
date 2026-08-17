/**
 * OFF-LEASE STAGE 9 — CONTAINER MOVEMENT LOG
 *
 * Stage 9 is deliberately NOT part of the 1..8 pipeline. Stages 1-8 fill a
 * column range on the container's single Off-Lease Tracking row and gate each
 * other in sequence (OL_ACTIVE_STAGE_NUMS); Stage 9 is an append-only journal —
 * one row per physical movement, so the same container can appear many times
 * and nothing is ever overwritten. It therefore lives in its own sheet, has no
 * entry in OL_STAGE_INFO, and does not sit in the workflow order the user set
 * on 2026-08-10 (1 Intimation -> Approval -> 2 Transportation -> 3 Inspection
 * -> 4 Get In -> 5 Billing -> FMS Close). Adding it there would renumber every
 * displayed stage.
 *
 * SOURCE OF PENDING CONTAINERS: "Stage 2" as users see it is INTERNAL stage 6
 * (Transportation, Kshirod Khatua) — internal stage 2 (Lifting / Arrival) was
 * retired and shows to nobody. See MOVEMENT_SOURCE_STAGE below; that constant
 * is the only place to change if the source stage moves.
 *
 * Reads go straight to Sheets rather than the Mongo mirror: this tab is not
 * registered with the reconcile job, and a movement must be visible in the app
 * the instant it lands in the sheet rather than up to 5 minutes later.
 */
import { getSheetData, appendRow, insertSheetIfMissing } from './googleSheets.service.js';
import { SHEETS } from '../config/sheets.config.js';
import { safeStr } from '../utils/format.js';
import { AppError, notFound } from '../utils/AppError.js';
import { withSheetLock } from '../utils/sheetMutex.js';
import { checkActionPermission } from './permissions.service.js';
import { getOffLeaseData } from './offlease.service.js';

const S9_SHEET = SHEETS.STAGE9_MOVEMENT;

/** INTERNAL stage number behind the tab labelled "Stage 2" — Transportation.
 *  Never the display number: display numbers renumber, internal ones don't. */
export const MOVEMENT_SOURCE_STAGE = 6;

export const MOVEMENT_TYPES = ['Offlease', 'Deployment', 'Return', 'Other'];

/** Only Offlease draws its identity fields from the Stage 2 pending list; the
 *  other types describe movements of containers that are not sitting there. */
const AUTOFILL_TYPE = 'Offlease';

/** Sheet column order. Append-only, so appending a column here is safe, but
 *  never reorder or remove one — existing rows are positional. */
export const S9_HEADERS = [
  'Movement Type', 'Container No', 'Client Name', 'Lease ID', 'Size', 'Type',
  'Location', 'Movement Date', 'Remarks', 'Timestamp', 'Entered By'
];

const pad2 = (n) => String(n).padStart(2, '0');

/** "dd/MM/yyyy HH:mm:ss" — same audit stamp saveOffLeaseStage writes. */
function dmyTime(d) {
  return `${safeStr(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * "yyyy-MM-dd" from a date input -> "dd/MM/yyyy" text, parsed from local Y/M/D
 * components. Never `new Date(string)`: that reads as UTC and rolls back a day
 * on a positive-offset server (the DATE-WRITE NOTE in offlease.service.js).
 */
function formDateToDMY(val) {
  const s = String(val ?? '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return s; // already dd/MM/yyyy, or free text — store as given
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? s : safeStr(d);
}

/* --------------------------------------------------------- Stage 2 source */

/** One pending Stage 2 row -> the movement form's field set.
 *
 *  The col_N keys are getOffLeaseData's identity columns, which are fixed
 *  positions on the tracking sheet: 0 Container, 1 Lease ID, 2 Size, 3 Type,
 *  5 Client Name, 6 Location, 7 Deployed, 8 Valid Upto. Column 4 is Client
 *  Code and 9 is Rate — neither belongs on this form. */
function toMovementSource(item) {
  return {
    containerNo: safeStr(item.col_0).trim(),
    leaseId: safeStr(item.col_1).trim(),
    size: safeStr(item.col_2).trim(),
    type: safeStr(item.col_3).trim(),
    clientName: safeStr(item.col_5).trim(),
    location: safeStr(item.col_6).trim(),
    deployedDate: safeStr(item.col_7).trim(),
    validUpto: safeStr(item.col_8).trim()
  };
}

/**
 * Every container currently pending at Stage 2, freshly read each call — the
 * dropdown must never serve a container that has since moved on, and must show
 * one that was added a moment ago.
 */
export async function getMovementSourceContainers() {
  const { data } = await getOffLeaseData(MOVEMENT_SOURCE_STAGE);
  return (data || []).map(toMovementSource).filter((r) => r.containerNo);
}

/**
 * GET /api/offlease/stage2/container/:containerNo — the auto-fill lookup.
 *
 * A container number is not unique on the tracking sheet: the same box can be
 * off-leased by two different clients (TRIU6681671). When both are pending,
 * every match is returned so the caller picks the lease rather than silently
 * getting whichever row came first.
 */
export async function getMovementSourceContainer(containerNo) {
  const wanted = String(containerNo || '').trim().toUpperCase();
  if (!wanted) throw new AppError('Container number is required');

  const matches = (await getMovementSourceContainers())
    .filter((r) => r.containerNo.toUpperCase() === wanted);

  if (!matches.length) throw notFound(`${wanted} is not pending at Stage 2`);
  if (matches.length > 1) return { ...matches[0], multiple: true, matches };
  return matches[0];
}

/* --------------------------------------------------------- Movement log */

/* The Sheets API answers a request against a tab that does not exist with
   "Unable to parse range". That is the cheap way to discover the sheet is
   missing: creating it eagerly would cost a full spreadsheets.get on every
   read AND every save, and this project already exhausts the per-minute read
   quota (see the retry/backoff in googleSheets.service.js). */
const isMissingSheet = (e) => String(e?.message || '').includes('Unable to parse range');

/** Existing movements, newest first. Empty (not an error) before the sheet
 *  has been created — nothing has been logged yet. */
export async function getStage9Movements() {
  let rows = [];
  try {
    ({ rows } = await getSheetData(S9_SHEET));
  } catch (e) {
    if (isMissingSheet(e)) return { headers: S9_HEADERS, data: [] };
    throw e;
  }

  const data = rows
    .map((r, i) => ({ row: S9_HEADERS.map((_, c) => safeStr(r[c])), _rowNum: i + 2 }))
    .filter((r) => r.row.some((v) => v !== ''))
    .reverse();

  return { headers: S9_HEADERS, data };
}

/**
 * Every movement logged for one container, newest first, as objects rather
 * than positional rows — this feeds the container history screen, which needs
 * to name the fields.
 *
 * Matched on container number ALONE, deliberately: a movement is a physical
 * event for the box, so the history should show every one of them even when
 * the container has been off-leased under more than one lease.
 */
export async function getMovementsForContainer(containerNo) {
  const wanted = String(containerNo || '').trim().toUpperCase();
  if (!wanted) return [];

  const { data } = await getStage9Movements();
  return data
    .filter((r) => safeStr(r.row[1]).trim().toUpperCase() === wanted)
    .map((r) => ({
      movementType: r.row[0],
      containerNo: r.row[1],
      clientName: r.row[2],
      leaseId: r.row[3],
      size: r.row[4],
      type: r.row[5],
      location: r.row[6],
      movementDate: r.row[7],
      remarks: r.row[8],
      timestamp: r.row[9],
      enteredBy: r.row[10]
    }));
}

/**
 * Appends one movement. For Offlease the identity fields are re-derived from
 * Stage 2 server-side and whatever the client sent is discarded — the same
 * rule Stage 1 applies to Lease ID. The form shows them read-only, so a
 * mismatch means tampering or a stale tab, and the sheet should record what
 * Stage 2 actually says.
 */
export async function saveStage9Movement(payload = {}, userEmail) {
  await checkActionPermission('offlease9', userEmail);

  const movementType = safeStr(payload.movementType).trim();
  if (!movementType) throw new AppError('Movement Type is required');
  if (!MOVEMENT_TYPES.includes(movementType)) {
    throw new AppError(`Movement Type must be one of: ${MOVEMENT_TYPES.join(', ')}`);
  }

  const containerNo = safeStr(payload.containerNo).trim().toUpperCase();
  if (!containerNo) throw new AppError('Container No is required');

  let fields = {
    clientName: safeStr(payload.clientName).trim(),
    leaseId: safeStr(payload.leaseId).trim(),
    size: safeStr(payload.size).trim(),
    type: safeStr(payload.type).trim(),
    location: safeStr(payload.location).trim()
  };

  if (movementType === AUTOFILL_TYPE) {
    /* Throws 404 when the container is not pending at Stage 2, which is the
       correct answer: an Offlease movement is only meaningful for a container
       Stage 2 is actually holding. */
    const src = await getMovementSourceContainer(containerNo);
    const chosen = src.multiple && fields.leaseId
      ? (src.matches.find((m) => m.leaseId === fields.leaseId) || src)
      : src;
    fields = {
      clientName: chosen.clientName,
      leaseId: chosen.leaseId,
      size: chosen.size,
      type: chosen.type,
      location: chosen.location
    };
  }

  const row = [
    movementType,
    containerNo,
    fields.clientName,
    fields.leaseId,
    fields.size,
    fields.type,
    fields.location,
    formDateToDMY(payload.movementDate),
    safeStr(payload.remarks).trim(),
    dmyTime(new Date()),
    userEmail || ''
  ];

  return withSheetLock(S9_SHEET, async () => {
    /* Append first, create only on failure. The steady-state cost of a save is
       then one write and ZERO reads; calling insertSheetIfMissing up front
       spent a spreadsheets.get per save and was enough on its own to trip the
       read quota during testing. */
    try {
      const { rowNum } = await appendRow(S9_SHEET, row);
      return { message: 'SAVED', rowNum, movement: row };
    } catch (e) {
      if (!isMissingSheet(e)) throw e;
      await insertSheetIfMissing(S9_SHEET, S9_HEADERS);
      const { rowNum } = await appendRow(S9_SHEET, row);
      return { message: 'SAVED', rowNum, movement: row };
    }
  });
}
