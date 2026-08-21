/**
 * Port of LMS.js lines 1358-1489 (Lease Expiry / Renewal "Documents" stage)
 * plus completeDocStage (LMS.js lines 5892-5985), which is the "Complete
 * Document Stage" action of the full lease-renewal workflow and belongs to
 * this same domain.
 *
 * Functions ported here:
 *   getExpiryDataByFilter, uploadAndSaveDeployedDocument, completeDocumentStage,
 *   saveExpiryAction, completeDocStage.
 *
 * DEPENDENCY NOTE: getExpiryDataByFilter calls _expiryOrderNoMap() (LMS.js
 * line 1025, just above this file's assigned range) and completeDocStage
 * calls _deployedClientName() (LMS.js line 681, well before this file's
 * assigned range). Those helpers are ported here too (faithfully, from the
 * original bodies) purely as dependencies so the in-range functions behave
 * identically — they were not otherwise assigned to this porting pass. If
 * another agent also ports the ranges that originally own them,
 * reconcile/dedupe against this copy.
 *
 * SHEETS-FIRST (reverted 2026-08-21). saveExpiryAction / completeDocStage
 * were briefly converted to the Mongo-first writeThrough pattern the same
 * day, then reverted at the user's explicit request: manual edits made
 * directly in the spreadsheet need to be visible to every reader
 * immediately, not after the next 5-minute reconcile cycle, so Sheets is
 * the read/write source of truth app-wide again and Mongo is kept as a
 * best-effort backup mirror via patchMongoMirrorRow.
 *
 * _normKey / _splitContainers: billing.service.js (the Collections domain)
 * normally owns these, but this standalone backend doesn't have that file —
 * they're just re-exports of utils/normalize.js's normKey/splitContainers
 * there, so import directly from normalize.js instead.
 */
import {
  getSheetData,
  getRange,
  updateCell,
  updateRange,
  batchUpdateValues,
  appendRow,
  insertSheetIfMissing,
  colLetter
} from './googleSheets.service.js';
import { patchMongoMirrorRow } from './mongoSheetData.service.js';
import { uploadToDrive, extractFileId, deleteFromDrive } from './googleDrive.service.js';
import { safeStr, buildDisplayRow, parseDate, formatDateVal, dmyTime } from '../utils/format.js';
import { withSheetLock } from '../utils/sheetMutex.js';
import { checkActionPermission } from './permissions.service.js';
import { AppError, notFound } from '../utils/AppError.js';
import { SHEETS } from '../config/sheets.config.js';
import { cacheGet, cachePut } from '../utils/memoryCache.js';
import { normKey as _normKey, splitContainers as _splitContainers } from '../utils/normalize.js';
import { salePersonScopeFor, matchesSalePersonScope } from './salePersonAccess.service.js';
import { getSalePersonResolver } from './salesCrmLeads.service.js';

/* =============================================
   getExpiryDataByFilter — LMS.js 1358-1406
============================================= */

/** Pads a row (or header row) to exactly `len` cells — Sheets API trims
 * trailing blank cells per-row, but the original Apps Script getValues()
 * range reads always return a fixed width. */
function padRow(row, len) {
  const out = row ? row.slice(0, len) : [];
  while (out.length < len) out.push('');
  return out;
}

/** First column whose header exactly matches one of `names` (case/space
 *  insensitive), or -1. Located by header rather than hardcoded index: this
 *  sheet has had columns inserted/removed by hand before (see the Off-Lease
 *  Tracking drift elsewhere in this codebase), and a positional read would
 *  silently use the wrong column instead of failing loudly. */
function findHeaderCol(headers, ...names) {
  for (let h = 0; h < headers.length; h++) {
    const hd = String(headers[h] || '').trim().toLowerCase();
    if (names.includes(hd)) return h;
  }
  return -1;
}

/**
 * Container -> Order No map (LMS.js line 1025, _expiryOrderNoMap).
 * Ported here as a dependency of getExpiryDataByFilter — see file header note.
 */
