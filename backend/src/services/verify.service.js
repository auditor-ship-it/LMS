/**
 * Port of LMS.js lines 530-870 (minus uploadToDrive, already in googleDrive.service.js):
 * uploadAndSaveVerifyDocument, updateLeasePeriod, renewLeaseWithAgreement,
 * getVerifyData, saveVerifyAction, saveVerifyFollowUp, saveVerifyDocument,
 * plus internal helpers _deployedClientName / _logRenewal (renewal history log).
 *
 * SHEETS-FIRST (reverted 2026-08-21). Every write in this file briefly used
 * the Mongo-first writeThrough pattern; reverted at the user's explicit
 * request so manual spreadsheet edits are visible to every reader
 * immediately rather than after the next reconcile cycle. Live Sheets is
 * the read/write source of truth; Mongo is a best-effort backup mirror kept
 * in step via patchMongoMirrorRow.
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
import { patchMongoMirrorRow, getSheetDataFromMongo } from './mongoSheetData.service.js';
import { cacheGetOrLoad, cacheRemove, cacheRemoveByPrefix } from '../utils/memoryCache.js';
import { sendMail } from './email.service.js';
import { DEPLOYED_RAW_CACHE_KEY } from './expiry.service.js';

/* getVerifyData cache — added 2026-08-26. Verify Lease was previously live
   on every call (an explicit, deliberate choice: manual spreadsheet edits
   must be visible instantly, not after a stale cache) — kept true for this
   app's OWN writes below (every one of them busts this immediately, so a
   save is still reflected on the very next read, same as before), but a
   short TTL now covers everything else: several tabs/users opening Verify
   Lease (or My Task, which also calls getVerifyData) in the same few
   seconds used to mean that many independent live reads of the same two
   sheets. 20s is short enough that an OUTSIDE-the-app manual edit is still
   visible almost immediately, not the 90s+ staleness that caused the
   original RAW-everything decision. */
const VERIFY_CACHE_KEY = 'verify_data_v1';
const VERIFY_CACHE_TTL_SECS = 20;

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

export async function uploadAndSaveVerifyDocument(base64Data, mimeType, fileName, containerNo, docType, userEmail, knownRow) {
  let url = '';
  try {
    url = await uploadToDrive(base64Data, mimeType, fileName);
    await saveVerifyDocument(containerNo, docType, url, userEmail, knownRow);
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

/** `knownRow` (1-based Deployed sheet row): addresses that EXACT row
 *  directly instead of searching — Container No is not unique on Deployed
 *  (see mongoSheetMapping.js's fullRefresh note on that sheet; same bug
 *  class fixed 2026-08-29 in offlease.service.js's addToOffLeaseTracking
 *  and expiry.service.js's own Deployed writers).
 *
 *  HARDENED 2026-08-31 (user directive: this class of error must never
 *  recur anywhere): omitting knownRow is safe only when the container
 *  genuinely has one Deployed row — a second row now throws a clear error
 *  instead of silently picking whichever comes first. See
 *  offlease.service.js's _resolveOlRow for the identical fix/reasoning. */
function _resolveDeployedRow(containerNo, rows, knownRow) {
  if (knownRow != null) {
    const row = rows[knownRow - 2];
    if (!row || String(row[0]) != containerNo) { // eslint-disable-line eqeqeq
      throw new AppError(`Deployed sheet row ${knownRow} no longer matches ${containerNo} — it may have changed. Refresh and try again.`);
    }
    return knownRow;
  }
  let first = -1, count = 0;
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) != containerNo) continue; // eslint-disable-line eqeqeq
    count++;
    if (first === -1) first = i + 2;
  }
  if (count > 1) {
    throw new AppError(`${containerNo} has ${count} Deployed sheet records — open it from its own list row (not by container number alone) so the exact one can be targeted.`);
  }
  return first;
}

