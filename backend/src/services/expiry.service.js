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
import { patchMongoMirrorRow, getSheetDataFromMongo, getMongoRowsWithKeys } from './mongoSheetData.service.js';
import { getCollection } from './mongo.service.js';
import { enqueueSheetReplay } from './outbox.service.js';
import { uploadToDrive, extractFileId, deleteFromDrive } from './googleDrive.service.js';
import { safeStr, buildDisplayRow, parseDate, formatDateVal, dmyTime } from '../utils/format.js';
import { withSheetLock } from '../utils/sheetMutex.js';
import { checkActionPermission } from './permissions.service.js';
import { AppError, notFound } from '../utils/AppError.js';
import { SHEETS } from '../config/sheets.config.js';
import { cacheGetOrLoad, cacheRemove, cacheRemoveByPrefix } from '../utils/memoryCache.js';
import { normKey as _normKey, splitContainers as _splitContainers } from '../utils/normalize.js';
import { salePersonScopeFor, matchesSalePersonScope } from './salePersonAccess.service.js';
import { getSalePersonResolver } from './salesCrmLeads.service.js';
import { sendMail } from './email.service.js';

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
  // cacheGetOrLoad: this reads TWO sheets and is called on every Lease
  // Expiry page load — several tabs/users opening it in the same moment
  // used to mean that many independent copies of both reads.
  return cacheGetOrLoad(EXPIRY_ORDMAP_CACHE_KEY, EXPIRY_ORDMAP_TTL_SECS, async () => {
    const map = {};
    for (const sheetName of EXPIRY_ORDER_SOURCES) {
      try {
        // Read-only map-building, no write ever derives a row number from
        // this read — safe to serve from the Mongo mirror.
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
    return map;
  });
}

export const DEPLOYED_RAW_CACHE_KEY = 'deployed_raw_v1';
const DEPLOYED_RAW_TTL_SECS = 30;

/** The Deployed sheet's raw values, shared across every filterType and
 *  every caller — added 2026-08-26. My Task calls this function twice in
 *  one load ('pending' then 'documents'), each of which used to
 *  independently re-read the same sheet; callers filter/scope on top of
 *  this shared raw data, so caching it here costs nothing in correctness
 *  (nothing user-specific lives in the cache — scoping still happens fresh,
 *  per call, below) while cutting real duplicate reads. degradeOnError:
 *  a quota hit serves the last successful read instead of a hard failure —
 *  this is Lease Expiry's core data, worth a stale screen over a broken one. */
export async function _deployedRawValues() {
  return cacheGetOrLoad(DEPLOYED_RAW_CACHE_KEY, DEPLOYED_RAW_TTL_SECS, async () => {
    // Read-only display source (Lease Expiry / Deployed Summary / Detail /
    // My Task) — the write paths below (saveExpiryAction, completeDocStage,
    // completeDocumentStage) always re-read this sheet LIVE and re-resolve
    // their target row fresh, so this cached/Mongo copy never feeds a write.
    const { values } = await getSheetDataFromMongo(SHEETS.DEPLOYED);
    return { values };
  }, { degradeOnError: true });
}

export async function getExpiryDataByFilter(filterType, user) {
  const { values, _stale, _staleSince } = await _deployedRawValues();
  if (values.length < 2) return { headers: [], data: [], validColIdx: -1 };

  const allHeaders = padRow(values[0], 26);
  const allRows = values.slice(1).map((r) => padRow(r, 26));

  let colIdx = -1;
  for (let h = 0; h <= 14; h++) {
    if (allHeaders[h] && String(allHeaders[h]).toLowerCase().indexOf('valid') !== -1) { colIdx = h; break; }
  }
  if (colIdx === -1) return { headers: allHeaders.slice(0, 15), data: [], validColIdx: -1 };

  /* PO Validity — a SECOND, independent expiry date (col M, "PO Validity").
     The header loop above matches the FIRST column containing "valid" and
     stops there (Agreement Valid Upto, col H) — PO Validity contains "valid"
     too but was never reached, so a container whose PO was about to lapse
     while its agreement still had months left showed as "Safe" instead of
     due for renewal. Searched separately, by a name that can't collide with
     the agreement column. */
  let poValidIdx = -1;
  for (let h = 0; h <= 14; h++) {
    const hd = String(allHeaders[h] || '').trim().toLowerCase();
    if (hd.indexOf('po') !== -1 && hd.indexOf('valid') !== -1) { poValidIdx = h; break; }
  }

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
  for (let ri = 0; ri < allRows.length; ri++) {
    const row = allRows[ri];
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
    const poExpDate = poValidIdx >= 0 ? parseDate(row[poValidIdx]) : null;

    /* Renewal urgency is driven by whichever of the two dates is CLOSER —
       a container due for renewal because its PO lapses in 5 days is just
       as urgent as one whose agreement lapses in 5 days, and must show that
       way even if the other date is months out. Whichever date is present
       and sooner wins; a blank cell simply doesn't compete. */
    const daysUntil = (d) => (d ? Math.ceil((d - today) / 86400000) : null);
    const agrDays = daysUntil(expDate);
    const poDays = daysUntil(poExpDate);
    let days = '';
    if (agrDays !== null && poDays !== null) days = Math.min(agrDays, poDays);
    else if (agrDays !== null) days = agrDays;
    else if (poDays !== null) days = poDays;

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
    /* +2: allRows is values.slice(1) (header stripped), so index 0 is sheet
       row 2. Used by the Off-Lease action to address this EXACT Deployed
       row — see _lookupDeployedForOffLease's doc comment on the backend for
       why a container-number-only lookup there isn't safe (a returned
       lease's old row stays on the sheet, not deleted, so a container can
       have more than one row and a plain search can grab the wrong one). */
    const item = { row: displayRow, daysLeft: days, band, actionDate: safeStr(vVal), actionStatus: safeStr(wVal), _rowNum: ri + 2 };
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
  return {
    headers: displayHeaders, data: finalData, validColIdx: (colIdx >= 1 ? colIdx + 1 : colIdx),
    ...(_stale ? { _stale, _staleSince } : {})
  };
}

/**
 * `knownRow` (1-based Deployed sheet row): when given, addresses that EXACT
 * row directly instead of searching — Container No is NOT unique on
 * Deployed (a container re-leased after an earlier cycle keeps its old row
 * — see mongoSheetMapping.js's fullRefresh note on this sheet), so a plain
 * "first row matching this container" search can silently grab a stale,
 * already-superseded row. Confirmed 2026-08-29: GRMU3707464 and TRIU6632949
 * both carry multiple Deployed rows for different lease cycles; every
 * Lease Expiry action below used to resolve by container number alone.
 * Verified against `containerNo` first, so a stale/out-of-range reference
 * still fails loudly rather than silently writing under the wrong row.
 *
 * HARDENED 2026-08-31 (user directive, after the identical bug class
 * resurfaced in Off-Lease Tracking: this must never silently recur
 * anywhere): omitting knownRow is safe ONLY when the container genuinely
 * has one Deployed row — first-match is used in that case exactly as
 * before. A SECOND row for the same container now throws a clear,
 * actionable error instead of silently picking whichever comes first; see
 * offlease.service.js's _resolveOlRow for the identical fix and reasoning.
 */
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

/** Same as _resolveDeployedRow but against the Mongo-mirrored, position-keyed
 *  (`row_<i>`) docs the Fast paths read — used by completeDocumentStageFast /
 *  saveExpiryActionFast. Same 2026-08-31 hardening applies. */
function _resolveDeployedMongoDoc(containerNo, docs, knownRow) {
  if (knownRow != null) {
    const doc = docs.find((d) => d.key === `row_${knownRow - 2}`);
    if (!doc || String(doc.row[0]) != containerNo) { // eslint-disable-line eqeqeq
      throw new AppError(`Deployed sheet row ${knownRow} no longer matches ${containerNo} — it may have changed. Refresh and try again.`);
    }
    return doc;
  }
  const allMatches = docs.filter((d) => String(d.row[0]) == containerNo); // eslint-disable-line eqeqeq
  if (allMatches.length > 1) {
    throw new AppError(`${containerNo} has ${allMatches.length} Deployed sheet records — open it from its own list row (not by container number alone) so the exact one can be targeted.`);
  }
  return allMatches[0];
}

/* =============================================
   uploadAndSaveDeployedDocument — LMS.js 1408-1439
   (extractFileId(url) itself is NOT re-defined here — the shared,
   already-ported googleDrive.service.js version is used instead, per the
   porting instructions.)
============================================= */
export async function uploadAndSaveDeployedDocument(base64Data, mimeType, fileName, containerNo, docType, callerEmail, knownRow) {
  await checkActionPermission('document', callerEmail);
  let url = '';
  try {
    url = await uploadToDrive(base64Data, mimeType, fileName);
    const result = await withSheetLock(SHEETS.DEPLOYED, async () => {
      const rows = await getRange(SHEETS.DEPLOYED, 'A2:A');
      if (!rows.length) throw new AppError('No data rows');
      const targetRow = _resolveDeployedRow(containerNo, rows, knownRow);
      if (targetRow === -1) throw notFound(`Not found: ${containerNo}`);
      const col0 = String(docType || '').trim().toLowerCase() === 'po' ? 24 : 25; // Y=24, Z=25 (0-based)
      await updateCell(SHEETS.DEPLOYED, targetRow, col0, url || '');
      await patchMongoMirrorRow(SHEETS.DEPLOYED, targetRow, [
        { range: `'${SHEETS.DEPLOYED}'!${colLetter(col0)}${targetRow}`, values: [[url || '']] }
      ]);
      // Same fix as renewLeaseWithAgreement/updateLeasePeriod/completeDocStage
      // — a directly-reachable write (not just an async replay target), so
      // without this the Documents tab's own PO/Agreement link column could
      // read stale for up to 30s right after the upload it's meant to show.
      cacheRemove(DEPLOYED_RAW_CACHE_KEY);
      cacheRemoveByPrefix('mytasks_v1'); // see saveExpiryActionFast's comment below — same sidebar-badge staleness class
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
export async function completeDocumentStage(containerNo, callerEmail, knownRow) {
  await checkActionPermission('document', callerEmail);
  return withSheetLock(SHEETS.DEPLOYED, async () => {
    if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');
    const { rows } = await getSheetData(SHEETS.DEPLOYED, undefined, 'A2:Z');
    if (!rows.length) throw new AppError('No data rows');

    const targetRow = _resolveDeployedRow(containerNo, rows, knownRow);
    if (targetRow === -1) throw notFound(`Not found: ${containerNo}`);
    const matched = rows[targetRow - 2];
    if (String(matched[22] || '').trim().toLowerCase() !== 'documents pending') return 'INVALID_STATE';
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

/**
 * Mongo-first fast path for completeDocumentStage — same design as
 * offlease.service.js's saveOffLeaseStageFast (see its header comment).
 * Decides against Mongo (already the read source), patches the Mongo doc
 * directly, then enqueues a replay of the ORIGINAL completeDocumentStage
 * above to make the same change on the real Google Sheet in the background.
 */
export async function completeDocumentStageFast(containerNo, callerEmail, knownRow) {
  await checkActionPermission('document', callerEmail);
  if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');

  const docs = await getMongoRowsWithKeys(SHEETS.DEPLOYED);
  const found = _resolveDeployedMongoDoc(containerNo, docs, knownRow);
  if (!found) throw notFound(`Not found: ${containerNo}`);
  if (String(found.row[22] || '').trim().toLowerCase() !== 'documents pending') return 'INVALID_STATE';
  if ((!found.row[24] || String(found.row[24]).trim() === '') && (!found.row[25] || String(found.row[25]).trim() === '')) {
    return 'MISSING_PO_OR_AGR';
  }

  await getCollection(SHEETS.DEPLOYED).updateOne({ key: found.key }, { $set: { 'row.21': '', 'row.22': '', updatedAt: new Date() } });
  cacheRemove(DEPLOYED_RAW_CACHE_KEY); // so the very next read (this page's own reload) sees it instantly, not up to 30s later
  // BUG FOUND AND FIXED 2026-09-03: this changes column W, the exact thing
  // tasks.service.js's getMyTasks() counts for the sidebar's "Renew &
  // Document" badge (renewPending) — but that whole counts object sits
  // behind its OWN 90s cache (mytasks_v1:<scope>), completely separate from
  // DEPLOYED_RAW_CACHE_KEY above, and nothing was busting it. Confirmed live:
  // the page's own KPI showed 8 while the sidebar badge still showed a
  // stale 6. Same fix pattern as the two-layer mongo_raw_v1 cache bug found
  // earlier today — a write like this must bust every cache layer sitting
  // between it and something that reads it, not just the nearest one.
  cacheRemoveByPrefix('mytasks_v1');
  // Pass the RESOLVED row through to the replay (derived from found.key when
  // knownRow wasn't given), not containerNo alone — so the live write a few
  // seconds later targets the exact same row this Fast patch just did, even
  // if a re-search by container number could land differently by then.
  const resolvedRow = knownRow ?? (parseInt(found.key.replace('row_', ''), 10) + 2);
  await enqueueSheetReplay('expiry.completeDocumentStage', [containerNo, callerEmail, resolvedRow], { actor: callerEmail });
  return 'OK';
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
export async function saveExpiryAction(rowId, timestamp, status, callerEmail, knownRow) {
  await checkActionPermission('expiry', callerEmail);
  return withSheetLock(SHEETS.DEPLOYED, async () => {
    if (!rowId || String(rowId).trim() === '') throw new AppError('Container number is required');

    const { rows } = await getSheetData(SHEETS.DEPLOYED);
    if (!rows.length) throw new AppError('No data rows');

    const targetRow = _resolveDeployedRow(rowId, rows, knownRow);
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

/**
 * Mongo-first fast path for saveExpiryAction — the Lease Expiry page's main
 * Renew/Off-Lease decision button, and the exact action that used to hit the
 * live-Sheets rate limit on this page. Same design as
 * offlease.service.js's saveOffLeaseStageFast: decide + patch Mongo
 * instantly, replay the ORIGINAL saveExpiryAction against the real sheet in
 * the background (env.outboxPollMs later, not instantly).
 */
export async function saveExpiryActionFast(rowId, timestamp, status, callerEmail, knownRow) {
  await checkActionPermission('expiry', callerEmail);
  if (!rowId || String(rowId).trim() === '') throw new AppError('Container number is required');

  const docs = await getMongoRowsWithKeys(SHEETS.DEPLOYED);
  const found = _resolveDeployedMongoDoc(rowId, docs, knownRow);
  if (!found) throw notFound(`Not found: ${rowId}`);
  if (found.row[21] && String(found.row[21]).trim() !== '') return 'ALREADY_PROCESSED';

  const dmy = dmyTime(new Date(timestamp));
  await getCollection(SHEETS.DEPLOYED).updateOne(
    { key: found.key },
    { $set: { 'row.21': dmy, 'row.22': status || '', updatedAt: new Date() } }
  );
  cacheRemove(DEPLOYED_RAW_CACHE_KEY); // so the very next read (this page's own reload) sees it instantly, not up to 30s later
  cacheRemoveByPrefix('mytasks_v1'); // see completeDocumentStageFast's identical note above — this also changes column W
  // Resolved row through to the replay — see completeDocumentStageFast's
  // identical note above.
  const resolvedRow = knownRow ?? (parseInt(found.key.replace('row_', ''), 10) + 2);
  await enqueueSheetReplay('expiry.saveExpiryAction', [rowId, timestamp, status, callerEmail, resolvedRow], { actor: callerEmail });
  return 'OK';
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
    // Read-only report, no write follows — safe for the Mongo mirror.
    ({ rows } = await getSheetDataFromMongo(SHEETS.NEW_LEASE));
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

export async function completeDocStage(containerNo, renewedDate, validTill, signedCopyUrl, remarks, userEmail, poNo, poFileUrl, billingCycle, callerEmail, poValidity, knownRow) {
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

    const targetRow = _resolveDeployedRow(containerNo, rows, knownRow);
    if (targetRow === -1) throw notFound(`Not found: ${containerNo}`);
    const matchedRow = rows[targetRow - 2];
    if (String(matchedRow[22] || '').trim().toLowerCase() !== 'documents pending') return 'INVALID_STATE';

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
    /* BUG FOUND AND FIXED 2026-09-03: this write clears V/W (status) so the
       container drops out of the Documents tab back to the general Pending
       list — but unlike this file's own completeDocumentStageFast/
       saveExpiryActionFast, it never busted the 30s _deployedRawValues()
       cache. The write succeeded and the Mongo mirror was patched, but the
       Renew & Document page's own post-submit reload (within that same 30s
       window, which it always is) kept reading the pre-write snapshot —
       reads as "nothing happened" until the cache aged out on its own. */
    cacheRemove(DEPLOYED_RAW_CACHE_KEY); // so the very next read (this page's own reload) sees it instantly, not up to 30s later
    cacheRemoveByPrefix('mytasks_v1'); // see completeDocumentStageFast's identical note above — this also changes column W

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
   first use. Never throws — a logging failure must not block the real renewal.
   ALWAYS APPENDS — never looks up or overwrites a prior row for the same
   container (explicit requirement 2026-08-25 — see the identical note on
   verify.service.js's own copy of this function, which both write-paths
   must agree with since they write the same sheet). */
async function _logRenewal(info) {
  try {
    await insertSheetIfMissing(RENEWAL_LOG_SHEET, RENEWAL_LOG_HEADERS);
    const { headers: curHeaders } = await getSheetData(RENEWAL_LOG_SHEET, undefined, 'A1:1');
    if (curHeaders.length < RENEWAL_LOG_HEADERS.length) {
      const missing = RENEWAL_LOG_HEADERS.slice(curHeaders.length);
      await updateRange(RENEWAL_LOG_SHEET, `${colLetter(curHeaders.length)}1:${colLetter(RENEWAL_LOG_HEADERS.length - 1)}1`, [missing]);
    }
    const stamp = new Date().toISOString();
    await appendRow(RENEWAL_LOG_SHEET, [
      stamp, info.container || '', info.clientName || '', info.poNo || '',
      info.poFileUrl || '', info.agreementUrl || '', info.validTill || '', info.userEmail || '',
      info.oldPoNo || '', info.oldPoFileUrl || '', info.oldAgreementUrl || ''
    ]);
    // Same try/catch as the log write above — a mail failure must not be
    // mistaken for the renewal itself failing, and this only ever fires
    // once the append has actually succeeded.
    await _sendRenewalNotification(stamp, info);
  } catch (e) { console.error('[RENEWAL-LOG]', e.message); }
}

/** Vertical table, same convention as offlease.service.js's
 *  _sendOffLeaseNotification — one row per RENEWAL_LOG_HEADERS column,
 *  values exactly as just appended above. */
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
