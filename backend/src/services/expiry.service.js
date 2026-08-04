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
 * calls _deployedClientName()/_logRenewal() (LMS.js lines 681/701, well
 * before this file's assigned range). Those three helpers are ported here
 * too (faithfully, from the original bodies) purely as dependencies so the
 * in-range functions behave identically — they were not otherwise assigned
 * to this porting pass. If another agent also ports the ranges that
 * originally own them, reconcile/dedupe against this copy.
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
import { getSheetDataFromMongo } from './mongoSheetData.service.js';
import { uploadToDrive, extractFileId, deleteFromDrive } from './googleDrive.service.js';
import { safeStr, buildDisplayRow, parseDate } from '../utils/format.js';
import { withSheetLock } from '../utils/sheetMutex.js';
import { checkActionPermission } from './permissions.service.js';
import { AppError, notFound } from '../utils/AppError.js';
import { SHEETS } from '../config/sheets.config.js';
import { cacheGet, cachePut } from '../utils/memoryCache.js';
import { normKey as _normKey, splitContainers as _splitContainers } from '../utils/normalize.js';

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
      // Display-only lookup, keyed by container (not row position) — safe to
      // read from the Mongo mirror the other backend's sync job keeps fresh,
      // instead of hitting the live Sheets API on every Lease Expiry /
      // Renew & Document page load.
      const { headers, rows } = await getSheetDataFromMongo(sheetName);
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

export async function getExpiryDataByFilter(filterType) {
  // Same reasoning as _expiryOrderNoMap above: this is the read backing the
  // Lease Expiry / Renew & Document list views, matched by container number
  // rather than row position, so the Mongo mirror is safe here. The actual
  // write actions below (saveExpiryAction, completeDocStage, ...) still read
  // live from Sheets immediately before writing — that positional freshness
  // requirement is exactly why those stay on getSheetData.
  const { values } = await getSheetDataFromMongo(SHEETS.DEPLOYED);
  if (values.length < 2) return { headers: [], data: [], validColIdx: -1 };

  const allHeaders = padRow(values[0], 26);
  const allRows = values.slice(1).map((r) => padRow(r, 26));

  let colIdx = -1;
  for (let h = 0; h <= 14; h++) {
    if (allHeaders[h] && String(allHeaders[h]).toLowerCase().indexOf('valid') !== -1) { colIdx = h; break; }
  }
  if (colIdx === -1) return { headers: allHeaders.slice(0, 15), data: [], validColIdx: -1 };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const ordMap = await _expiryOrderNoMap(); // ★ Order No joined by container

  const finalData = [];
  for (const row of allRows) {
    if (!row[0] || String(row[0]).trim() === '') continue;
    const vVal = row[21], wVal = row[22];
    let include = false;
    if (filterType === 'pending') include = (!vVal || String(vVal).trim() === '');
    else if (filterType === 'renewed') include = (wVal && String(wVal).trim().toLowerCase() === 'renewed');
    else if (filterType === 'documents') include = (wVal && String(wVal).trim().toLowerCase() === 'documents pending');
    // off-lease stages removed
    if (!include) continue;

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

    const displayRow = buildDisplayRow(row, 15, allHeaders);
    /* ★ Order No as the 2nd column (joined from New Lease by container) */
    displayRow.splice(1, 0, ordMap[_normKey(row[0])] || '');
    if (filterType === 'renewed' || filterType === 'offlease') {
      displayRow.push(safeStr(vVal));
      displayRow.push(safeStr(wVal));
    }
    const item = { row: displayRow, daysLeft: days, band };
    if (filterType === 'documents') {
      item.poUrl = safeStr(row[24]);
      item.agrUrl = safeStr(row[25]);
      item.actionDate = safeStr(vVal);
      item.actionStatus = safeStr(wVal);
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
    if (!matched[24] || String(matched[24]).trim() === '') return 'MISSING_PO';
    if (!matched[25] || String(matched[25]).trim() === '') return 'MISSING_AGR';

    await batchUpdateValues([
      { range: `'${SHEETS.DEPLOYED}'!V${targetRow}`, values: [['']] },
      { range: `'${SHEETS.DEPLOYED}'!W${targetRow}`, values: [['']] }
    ]);
    return 'OK';
  });
}

/* =============================================
   saveExpiryAction — LMS.js 1467-1489
============================================= */
export async function saveExpiryAction(rowId, timestamp, status, callerEmail) {
  await checkActionPermission('expiry', callerEmail);
  return withSheetLock(SHEETS.DEPLOYED, async () => {
    if (!rowId || String(rowId).trim() === '') throw new AppError('Container number is required');
    const { rows } = await getSheetData(SHEETS.DEPLOYED, undefined, 'A2:W');
    if (!rows.length) throw new AppError('No data rows');

    let targetRow = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] == rowId) { // eslint-disable-line eqeqeq
        if (rows[i][21] && String(rows[i][21]).trim() !== '') return 'ALREADY_PROCESSED';
        targetRow = i + 2;
        break;
      }
    }
    if (targetRow === -1) throw notFound(`Not found: ${rowId}`);

    await batchUpdateValues([
      { range: `'${SHEETS.DEPLOYED}'!V${targetRow}`, values: [[new Date(timestamp).toISOString()]] },
      { range: `'${SHEETS.DEPLOYED}'!W${targetRow}`, values: [[status || '']] }
    ]);
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

async function _logRenewal(info) {
  try {
    await insertSheetIfMissing(RENEWAL_LOG_SHEET, RENEWAL_LOG_HEADERS);
    /* ★ Extend an already-existing (older-schema) log sheet with the new
       "Old ..." columns rather than assuming a fresh sheet every time. */
    const { headers: curHeaders } = await getSheetData(RENEWAL_LOG_SHEET, undefined, 'A1:1');
    if (curHeaders.length < RENEWAL_LOG_HEADERS.length) {
      const missing = RENEWAL_LOG_HEADERS.slice(curHeaders.length);
      await updateRange(RENEWAL_LOG_SHEET, `${colLetter(curHeaders.length)}1:${colLetter(RENEWAL_LOG_HEADERS.length - 1)}1`, [missing]);
    }
    await appendRow(RENEWAL_LOG_SHEET, [
      new Date().toISOString(), info.container || '', info.clientName || '', info.poNo || '',
      info.poFileUrl || '', info.agreementUrl || '', info.validTill || '', info.userEmail || '',
      info.oldPoNo || '', info.oldPoFileUrl || '', info.oldAgreementUrl || ''
    ]);
  } catch (e) { console.error('[RENEWAL-LOG]', e.message); } // Never throws — a logging failure must not block the real renewal.
}

export async function completeDocStage(containerNo, renewedDate, validTill, signedCopyUrl, remarks, userEmail, poNo, poFileUrl, billingCycle, callerEmail) {
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
    let agrCol = -1, poCol = -1, poPdfCol = -1, cycleCol = -1;
    for (let h = 0; h < hdrs0.length; h++) {
      const hd = String(hdrs0[h] || '').trim().toLowerCase();
      if (agrCol < 0 && hd.indexOf('agreement') !== -1 && hd.indexOf('valid') === -1 &&
        (hd.indexOf('pdf') !== -1 || hd.indexOf('file') !== -1 || hd.indexOf('copy') !== -1 || hd.indexOf('doc') !== -1)) agrCol = h;
      if (poPdfCol < 0 && hd.indexOf('po') !== -1 && hd.indexOf('pdf') !== -1) poPdfCol = h;
      if (cycleCol < 0 && hd.indexOf('billing') !== -1 && hd.indexOf('cycle') !== -1) cycleCol = h;
    }
    for (let h2 = 0; h2 < hdrs0.length; h2++) {
      const hd2 = String(hdrs0[h2] || '').trim().toLowerCase();
      if (poCol < 0 && hd2 === 'po') { poCol = h2; break; }
    }
    if (agrCol < 0) agrCol = 8;     // col I fallback
    if (poCol < 0) poCol = 10;      // col K fallback
    if (poPdfCol < 0) poPdfCol = 11; // col L fallback
    if (cycleCol < 0) cycleCol = 14; // col O fallback

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

    /* Update Valid Upto — in all three: H, O, X (O is the billing cycle
       column's neighbor semantics in the original comment, but the original
       code only ever writes H and X — preserved exactly as written). */
    updates.push({ range: `'${SHEETS.DEPLOYED}'!H${targetRow}`, values: [[newValidIso]] });
    updates.push({ range: `'${SHEETS.DEPLOYED}'!X${targetRow}`, values: [[newValidIso]] });

    /* Clear status — it will go back to Pending */
    updates.push({ range: `'${SHEETS.DEPLOYED}'!V${targetRow}`, values: [['']] });
    updates.push({ range: `'${SHEETS.DEPLOYED}'!W${targetRow}`, values: [['']] });

    await batchUpdateValues(updates);

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