const EXPIRY_ORDER_SOURCES = [SHEETS.OPERATION, SHEETS.NEW_LEASE]; // priority order
const EXPIRY_ORDMAP_CACHE_KEY = 'expiry_ordmap_v1';
const EXPIRY_ORDMAP_TTL_SECS = 300;

export async function _expiryOrderNoMap() {
  const hit = cacheGet(EXPIRY_ORDMAP_CACHE_KEY);
  if (hit) return JSON.parse(hit);

  const map = {};
  for (const sheetName of EXPIRY_ORDER_SOURCES) {
    try {
      const { headers, rows } = await getSheetData(sheetName);
      if (!rows.length) continue;
      let ordCol = 3; // fallback: col D
      for (let h = 0; h < headers.length; h++) {
        const hd = String(headers[h] || '').trim().toLowerCase();
        if (hd.indexOf('order') !== -1 && hd.indexOf('no') !== -1) { ordCol = h; break; }
      }
      for (const row of rows) {
        const o = safeStr(row[ordCol]).trim();
        if (!o) continue;
        const parts = _splitContainers(row[0]);
        for (const part of parts) {
          const k = _normKey(part);
          if (k && !map[k]) map[k] = o; // first non-blank wins -> Operation sheet takes priority
        }
      }
    } catch (e) { /* never break the expiry screen */ }
  }
  try { cachePut(EXPIRY_ORDMAP_CACHE_KEY, JSON.stringify(map), EXPIRY_ORDMAP_TTL_SECS); } catch (e) { /* best-effort cache */ }
  return map;
}

