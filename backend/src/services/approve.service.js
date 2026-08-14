/**
 * Port of LMS.js lines 872-1103: getApproveData, runAutoApproval,
 * revertAutoApproved, saveActionData, saveApproveLeaseByRow, plus internal
 * helpers _expiryOrderNoMap / _olStageCounts.
 *
 * _expiryOrderNoMap and _olStageCounts are exported even though only used
 * internally by this migration slice — later modules (Lease Expiry, My Task
 * dashboard) reuse them exactly as the original did (see MIGRATION_MAP.md).
 *
 * RECONCILE: expiry.service.js (a sibling migration pass, ported concurrently)
 * also has its own copy of _expiryOrderNoMap (same body, needed there as a
 * dependency of getExpiryDataByFilter). tasks.service.js currently imports
 * THIS copy for getMyTasks — pick one canonical home and re-export/import
 * from the other in a later integration pass rather than keeping two.
 *
 * getApproveData / runAutoApproval have NO checkActionPermission call in the
 * original (they were only ever invoked from the Apps Script editor or an
 * hourly time trigger, never through a permission-gated UI action) — that is
 * preserved here: their routes require a valid session but no specific
 * permission. See verify.service.js header for the date-write-format note
 * (dd/MM/yyyy text, not native Date objects) — the same convention is used
 * for the AC/timestamp columns here.
 */
import { getSheetData, updateRange, batchUpdateValues } from './googleSheets.service.js';
import { getSheetDataFromMongo } from './mongoSheetData.service.js';
import { SHEETS } from '../config/sheets.config.js';
import { safeStr, buildDisplayRow } from '../utils/format.js';
import { normKey, splitContainers } from '../utils/normalize.js';
import { withSheetLock } from '../utils/sheetMutex.js';
import { AppError } from '../utils/AppError.js';
import { cacheGet, cachePut } from '../utils/memoryCache.js';
import { OL_STAGE_INFO, _findOlColumnMulti } from './offlease.service.js';

