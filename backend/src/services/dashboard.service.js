/**
 * Port of LMS.js's Deployed Summary/Detail slice (also present in
 * backend/src/services/dashboard.service.js — copied here rather than
 * shared, per the "duplication over cross-app sharing" decision, see
 * splendid-rolling-candy.md). Only the two Deployed Summary functions are
 * ported — the original file's dashboard/report-suite functions depend on
 * Accounts & Collection's receivablesCategory.service.js, which doesn't
 * belong in this backend; Deployed Summary itself only ever reads
 * SHEETS.DEPLOYED, so it has no such dependency.
 */
import { safeStr, parseDate } from '../utils/format.js';
import { _expiryOrderNoMap, _resolveOrderNo, _deployedRawValues, getExpiryDataByFilter, _agreementStartDateMap, _resolveRenewalColumns } from './expiry.service.js';
import { getSheetDataFromMongo } from './mongoSheetData.service.js';
import { SHEETS } from '../config/sheets.config.js';

export function normalizeContainerType(rawType) {
  if (!rawType) return 'Other';
  const t = rawType.toString().trim().toLowerCase();
  if (t.indexOf('refer') !== -1) return 'Refer';
  if (t.indexOf('dry') !== -1) return 'Dry';
  if (t.indexOf('iso') !== -1 || t.indexOf('tank') !== -1) return 'ISO TANK';
  return rawType.toString().trim();
}

export async function getDeployedSummaryData() {
  // Shared cached read (expiry.service.js's _deployedRawValues) — Lease
  // Expiry, Deployed Summary and Deployed Detail all read this same sheet;
  // added 2026-08-26 so opening any of them doesn't cost its own live read.
  const { values, _stale, _staleSince } = await _deployedRawValues();
  const rows = values.slice(1);
  if (!rows.length) return { months: [], types: [], sizes: [], typeSizes: {}, rows: [] };

  const containers = [];
  let minDate = null;
  const typeSet = {}, sizeSet = {}, typeSizeSet = {};

  for (const row of rows) {
    if (!row[0] || String(row[0]).trim() === '') continue;

    const deployDate = parseDate(row[6]); // G = Deployed Date
    if (!deployDate) continue;

    const actionTimestamp = parseDate(row[21]); // V = Action Timestamp
    const actionStatus = safeStr(row[22]).toLowerCase(); // W = Action Status

    const type = normalizeContainerType(row[3]); // D = Type
    const size = safeStr(row[2]).trim() || 'Unknown'; // C = Size

    containers.push({
      deployDate,
      offLeaseDate: (actionStatus === 'off-lease' && actionTimestamp) ? actionTimestamp : null,
      type, size
    });
    typeSet[type] = true;
    sizeSet[size] = true;
    if (!typeSizeSet[type]) typeSizeSet[type] = {};
    typeSizeSet[type][size] = true;
    if (!minDate || deployDate < minDate) minDate = new Date(deployDate);
  }

  if (containers.length === 0 || !minDate) return { months: [], types: [], sizes: [], typeSizes: {}, rows: [] };

  const typePriority = ['Refer', 'Dry', 'ISO TANK'];
  let types = [];
  for (const tp of typePriority) if (typeSet[tp]) types.push(tp);
  types = types.concat(Object.keys(typeSet).filter((t) => typePriority.indexOf(t) === -1).sort());
  const sizes = Object.keys(sizeSet).sort();
  const typeSizes = {};
  for (const t of types) typeSizes[t] = typeSizeSet[t] ? Object.keys(typeSizeSet[t]).sort() : [];

  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const months = [];
  let cursor = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
  const endBound = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1);
  while (cursor < endBound) {
    months.push({
      label: `${MONTH_NAMES[cursor.getMonth()]} ${cursor.getFullYear()}`,
      start: new Date(cursor.getTime()),
      end: new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    });
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  months.reverse();
  if (months.length === 0) return { months: [], types, sizes, typeSizes, rows: [] };

  function emptyStat() {
    const s = { total: 0 };
    for (const t of types) s[t] = 0;
    return s;
  }
  function emptyTsMap() {
    const map = {};
    for (const t of types) {
      map[t] = { total: 0 };
      const szArr = typeSizes[t] || [];
      for (const sz of szArr) map[t][sz] = 0;
    }
    return map;
  }

  const summaryRows = [];
  for (const mObj of months) {
    const ms = mObj.start.getTime(), me = mObj.end.getTime();
    const opening = emptyStat(), addition = emptyStat(), deletion = emptyStat();
    const openingTs = emptyTsMap(), additionTs = emptyTsMap(), deletionTs = emptyTsMap();

    for (const ct of containers) {
      const dt = ct.deployDate.getTime();
      const ot = ct.offLeaseDate ? ct.offLeaseDate.getTime() : null;

      if (dt < ms && (ot === null || ot >= ms)) {
        opening.total++; opening[ct.type] = (opening[ct.type] || 0) + 1;
        openingTs[ct.type].total++; openingTs[ct.type][ct.size] = (openingTs[ct.type][ct.size] || 0) + 1;
      }
      if (dt >= ms && dt < me) {
        addition.total++; addition[ct.type] = (addition[ct.type] || 0) + 1;
        additionTs[ct.type].total++; additionTs[ct.type][ct.size] = (additionTs[ct.type][ct.size] || 0) + 1;
      }
      if (ot !== null && ot >= ms && ot < me) {
        deletion.total++; deletion[ct.type] = (deletion[ct.type] || 0) + 1;
        deletionTs[ct.type].total++; deletionTs[ct.type][ct.size] = (deletionTs[ct.type][ct.size] || 0) + 1;
      }
    }

    const net = { total: addition.total - deletion.total }, netTs = emptyTsMap();
    const closing = { total: opening.total + net.total }, closingTs = emptyTsMap();
    for (const tn of types) {
      net[tn] = (addition[tn] || 0) - (deletion[tn] || 0);
      netTs[tn].total = net[tn];
      closing[tn] = (opening[tn] || 0) + net[tn];
      closingTs[tn].total = closing[tn];
      const szArr = typeSizes[tn] || [];
      for (const sz of szArr) {
        netTs[tn][sz] = (additionTs[tn][sz] || 0) - (deletionTs[tn][sz] || 0);
        closingTs[tn][sz] = (openingTs[tn][sz] || 0) + (netTs[tn][sz] || 0);
      }
    }

    summaryRows.push({
      month: mObj.label,
      opening, addition, deletion,
      net, closing,
      _sz: { opening: openingTs, addition: additionTs, deletion: deletionTs, net: netTs, closing: closingTs }
    });
  }

  return {
    months: months.map((m) => m.label), types, sizes, typeSizes, rows: summaryRows,
    ...(_stale ? { _stale, _staleSince } : {})
  };
}