export async function getExpiryDataByFilter(filterType, user) {
  const { values } = await getSheetData(SHEETS.DEPLOYED);
  if (values.length < 2) return { headers: [], data: [], validColIdx: -1 };

  const allHeaders = padRow(values[0], 26);
  const allRows = values.slice(1).map((r) => padRow(r, 26));

  let colIdx = -1;
  for (let h = 0; h <= 14; h++) {
    if (allHeaders[h] && String(allHeaders[h]).toLowerCase().indexOf('valid') !== -1) { colIdx = h; break; }
  }
  if (colIdx === -1) return { headers: allHeaders.slice(0, 15), data: [], validColIdx: -1 };

  /* USER-WISE VISIBILITY. `user` is req.user — the identity requireAuth
   * resolved from the bearer token, never a frontend-supplied name/email/id.
   * A scoped caller (see salePersonAccess.service.js) only ever gets rows
   * whose "Sale Person" cell is theirs; everyone else (admins, and anyone
   * with no mapped Sale Person identity) is unaffected — same list as before
   * this feature existed.
   *
   * Located by header, not hardcoded to its current index 9 — see
   * findHeaderCol above. */
  const salePersonScope = salePersonScopeFor(user);
  const salePersonCol = findHeaderCol(allHeaders, 'sale person');
  if (salePersonScope && salePersonCol === -1) {
    /* The column could not be located — fail CLOSED (show nothing) rather
       than fail open (show everyone's records) for a scoped user. This is a
       confidentiality feature: an empty list reads as a bug to report, which
       is the safe failure; a leaked list is not. Unscoped callers (the
       overwhelming majority) are entirely unaffected by this branch. */
    console.error('[EXPIRY-ACCESS] "Sale Person" column not found — showing nothing to a scoped user rather than everyone.');
    return { headers: allHeaders.slice(0, 15), data: [], validColIdx: (colIdx >= 1 ? colIdx + 1 : colIdx) };
  }

  /* ★ LIVE SALE PERSON. The sheet's own "Sale Person" cell is a stale copy —
     when an admin reassigns a company to another salesperson, that happens in
     the Sales CRM and the sheet is never updated. Resolve each row's owner
     from the CRM's existing_leads collection instead, keyed by Customer Name
     (salesCrmLeads.service.js — READ-ONLY; this app never reassigns anyone).
     A company the CRM doesn't know keeps the sheet value, so the column can
     never go blank, and a CRM outage degrades to exactly today's behaviour. */
  const customerCol = findHeaderCol(allHeaders, 'customer name', 'client name');
  const resolveSalePerson = await getSalePersonResolver();
  const liveSalePerson = (row) => {
    if (salePersonCol === -1) return '';
    const sheetValue = safeStr(row[salePersonCol]);
    if (customerCol === -1) return sheetValue;
    return resolveSalePerson(row[customerCol]) || sheetValue;
  };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const ordMap = await _expiryOrderNoMap(); // ★ Order No joined by container

  const finalData = [];
  for (const row of allRows) {
    if (!row[0] || String(row[0]).trim() === '') continue;
    const vVal = row[21], wVal = row[22];

    /* A container marked Off-Lease has LEFT this stage — it belongs to the
       Off-Lease pipeline now and must not appear here under any filter.
       The 'pending' test below only asks whether the Update cell is empty,
       so a row whose Status said Off-Lease still showed up whenever that
       cell had not been stamped. Status is the authority on which stage a
       container is in; Update is just when it last changed. */
    if (String(wVal || '').trim().toLowerCase().replace(/[\s-]/g, '') === 'offlease') continue;

    let include = false;
    // 'pending' is Lease Expiry's own list, not a to-do queue that empties as
    // rows get actioned — a container mid-renewal can still need renewing
    // again later, so it stays visible here permanently (Off-Lease above is
    // the only real exit). Renewed/Documents Pending rows carry actionStatus
    // below so the frontend can show that in progress instead of hiding it.
    if (filterType === 'pending') include = true;
    else if (filterType === 'renewed') include = (wVal && String(wVal).trim().toLowerCase() === 'renewed');
    else if (filterType === 'documents') include = (wVal && String(wVal).trim().toLowerCase() === 'documents pending');
    // off-lease stages removed
    if (!include) continue;

    /* Filter on the SAME value the row will display. Filtering on the stale
       sheet cell while showing the live CRM name would hand a scoped user
       rows visibly labelled with someone else's name (and hide rows that had
       just been reassigned TO them). */
    const salePerson = liveSalePerson(row);
    if (salePersonScope && !matchesSalePersonScope(salePerson, salePersonScope)) continue;

    const expRaw = row[colIdx];
    const expDate = parseDate(expRaw); // Sheets API returns formatted strings, not Date objects — see format.js
    let days = '';
    if (expDate) days = Math.ceil((expDate - today) / 86400000);
    let band = '';
    if (typeof days === 'number') {
      if (days < 0) band = 'overdue';
      else if (days <= 7) band = 'critical';
      else if (days <= 30) band = 'warning';
      else band = 'safe';
    }

    /* Substitute the resolved owner on a COPY — the untouched `row` is what
       the Update/Status/PO/agreement reads below still use, and nothing here
       is ever written back to the sheet or to either database. */
    const displaySrc = row.slice();
    if (salePersonCol !== -1) displaySrc[salePersonCol] = salePerson;
    const displayRow = buildDisplayRow(displaySrc, 15, allHeaders);
    /* ★ Order No as the 2nd column (joined from New Lease by container) */
    displayRow.splice(1, 0, ordMap[_normKey(row[0])] || '');
    if (filterType === 'renewed' || filterType === 'offlease') {
      displayRow.push(safeStr(vVal));
      displayRow.push(safeStr(wVal));
    }
    const item = { row: displayRow, daysLeft: days, band, actionDate: safeStr(vVal), actionStatus: safeStr(wVal) };
    if (filterType === 'documents') {
      item.poUrl = safeStr(row[24]);
      item.agrUrl = safeStr(row[25]);
    }
    finalData.push(item);
  }

  const displayHeaders = allHeaders.slice(0, 15);
  displayHeaders.splice(1, 0, 'Order No'); /* ★ matches the row splice above */
  if (filterType === 'renewed' || filterType === 'offlease') displayHeaders.push('Action Date', 'Status');

  /* ★ every column from index 1 shifted right by one, so the "Valid Upto"
     highlight index must shift too. */
  return { headers: displayHeaders, data: finalData, validColIdx: (colIdx >= 1 ? colIdx + 1 : colIdx) };
}

