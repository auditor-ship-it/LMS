/**
 * PO & Agreement Tracker — historical period backfill. Explicit request
 * 2026-11-04 ("this is many gap the sytem po and agremnet one create the
 * one form and gap data file backdata filed and all po and agremnet...
 * container and client... start date and end dat and upload"): the
 * Tracker's own coverage grid (dashboard.service.js's
 * getPoAgreementTrackerData, PoAgreementTrackerPage.jsx's
 * resolveCoverageRange) only ever reads ONE current Agreement date and ONE
 * current PO date per container — there is nowhere in that data path to
 * represent "PO ran Mar-Jun 2024, then a new PO ran Jul-Dec 2024", so every
 * period before the current one is structurally invisible, producing the
 * unchecked gaps on screen. This is a NEW, dedicated store for exactly
 * those past periods — add-only, confirmed directly: "One-way log, no
 * edit/delete... a mistake means adding a correcting entry, not editing
 * the wrong one".
 *
 * REWORKED 2026-11-04, TWICE the same day:
 *   1st: originally built Mongo-only (no Sheet backing). The user then
 *      showed a tab they had ALREADY created by hand in the live workbook
 *      — "Master Po and Agremnet data" (SHEETS.PO_AGREEMENT_HISTORY), with
 *      its own exact columns — and asked for both the sheet AND Mongo to
 *      be written. Rebuilt as a live-Sheets-write-first + Mongo-mirror,
 *      matching refunds.service.js's own addRefundEntry.
 *   2nd: that live-Sheets-first version let a slow/failing live Sheets
 *      call (the same shared-quota issue documented throughout this
 *      codebase — see googleSheets.service.js's withQuotaRetry) block the
 *      WHOLE save, including the Mongo write — confirmed live: the user
 *      submitted a real entry, the header row updated (proof the request
 *      reached the backend) but NO data row ever appeared anywhere.
 *      Explicit follow-up ("data store firsst mango then sheet read and
 *      write the mango"): rebuilt MONGO-FIRST, same established pattern
 *      this codebase already uses everywhere else for exactly this reason
 *      (outbox.service.js's own header comment: "every write action
 *      responds the instant its Mongo write lands; the matching Google
 *      Sheets write happens afterward, in the background, via the outbox
 *      worker"). addPoAgreementHistoryEntry below is now the FAST path —
 *      it writes Mongo only and enqueues the real Sheets write;
 *      writeHistoryRowToSheet is the REPLAY target the outbox worker
 *      calls later (registered in jobs/outboxRegistry.js) — it writes
 *      ONLY to the live sheet, never touching Mongo again, so the two
 *      writes can never double up into duplicate rows.
 *
 * Column order (fixed — matches the live tab's own header row exactly,
 * typo included): Timestamp | Container no | Client name |
 * Agremnet and Po | start date | end date | file | Emails | PO No.
 */
import { appendRow, insertSheetIfMissing, getSheetData, updateRange, colLetter, ensureColumnCount } from './googleSheets.service.js';
import { getSheetDataFromMongo, appendMongoMirrorRow } from './mongoSheetData.service.js';
import { enqueueSheetReplay } from './outbox.service.js';
import { SHEETS } from '../config/sheets.config.js';
import { safeStr, dmyTime } from '../utils/format.js';
import { AppError } from '../utils/AppError.js';
import { withSheetLock } from '../utils/sheetMutex.js';

const SHEET = SHEETS.PO_AGREEMENT_HISTORY;
export const PO_AGREEMENT_HISTORY_TYPES = ['PO', 'Agreement'];
// 'PO No' (index 8) added 2026-11-04, same day — explicit follow-up
// ("click the po one opnrthe po no" — "when [Type is] PO, open [show] the
// PO No [field]"): the live sheet only had 8 columns when the user first
// made it; this is appended as a 9th, auto-extending the live header row
// the same way _ensureRefundsHeaderWidth already does for Offlease Bills —
// never rewriting the tab's own existing columns.
const HEADERS = ['Timestamp', 'Container no', 'Client name', 'Agremnet and Po', 'start date', 'end date', 'file', 'Emails', 'PO No'];

// Same detection refunds.service.js's own addRefundEntry uses for "the
// sheet doesn't exist yet" vs. a genuine error worth rethrowing.
const isMissingSheet = (e) => String(e?.message || '').includes('Unable to parse range');

let headerWidthChecked = false;
/** Extends the live sheet's header row to match HEADERS above if it's
 *  still short (e.g. the user's own hand-made tab only had 8 columns before
 *  'PO No' was added here) — same pattern refunds.service.js's own
 *  _ensureRefundsHeaderWidth uses, checked once per process. */