export async function getDeployedDetailData(monthLabel, category, typeFilter, sizeFilter) {
  const parts = monthLabel.trim().split(' ');
  const monthStr = parts[0], year = parseInt(parts[1], 10);
  const monthOrder = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const monthNum = monthOrder[monthStr];
  if (monthNum === undefined) return { containers: [] };
  const monthStart = new Date(year, monthNum, 1), monthEnd = new Date(year, monthNum + 1, 1);
  const ms = monthStart.getTime(), me = monthEnd.getTime();

  const { values } = await _deployedRawValues();
  const rows = values.slice(1);
  if (!rows.length) return { containers: [] };

  // SHEETS.DEPLOYED doesn't carry Order No directly — join it the same way
  // Lease Expiry does, via the cached container -> Order No map built from
  // Operation sheet / New Lease (see expiry.service.js).
  const ordMap = await _expiryOrderNoMap();
  // PO No / PO Validity — explicit request 2026-10-27 ("po no show for this
  // and po vaild show" / follow-up "PO Validity this is not shpoe for
  // deployed"): the exported "Deployed Containers" sheet had PO PDF (a
  // link) but never the actual PO Number or its own valid-till date.
  // Resolved by header (same helper getExpiryDataByFilter/completeDocStage
  // use), not a hardcoded index — this sheet's columns have shifted before.
  const { poCol, poValidityCol } = _resolveRenewalColumns(values[0] || []);
  // "Last Updated" / recently-changed flag — explicit request 2026-10-27
  // ("jo bhi edit hua hai usko highlight kar do... mai 10 din tak update
  // kiya uske baad download kiya tho woh highlight hona chahiye"): this
  // sheet has no true per-cell "last edited" metadata (the Sheets API
  // doesn't expose one, and a manual edit made directly in the spreadsheet
  // — outside this app — leaves no trace at all), so this is a PROXY: the
  // most recent of the three timestamps this app itself actually stamps on
  // a row (Renewal Submitted Date — every Save/Submit; Action Timestamp —
  // every Off-Lease action; Approval Date — Pushpa's Approve/Reject). A row
  // whose real sheet cell was hand-edited outside the app, with none of
  // these three touched, will NOT be caught by this — the digest email
  // says so explicitly (see deployedSummaryDigest.service.js).
  const RECENT_DAYS = 30;
  const recentCutoff = Date.now() - RECENT_DAYS * 86400000;

  const cleanType = typeFilter ? normalizeContainerType(typeFilter).toLowerCase() : '';
  const cleanSize = sizeFilter ? sizeFilter.toLowerCase().trim() : '';
  const containers = [];

  for (const row of rows) {
    if (!row[0] || String(row[0]).trim() === '') continue;
    const deployDate = parseDate(row[6]); // G = Deployed Date
    if (!deployDate) continue;

    const dt = deployDate.getTime();
    const actionTs = parseDate(row[21]); // V = Action Timestamp
    const actionSt = safeStr(row[22]).toLowerCase(); // W = Action Status
    const ot = (actionSt === 'off-lease' && actionTs) ? actionTs.getTime() : null;

    // D(3) = Type, C(2) = Size
    if (cleanType && normalizeContainerType(row[3]).toLowerCase() !== cleanType) continue;
    if (cleanSize && safeStr(row[2]).trim().toLowerCase() !== cleanSize) continue;

    let include = false, movement = '';
    if (category === 'opening') { include = (dt < ms && (ot === null || ot >= ms)); movement = 'Existing'; }
    else if (category === 'addition') { include = (dt >= ms && dt < me); movement = 'Addition'; }
    else if (category === 'deletion') { include = (ot !== null && ot >= ms && ot < me); movement = 'Deletion'; }
    else if (category === 'closing') { include = (dt < me && (ot === null || ot >= me)); movement = 'Existing'; }
    else if (category === 'net') {
      if (dt >= ms && dt < me) { include = true; movement = 'Addition'; }
      else if (ot !== null && ot >= ms && ot < me) { include = true; movement = 'Deletion'; }
    }
    if (!include) continue;

    const renewalSubmitted = parseDate(row[39]); // AN = Renewal Submitted Date
    const approvalDate = parseDate(row[42]);     // AQ = Approval Date
    const lastUpdatedDate = [renewalSubmitted, actionTs, approvalDate]
      .filter(Boolean)
      .sort((a, b) => b.getTime() - a.getTime())[0] || null;

    containers.push({
      container: safeStr(row[0]),   // A = Container
      orderNo: _resolveOrderNo(ordMap, row[0], row[1]), // client-disambiguated — see expiry.service.js's own doc comment
      clientCode: safeStr(row[15]),  // P = Client Code
      clientName: safeStr(row[1]),   // B = Client Name
      size: safeStr(row[2]),         // C = Size
      type: safeStr(row[3]),         // D = Type
      location: safeStr(row[4]),     // E = Location
      deployedDate: safeStr(row[6]), // G = Deployed Date
      validUpto: safeStr(row[7]),    // H = Valid Upto
      rate: typeof row[13] === 'number' ? row[13] : 0, // N = Rate
      billingType: safeStr(row[16]), // Q = Billing Type
      agreementUrl: safeStr(row[8]), // I = Agreement PDF
      poNo: safeStr(row[poCol]),
      poValidity: safeStr(row[poValidityCol]),
      poAttachment: safeStr(row[11]), // L = PO PDF
      movement,
      offLeaseDate: movement === 'Deletion' ? safeStr(row[21]) : '', // V = Action TS
      lastUpdated: lastUpdatedDate ? safeStr(lastUpdatedDate) : '',
      recentlyUpdated: !!(lastUpdatedDate && lastUpdatedDate.getTime() >= recentCutoff)
    });
  }

  return { containers };
}

