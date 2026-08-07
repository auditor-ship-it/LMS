/**
 * Port of LMS.js lines 530-870 (minus uploadToDrive, already in googleDrive.service.js):
 * uploadAndSaveVerifyDocument, updateLeasePeriod, renewLeaseWithAgreement,
 * getVerifyData, saveVerifyAction, saveVerifyFollowUp, saveVerifyDocument,
 * plus internal helpers _deployedClientName / _logRenewal (renewal history log).
 *
 * IDENTITY NOTE: every "userEmail" parameter below is the CALLER's own identity
 * (in the original, the same value doubled as both the checkActionPermission
 * `tok` and the "who did this" value written to the sheet — Apps Script client
 * code always passed its own session token for both). Permission checks now
 * happen in route middleware (requirePermission) using req.user.email; the
 * controller passes that same req.user.email through as `userEmail` here so
 * the recorded value is unchanged, but it is never taken from the request body.
 *
 * DATE-WRITE NOTE: values are written as "dd/MM/yyyy" / "dd/MM/yyyy HH:mm:ss"
 * text (server-local time), not native Date objects — there is no equivalent of
 * Apps Script's typed-Date cell write over the Sheets values API without risking
 * a UTC day-shift (new Date(y,m,d).toISOString() can roll to the previous day
 * for positive-UTC-offset servers). This format round-trips correctly through
 * utils/format.js's parseDate()/formatDateVal(), which already handle text dates.
 */
import {
  getSheetData,
  updateRange,
  updateCell,
  batchUpdateValues,
  appendRow,
  insertSheetIfMissing,
  colLetter
} from './googleSheets.service.js';
import { SHEETS } from '../config/sheets.config.js';
import { safeStr, formatDateVal, buildDisplayRow } from '../utils/format.js';
import { withSheetLock } from '../utils/sheetMutex.js';
import { AppError } from '../utils/AppError.js';
import { uploadToDrive, extractFileId, deleteFromDrive } from './googleDrive.service.js';
import { getSheetDataFromMongo } from './mongoSheetData.service.js';