export async function updateLeasePeriod(containerNo, newDateString, userEmail, knownRow) {
  return withSheetLock(SHEETS.DEPLOYED, async () => {
    if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');
    if (!newDateString) throw new AppError('Date is required');

    const { rows } = await getSheetData(SHEETS.DEPLOYED, undefined, 'A1:Z');
    if (!rows.length) throw new AppError('No data rows');

    const targetRow = _resolveDeployedRow(containerNo, rows, knownRow);
    if (targetRow === -1) throw new AppError(`Not found: ${containerNo}`);

    const parts = String(newDateString).split('-');
    const newDate = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    const newDateStr = safeStr(newDate);

    const updates = [
      { range: `'${SHEETS.DEPLOYED}'!H${targetRow}`, values: [[newDateStr]] },
      { range: `'${SHEETS.DEPLOYED}'!O${targetRow}`, values: [[newDateStr]] },
      { range: `'${SHEETS.DEPLOYED}'!X${targetRow}`, values: [[newDateStr]] },
      { range: `'${SHEETS.DEPLOYED}'!V${targetRow}`, values: [[dmyTime(new Date())]] },
      { range: `'${SHEETS.DEPLOYED}'!W${targetRow}`, values: [['Documents Pending']] },
      { range: `'${SHEETS.DEPLOYED}'!Y${targetRow}`, values: [['']] },
      { range: `'${SHEETS.DEPLOYED}'!Z${targetRow}`, values: [['']] }
    ];
    await batchUpdateValues(updates);
    // Keep the Mongo mirror in step immediately — see patchMongoMirrorRow's
    // header comment for why GET /api/expiry would otherwise show stale data
    // for up to 5 minutes after this write.
    await patchMongoMirrorRow(SHEETS.DEPLOYED, targetRow, updates);
    // BUG FOUND AND FIXED 2026-09-03: patching the Mongo mirror isn't enough
    // on its own — getExpiryDataByFilter reads through _deployedRawValues()'s
    // OWN 30s cache sitting in front of it, so without this the very next
    // read (this page's own post-submit reload) still saw the pre-write
    // snapshot for up to 30s. Same fix as renewLeaseWithAgreement below.
    cacheRemove(DEPLOYED_RAW_CACHE_KEY); // so the very next read (this page's own reload) sees it instantly, not up to 30s later
    cacheRemoveByPrefix('mytasks_v1'); // this write also sets column W — see completeDocumentStageFast's identical note in expiry.service.js

    return 'OK';
  });
}

const HIST_HEADERS = ['Renewal History Dates', 'Renewal History Old Valid Upto', 'Renewal History Old Agreement'];

/**
 * Renew a lease WITH an agreement file, keeping full renewal history.
 * See LMS.js lines 580-676 for the full behavioral spec (doc comment there).
 */