/**
 * Off-leased containers whose Final Billing Date is this month OR LATER —
 * explicit request 2026-10-27 ("offlease kiya hai final billing date...
 * oct month ka diya hai tho woh bhi dikhega deployed sheet pe... red ho
 * jayega pura row"), widened same day ("oct bhi and nov bhi and koi dec
 * hai tho woh bhi dikhega" — not just the exact current month, Oct/Nov/Dec/
 * any later month too, NO upper bound): Final Billing Date is set on the
 * Off-Lease Tracking sheet (SHEETS.OFF_LEASE_TRACKING, col_13, "Final
 * Billing Date") during Stage 1 intake — the target cutoff date Stage 5/
 * Billing reconciles actual charges against — and a container with one due
 * THIS month or any future month is still billing-relevant even though
 * it's no longer in the "currently deployed" pool. Only an ALREADY-PASSED
 * Final Billing Date (before this month started) is excluded — that one's
 * billing cycle has already closed out.
 *
 * Deliberately a SEPARATE function, not folded into getDeployedDetailData's
 * own 'closing' category: that category's result count must keep matching
 * getDeployedSummaryData's independently-computed closing KPI (opening +
 * net, arithmetic) — silently adding off-leased rows into it would inflate
 * the container list without the KPI agreeing, a confusing mismatch. This
 * is meant to be called separately and the results shown as an ADDITIONAL,
 * clearly distinct group (see deployedSummaryExcel.service.js, which red-
 * fills these rows' whole row BACKGROUND — explicit request 2026-10-27
 * "data shoe ho par background row red dikhe" — not the text/font color).
 */