function pad2(n) { return String(n).padStart(2, '0'); }
function dmyTime(d) {
  return `${safeStr(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function padWidth(arr, width) {
  const out = (arr || []).slice(0, width);
  while (out.length < width) out.push('');
  return out;
}

/* ===================== APPROVE LEASE SCREEN ===================== */

/**
 * doWrite=false (default, page-load): read-only, no sheet write -> fast, and
 * safe to serve from the Mongo mirror. The actual auto-approve WRITE only
 * happens when doWrite=true (runAutoApproval / an explicit manual re-run) —
 * that path computes row numbers positionally from this same read and writes
 * them straight back to the live sheet (acWrites below), so it MUST read live
 * Sheets too: a Mongo mirror's row order isn't guaranteed to match the live
 * sheet, and reusing its positions for a write would silently hit the wrong
 * row (see splendid-rolling-candy.md Phase 1a/1b). The list is still correct
 * either way because would-be-approved rows are filtered out in memory either way.
 */
/**
 * Client names for cross-sheet comparison — lower-cased with punctuation and
 * spacing removed, so "AAK India Pvt.Ltd" and "AAK INDIA PVT LTD" match.
 *
 * Deliberately NOT fuzzy: this decides whether a row skips human approval, so
 * a near-miss must fail to manual rather than guess. Suffix-stripping or edit
 * distance would risk auto-approving one client's row against another's.
 */
function normClientName(v) {
  return String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export async function getApproveData(doWrite) {
  const { headers: rawHeaders, rows: rawRows } = doWrite
    ? await getSheetData(SHEETS.OPERATION)
    : await getSheetDataFromMongo(SHEETS.OPERATION);
  if (!rawRows.length) return { headers: [], data: [], catColIdx: -1 };

  const hdr = padWidth(rawHeaders, 31);
  const allRows = rawRows.map((r) => padWidth(r, 31));
  const n = allRows.length;

  /* RECURRING-LEASE AUTO-APPROVAL: a container+client pair that already has
     at least one MANUALLY-approved row elsewhere in this sheet is a proven,
     recurring monthly lease relationship -> auto-approve subsequent rows for
     it without making someone re-click Approve every month. A pair with no
     prior manual-approval history is a genuinely new lease and stays manual.
     (Replaced the old "still unmoved in New Lease sheet" check 2026-08-08 —
     that check missed exactly this case: a container could have several
     already-approved rows here yet still have a live New Lease entry,
     wrongly keeping its next row manual every time.)
     Only a MANUAL approval seeds history (AE user is a real email, not
     "Auto-approved") — an auto-approval can never itself justify the next
     one, so every recurring chain still traces back to one human decision. */
  const approvedPairs = new Set();
  for (let i = 0; i < n; i++) {
    if (String(allRows[i][29] || '').trim().toLowerCase() !== 'approved') continue;
    if (String(allRows[i][30] || '').trim().toLowerCase() === 'auto-approved') continue;
    const cn = normKey(allRows[i][0]);
    const client = String(allRows[i][2] || '').trim().toLowerCase();
    if (cn && client) approvedPairs.add(`${cn}|${client}`);
  }

  /* DEPLOYED-SHEET MATCH — the second, independent way a row qualifies.
   *
   * A container+client already ON the Deployed sheet is an existing, live
   * deployment: this Operation row is the next billing cycle for a lease that
   * physically exists, so it auto-approves. A pair NOT on Deployed has never
   * gone out under that client — a genuinely new lease — and stays manual.
   *
   * This complements the approval-history rule rather than replacing it: a
   * first-ever lease still needs one human decision before deployment, and
   * after deployment the repeat cycles no longer do.
   *
   * Deployed columns are 0 = Container No, 1 = Customer Name; Operation is
   * 0 = Container No., 2 = Client Name — the two sheets name them differently.
   */
  const deployedPairs = new Set();
  try {
    const { rows: depRows } = await getSheetDataFromMongo(SHEETS.DEPLOYED);
    for (const r of depRows) {
      const client = normClientName(r[1]);
      if (!client) continue;
      /* Multi-container cells occur here too, so each part is indexed
         separately — otherwise a two-container deployment would only ever
         match a two-container Operation row written the same way. */
      for (const p of splitContainers(String(r[0] || ''))) {
        const cn = normKey(p);
        if (cn) deployedPairs.add(`${cn}|${client}`);
      }
    }
  } catch (e) {
    /* Fail CLOSED: with no Deployed data the pairs set stays empty, so nothing
       auto-approves on that basis and everything falls back to manual. The
       opposite default would approve rows because a read failed. */
    console.error('[AUTO-APPROVE] Deployed sheet unavailable — deployed-match rule inactive:', e?.message || e);
  }

  const now = dmyTime(new Date());
  let autoCount = 0;
  const acWrites = [];
  for (let i = 0; i < n; i++) {
    const cn = String(allRows[i][0] || '').trim();
    if (!cn) continue;
    if (String(allRows[i][29] || '').trim().toLowerCase() === 'approved') continue;
    const client = String(allRows[i][2] || '').trim().toLowerCase();
    const depClient = normClientName(allRows[i][2]);

    /* Multi-container cell safe: EVERY part must qualify under this same
       client. One unknown container in a multi-container row makes the whole
       row a human decision — approving the row approves all of it. */
    const parts = splitContainers(cn);

    const hasHistory = client !== '' && parts.every((p) => approvedPairs.has(`${normKey(p)}|${client}`));
    const isDeployed = depClient !== '' && parts.every((p) => deployedPairs.has(`${normKey(p)}|${depClient}`));

    if (!hasHistory && !isDeployed) continue; // new container+client -> manual

    allRows[i][28] = now;             // AC = timestamp
    allRows[i][29] = 'Approved';      // AD = status
    allRows[i][30] = 'Auto-approved'; // AE = user
    acWrites.push({ rowNum: i + 2, values: [now, 'Approved', 'Auto-approved'] });
    autoCount++;
  }
  if (acWrites.length && doWrite) { // write only from trigger/manual (not on load)
    await batchUpdateValues(acWrites.map((w) => ({ range: `'${SHEETS.OPERATION}'!AC${w.rowNum}:AE${w.rowNum}`, values: [w.values] })));
  }

  /* List: skip approved (incl auto) -> only FRESH new leases remain */
  const pick = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 24, 25];
  const displayHeaders = pick.map((ci) => safeStr(hdr[ci]));
  const finalData = [];
  for (let i = 0; i < n; i++) {
    if (!allRows[i][0] || String(allRows[i][0]).trim() === '') continue;
    if (String(allRows[i][29] || '').trim().toLowerCase() === 'approved') continue;
    finalData.push({ row: buildDisplayRow(allRows[i], pick, hdr), _rowNum: i + 2 });
  }
  return { headers: displayHeaders, data: finalData, catColIdx: -1, autoApproved: autoCount };
}

/* AUTO-APPROVAL — leave fresh new leases alone, auto-approve the rest.
   Run from the Editor, or attach to an hourly trigger (see jobs/index.js TODO). */
export async function runAutoApproval() {
  const r = await getApproveData(true); // true = perform the actual write
  const msg = `Auto-approved: ${r.autoApproved || 0} row(s). | Pending (new leases) left: ${r.data ? r.data.length : 0}`;
  console.log('[AUTO-APPROVE]', msg);
  return msg;
}

/* CLEANUP — revert rows accidentally set to "Auto-approved (renewal)" back to
   PENDING. For rows in Operation sheet where AE(31) User starts with
   "auto-approved", clear AC(29)/AD(30)/AE(31) -> they return to the Approve
   Lease list. */
export async function revertAutoApproved() {
  return withSheetLock(SHEETS.OPERATION, async () => {
    const { rows } = await getSheetData(SHEETS.OPERATION, undefined, 'A1:AE');
    if (!rows.length) return 'No data in Operation sheet.';
    let reverted = 0;
    const updates = [];
    for (let i = 0; i < rows.length; i++) {
      const user = String(rows[i][30] || '').trim().toLowerCase(); // AE, 0-based index 30
      if (user.indexOf('auto-approved') === 0) { // "auto-approved" or "auto-approved (renewal)"
        updates.push({ range: `'${SHEETS.OPERATION}'!AC${i + 2}:AE${i + 2}`, values: [['', '', '']] });
        reverted++;
      }
    }
    if (updates.length) await batchUpdateValues(updates);
    return `Reverted ${reverted} auto-approved row(s) -> back to Pending (manual approval).`;
  });
}

export async function saveActionData(containerNo, actionType, timestamp, status, userEmail) {
  return withSheetLock(SHEETS.OPERATION, async () => {
    if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');
    const { rows } = await getSheetData(SHEETS.OPERATION, undefined, 'A1:AD');
    if (!rows.length) throw new AppError('No data rows');

    let targetRow = -1;
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0]) == containerNo) { // eslint-disable-line eqeqeq
        if (actionType === 'approve' && rows[i][29] && String(rows[i][29]).trim().toLowerCase() === 'approved') return 'ALREADY_PROCESSED';
        targetRow = i + 2; break;
      }
    }
    if (targetRow === -1) throw new AppError(`Not found: ${containerNo}`);

    if (actionType === 'approve') {
      await updateRange(SHEETS.OPERATION, `AC${targetRow}:AE${targetRow}`, [[dmyTime(new Date(timestamp)), status, userEmail || '']]);
    }
    return 'OK';
  });
}

export async function saveApproveLeaseByContainer(containerNo, timestamp, status, userEmail) {
  return withSheetLock(SHEETS.OPERATION, async () => {
    if (!containerNo || String(containerNo).trim() === '') throw new AppError('Container number is required');

    const { rows } = await getSheetData(SHEETS.OPERATION, undefined, 'A1:AE');
    // Located by container number (not a client-cached row number) so a
    // stale/differently-ordered list read (e.g. from the Mongo mirror) can
    // never cause this write to land on the wrong row — see splendid-rolling-candy.md Phase 1a.
    //
    // A container number can legitimately repeat across multiple rows in
    // this sheet (same reasoning as mongoSheetMapping.js's fullRefresh note
    // on Operation sheet — confirmed 2026-08-08: TRIU6688779 had 5 rows, all
    // Order OR454, 4 already approved). Stopping at the FIRST name match
    // risked landing on an old already-approved duplicate and permanently
    // blocking the real pending row from ever being approved — scan past
    // already-approved matches for the first one that still needs a decision.
    let rn = -1;
    let foundAny = false;
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0]) != containerNo) continue; // eslint-disable-line eqeqeq
      foundAny = true;
      const st = String(rows[i][29] || '').trim().toLowerCase(); // AD, 0-based index 29
      if (st !== 'approved') { rn = i + 2; break; }
    }
    if (!foundAny) throw new AppError(`Not found: ${containerNo}`);
    if (rn === -1) return 'ALREADY_PROCESSED'; // every matching row is already approved

    await updateRange(SHEETS.OPERATION, `AC${rn}:AE${rn}`, [[dmyTime(new Date(timestamp)), status || '', userEmail || '']]);
    return 'OK';
  });
}

/* ===================== CONTAINER -> ORDER NO MAP ===================== */

/**
 * Container -> Order No, fetched from "Operation sheet" (col A = container,
 * header-detected Order No column), falling back to "New Lease" for
 * containers the Operation sheet does not carry.
 */
const EXPIRY_ORDER_SOURCES = [SHEETS.OPERATION, SHEETS.NEW_LEASE]; // priority order
const EXPIRY_ORDMAP_CACHE_KEY = 'expiry_ordmap_v1';

export async function _expiryOrderNoMap() {
  const hit = cacheGet(EXPIRY_ORDMAP_CACHE_KEY);
  if (hit) return hit;

  const map = {};
  for (const sourceName of EXPIRY_ORDER_SOURCES) {
    try {
      const { headers, rows } = await getSheetData(sourceName);
      if (!rows.length) continue;

      let ordCol = 3; // fallback: col D
      for (let h = 0; h < headers.length; h++) {
        const hd = String(headers[h] || '').trim().toLowerCase();
        if (hd.includes('order') && hd.includes('no')) { ordCol = h; break; }
      }

      for (const r of rows) {
        const o = safeStr(r[ordCol]).trim();
        if (!o) continue;
        for (const p of splitContainers(r[0])) {
          const k = normKey(p);
          if (k && !map[k]) map[k] = o; // first non-blank wins -> Operation sheet takes priority
        }
      }
    } catch (e) { /* never break the expiry screen */ }
  }

  cachePut(EXPIRY_ORDMAP_CACHE_KEY, map, 300); // 5-minute cache, matches original
  return map;
}

/* ===================== OFF-LEASE STAGE COUNTS ===================== */

/**
 * Off-Lease pending counts for Stage 1..8 + Pending Approval.
 * Wired to the now-ported Off-Lease Tracking module (offlease.service.js).
 *
 * Pure display counts, no write anywhere in this function — safe to read
 * from the Mongo mirror (same reasoning as offlease.service.js's own
 * getOffLeaseData/getOffLeaseApprovalData). Previously read live Sheets
 * directly; a Sheets quota hit silently zeroed every Off-Lease count on My
 * Task (the try/catch below swallows it) without affecting Off-Lease's own
 * tabs, which were already Mongo-backed — confirmed 2026-08-01 as the cause
 * of My Task showing 0 across every Off-Lease scorecard.
 */
export async function _olStageCounts() {
  const c = { s1: 0, s2: 0, s3: 0, s4: 0, s5: 0, s6: 0, s7: 0, s8: 0, approval: 0 };
  try {
    const { headers, rows } = await getSheetDataFromMongo(SHEETS.OFF_LEASE_TRACKING);
    if (!rows.length) return c;
    const apCol = _findOlColumnMulti(headers, ['intimation approval status', 'intimation appt status', 'approval status']);
    const s1Col = OL_STAGE_INFO[1].statusCol;
    for (const row of rows) {
      if (!row[0] || String(row[0]).trim() === '') continue;
      const appr = apCol >= 0 ? String(row[apCol] || '').trim().toLowerCase() : '';
      if (String(row[s1Col] || '').trim().toLowerCase() === 'completed' && appr === '') c.approval++;
      for (let st = 1; st <= 8; st++) {
        const info = OL_STAGE_INFO[st];
        if (String(row[info.statusCol] || '').trim() !== '') continue; // already done at this stage
        if (st > 1) {
          const prev = OL_STAGE_INFO[st - 1];
          if (String(row[prev.statusCol] || '').trim() === '') continue; // previous stage not done
          if (st === 2 && appr !== 'approved') continue; // Stage 2 needs approval
        }
        c['s' + st]++;
      }
    }
  } catch (e) { /* matches original: never throws, returns zeroed counts on any failure */ }
  return c;
}
