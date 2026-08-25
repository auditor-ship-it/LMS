/**
 * Port of LMS.js lines 872-1103: getApproveData, runAutoApproval,
 * revertAutoApproved, saveActionData, saveApproveLeaseByRow, plus the
 * internal helper _expiryOrderNoMap. (This file used to also own
 * _olStageCounts, the Off-Lease stage-count helper My Task called — removed
 * 2026-08-25, replaced by offlease.service.js's getOffLeaseStageCounts.)
 *
 * _expiryOrderNoMap is exported even though only used internally by this
 * migration slice — Lease Expiry reuses it exactly as the original did (see
 * MIGRATION_MAP.md).
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
import { SHEETS } from '../config/sheets.config.js';
import { safeStr, buildDisplayRow } from '../utils/format.js';
import { normKey, splitContainers } from '../utils/normalize.js';
import { withSheetLock } from '../utils/sheetMutex.js';
import { AppError } from '../utils/AppError.js';
import { cacheGet, cachePut } from '../utils/memoryCache.js';
import { _findOlColumnMulti } from './offlease.service.js';
import { parseStamp } from './offleaseSla.service.js';

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
 * doWrite=false (default, page-load): read-only, no sheet write. The actual
 * auto-approve WRITE only happens when doWrite=true (runAutoApproval / an
 * explicit manual re-run) — that path computes row numbers positionally
 * from this same read and writes them straight back to the live sheet
 * (acWrites below). Both paths read live Sheets (SHEETS-FIRST, reverted
 * 2026-08-21).
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

/* ---------------- LEASE-CYCLE BOUNDARY ----------------
 *
 * Going Off-Lease CLOSES a container+client approval cycle. If that pair is
 * later re-leased, its first entry is a new lease and must go back through a
 * human — otherwise a decision made about a lease that ended months ago would
 * keep auto-approving rows for a completely new one.
 *
 * Two sources, unioned, because neither alone is complete:
 *   - Off-Lease Tracking, the workflow record. Carries the client NAME, but
 *     only for containers that actually entered the workflow (38 rows).
 *   - Deployed, whose Status column is the broader "this box is off-lease"
 *     flag (40 rows, 3 of them with no tracking row at all).
 *
 * Every column is located BY HEADER, never by position: both sheets have had
 * columns inserted and deleted by hand, and Off-Lease Tracking is currently
 * 289 columns against a live 212, so a positional read would silently take a
 * neighbouring column and mis-date the boundary.
 */
const OL_CYCLE_CACHE_KEY = 'approve_offlease_cycle_v1';

/** Container -> the off-lease events recorded against it, each with the client
 *  it was leased to and when the cycle closed. */
export async function _offLeaseCycleIndex() {
  const hit = cacheGet(OL_CYCLE_CACHE_KEY);
  if (hit) return hit;

  const byContainer = new Map();
  const add = (container, code, name, stamp) => {
    const key = normKey(container);
    const ts = parseStamp(stamp);
    if (!key || !ts) return; // an undated event cannot bound a cycle
    if (!byContainer.has(key)) byContainer.set(key, []);
    byContainer.get(key).push({
      code: String(code || '').trim().toUpperCase(),
      name: normClientName(name),
      ts: ts.getTime()
    });
  };

  try {
    const { headers, rows } = await getSheetData(SHEETS.OFF_LEASE_TRACKING);
    const cCode = _findOlColumnMulti(headers, ['client code']);
    const cName = _findOlColumnMulti(headers, ['client name']);
    const cDate = _findOlColumnMulti(headers, ['ol intimation date', 'intimation date']);
    const cFallback = _findOlColumnMulti(headers, ['stage 1 timestamp']);
    for (const r of rows) {
      if (!safeStr(r[0]).trim()) continue;
      /* Intimation date is when the off-lease began; Stage 1's timestamp is
         when it was recorded. Either dates the boundary — prefer the former. */
      add(r[0], cCode >= 0 ? r[cCode] : '', cName >= 0 ? r[cName] : '',
        (cDate >= 0 ? safeStr(r[cDate]).trim() : '') || (cFallback >= 0 ? r[cFallback] : ''));
    }
  } catch (e) {
    console.error('[APPROVE-CYCLE] off-lease tracking read failed:', e?.message || e);
  }

  try {
    const { headers, rows } = await getSheetData(SHEETS.DEPLOYED);
    /* 'Customer Name' here, not 'Client Name' — this sheet names the column
       differently from the other two, and matching on /client/ alone picks up
       'Client Code' instead and compares a code against a name. */
    const cName = _findOlColumnMulti(headers, ['customer name', 'client name']);
    const cCode = _findOlColumnMulti(headers, ['client code']);
    const cSts = _findOlColumnMulti(headers, ['status']);
    const cUpd = _findOlColumnMulti(headers, ['update']);
    if (cSts >= 0 && cUpd >= 0) {
      for (const r of rows) {
        if (!/off[\s-]?lease/i.test(safeStr(r[cSts]))) continue;
        add(r[0], cCode >= 0 ? r[cCode] : '', cName >= 0 ? r[cName] : '', r[cUpd]);
      }
    }
  } catch (e) {
    console.error('[APPROVE-CYCLE] deployed read failed:', e?.message || e);
  }

  cachePut(OL_CYCLE_CACHE_KEY, byContainer, 300); // 5 min, same as _expiryOrderNoMap
  return byContainer;
}