/* =============================================
   uploadAndSaveDeployedDocument — LMS.js 1408-1439
   (extractFileId(url) itself is NOT re-defined here — the shared,
   already-ported googleDrive.service.js version is used instead, per the
   porting instructions.)
============================================= */
export async function uploadAndSaveDeployedDocument(base64Data, mimeType, fileName, containerNo, docType, callerEmail) {
  await checkActionPermission('document', callerEmail);
  let url = '';
  try {
    url = await uploadToDrive(base64Data, mimeType, fileName);
    const result = await withSheetLock(SHEETS.DEPLOYED, async () => {
      const rows = await getRange(SHEETS.DEPLOYED, 'A2:A');
      if (!rows.length) throw new AppError('No data rows');
      let targetRow = -1;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i][0] == containerNo) { targetRow = i + 2; break; } // eslint-disable-line eqeqeq
      }
      if (targetRow === -1) throw notFound(`Not found: ${containerNo}`);
      const col0 = String(docType || '').trim().toLowerCase() === 'po' ? 24 : 25; // Y=24, Z=25 (0-based)
      await updateCell(SHEETS.DEPLOYED, targetRow, col0, url || '');
      await patchMongoMirrorRow(SHEETS.DEPLOYED, targetRow, [
        { range: `'${SHEETS.DEPLOYED}'!${colLetter(col0)}${targetRow}`, values: [[url || '']] }
      ]);
      return { success: true, url, savedTo: col0 === 24 ? 'Y' : 'Z' };
    });
    return result;
  } catch (e) {
    if (url) {
      try { const fid = extractFileId(url); if (fid) await deleteFromDrive(fid); } catch (ignore) { /* best-effort cleanup */ }
    }
    throw e;
  }
}

/* =============================================
   completeDocumentStage — LMS.js 1441-1465
============================================= */
export async function completeDocumentStage(containerNo, callerEmail) {
  await checkActionPermission('document', callerEmail);
  return withSheetLock(SHEETS.DEPLOYED, async () => {
    if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');
    const { rows } = await getSheetData(SHEETS.DEPLOYED, undefined, 'A2:Z');
    if (!rows.length) throw new AppError('No data rows');

    let targetRow = -1, matched = null;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] == containerNo) { // eslint-disable-line eqeqeq
        if (String(rows[i][22] || '').trim().toLowerCase() !== 'documents pending') return 'INVALID_STATE';
        targetRow = i + 2;
        matched = rows[i];
        break;
      }
    }
    if (targetRow === -1) throw notFound(`Not found: ${containerNo}`);
    // Either a PO reference or a signed Agreement copy is enough to move
    // forward — not all containers renew on an Agreement basis, some are
    // PO-only, so requiring BOTH blocked a real, legitimate renewal path.
    // Fixed 2026-08-20.
    if ((!matched[24] || String(matched[24]).trim() === '') && (!matched[25] || String(matched[25]).trim() === '')) {
      return 'MISSING_PO_OR_AGR';
    }

    const updates = [
      { range: `'${SHEETS.DEPLOYED}'!V${targetRow}`, values: [['']] },
      { range: `'${SHEETS.DEPLOYED}'!W${targetRow}`, values: [['']] }
    ];
    await batchUpdateValues(updates);
    await patchMongoMirrorRow(SHEETS.DEPLOYED, targetRow, updates);
    return 'OK';
  });
}

/* =============================================
   saveExpiryAction — LMS.js 1467-1489

   SHEETS-FIRST (reverted 2026-08-21 — see roles.service.js's identical note
   for why: manual edits made directly in the spreadsheet must be visible
   the moment anyone reads it, not up to 5 minutes later. Live Sheets is the
   source of truth for both reads and writes across the app now; the Mongo
   mirror is kept in step as a backup copy via patchMongoMirrorRow, updated
   from the SAME {range,values} array already sent to Sheets so it can't
   drift, but nothing in the app depends on Mongo containing the truth. */
