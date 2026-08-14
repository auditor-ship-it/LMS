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
import { getCollection } from './mongo.service.js';
import { normalizeKey } from '../config/mongoSheetMapping.js';
import { writeThrough } from './writeThrough.service.js';

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

/** Container numbers are compared case- and punctuation-insensitively, so a
 *  stray space or lower-case entry still resolves to the same row. */
const rlKey = (v) => safeStr(v).toUpperCase().replace(/[^A-Z0-9]/g, '');

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
    /* UPSERT on Container No, not append — see the same logic in
       expiry.service.js. Both paths write this sheet, so both must upsert or
       one of them re-creates the duplicates the other avoids. Blank incoming
       values mean "not part of this update" and keep what is already there;
       only Timestamp and Updated By always take the newest value. */
    const incoming = {
      1: info.container || '', 2: info.clientName || '', 3: info.poNo || '',
      4: info.poFileUrl || '', 5: info.agreementUrl || '', 6: info.validTill || '',
      8: info.oldPoNo || '', 9: info.oldPoFileUrl || '', 10: info.oldAgreementUrl || ''
    };
    const stamp = dmyTime(new Date());
    const wantKey = rlKey(info.container);

    const { rows } = await getSheetData(SHEETS.RENEWAL_LOG);
    let rn = -1;
    for (let i = 0; i < rows.length; i++) {
      if (wantKey && rlKey(rows[i][1]) === wantKey) rn = i + 2;   // last match wins
    }

    const existing = rn === -1 ? [] : (rows[rn - 2] || []);

    /* New renewal cycle -> new row; document upload -> update the current row.
       Valid Till moving is what marks a renewal. Same rule as
       expiry.service.js — both write this sheet and must agree. */
    const incomingValid = safeStr(info.validTill).trim();
    const currentValid = safeStr(existing[6]).trim();
    if (rn === -1 || (incomingValid !== '' && incomingValid !== currentValid)) {
      await appendRow(SHEETS.RENEWAL_LOG, RENEWAL_LOG_HEADERS.map((_, i) =>
        (i === 0 ? stamp : i === 7 ? (info.userEmail || '') : (incoming[i] || ''))));
      return;
    }

    const merged = RENEWAL_LOG_HEADERS.map((_, i) => {
      if (i === 0) return stamp;
      if (i === 7) return info.userEmail || safeStr(existing[7]);
      const next = incoming[i];
      return next !== '' && next !== undefined ? next : safeStr(existing[i]);
    });
    await updateRange(SHEETS.RENEWAL_LOG, `A${rn}:${colLetter(RENEWAL_LOG_HEADERS.length - 1)}${rn}`, [merged]);
  } catch (e) {
    console.error('[RENEWAL-LOG]', e?.message || e);
  }
}

/* ===================== VERIFY LEASE SCREEN ===================== */

export function _padNewLeaseHeader(colStartCount, upToCount) {
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
     Date, col O=Agreement PDF, keyed by Order No (col D). Display-only
     enrichment — read from the Mongo mirror (synced every 5 min by
     sheetsReconcile.job.js), NOT the live sheet: this used to hit
     sheets.googleapis.com on every single Verify Lease page load, which was
     a confirmed contributor to the shared project's quota errors (2026-08-07). */
  const agrMap = {};
  try {
    const refData = await getSheetDataFromMongo(SHEETS.NEW_LEASE_REFF);
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
    const logDates = [], logIssues = [], logRemarks = [], logUsers = [];
    for (const line of aeLines) {
      const parts = line.split(' | ');
      // New entries are "date | issue | remarks | user" (4 parts). Older
      // entries written before the Issue field existed are "date | remarks |
      // user" (3 parts) — keep displaying those with a blank issue rather
      // than reinterpreting their remarks text as an issue.
      if (parts.length >= 4) {
        logDates.push(parts[0] || ''); logIssues.push(parts[1] || ''); logRemarks.push(parts[2] || ''); logUsers.push(parts[3] || '');
      } else {
        logDates.push(parts[0] || ''); logIssues.push(''); logRemarks.push(parts[1] || ''); logUsers.push(parts[2] || '');
      }
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
      logV: logDates.join('\n'), logW: logRemarks.join('\n'), logX: logUsers.join('\n'), logU: logIssues.join('\n'),
      poUrl: safeStr(row[31]), agrUrl: safeStr(row[32]),
      billingType: safeStr(row[33]),
      invoiceType: safeStr(row[34]),
      linkContainer: safeStr(row[35])
    });
  }
  return { headers: displayHeaders, data: finalData };
}