export async function renewLeaseWithAgreement(containerNo, newDateString, agreementUrl, userEmail, knownRow) {
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

    const targetRow = _resolveDeployedRow(containerNo, rows, knownRow);
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
      /* date updated but agreement still pending -> W = 'Documents Pending',
         which hands this container from Renew & Document's "Renewed" tab
         into its "Documents" tab (comment corrected 2026-09-03 — this used
         to say "shows in Renew Pending", which was stale/wrong: the code
         has always written 'Documents Pending' here, not 'Renewed'). */
      updates.push({ range: `'${SHEETS.DEPLOYED}'!V${targetRow}`, values: [[dmyTime(new Date())]] });
      updates.push({ range: `'${SHEETS.DEPLOYED}'!W${targetRow}`, values: [['Documents Pending']] });
    }

    await batchUpdateValues(updates);
    await patchMongoMirrorRow(SHEETS.DEPLOYED, targetRow, updates);
    // BUG FOUND AND FIXED 2026-09-03: this is the exact "click Update in the
    // Renewed tab, container doesn't move to Documents Pending" report — the
    // Mongo mirror was patched correctly, but getExpiryDataByFilter reads
    // through _deployedRawValues()'s own 30s cache sitting in front of it,
    // which this write never busted. The transition WAS happening; it just
    // didn't show up until that cache aged out on its own (up to 30s later),
    // which read as "nothing happened" on the page's own immediate reload.
    cacheRemove(DEPLOYED_RAW_CACHE_KEY); // so the very next read (this page's own reload) sees it instantly, not up to 30s later
    // BUG FOUND AND FIXED 2026-09-03: this also changes column W, which the
    // sidebar's "Renew & Document" badge counts via tasks.service.js's
    // getMyTasks() — that whole counts object sits behind its OWN 90s cache
    // (mytasks_v1:<scope>), untouched by the bust above. Confirmed live: the
    // page's own KPI correctly showed 8 while the sidebar badge still read a
    // stale 6.
    cacheRemoveByPrefix('mytasks_v1');

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
   first use. Never throws — a logging failure must not block the real renewal.
   ALWAYS APPENDS — never looks up or overwrites a prior row for the same
   container (explicit requirement 2026-08-25: this sheet is the full audit
   history, so every renewal action, including a Complete Document Stage that
   follows an Update Lease Period for the same cycle, gets its own row rather
   than being merged into an earlier one). */
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
    const stamp = dmyTime(new Date());
    await appendRow(SHEETS.RENEWAL_LOG, [
      stamp, info.container || '', info.clientName || '', info.poNo || '',
      info.poFileUrl || '', info.agreementUrl || '', info.validTill || '', info.userEmail || '',
      info.oldPoNo || '', info.oldPoFileUrl || '', info.oldAgreementUrl || ''
    ]);
    // Same try/catch as the log write above — a mail failure must not be
    // mistaken for the renewal itself failing, and this only ever fires
    // once the append has actually succeeded.
    await _sendRenewalNotification(stamp, info);
  } catch (e) {
    console.error('[RENEWAL-LOG]', e?.message || e);
  }
}

/** Vertical table, same convention as offlease.service.js's
 *  _sendOffLeaseNotification / expiry.service.js's own copy of this
 *  function — kept duplicated here rather than shared, matching how
 *  _logRenewal/RENEWAL_LOG_HEADERS above are already duplicated between the
 *  two files that can trigger a renewal completion. */
async function _sendRenewalNotification(stamp, info) {
  const fields = [
    ['Timestamp', stamp],
    ['Container No', info.container || ''],
    ['Client Name', info.clientName || ''],
    ['PO No', info.poNo || ''],
    ['PO File', info.poFileUrl || ''],
    ['Agreement File', info.agreementUrl || ''],
    ['Agreement Valid Till', info.validTill || ''],
    ['Updated By', info.userEmail || ''],
    ['Old PO No', info.oldPoNo || ''],
    ['Old PO File', info.oldPoFileUrl || ''],
    ['Old Agreement File', info.oldAgreementUrl || '']
  ];

  const subject = `Renew & Document Notification – ${info.container || 'Unknown Container'}`;
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
  console.log(`[RENEWAL-LOG-EMAIL] sent for ${info.container}`);
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
  return cacheGetOrLoad(VERIFY_CACHE_KEY, VERIFY_CACHE_TTL_SECS, async () => {
  // Read-only display list — every write below (saveVerifyAction etc.)
  // re-reads NEW_LEASE LIVE and re-resolves its target row by container
  // number fresh, so this Mongo-served copy never feeds a write.
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
     Date, col O=Agreement PDF, keyed by Order No (col D).
     Back on the Mongo mirror (2026-08-26) — this was the original fix
     (2026-08-07) for exactly this read being a quota contributor on every
     Verify Lease load; the 2026-08-21 revert to live Sheets reintroduced
     that same pressure app-wide, so restored. Pure lookup-map read, no
     write ever derives a row number from it. */
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
  });
}