export async function saveExpiryAction(rowId, timestamp, status, callerEmail) {
  await checkActionPermission('expiry', callerEmail);
  return withSheetLock(SHEETS.DEPLOYED, async () => {
    if (!rowId || String(rowId).trim() === '') throw new AppError('Container number is required');

    const { rows } = await getSheetData(SHEETS.DEPLOYED);
    if (!rows.length) throw new AppError('No data rows');

    let targetRow = -1;
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0]) == rowId) { targetRow = i + 2; break; } // eslint-disable-line eqeqeq
    }
    if (targetRow === -1) throw notFound(`Not found: ${rowId}`);
    if (rows[targetRow - 2][21] && String(rows[targetRow - 2][21]).trim() !== '') return 'ALREADY_PROCESSED';

    const dmy = dmyTime(new Date(timestamp));
    const updates = [
      { range: `'${SHEETS.DEPLOYED}'!V${targetRow}`, values: [[dmy]] },
      { range: `'${SHEETS.DEPLOYED}'!W${targetRow}`, values: [[status || '']] }
    ];
    await batchUpdateValues(updates);
    // Best-effort backup mirror — a failure here must never fail a write
    // that already succeeded on the sheet; the next reconcile cycle
    // catches up regardless.
    await patchMongoMirrorRow(SHEETS.DEPLOYED, targetRow, updates);
    return 'OK';
  });
}

/* =============================================
   completeDocStage — LMS.js 5892-5985 (renewal-log dependencies also ported
   here: _deployedClientName @681, _logRenewal @701 — see file header note)
============================================= */
const RENEWAL_LOG_SHEET = SHEETS.RENEWAL_LOG;
const RENEWAL_LOG_HEADERS = ['Timestamp', 'Container No', 'Client Name', 'PO No', 'PO File', 'Agreement File', 'Valid Till', 'Updated By', 'Old PO No', 'Old PO File', 'Old Agreement File'];

function _deployedClientName(headers, row) {
  try {
    for (let h = 0; h < headers.length; h++) {
      const hd = String(headers[h] || '').trim().toLowerCase();
      if ((hd.indexOf('client') !== -1 || hd.indexOf('customer') !== -1) && hd.indexOf('name') !== -1) {
        return safeStr(row[h]);
      }
    }
  } catch (e) { /* ignore */ }
  return '';
}

/**
 * The Renewal Log as report rows — one per renewal, newest first.
 */
export async function getRenewalLogReport() {
  let rows = [];
  try {
    ({ rows } = await getSheetData(RENEWAL_LOG_SHEET));
  } catch (e) {
    return { headers: RENEWAL_LOG_HEADERS, data: [], error: e?.message || 'Could not read Renewal Log' };
  }

  const data = rows
    .filter((r) => safeStr(r[1]).trim() !== '')     // must have a container
    .map((r) => ({
      timestamp: safeStr(r[0]).trim(),
      container: safeStr(r[1]).trim(),
      clientName: safeStr(r[2]).trim(),
      poNo: safeStr(r[3]).trim(),
      poFile: safeStr(r[4]).trim(),
      agreementFile: safeStr(r[5]).trim(),
      validTill: safeStr(r[6]).trim(),
      updatedBy: safeStr(r[7]).trim(),
      oldPoNo: safeStr(r[8]).trim(),
      oldPoFile: safeStr(r[9]).trim(),
      oldAgreementFile: safeStr(r[10]).trim()
    }))
    .reverse();                                     // newest first

  return { headers: RENEWAL_LOG_HEADERS, data, count: data.length };
}

/**
 * New Lease rows for the month-wise report.
 *
 * Grouped downstream by Deployed Date — when the container actually went out —
 * rather than the approval timestamp, which records when paperwork cleared and
 * can fall in a different month from the deployment it describes.
 *
 * Column positions are fixed on this sheet.
 */