/**
 * Mongo-first: the Mongo mirror (New Lease is naturalKeyColumn-keyed by
 * Container No, not fullRefresh — see mongoSheetMapping.js — so a write-through
 * update lands on the SAME doc every reconcile cycle, never orphaned by a
 * delete+recreate) is updated and committed before this returns; the matching
 * Sheets write is enqueued in the same transaction and pushed asynchronously
 * by jobs/outboxWorker.js (see sheetPushers/verify.pusher.js for the actual
 * Sheets mutation, moved there verbatim from what used to run inline here).
 */
export async function saveVerifyAction(containerNo, timestamp, status, billingType, invoiceType, linkContainer, userEmail) {
  if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');
  const link = invoiceType === 'Link to Container' ? (linkContainer || '') : '';

  const result = await writeThrough({
    collection: SHEETS.NEW_LEASE,
    filter: { key: normalizeKey(SHEETS.NEW_LEASE, containerNo) },
    update: {
      $set: {
        'row.25': dmyTime(new Date(timestamp)), // Z
        'row.26': status || '', // AA
        'row.27': userEmail || '', // AB
        'row.33': billingType || '', // AH
        'row.34': invoiceType || '', // AI
        'row.35': link // AJ
      }
    },
    mode: 'update',
    actor: userEmail,
    sheetPush: {
      targetSheet: SHEETS.NEW_LEASE, operation: 'update', handler: 'verify.saveVerifyAction',
      payload: { containerNo, timestamp, status: status || '', userEmail: userEmail || '', billingType: billingType || '', invoiceType: invoiceType || '', linkContainer: link }
    }
  });
  if (!result.matched) throw new AppError(`Not found: ${containerNo}`);
  return 'OK';
}

export async function saveVerifyFollowUp(containerNo, timestamp, remarks, userEmail, issue) {
  if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');
  if (!remarks || String(remarks).trim() === '') throw new AppError('Remarks required');

  const key = normalizeKey(SHEETS.NEW_LEASE, containerNo);
  // Log columns append rather than replace — compute the full next value
  // up front (from the Mongo doc, which is the same value the previous
  // writeThrough call left it at) so both the Mongo $set and the async
  // Sheets push write the identical absolute string. A retry of the Sheets
  // push then just re-sets the same value instead of appending twice.
  const existing = await getCollection(SHEETS.NEW_LEASE).findOne({ key });
  if (!existing) throw new AppError(`Not found: ${containerNo}`);

  const dateStr = safeStr(new Date(timestamp));
  const newEntry = `${dateStr} | ${issue || ''} | ${remarks || ''} | ${userEmail || ''}`;
  const cur = safeStr(existing.row?.[30]); // AE, 0-based index 30
  const next = cur && cur.trim() !== '' ? `${cur}\n${newEntry}` : newEntry;

  const result = await writeThrough({
    collection: SHEETS.NEW_LEASE,
    filter: { key },
    update: { $set: { 'row.30': next } },
    mode: 'update',
    actor: userEmail,
    sheetPush: {
      targetSheet: SHEETS.NEW_LEASE, operation: 'update', handler: 'verify.saveVerifyFollowUp',
      payload: { containerNo, next }
    }
  });
  if (!result.matched) throw new AppError(`Not found: ${containerNo}`);
  return 'OK';
}

/* ===================== RETURN DASHBOARD (send-back log across ALL rows) ===================== */

function _findHeaderIdx(headers, mustInclude, oneOf) {
  for (let h = 0; h < headers.length; h++) {
    const hl = String(headers[h] || '').trim().toLowerCase();
    if (mustInclude.every((m) => hl.includes(m)) && (!oneOf || oneOf.some((o) => hl.includes(o)))) return h;
  }
  return -1;
}

/**
 * Every "Send Back" (Follow Up with an Issue selected) across the whole New
 * Lease sheet — not just currently-pending rows, since a row can be sent
 * back, fixed, and approved later while the send-back history still matters
 * for reporting. Scans column AE (the same follow-up log saveVerifyFollowUp
 * writes to) on every row, regardless of that row's approval status.
 */