/**
 * `knownRow` (1-based sheet row): when given, addresses that EXACT row
 * directly instead of searching — verified against `containerNo` first, so
 * a stale/out-of-range reference still fails loudly rather than silently
 * writing under the wrong row. Falls back to the old first-match search
 * when omitted.
 *
 * Container No is NOT unique on New Lease — 14 of 73 containers currently
 * have 2-3 rows each (see mongoSheetMapping.js's doc comment on why). Every
 * write below used to search for "the first row matching this container",
 * which silently grabs whichever row happens to sort first — confirmed
 * 2026-08-29 on TRIU6632949: clicking Approve on its "Bengaluru Co.op. Milk
 * Union Ltd.(BAMUL)" record (the SECOND row) actually wrote Approved /
 * Billing Type / Invoice Type onto its FIRST row instead — a different,
 * already-approved lease for "63IDEAS INFOLABS PRIVATE LIMITED" — silently
 * overwriting that row's own (blank) billing/invoice fields with values
 * that belonged to a completely different client. getVerifyData's list
 * already resolves and returns each row's own `_rowNum`; every caller that
 * has a specific record open (which is every caller — this app only ever
 * shows one record's action buttons at a time) should pass it through.
 */
/* HARDENED 2026-08-31 (user directive: this class of error must never
 * recur anywhere): omitting knownRow is safe only when the container
 * genuinely has one New Lease row — a second row now throws a clear error
 * instead of silently picking whichever comes first. See
 * offlease.service.js's _resolveOlRow for the identical fix/reasoning. */
function _resolveNewLeaseRow(containerNo, rows, knownRow) {
  if (knownRow != null) {
    const row = rows[knownRow - 2];
    if (!row || String(row[0]) != containerNo) { // eslint-disable-line eqeqeq
      throw new AppError(`New Lease row ${knownRow} no longer matches ${containerNo} — it may have changed. Refresh and try again.`);
    }
    return knownRow;
  }
  let first = -1, count = 0;
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) != containerNo) continue; // eslint-disable-line eqeqeq
    count++;
    if (first === -1) first = i + 2;
  }
  if (count > 1) {
    throw new AppError(`${containerNo} has ${count} New Lease records — open it from its own list row (not by container number alone) so the exact one can be targeted.`);
  }
  return first;
}

export async function saveVerifyAction(containerNo, timestamp, status, billingType, invoiceType, linkContainer, userEmail, knownRow) {
  return withSheetLock(SHEETS.NEW_LEASE, async () => {
    if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');
    const link = invoiceType === 'Link to Container' ? (linkContainer || '') : '';

    const { rows } = await getSheetData(SHEETS.NEW_LEASE);
    const targetRow = _resolveNewLeaseRow(containerNo, rows, knownRow);
    if (targetRow === -1) throw new AppError(`Not found: ${containerNo}`);

    const updates = [
      { range: `'${SHEETS.NEW_LEASE}'!Z${targetRow}`, values: [[dmyTime(new Date(timestamp))]] },
      { range: `'${SHEETS.NEW_LEASE}'!AA${targetRow}`, values: [[status || '']] },
      { range: `'${SHEETS.NEW_LEASE}'!AB${targetRow}`, values: [[userEmail || '']] },
      { range: `'${SHEETS.NEW_LEASE}'!AH${targetRow}`, values: [[billingType || '']] },
      { range: `'${SHEETS.NEW_LEASE}'!AI${targetRow}`, values: [[invoiceType || '']] },
      { range: `'${SHEETS.NEW_LEASE}'!AJ${targetRow}`, values: [[link]] }
    ];
    await batchUpdateValues(updates);
    // Position-keyed (row_<i>), NOT normalizeKey(containerNo) — New Lease is
    // fullRefresh now, see mongoSheetMapping.js's doc comment on why a
    // container-number key silently collided for any reused container.
    await patchMongoMirrorRow(SHEETS.NEW_LEASE, targetRow, updates);
    cacheRemove(VERIFY_CACHE_KEY); // this row just changed — next read must not serve the pre-save cache
    return 'OK';
  });
}