export async function getNewLeaseReport() {
  const NL = {
    CONTAINER: 0, CLIENT_CODE: 1, CLIENT_NAME: 2, ORDER_NO: 3, ORDER_TYPE: 4,
    QTY: 5, SALE_EXEC: 8, LOCATION: 9, SIZE: 10, PRODUCT_TYPE: 11, DEPLOYED_DATE: 12
  };

  let rows = [];
  try {
    ({ rows } = await getSheetData(SHEETS.NEW_LEASE));
  } catch (e) {
    return { data: [], error: e?.message || 'Could not read New Lease' };
  }

  const data = rows
    .filter((r) => safeStr(r[NL.CONTAINER]).trim() !== '')
    .map((r) => ({
      container: safeStr(r[NL.CONTAINER]).trim(),
      clientCode: safeStr(r[NL.CLIENT_CODE]).trim(),
      clientName: safeStr(r[NL.CLIENT_NAME]).trim(),
      orderNo: safeStr(r[NL.ORDER_NO]).trim(),
      orderType: safeStr(r[NL.ORDER_TYPE]).trim(),
      qty: safeStr(r[NL.QTY]).trim(),
      saleExec: safeStr(r[NL.SALE_EXEC]).trim(),
      location: safeStr(r[NL.LOCATION]).trim(),
      size: safeStr(r[NL.SIZE]).trim(),
      productType: safeStr(r[NL.PRODUCT_TYPE]).trim(),
      deployedDate: fmtCellDate(r[NL.DEPLOYED_DATE])
    }));

  return { data, count: data.length };
}

/** Deployed Date arrives as a Date, a Sheets serial or an already-formatted
 *  string depending on the row — normalised so the month grouping sees one
 *  shape. */
function fmtCellDate(v) {
  const d = parseDate(v);
  return d ? formatDateVal(d) : safeStr(v).trim();
}