function pad2(n) { return String(n).padStart(2, '0'); }
function dmyTime(d) {
  return `${safeStr(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function padWidth(arr, width) {
  const out = (arr || []).slice(0, width);
  while (out.length < width) out.push('');
  return out;
}

/* ===================== VERIFY DOCUMENT UPLOAD ===================== */

export async function uploadAndSaveVerifyDocument(base64Data, mimeType, fileName, containerNo, docType, userEmail) {
  let url = '';
  try {
    url = await uploadToDrive(base64Data, mimeType, fileName);
    await saveVerifyDocument(containerNo, docType, url, userEmail);
    return { success: true, url };
  } catch (e) {
    if (url) {
      try {
        const id = extractFileId(url);
        if (id) await deleteFromDrive(id);
      } catch (ignore) { /* best-effort cleanup only */ }
    }
    throw e;
  }
}

/* ===================== LEASE PERIOD / RENEWAL ===================== */

export async function updateLeasePeriod(containerNo, newDateString, userEmail) {
  return withSheetLock(SHEETS.DEPLOYED, async () => {
    if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');
    if (!newDateString) throw new AppError('Date is required');

    const { rows } = await getSheetData(SHEETS.DEPLOYED, undefined, 'A1:Z');
    if (!rows.length) throw new AppError('No data rows');

    let targetRow = -1;
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0]) == containerNo) { targetRow = i + 2; break; } // eslint-disable-line eqeqeq
    }
    if (targetRow === -1) throw new AppError(`Not found: ${containerNo}`);

    const parts = String(newDateString).split('-');
    const newDate = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    const newDateStr = safeStr(newDate);

    await batchUpdateValues([
      { range: `'${SHEETS.DEPLOYED}'!H${targetRow}`, values: [[newDateStr]] },
      { range: `'${SHEETS.DEPLOYED}'!O${targetRow}`, values: [[newDateStr]] },
      { range: `'${SHEETS.DEPLOYED}'!X${targetRow}`, values: [[newDateStr]] },
      { range: `'${SHEETS.DEPLOYED}'!V${targetRow}`, values: [[dmyTime(new Date())]] },
      { range: `'${SHEETS.DEPLOYED}'!W${targetRow}`, values: [['Documents Pending']] },
      { range: `'${SHEETS.DEPLOYED}'!Y${targetRow}`, values: [['']] },
      { range: `'${SHEETS.DEPLOYED}'!Z${targetRow}`, values: [['']] }
    ]);

    return 'OK';
  });
}

const HIST_HEADERS = ['Renewal History Dates', 'Renewal History Old Valid Upto', 'Renewal History Old Agreement'];

/**
 * Renew a lease WITH an agreement file, keeping full renewal history.
 * See LMS.js lines 580-676 for the full behavioral spec (doc comment there).
 */
export async function renewLeaseWithAgreement(containerNo, newDateString, agreementUrl, userEmail) {
  return withSheetLock(SHEETS.DEPLOYED, async () => {
    if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');
    if (!newDateString) throw new AppError('Date is required');

    const { headers, rows } = await getSheetData(SHEETS.DEPLOYED);
    if (!rows.length) throw new AppError('No data rows');
    const lc = headers.length;

    /* Agreement PDF column (the one shown in Lease Expiry). Header-detected;
       fallback col I (index 8) which is where that column sits today. */
    let agrCol = -1;
    for (let h = 0; h < lc; h++) {
      const hd = String(headers[h] || '').trim().toLowerCase();
      if (hd.includes('agreement') && !hd.includes('valid') &&
        (hd.includes('pdf') || hd.includes('file') || hd.includes('copy') || hd.includes('doc'))) { agrCol = h; break; }
    }
    if (agrCol < 0) agrCol = 8; // col I

    /* Renewal-history columns at the END of the sheet (created if missing). */
    const hCol = HIST_HEADERS.map((name) =>
      headers.findIndex((h) => String(h || '').trim().toLowerCase() === name.toLowerCase())
    );
    const toAppend = [];
    const base = lc;
    for (let q = 0; q < HIST_HEADERS.length; q++) {
      if (hCol[q] < 0) { hCol[q] = base + toAppend.length; toAppend.push(HIST_HEADERS[q]); }
    }
    if (toAppend.length) {
      const startCol = colLetter(base);
      const endCol = colLetter(base + toAppend.length - 1);
      await updateRange(SHEETS.DEPLOYED, `${startCol}1:${endCol}1`, [toAppend]);
    }

    let targetRow = -1;
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0]) == containerNo) { targetRow = i + 2; break; } // eslint-disable-line eqeqeq
    }
    if (targetRow === -1) throw new AppError(`Not found: ${containerNo}`);
    const srcRow = rows[targetRow - 2];

    /* Capture OLD values BEFORE overwriting */
    const oldValidStr = formatDateVal(srcRow[7]); // col H, 0-based index 7
    const oldAgr = safeStr(srcRow[agrCol]);
    const nowStr = safeStr(new Date());

    const histUpdates = [];
    function appendHist(colIdx, val) {
      const cur = safeStr(srcRow[colIdx]);
      const next = cur ? `${cur}\n${val}` : val;
      histUpdates.push({ range: `'${SHEETS.DEPLOYED}'!${colLetter(colIdx)}${targetRow}`, values: [[next]] });
    }
    appendHist(hCol[0], nowStr);
    appendHist(hCol[1], oldValidStr || '-');
    appendHist(hCol[2], oldAgr || '-');

    /* New date -> H, O, X */
    const parts = String(newDateString).split('-');
    const newDate = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    const newDateStr = safeStr(newDate);

    const updates = [
      ...histUpdates,
      { range: `'${SHEETS.DEPLOYED}'!H${targetRow}`, values: [[newDateStr]] },
      { range: `'${SHEETS.DEPLOYED}'!O${targetRow}`, values: [[newDateStr]] },
      { range: `'${SHEETS.DEPLOYED}'!X${targetRow}`, values: [[newDateStr]] }
    ];

    /* Latest agreement -> Agreement PDF column (shows in Lease Expiry) */
    if (agreementUrl) updates.push({ range: `'${SHEETS.DEPLOYED}'!${colLetter(agrCol)}${targetRow}`, values: [[agreementUrl]] });

    if (agreementUrl) {
      /* agreement uploaded -> fully renewed -> back to Pending for tracking */
      updates.push({ range: `'${SHEETS.DEPLOYED}'!V${targetRow}`, values: [['']] });
      updates.push({ range: `'${SHEETS.DEPLOYED}'!W${targetRow}`, values: [['']] });
    } else {
      /* date updated but agreement still pending -> shows in "Renew Pending" */
      updates.push({ range: `'${SHEETS.DEPLOYED}'!V${targetRow}`, values: [[dmyTime(new Date())]] });
      updates.push({ range: `'${SHEETS.DEPLOYED}'!W${targetRow}`, values: [['Documents Pending']] });
    }

    await batchUpdateValues(updates);

    /* Renewal Log — one row per renewal, whichever screen it came from. */
    await _logRenewal({
      container: containerNo, clientName: _deployedClientName(headers, srcRow),
      poNo: '', poFileUrl: '', agreementUrl: agreementUrl || '',
      oldPoNo: '', oldPoFileUrl: '', oldAgreementUrl: oldAgr || '',
      validTill: newDateString, userEmail, source: 'Update Lease Period'
    });

    return 'OK';
  });
}

/** Find "Client Name" (or "Customer Name") in an already-fetched header/row pair.
 *  Adapted from the original's (sheet, targetRow) signature to (headers, row)
 *  since renewLeaseWithAgreement already has both in hand under its lock —
 *  same lookup logic, just no extra sheet read. Returns "" if not found. */
function _deployedClientName(headers, row) {
  try {
    for (let h = 0; h < headers.length; h++) {
      const hd = String(headers[h] || '').trim().toLowerCase();
      if ((hd.includes('client') || hd.includes('customer')) && hd.includes('name')) {
        return safeStr(row[h]);
      }
    }
  } catch (e) { /* never break the caller */ }
  return '';
}

/* ★★★ RENEWAL LOG — every renewal (Update Lease Period + Complete Document
   Stage) appends ONE row here. Creates the "Renewal Log" sheet + headers on
   first use. Never throws — a logging failure must not block the real renewal. */
const RENEWAL_LOG_HEADERS = ['Timestamp', 'Container No', 'Client Name', 'PO No', 'PO File', 'Agreement File', 'Valid Till', 'Updated By', 'Old PO No', 'Old PO File', 'Old Agreement File'];

async function _logRenewal(info) {
  try {
    await insertSheetIfMissing(SHEETS.RENEWAL_LOG, RENEWAL_LOG_HEADERS);
    /* Extend an already-existing (older-schema) log sheet with the new
       "Old ..." columns rather than assuming a fresh sheet every time. */
    const { headers } = await getSheetData(SHEETS.RENEWAL_LOG, undefined, 'A1:Z1');
    if (headers.length < RENEWAL_LOG_HEADERS.length) {
      const startCol = colLetter(headers.length);
      const endCol = colLetter(RENEWAL_LOG_HEADERS.length - 1);
      await updateRange(SHEETS.RENEWAL_LOG, `${startCol}1:${endCol}1`, [RENEWAL_LOG_HEADERS.slice(headers.length)]);
    }
    await appendRow(SHEETS.RENEWAL_LOG, [
      dmyTime(new Date()), info.container || '', info.clientName || '', info.poNo || '',
      info.poFileUrl || '', info.agreementUrl || '', info.validTill || '', info.userEmail || '',
      info.oldPoNo || '', info.oldPoFileUrl || '', info.oldAgreementUrl || ''
    ]);
  } catch (e) {
    console.error('[RENEWAL-LOG]', e?.message || e);
  }
}

/* ===================== VERIFY LEASE SCREEN ===================== */

function _padNewLeaseHeader(colStartCount, upToCount) {
  const t = [];
  for (let c = colStartCount; c <= upToCount; c++) {
    if (c === 34) t.push('Billing Type');
    else if (c === 35) t.push('Invoice Generate Type');
    else if (c === 36) t.push('Link Container No.');
    else t.push('');
  }
  return t;
}

export async function getVerifyData() {
  // Display-only list read — safe to serve from the Mongo mirror now that
  // saveVerifyAction/saveVerifyFollowUp locate their row by container number
  // instead of trusting a row number cached from this read (Phase 1a).
  const { headers: rawHeaders, rows: rawRows } = await getSheetDataFromMongo(SHEETS.NEW_LEASE);
  if (!rawRows.length) return { headers: [], data: [] };

  /* Ensure the sheet has (at least, logically) 36 header columns, same
     off-by-one arithmetic as the original (c starts at lastCol, write starts
     at lastCol+1) — preserved exactly, not "fixed", since it is rarely hit in
     practice (the live sheet already has data past col 36). */
  let lastCol = rawHeaders.length;
  for (const r of rawRows) if (r.length > lastCol) lastCol = r.length;
  if (lastCol < 36) {
    const t = _padNewLeaseHeader(lastCol, 36);
    if (t.length > 0) {
      await updateRange(SHEETS.NEW_LEASE, `${colLetter(lastCol)}1:${colLetter(lastCol + t.length - 1)}1`, [t]);
    }
  }

  const hdr = padWidth(rawHeaders, 36);
  const allRows = rawRows.map((r) => padWidth(r, 36));

  const displayIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 23, 24];
  const displayHeaders = displayIndices.map((ci) => hdr[ci]);

  /* Locate the Agreement / Client Code / Order No columns in "New Lease" by header name */
  let agrDateIdx = -1, agrPdfIdx = -1, ordIdx = -1, clientCodeIdx = -1;
  for (let hh = 0; hh < hdr.length; hh++) {
    const hl = String(hdr[hh] || '').toLowerCase();
    if (hl.includes('agreement') && hl.includes('pdf')) agrPdfIdx = hh;
    else if (hl.includes('agreement') && (hl.includes('date') || hl.includes('valid'))) agrDateIdx = hh;
    if (ordIdx === -1 && hl.includes('order') && hl.includes('no')) ordIdx = hh;
    if (clientCodeIdx === -1 && hl.includes('client') && hl.includes('code')) clientCodeIdx = hh;
  }
  if (ordIdx === -1) ordIdx = 3; // fallback: column D

  /* Build lookup from "New lease reff": col B=Client Code, col N=Agreement
     Date, col O=Agreement PDF, keyed by Order No (col D) */
  const agrMap = {};
  try {
    const refNames = ['New lease reff', 'New Lease reff', 'New lease ref', 'New Lease Reff'];
    let refData = null;
    for (const rn of refNames) {
      try { refData = await getSheetData(rn, undefined, 'A1:O'); break; } catch (e) { /* try next name */ }
    }
    if (refData && refData.rows.length) {
      for (const raw of refData.rows) {
        const r = padWidth(raw, 15);
        const k = safeStr(r[3]).trim(); // D = Order No
        if (!k) continue;
        agrMap[k] = { code: safeStr(r[1]).trim(), date: formatDateVal(r[13]), pdf: safeStr(r[14]) };
      }
    }
  } catch (e) { /* never break the verify screen */ }

  const finalData = [];
  for (let i = 0; i < allRows.length; i++) {
    const row = allRows[i];
    if (!row[0] || String(row[0]).trim() === '') continue;
    if (row[26] && String(row[26]).trim() !== '') continue; // already actioned (AA)

    const aeRaw = safeStr(row[30]); // AE
    const aeLines = aeRaw.split('\n').filter((x) => x.trim() !== '');
    const logDates = [], logRemarks = [], logUsers = [];
    for (const line of aeLines) {
      const parts = line.split(' | ');
      logDates.push(parts[0] || ''); logRemarks.push(parts[1] || ''); logUsers.push(parts[2] || '');
    }

    const dispRow = buildDisplayRow(row, displayIndices, hdr);
    const ordKey = safeStr(row[ordIdx]).trim();
    if (ordKey && agrMap[ordKey]) {
      const m = agrMap[ordKey];
      if (clientCodeIdx !== -1 && clientCodeIdx < dispRow.length && m.code &&
        (!dispRow[clientCodeIdx] || String(dispRow[clientCodeIdx]).trim() === '')) dispRow[clientCodeIdx] = m.code;
      if (agrDateIdx !== -1 && agrDateIdx < dispRow.length && m.date) dispRow[agrDateIdx] = m.date;
      if (agrPdfIdx !== -1 && agrPdfIdx < dispRow.length && m.pdf) dispRow[agrPdfIdx] = m.pdf;
    }

    finalData.push({
      row: dispRow,
      _rowNum: i + 2,
      logV: logDates.join('\n'), logW: logRemarks.join('\n'), logX: logUsers.join('\n'),
      poUrl: safeStr(row[31]), agrUrl: safeStr(row[32]),
      billingType: safeStr(row[33]),
      invoiceType: safeStr(row[34]),
      linkContainer: safeStr(row[35])
    });
  }
  return { headers: displayHeaders, data: finalData };
}

export async function saveVerifyAction(containerNo, timestamp, status, billingType, invoiceType, linkContainer, userEmail) {
  return withSheetLock(SHEETS.NEW_LEASE, async () => {
    if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');

    const { headers, rows } = await getSheetData(SHEETS.NEW_LEASE);
    // Located by container number (not a client-cached row number) so a
    // stale/differently-ordered list read (e.g. from the Mongo mirror) can
    // never cause this write to land on the wrong row — see splendid-rolling-candy.md Phase 1a.
    let rn = -1;
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0]) == containerNo) { rn = i + 2; break; } // eslint-disable-line eqeqeq
    }
    if (rn === -1) throw new AppError(`Not found: ${containerNo}`);

    let lastCol = headers.length;
    for (const r of rows) if (r.length > lastCol) lastCol = r.length;
    if (lastCol < 36) {
      const t = _padNewLeaseHeader(lastCol, 36);
      if (t.length > 0) {
        await updateRange(SHEETS.NEW_LEASE, `${colLetter(lastCol)}1:${colLetter(lastCol + t.length - 1)}1`, [t]);
      }
    }

    await batchUpdateValues([
      { range: `'${SHEETS.NEW_LEASE}'!Z${rn}:AB${rn}`, values: [[dmyTime(new Date(timestamp)), status || '', userEmail || '']] },
      { range: `'${SHEETS.NEW_LEASE}'!AH${rn}:AJ${rn}`, values: [[billingType || '', invoiceType || '', invoiceType === 'Link to Container' ? (linkContainer || '') : '']] }
    ]);
    return 'OK';
  });
}

export async function saveVerifyFollowUp(containerNo, timestamp, remarks, userEmail) {
  return withSheetLock(SHEETS.NEW_LEASE, async () => {
    if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');
    if (!remarks || String(remarks).trim() === '') throw new AppError('Remarks required');

    const { rows } = await getSheetData(SHEETS.NEW_LEASE, undefined, 'A1:AE');
    let rn = -1;
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0]) == containerNo) { rn = i + 2; break; } // eslint-disable-line eqeqeq
    }
    if (rn === -1) throw new AppError(`Not found: ${containerNo}`);

    const dateStr = safeStr(new Date(timestamp));
    const newEntry = `${dateStr} | ${remarks || ''} | ${userEmail || ''}`;

    const srcRow = rows[rn - 2] || [];
    const cur = safeStr(srcRow[30]); // AE, 0-based index 30
    const next = cur && cur.trim() !== '' ? `${cur}\n${newEntry}` : newEntry;

    await updateCell(SHEETS.NEW_LEASE, rn, 30, next);
    return 'OK';
  });
}

export async function saveVerifyDocument(containerNo, docType, url, userEmail) {
  return withSheetLock(SHEETS.NEW_LEASE, async () => {
    if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');

    const { rows } = await getSheetData(SHEETS.NEW_LEASE, undefined, 'A1:A');
    if (!rows.length) throw new AppError('No data rows');

    let targetRow = -1;
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0]) == containerNo) { targetRow = i + 2; break; } // eslint-disable-line eqeqeq
    }
    if (targetRow === -1) throw new AppError(`Not found: ${containerNo}`);

    const col0 = docType === 'po' ? 31 : 32; // AF=31, AG=32 (0-based)
    await updateCell(SHEETS.NEW_LEASE, targetRow, col0, url || '');
    return 'OK';
  });
}