export async function getReturnDashboardData() {
  const { headers: rawHeaders, rows: rawRows } = await getSheetDataFromMongo(SHEETS.NEW_LEASE);
  if (!rawRows.length) return { total: 0, byIssue: [], data: [] };

  const hdr = padWidth(rawHeaders, 36);
  const allRows = rawRows.map((r) => padWidth(r, 36));

  const clientNameIdx = _findHeaderIdx(hdr, ['client'], ['name']) !== -1 ? _findHeaderIdx(hdr, ['client'], ['name']) : _findHeaderIdx(hdr, ['customer'], ['name']);
  const clientCodeIdx = _findHeaderIdx(hdr, ['client'], ['code']);
  const saleExecIdx = _findHeaderIdx(hdr, ['sale'], ['exec', 'person']);
  const orderNoIdx = _findHeaderIdx(hdr, ['order'], ['no']);

  const data = [];
  const issueCounts = {};

  for (let i = 0; i < allRows.length; i++) {
    const row = allRows[i];
    const containerNo = safeStr(row[0]).trim();
    if (!containerNo) continue;

    const aeRaw = safeStr(row[30]); // AE
    const aeLines = aeRaw.split('\n').filter((x) => x.trim() !== '');
    if (!aeLines.length) continue;

    for (const line of aeLines) {
      const parts = line.split(' | ');
      if (parts.length < 4) continue; // legacy 3-part entries have no issue — not a "send back"
      const [date, issue, remarks, user] = parts;
      if (!issue || !issue.trim()) continue;

      data.push({
        container: containerNo,
        clientCode: clientCodeIdx !== -1 ? safeStr(row[clientCodeIdx]) : '',
        clientName: clientNameIdx !== -1 ? safeStr(row[clientNameIdx]) : '',
        orderNo: orderNoIdx !== -1 ? safeStr(row[orderNoIdx]) : '',
        saleExecutive: saleExecIdx !== -1 ? safeStr(row[saleExecIdx]) : '',
        issue: issue.trim(),
        remarks: remarks || '',
        date: date || '',
        user: user || ''
      });
      issueCounts[issue.trim()] = (issueCounts[issue.trim()] || 0) + 1;
    }
  }

  data.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const byIssue = Object.entries(issueCounts)
    .map(([issue, count]) => ({ issue, count }))
    .sort((a, b) => b.count - a.count);

  return { total: data.length, byIssue, data };
}

/* ===================== AGREEMENT FORM (edit lease fields in place) ===================== */

// Column 0 (Container No, the lookup key) and the internal bookkeeping
// columns (Z:AJ — action status/log/doc urls/billing) are never editable
// through this endpoint, regardless of what the caller sends.
const EDITABLE_COL_MAX = 25; // matches displayIndices' highest non-detail index used on the Verify screen

export async function updateVerifyLeaseFields(containerNo, fieldUpdates, userEmail) {
  return withSheetLock(SHEETS.NEW_LEASE, async () => {
    if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');
    if (!fieldUpdates || typeof fieldUpdates !== 'object' || !Object.keys(fieldUpdates).length) {
      throw new AppError('No field updates provided');
    }

    const { headers, rows } = await getSheetData(SHEETS.NEW_LEASE);
    let rn = -1;
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0]) == containerNo) { rn = i + 2; break; } // eslint-disable-line eqeqeq
    }
    if (rn === -1) throw new AppError(`Not found: ${containerNo}`);

    const updates = [];
    const changedLabels = [];
    for (const [key, value] of Object.entries(fieldUpdates)) {
      const ci = Number(key);
      if (!Number.isInteger(ci) || ci <= 0 || ci > EDITABLE_COL_MAX) continue; // silently skip out-of-range/protected columns
      updates.push({ range: `'${SHEETS.NEW_LEASE}'!${colLetter(ci)}${rn}`, values: [[value == null ? '' : String(value)]] });
      changedLabels.push(headers[ci] || `col${ci}`);
    }
    if (!updates.length) throw new AppError('No editable fields in update');

    await batchUpdateValues(updates);

    // Audit trail entry in the same follow-up log the Verify detail page's
    // Follow-up Log reads — written in the legacy 3-part (no-issue) shape so
    // it shows in that history without also counting as a "send back" on the
    // Return Dashboard (which only counts 4-part entries with an issue).
    const dateStr = safeStr(new Date());
    const newEntry = `${dateStr} | Agreement data updated (${changedLabels.join(', ')}) | ${userEmail || ''}`;
    const srcRow = rows[rn - 2] || [];
    const cur = safeStr(srcRow[30]);
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