export async function completeDocStage(containerNo, renewedDate, validTill, signedCopyUrl, remarks, userEmail, poNo, poFileUrl, billingCycle, callerEmail, poValidity) {
  await checkActionPermission('renew', callerEmail);
  return withSheetLock(SHEETS.DEPLOYED, async () => {
    if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');
    if (!renewedDate) throw new AppError('Renewed Date is required');
    if (!validTill) throw new AppError('Valid Till Date is required');

    const { headers, rows } = await getSheetData(SHEETS.DEPLOYED);
    if (!rows.length) throw new AppError('No data rows');

    /* Ensure new columns AA(27)-AD(30) exist */
    let hdrs0 = headers.slice();
    const lastCol = hdrs0.length; // approximates sheet.getLastColumn()
    const newCols = { 27: 'Renewed Date', 28: 'Valid Till Date', 29: 'Signed Copy URL', 30: 'Remarks' };
    if (lastCol < 30) {
      const t = [];
      for (let c = lastCol + 1; c <= 30; c++) t.push(newCols[c] || '');
      if (t.length > 0) {
        await updateRange(SHEETS.DEPLOYED, `${colLetter(lastCol)}1:${colLetter(29)}1`, [t]);
        hdrs0 = hdrs0.concat(t);
      }
    }

    /* ★ Find the REAL "Agreement PDF" / "PO" / "PO PDF" / Billing Cycle columns
       by header name (never hard-code a position — it shifts). */
    let agrCol = -1, poCol = -1, poPdfCol = -1, cycleCol = -1, poValidityCol = -1;
    for (let h = 0; h < hdrs0.length; h++) {
      const hd = String(hdrs0[h] || '').trim().toLowerCase();
      if (agrCol < 0 && hd.indexOf('agreement') !== -1 && hd.indexOf('valid') === -1 &&
        (hd.indexOf('pdf') !== -1 || hd.indexOf('file') !== -1 || hd.indexOf('copy') !== -1 || hd.indexOf('doc') !== -1)) agrCol = h;
      if (poPdfCol < 0 && hd.indexOf('po') !== -1 && hd.indexOf('pdf') !== -1) poPdfCol = h;
      if (cycleCol < 0 && hd.indexOf('billing') !== -1 && hd.indexOf('cycle') !== -1) cycleCol = h;
      if (poValidityCol < 0 && hd.indexOf('po') !== -1 && hd.indexOf('valid') !== -1) poValidityCol = h;
    }
    for (let h2 = 0; h2 < hdrs0.length; h2++) {
      const hd2 = String(hdrs0[h2] || '').trim().toLowerCase();
      if (poCol < 0 && hd2 === 'po') { poCol = h2; break; }
    }
    if (agrCol < 0) agrCol = 8;     // col I fallback
    if (poCol < 0) poCol = 10;      // col K fallback
    if (poPdfCol < 0) poPdfCol = 11; // col L fallback
    if (cycleCol < 0) cycleCol = 14; // col O fallback
    if (poValidityCol < 0) poValidityCol = 12; // col M fallback

    let targetRow = -1, matchedRow = null;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] == containerNo) { // eslint-disable-line eqeqeq
        if (String(rows[i][22] || '').trim().toLowerCase() !== 'documents pending') return 'INVALID_STATE';
        targetRow = i + 2;
        matchedRow = rows[i];
        break;
      }
    }
    if (targetRow === -1) throw notFound(`Not found: ${containerNo}`);

    /* Capture OLD values BEFORE overwriting, for the Renewal Log. */
    const [oldAgrCell, oldPoNoCell, oldPoPdfCell] = await Promise.all([
      getRange(SHEETS.DEPLOYED, `${colLetter(agrCol)}${targetRow}:${colLetter(agrCol)}${targetRow}`),
      getRange(SHEETS.DEPLOYED, `${colLetter(poCol)}${targetRow}:${colLetter(poCol)}${targetRow}`),
      getRange(SHEETS.DEPLOYED, `${colLetter(poPdfCol)}${targetRow}:${colLetter(poPdfCol)}${targetRow}`)
    ]);
    const oldAgr = safeStr(oldAgrCell?.[0]?.[0]);
    const oldPoNo = safeStr(oldPoNoCell?.[0]?.[0]);
    const oldPoPdf = safeStr(oldPoPdfCell?.[0]?.[0]);

    /* Save new fields (AA-AD) */
    const newValidIso = new Date(validTill).toISOString();
    const updates = [
      { range: `'${SHEETS.DEPLOYED}'!AA${targetRow}`, values: [[new Date(renewedDate).toISOString()]] },
      { range: `'${SHEETS.DEPLOYED}'!AB${targetRow}`, values: [[newValidIso]] },
      { range: `'${SHEETS.DEPLOYED}'!AC${targetRow}`, values: [[signedCopyUrl || '']] },
      { range: `'${SHEETS.DEPLOYED}'!AD${targetRow}`, values: [[remarks || '']] }
    ];

    /* ★ The SAME upload also updates the real Agreement PDF / PO / PO PDF
       columns the rest of the app reads (not just the AA:AD history fields). */
    if (signedCopyUrl) updates.push({ range: `'${SHEETS.DEPLOYED}'!${colLetter(agrCol)}${targetRow}`, values: [[signedCopyUrl]] });
    if (poNo) updates.push({ range: `'${SHEETS.DEPLOYED}'!${colLetter(poCol)}${targetRow}`, values: [[poNo]] });
    if (poFileUrl) updates.push({ range: `'${SHEETS.DEPLOYED}'!${colLetter(poPdfCol)}${targetRow}`, values: [[poFileUrl]] });
    if (billingCycle) updates.push({ range: `'${SHEETS.DEPLOYED}'!${colLetter(cycleCol)}${targetRow}`, values: [[billingCycle]] });
    if (poValidity) updates.push({ range: `'${SHEETS.DEPLOYED}'!${colLetter(poValidityCol)}${targetRow}`, values: [[new Date(poValidity).toISOString()]] });

    /* Update Valid Upto — in H and X (preserved exactly as the original wrote it). */
    updates.push({ range: `'${SHEETS.DEPLOYED}'!H${targetRow}`, values: [[newValidIso]] });
    updates.push({ range: `'${SHEETS.DEPLOYED}'!X${targetRow}`, values: [[newValidIso]] });

    /* Clear status — it will go back to Pending */
    updates.push({ range: `'${SHEETS.DEPLOYED}'!V${targetRow}`, values: [['']] });
    updates.push({ range: `'${SHEETS.DEPLOYED}'!W${targetRow}`, values: [['']] });

    await batchUpdateValues(updates);
    await patchMongoMirrorRow(SHEETS.DEPLOYED, targetRow, updates);

    /* ★ Renewal Log — one row per renewal, whichever screen it came from,
       with the OLD (pre-overwrite) agreement/PO alongside the new. */
    await _logRenewal({
      container: containerNo,
      clientName: _deployedClientName(hdrs0, matchedRow),
      poNo: poNo || '', poFileUrl: poFileUrl || '', agreementUrl: signedCopyUrl || '',
      oldPoNo, oldPoFileUrl: oldPoPdf, oldAgreementUrl: oldAgr,
      validTill, userEmail: userEmail || '', source: 'Complete Document Stage'
    });

    return 'Documents completed — moved to Pending';
  });
}