/**
 * When this container+client pair most recently went off-lease, as epoch ms —
 * 0 if it never has.
 *
 * The client is matched on its CODE when both sides carry one (an exact
 * identifier, immune to the punctuation drift between sheets) and on the
 * normalised name otherwise. A pair whose client matches neither is a
 * different lease and does not bound this one — per the rule that ABC123 with
 * Client A and ABC123 with Client B are two separate combinations.
 */
export function _cycleClosedAt(cycleIndex, container, clientCode, clientName) {
  const events = cycleIndex.get(normKey(container));
  if (!events?.length) return 0;
  const code = String(clientCode || '').trim().toUpperCase();
  const name = normClientName(clientName);
  let latest = 0;
  for (const e of events) {
    const sameClient = (code && e.code && code === e.code) || (name && e.name && name === e.name);
    if (sameClient && e.ts > latest) latest = e.ts;
  }
  return latest;
}

export async function getApproveData(doWrite) {
  const { headers: rawHeaders, rows: rawRows } = await getSheetData(SHEETS.OPERATION);
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
  /* HISTORY of container + client pairs, built from the WHOLE sheet — every
     row, every month, not just recent ones or the row above.

     A pair counts as history only once it has been APPROVED. Mere existence is
     not enough: two entries can be created in the same batch before anyone has
     looked at either, and treating the first as history would auto-approve the
     second while the first is still awaiting the human decision that the whole
     rule exists to require.

     An AUTO-approval never seeds history, so a chain cannot bootstrap itself —
     every recurring pair traces back to exactly one manual decision. */
  /* A manual approval seeds history only for the cycle it belongs to. Once the
     pair has gone off-lease, every approval made BEFORE that closes with it,
     so a re-lease of the same container to the same client starts over at
     manual — and a later manual approval (the new cycle's first entry) seeds
     the new cycle exactly as the first one did.

     An approval that cannot be dated is not credited against a pair that has
     an off-lease event: there is no way to tell which side of the boundary it
     falls on, and manual is the safe answer. All 435 manual approvals on the
     sheet today carry a parseable date, so this discards nothing in practice. */
  const cycleIndex = await _offLeaseCycleIndex();
  const approvedPairs = new Set();
  for (let i = 0; i < n; i++) {
    if (String(allRows[i][29] || '').trim().toLowerCase() !== 'approved') continue;
    if (String(allRows[i][30] || '').trim().toLowerCase() === 'auto-approved') continue;
    /* Multi-container cells: each container is history in its own right. */
    /* normClientName (not a bare trim+lowercase) so "ABC Ltd", "ABC  Ltd"
       and "abc.ltd." all resolve to the same key -- matches the
       normalisation _cycleClosedAt already applies above, and closes a real
       gap: extra internal spaces or punctuation used to be able to split
       one client into two separate history keys. */
    const client = normClientName(allRows[i][2]);
    if (!client) continue;
    const approvedAt = parseStamp(allRows[i][28]);
    for (const p of splitContainers(String(allRows[i][0] || ''))) {
      const cn = normKey(p);
      if (!cn) continue;
      const closedAt = _cycleClosedAt(cycleIndex, p, allRows[i][1], allRows[i][2]);
      if (closedAt && !(approvedAt && approvedAt.getTime() > closedAt)) continue;
      approvedPairs.add(`${cn}|${client}`);
    }
  }

  const now = dmyTime(new Date());
  let autoCount = 0;
  const acWrites = [];
  for (let i = 0; i < n; i++) {
    const cn = String(allRows[i][0] || '').trim();
    if (!cn) continue;
    if (String(allRows[i][29] || '').trim().toLowerCase() === 'approved') continue;
    const client = normClientName(allRows[i][2]);

    /* Multi-container cell safe: EVERY part must have approval history under
       this same client. One unknown container in a multi-container row makes
       the whole row a human decision — approving the row approves all of it. */
    const parts = splitContainers(cn);

    /* PRIOR MANUAL APPROVAL is the only thing that auto-approves a row.
     *
     * The first entry for a container + client is a new lease and needs a
     * person; every later month for that same pair is the recurring billing of
     * a relationship someone has already signed off.
     *
     * A "container is on the Deployed sheet" rule was tried here and removed:
     * it matched 1,208 of 1,216 rows, so first entries auto-approved too and
     * the manual gate effectively disappeared. Being deployed says the box is
     * out on lease — it says nothing about whether anyone approved THIS row.
     *
     * approvedPairs is already scoped to the CURRENT lease cycle (see above),
     * so a pair whose last cycle ended at off-lease is absent from it and
     * lands back on manual, exactly as it did the first time round. */
    const hasHistory = client !== '' && parts.every((p) => approvedPairs.has(`${normKey(p)}|${client}`));

    if (!hasHistory) continue; // no prior manual approval for this pair -> manual

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
    /* Every row reaching this list is, by construction, a first-ever
       Container+Client pair -- anything with prior manual-approval history
       was auto-approved above and excluded. These fields make that fact
       explicit for the UI instead of leaving it implicit in the filter, per
       the approval-workflow audit-trail spec. Purely additive: existing
       consumers (tasks.service.js's `.data.length`, the frontend's
       `item.row`) read past new keys without needing to change. */
    finalData.push({
      row: buildDisplayRow(allRows[i], pick, hdr),
      _rowNum: i + 2,
      entryType: 'FIRST_ENTRY',
      approvalType: 'MANUAL',
      approvalStatus: 'PENDING',
      approvedBy: '',
      approvalReason: ''
    });
  }
  return { headers: displayHeaders, data: finalData, catColIdx: -1, autoApproved: autoCount };
}