export async function getOffLeasedWithFinalBillingDue(monthLabel) {
  const parts = monthLabel.trim().split(' ');
  const monthStr = parts[0], year = parseInt(parts[1], 10);
  const monthOrder = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const monthNum = monthOrder[monthStr];
  if (monthNum === undefined) return { containers: [] };
  const ms = new Date(year, monthNum, 1).getTime();

  const { values } = await _deployedRawValues();
  const deployedRows = values.slice(1);
  if (!deployedRows.length) return { containers: [] };

  const { poCol, poValidityCol } = _resolveRenewalColumns(values[0] || []);
  const ordMap = await _expiryOrderNoMap();

  // Container No (col 0) -> Final Billing Date (col 13, "Final Billing
  // Date" per olHeaders.generated.js). Last match wins — this sheet is
  // append-only, so if a container was off-leased more than once over its
  // life, the LAST row is the current/relevant cycle.
  //
  // Only rows whose Intimation Approval Status is 'Approved' count —
  // explicit request 2026-10-27 ("yah approved hoga yahi haa bas"): a
  // container whose off-lease intimation was 'Sent Back' (not yet
  // re-approved) shouldn't show up here as if it were a settled off-lease.
  // Resolved by header name, NOT olHeaders.generated.js's static OL_HEADERS
  // array — that file is stale for this sheet (confirmed live 2026-10-27:
  // it puts "Intimation Approval Status" at index 107, but the live sheet
  // actually has it at index 30 — a real drift between the generated file
  // and the live column layout, not a typo on either side).
  const { headers: olHeaders, rows: olRows } = await getSheetDataFromMongo(SHEETS.OFF_LEASE_TRACKING);
  const approvalStatusCol = olHeaders.findIndex((h) => String(h || '').trim() === 'Intimation Approval Status');
  const finalBillingByContainer = new Map();
  for (const r of olRows) {
    const c = safeStr(r[0]).trim();
    if (!c) continue;
    if (approvalStatusCol >= 0 && safeStr(r[approvalStatusCol]).trim().toLowerCase() !== 'approved') continue;
    const fbd = parseDate(r[13]);
    if (fbd) finalBillingByContainer.set(c, fbd);
  }

  const containers = [];
  for (const row of deployedRows) {
    const containerNo = safeStr(row[0]).trim();
    if (!containerNo) continue;
    const actionStatus = safeStr(row[22]).trim().toLowerCase(); // W = Action Status
    if (actionStatus !== 'off-lease') continue;

    const fbd = finalBillingByContainer.get(containerNo);
    if (!fbd || fbd.getTime() < ms) continue;

    containers.push({
      container: containerNo,
      orderNo: _resolveOrderNo(ordMap, row[0], row[1]),
      clientCode: safeStr(row[15]),  // P = Client Code
      clientName: safeStr(row[1]),   // B = Client Name
      size: safeStr(row[2]),         // C = Size
      type: safeStr(row[3]),         // D = Type
      location: safeStr(row[4]),     // E = Location
      deployedDate: safeStr(row[6]), // G = Deployed Date
      validUpto: safeStr(row[7]),    // H = Valid Upto
      rate: typeof row[13] === 'number' ? row[13] : 0, // N = Rate (Deployed sheet's own col 13 — unrelated to Off-Lease Tracking's own col 13 used above)
      billingType: safeStr(row[16]), // Q = Billing Type
      agreementUrl: safeStr(row[8]), // I = Agreement PDF
      poNo: safeStr(row[poCol]),
      poValidity: safeStr(row[poValidityCol]),
      poAttachment: safeStr(row[11]), // L = PO PDF
      movement: 'Off-Lease (Final Billing)',
      offLeaseDate: safeStr(row[21]), // V = Action Timestamp
      finalBillingDate: safeStr(fbd),
      finalBillingDue: true,
      lastUpdated: '',
      recentlyUpdated: false
    });
  }

  return { containers };
}