export async function saveVerifyFollowUp(containerNo, timestamp, remarks, userEmail, issue, knownRow) {
  return withSheetLock(SHEETS.NEW_LEASE, async () => {
    if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');
    if (!remarks || String(remarks).trim() === '') throw new AppError('Remarks required');

    const { rows } = await getSheetData(SHEETS.NEW_LEASE);
    const targetRow = _resolveNewLeaseRow(containerNo, rows, knownRow);
    if (targetRow === -1) throw new AppError(`Not found: ${containerNo}`);

    // dmyTime, not safeStr — safeStr's `val instanceof Date` branch formats a
    // DATE ONLY (formatDMY), silently dropping the time of day this log entry
    // happened at, unlike every sibling save in this file (saveVerifyAction,
    // etc.), which all use dmyTime for exactly this reason.
    const dateStr = dmyTime(new Date(timestamp));
    const newEntry = `${dateStr} | ${issue || ''} | ${remarks || ''} | ${userEmail || ''}`;
    const cur = safeStr(rows[targetRow - 2][30]); // AE, 0-based index 30
    const next = cur && cur.trim() !== '' ? `${cur}\n${newEntry}` : newEntry;

    const updates = [{ range: `'${SHEETS.NEW_LEASE}'!AE${targetRow}`, values: [[next]] }];
    await batchUpdateValues(updates);
    // Position-keyed — see saveVerifyAction's identical note above.
    await patchMongoMirrorRow(SHEETS.NEW_LEASE, targetRow, updates);
    cacheRemove(VERIFY_CACHE_KEY);
    return 'OK';
  });
}

/* ===================== RETURN DASHBOARD (send-back log across ALL rows) ===================== */

/* ===================== AGREEMENT FORM (edit lease fields in place) ===================== */

// Column 0 (Container No, the lookup key) and the internal bookkeeping
// columns (Z:AJ — action status/log/doc urls/billing) are never editable
// through this endpoint, regardless of what the caller sends.
const EDITABLE_COL_MAX = 25; // matches displayIndices' highest non-detail index used on the Verify screen

export async function updateVerifyLeaseFields(containerNo, fieldUpdates, userEmail, knownRow) {
  return withSheetLock(SHEETS.NEW_LEASE, async () => {
    if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');
    if (!fieldUpdates || typeof fieldUpdates !== 'object' || !Object.keys(fieldUpdates).length) {
      throw new AppError('No field updates provided');
    }

    const { headers, rows } = await getSheetData(SHEETS.NEW_LEASE);
    const rn = _resolveNewLeaseRow(containerNo, rows, knownRow);
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
    // Position-keyed — see saveVerifyAction's identical note above.
    await patchMongoMirrorRow(SHEETS.NEW_LEASE, rn, updates);

    // Audit trail entry in the same follow-up log the Verify detail page's
    // Follow-up Log reads — written in the legacy 3-part (no-issue) shape so
    // it shows in that history without also counting as a "send back" on the
    // Return Dashboard (which only counts 4-part entries with an issue).
    const dateStr = dmyTime(new Date());
    const newEntry = `${dateStr} | Agreement data updated (${changedLabels.join(', ')}) | ${userEmail || ''}`;
    const srcRow = rows[rn - 2] || [];
    const cur = safeStr(srcRow[30]);
    const next = cur && cur.trim() !== '' ? `${cur}\n${newEntry}` : newEntry;
    await updateCell(SHEETS.NEW_LEASE, rn, 30, next);
    cacheRemove(VERIFY_CACHE_KEY);

    return 'OK';
  });
}

export async function saveVerifyDocument(containerNo, docType, url, userEmail, knownRow) {
  return withSheetLock(SHEETS.NEW_LEASE, async () => {
    if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');

    const { rows } = await getSheetData(SHEETS.NEW_LEASE, undefined, 'A1:A');
    if (!rows.length) throw new AppError('No data rows');

    const targetRow = _resolveNewLeaseRow(containerNo, rows, knownRow);
    if (targetRow === -1) throw new AppError(`Not found: ${containerNo}`);

    const col0 = docType === 'po' ? 31 : 32; // AF=31, AG=32 (0-based)
    await updateCell(SHEETS.NEW_LEASE, targetRow, col0, url || '');
    cacheRemove(VERIFY_CACHE_KEY);
    return 'OK';
  });
}