/* AUTO-APPROVAL — leave fresh new leases alone, auto-approve the rest.
   Run from the Editor, or attach to an hourly trigger (see jobs/index.js TODO). */
/* ===================== APPROVAL HISTORY / AUDIT TRAIL ===================== */

/**
 * Audit-trail fields for one ALREADY-DECIDED Operation Sheet row.
 *
 * The distinction is read straight off the same two columns getApproveData
 * already trusts: AE (user) starting with "auto-approved" means the system
 * decided it, anything else means a person did. A row can only ever reach a
 * MANUAL decision as a first entry -- the pending list (above) excludes any
 * pair with prior manual-approval history before a human ever sees it, and
 * the hourly cron auto-approves it before that -- so a genuine manual AE
 * value is proof enough that this was a first entry without re-deriving
 * approvedPairs/hasHistory a second time here.
 */
function decidedEntryFields(row) {
  const status = String(row[29] || '').trim().toLowerCase();
  const user = String(row[30] || '').trim();
  const isAuto = user.toLowerCase().indexOf('auto-approved') === 0;

  if (isAuto) {
    return {
      entryType: 'REPEAT_ENTRY',
      approvalType: 'AUTO',
      approvalStatus: 'APPROVED',
      approvedBy: 'SYSTEM',
      approvalReason: 'Repeat Container + Client combination found in previous Operation Sheet entry.'
    };
  }
  return {
    entryType: 'FIRST_ENTRY',
    approvalType: 'MANUAL',
    approvalStatus: status === 'rejected' ? 'REJECTED' : 'APPROVED',
    approvedBy: user,
    approvalReason: ''
  };
}

/**
 * Decided Operation Sheet rows (Approved or Rejected), each annotated with
 * the audit-trail fields above. Read-only, no sheet lock needed.
 */
export async function getApprovalHistory() {
  const { rows: rawRows } = await getSheetData(SHEETS.OPERATION);
  if (!rawRows.length) return { data: [] };

  const allRows = rawRows.map((r) => padWidth(r, 31));
  const data = [];
  for (let i = 0; i < allRows.length; i++) {
    const containerNo = String(allRows[i][0] || '').trim();
    if (!containerNo) continue;
    const status = String(allRows[i][29] || '').trim().toLowerCase();
    if (status !== 'approved' && status !== 'rejected') continue; // still pending -> the other screen

    data.push({
      _rowNum: i + 2,
      containerNo,
      clientCode: String(allRows[i][1] || '').trim(),
      clientName: String(allRows[i][2] || '').trim(),
      orderNo: String(allRows[i][3] || '').trim(),
      approvedAt: safeStr(allRows[i][28]).trim(),
      ...decidedEntryFields(allRows[i])
    });
  }

  // Newest decision first. parseStamp returns null for anything it can't
  // read, and those sort to the end rather than throwing.
  data.sort((a, b) => (parseStamp(b.approvedAt)?.getTime() || 0) - (parseStamp(a.approvedAt)?.getTime() || 0));
  return { data };
}

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

/* Off-Lease stage counts used to live here (_olStageCounts) — replaced
   2026-08-25 by offlease.service.js's getOffLeaseStageCounts, which runs the
   SAME queue logic (with the Gate-In/repair-skip/STAGE-10 bypasses) the
   Off-Lease tabs themselves use, instead of this function's own much older
   counter. That older version walked stages 1..8 in plain numeric order —
   not the actual workflow order 1->6->7->3->5->8 — and had no idea any of
   those bypasses existed, so the moment a container's progress depended on
   one (the normal case, not the exception), its status column stayed
   permanently blank to this function and every count past Stage 1 collapsed
   to 0 on My Task while the real Off-Lease tabs correctly showed pending
   work. See getOffLeaseStageCounts's doc comment for the full account. */