/**
 * PO & Agreement Tracker — explicit request 2026-10-16: a day-strip view
 * (one month at a time) of every deployed container's Agreement Valid Upto
 * and PO Validity dates, so a client's two dates can be spotted on the
 * calendar at a glance. Reuses getExpiryDataByFilter('pending', null) —
 * the same "every currently-deployed container" list Lease Expiry's own
 * default tab and the daily digest email already use (unscoped: null
 * bypasses Sale-Person visibility, same as leaseExpiryDigest.service.js) —
 * rather than re-reading/re-parsing the Deployed sheet a second way.
 * Returns only what this page needs; the fuller Lease Expiry row (band,
 * remarks, action status, …) is irrelevant here.
 *
 * agreementStartDate (explicit request 2026-10-16, for a coverage range
 * rather than a single end-date tick): prefers item.renewedDate (the
 * Deployed sheet's own col AA, set on every Save/Submit — reflects the
 * CURRENT agreement period), falling back to _agreementStartDateMap()'s
 * New Lease Reff join by Order No for a container never yet renewed
 * through this app. PO has no equivalent start date tracked anywhere in
 * this system — the Tracker page's frontend instead treats the
 * Agreement's OWN valid-till date as the PO's implicit start (explicit
 * request/example 2026-10-16: a PO commonly picks up coverage right where
 * the agreement renewal left off), so PO still gets a real range when an
 * Agreement date exists, a single tick otherwise.
 */
export async function getPoAgreementTrackerData() {
  const [{ data }, agrStartMap] = await Promise.all([getExpiryDataByFilter('pending', null), _agreementStartDateMap()]);
  return {
    containers: data.map((item) => {
      // Explicit pasted spec 2026-10-16: "if I renew again in May with a
      // start date of April, automatically mark April green as well" — the
      // tracker must reflect a renewal the moment it's SUBMITTED (Save or
      // Submit on the Documents form), not wait for Pushpa's Approve, which
      // is what the real "Agreement Valid Upto" column (H, item.agreementDate)
      // is gated on. The one case this must NOT apply: a submission Pushpa
      // already sent back (Approval Status 'Rejected') — that proposed
      // period was explicitly rejected, so showing it as if it already
      // covers those months would be wrong; falls back to the last
      // genuinely-approved date (H) instead, same as before this fix.
      const rejected = String(item.approvalStatus || '').trim().toLowerCase() === 'rejected';
      const trustStaged = !rejected && !!item.renewedDate;
      const agreementStartDate = trustStaged ? item.renewedDate : (agrStartMap[safeStr(item.row[1]).trim()] || null);
      const agreementDate = (trustStaged && item.stagedValidTill) ? item.stagedValidTill : (item.agreementDate || null);
      return {
        container: safeStr(item.row[0]),
        clientName: safeStr(item.row[2]),
        deployedDate: item.deployedDate || null,
        agreementStartDate,
        agreementDate,
        poDate: item.poDate || null,
        // Click-through detail (explicit request 2026-10-16) — the actual
        // Agreement/PO file links + PO No/Billing Cycle, and whether this
        // container is in 'documents pending' (the only stage its Update
        // Agreement form in Renew & Document can actually save to).
        agreementUrl: item.agreementUrl || '',
        poPdfUrl: item.poPdfUrl || '',
        poNo: item.poNo || '',
        billingCycle: item.billingCycle || '',
        status: item.actionStatus || '',
        // Month-Wise Renew Tracking table (explicit spec 2026-10-16) —
        // "Actual Renewal Entry Date" and "Remarks" columns.
        renewalSubmittedDate: item.renewalSubmittedDate || '',
        remarks: item.renewalRemarks || '',
        // Transparency note (explicit request pattern this session: be
        // upfront about data nuances) — true only while the container is
        // actually still sitting in 'Documents Pending' (awaiting Pushpa's
        // Approve/Send Back) AND these dates came from that submission —
        // NOT just because trustStaged happened to be true (which is also
        // true for any long-since-approved container, where AA/AB already
        // equal H/X anyway and there's nothing provisional left to flag).
        provisional: trustStaged && String(item.actionStatus || '').trim().toLowerCase() === 'documents pending'
      };
    })
  };
}