/* ★★★ RENEWAL LOG — every renewal (Update Lease Period + Complete Document
   Stage) appends ONE row here. Creates the "Renewal Log" sheet + headers on
   first use. Never throws — a logging failure must not block the real renewal. */
const RL_CONTAINER = 1;

async function _upsertRenewalRow(info) {
  const incoming = {
    1: info.container || '', 2: info.clientName || '', 3: info.poNo || '',
    4: info.poFileUrl || '', 5: info.agreementUrl || '', 6: info.validTill || '',
    8: info.oldPoNo || '', 9: info.oldPoFileUrl || '', 10: info.oldAgreementUrl || ''
  };
  const stamp = new Date().toISOString();
  const wantKey = _normKey(info.container);

  const { rows } = await getSheetData(RENEWAL_LOG_SHEET);
  let rn = -1;
  for (let i = 0; i < rows.length; i++) {
    if (wantKey && _normKey(rows[i][RL_CONTAINER]) === wantKey) rn = i + 2;
  }
  const existing = rn === -1 ? [] : (rows[rn - 2] || []);

  const incomingValid = safeStr(info.validTill).trim();
  const currentValid = safeStr(existing[6]).trim();
  const isNewCycle = rn === -1 || (incomingValid !== '' && incomingValid !== currentValid);

  if (isNewCycle) {
    const fresh = RENEWAL_LOG_HEADERS.map((_, i) => (i === 0 ? stamp : i === 7 ? (info.userEmail || '') : (incoming[i] || '')));
    await appendRow(RENEWAL_LOG_SHEET, fresh);
    return;
  }

  const merged = RENEWAL_LOG_HEADERS.map((_, i) => {
    if (i === 0) return stamp;
    if (i === 7) return info.userEmail || safeStr(existing[7]);
    const next = incoming[i];
    return next !== '' && next !== undefined ? next : safeStr(existing[i]);
  });
  await updateRange(RENEWAL_LOG_SHEET, `A${rn}:${colLetter(RENEWAL_LOG_HEADERS.length - 1)}${rn}`, [merged]);
}

async function _logRenewal(info) {
  try {
    await insertSheetIfMissing(RENEWAL_LOG_SHEET, RENEWAL_LOG_HEADERS);
    const { headers: curHeaders } = await getSheetData(RENEWAL_LOG_SHEET, undefined, 'A1:1');
    if (curHeaders.length < RENEWAL_LOG_HEADERS.length) {
      const missing = RENEWAL_LOG_HEADERS.slice(curHeaders.length);
      await updateRange(RENEWAL_LOG_SHEET, `${colLetter(curHeaders.length)}1:${colLetter(RENEWAL_LOG_HEADERS.length - 1)}1`, [missing]);
    }
    await _upsertRenewalRow(info);
  } catch (e) { console.error('[RENEWAL-LOG]', e.message); }
}
