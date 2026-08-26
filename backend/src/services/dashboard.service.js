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
import { normKey } from '../utils/normalize.js';
import { _expiryOrderNoMap, _deployedRawValues } from './expiry.service.js';

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

    containers.push({
      container: safeStr(row[0]),   // A = Container
      orderNo: ordMap[normKey(row[0])] || '',
      clientCode: safeStr(row[15]),  // P = Client Code
      clientName: safeStr(row[1]),   // B = Client Name
      size: safeStr(row[2]),         // C = Size
      type: safeStr(row[3]),         // D = Type
      location: safeStr(row[4]),     // E = Location
      deployedDate: safeStr(row[6]), // G = Deployed Date
      validUpto: safeStr(row[7]),    // H = Valid Upto
      rate: typeof row[13] === 'number' ? row[13] : 0, // N = Rate
      movement,
      offLeaseDate: movement === 'Deletion' ? safeStr(row[21]) : '' // V = Action TS
    });
  }

  return { containers };
}