async function _ensureHistoryHeaderWidth() {
  if (headerWidthChecked) return;
  headerWidthChecked = true;
  const { headers } = await getSheetData(SHEET).catch(() => ({ headers: [] }));
  if (!headers.length) return; // sheet doesn't exist yet — insertSheetIfMissing (on first append) handles that case
  if (headers.length >= HEADERS.length) return;
  const startCol = headers.length;
  const missing = HEADERS.slice(startCol);
  await ensureColumnCount(SHEET, HEADERS.length);
  await updateRange(SHEET, `${colLetter(startCol)}1:${colLetter(HEADERS.length - 1)}1`, [missing]);
}

/** One backfilled period — MONGO-FIRST (the fast path real callers use; see
 *  this file's own header comment for why). Validates, builds the row,
 *  writes it straight into the Mongo mirror (appendMongoMirrorRow assigns
 *  its own synthetic row_N key independent of the live sheet — it does not
 *  need a real sheet row number to exist first), then enqueues the actual
 *  live-sheet write via the outbox so the response never waits on it. */
export async function addPoAgreementHistoryEntry({ containerNo, leaseId, clientName, type, startDate, endDate, fileUrl, enteredBy, poNo }) {
  const container = safeStr(containerNo).trim().toUpperCase();
  if (!container) throw new AppError('Container is required');
  if (!PO_AGREEMENT_HISTORY_TYPES.includes(type)) throw new AppError('Type must be PO or Agreement');
  if (!startDate || !endDate) throw new AppError('Start date and end date are required');
  if (new Date(startDate) > new Date(endDate)) throw new AppError('Start date must be before end date');

  const row = [
    dmyTime(new Date()),
    container,
    safeStr(clientName).trim(),
    type,
    safeStr(startDate).trim(),
    safeStr(endDate).trim(),
    safeStr(fileUrl).trim(),
    safeStr(enteredBy).trim(),
    safeStr(poNo).trim()
  ];

  await appendMongoMirrorRow(SHEET, row);
  await enqueueSheetReplay('poAgreementHistory.writeRowToSheet', [row], { actor: row[7] || null });

  return {
    containerNo: container,
    leaseId: safeStr(leaseId).trim(),
    clientName: row[2],
    type,
    startDate: row[4],
    endDate: row[5],
    fileUrl: row[6],
    enteredBy: row[7],
    poNo: row[8],
    timestamp: row[0]
  };
}

/** The outbox replay target (registered in jobs/outboxRegistry.js as
 *  'poAgreementHistory.writeRowToSheet') — writes ONE already-Mongo-saved
 *  row to the live sheet. Never touches Mongo itself (that already
 *  happened in addPoAgreementHistoryEntry above) — calling both from the
 *  same save would insert the SAME logical entry into Mongo twice, since
 *  appendMongoMirrorRow always creates a new document rather than updating
 *  one. Append-first, create-the-sheet-only-on-failure — same reasoning
 *  refunds.service.js's own addRefundEntry gives for that order. */
export async function writeHistoryRowToSheet(row) {
  await _ensureHistoryHeaderWidth();
  return withSheetLock(SHEET, async () => {
    try {
      await appendRow(SHEET, row);
    } catch (e) {
      if (!isMissingSheet(e)) throw e;
      await insertSheetIfMissing(SHEET, HEADERS);
      await appendRow(SHEET, row);
    }
  });
}

/** Every backfilled period for every container, grouped by container number
 *  — the shape getPoAgreementTrackerData needs to attach onto each row it
 *  already builds. Container-keyed (not container+lease) because the
 *  Tracker's own coverage grid is drawn per CONTAINER, same scope its
 *  existing agreementDate/poDate fields already use. Read from the Mongo
 *  mirror (fast, cached), same as every other hot-read list in this app —
 *  the live sheet write above keeps it in sync within the normal
 *  reconcile cadence, same as any other tab. */
export async function getPoAgreementHistoryByContainer() {
  const { rows } = await getSheetDataFromMongo(SHEET);
  const byContainer = new Map();
  for (const r of rows) {
    const key = safeStr(r[1]).trim().toUpperCase();
    if (!key) continue;
    if (!byContainer.has(key)) byContainer.set(key, []);
    byContainer.get(key).push({
      clientName: safeStr(r[2]),
      type: safeStr(r[3]),
      startDate: safeStr(r[4]),
      endDate: safeStr(r[5]),
      fileUrl: safeStr(r[6]),
      enteredBy: safeStr(r[7]),
      poNo: safeStr(r[8]),
      timestamp: safeStr(r[0])
    });
  }
  return byContainer;
}
