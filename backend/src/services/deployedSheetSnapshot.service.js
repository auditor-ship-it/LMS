/**
 * MONTHLY DEPLOYED SHEET SNAPSHOTS
 *
 * Explicit request 2026-10-27 ("sep deployed sheet and oct deployed...
 * highlight ho jaye... kya kya change nahi hua hai" — what changed from
 * September's sheet to October's): a TRUE row-by-row diff needs an actual
 * copy of the sheet as it looked at an earlier point — Google Sheets has no
 * change-history API this app can read, and nothing here was storing dated
 * copies before now. Asked whether a September file could be supplied for a
 * one-time retroactive diff vs. starting to snapshot going forward;
 * answered: start snapshotting now. So Sep -> Oct specifically can't be
 * done (no September snapshot exists) — but every month from here on will
 * have one, and the digest email can show a real diff against the PREVIOUS
 * month's snapshot once there are two to compare.
 *
 * One snapshot PER CALENDAR MONTH (not daily) — _id is the month key
 * ("YYYY-MM"), so saving is naturally idempotent: whichever run is the
 * FIRST to land in a new month saves it, every later run that same month is
 * a no-op. Wired into the daily 9:05 AM cron (jobs/index.js) so it's
 * captured reliably near the start of each month regardless of the
 * deployedSummaryDigest job's own 25th-2nd window.
 */
import { getCollection } from './mongo.service.js';
import { _deployedRawValues } from './expiry.service.js';
import { logger } from '../utils/logger.js';

const COLLECTION = '_deployed_sheet_snapshots';

export function monthKeyOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** Previous calendar month's key, e.g. monthKeyOf(Oct 2026) -> "2026-09". */
export function previousMonthKey(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(y, m - 2, 1); // m is 1-based; -2 steps back one month from a 0-based Date
  return monthKeyOf(d);
}

/**
 * Saves a snapshot of the current live Deployed sheet for "this month", if
 * one doesn't already exist. Safe to call as often as wanted (daily cron,
 * or on-demand) — only the first call in a given calendar month actually
 * writes anything.
 */
export async function saveDeployedSheetSnapshotIfNeeded(now = new Date()) {
  const monthKey = monthKeyOf(now);
  const col = getCollection(COLLECTION);
  const existing = await col.findOne({ _id: monthKey }, { projection: { _id: 1 } });
  if (existing) return { saved: false, monthKey };

  const { values } = await _deployedRawValues();
  if (!values.length) {
    logger.warn(`[DEPLOYED-SNAPSHOT] ${monthKey}: Deployed sheet read returned 0 rows — skipping, not saving an empty snapshot.`);
    return { saved: false, monthKey, skipped: 'empty' };
  }

  await col.insertOne({ _id: monthKey, values, rowCount: values.length - 1, snapshotAt: new Date() });
  logger.info(`[DEPLOYED-SNAPSHOT] saved snapshot for ${monthKey} (${values.length - 1} rows)`);
  return { saved: true, monthKey, rowCount: values.length - 1 };
}

export async function getDeployedSheetSnapshot(monthKey) {
  return getCollection(COLLECTION).findOne({ _id: monthKey });
}

/**
 * Row-by-row diff between two monthly snapshots, keyed by Container No
 * (col 0). Container No is NOT unique on this sheet (a re-leased container
 * keeps its old row — same caveat documented elsewhere in this codebase,
 * e.g. expiry.service.js's _resolveDeployedRow) — rows are grouped by
 * container and matched positionally (1st-with-1st, 2nd-with-2nd, …)
 * between the two snapshots; a count mismatch for a given container is
 * reported as that many added/removed rather than guessing which specific
 * row is "the same one".
 *
 * @returns {Promise<{ok:boolean, reason?:string, oldMonthKey, newMonthKey,
 *   added:Array, removed:Array, changed:Array, headers:Array}>}
 *   changed[].fieldChanges is [{col, header, from, to}] — every column that
 *   differs, not just a yes/no "something changed".
 */
export async function diffDeployedSnapshots(oldMonthKey, newMonthKey) {
  const [oldSnap, newSnap] = await Promise.all([
    getDeployedSheetSnapshot(oldMonthKey),
    getDeployedSheetSnapshot(newMonthKey)
  ]);
  if (!oldSnap) return { ok: false, reason: `No snapshot stored for ${oldMonthKey}` };
  if (!newSnap) return { ok: false, reason: `No snapshot stored for ${newMonthKey}` };

  const headers = newSnap.values[0] || [];
  const oldRows = oldSnap.values.slice(1);
  const newRows = newSnap.values.slice(1);

  const groupByContainer = (rows) => {
    const map = new Map();
    for (const row of rows) {
      const c = String(row[0] || '').trim();
      if (!c) continue;
      if (!map.has(c)) map.set(c, []);
      map.get(c).push(row);
    }
    return map;
  };
  const oldMap = groupByContainer(oldRows);
  const newMap = groupByContainer(newRows);

  const added = [], removed = [], changed = [];
  for (const [container, newList] of newMap) {
    const oldList = oldMap.get(container) || [];
    const pairCount = Math.min(oldList.length, newList.length);
    for (let i = 0; i < pairCount; i++) {
      const oldRow = oldList[i], newRow = newList[i];
      const fieldChanges = [];
      for (let col = 0; col < Math.max(oldRow.length, newRow.length); col++) {
        const ov = String(oldRow[col] ?? '').trim(), nv = String(newRow[col] ?? '').trim();
        if (ov !== nv) fieldChanges.push({ col, header: headers[col] || `col_${col}`, from: ov, to: nv });
      }
      if (fieldChanges.length) changed.push({ container, row: newRow, fieldChanges });
    }
    for (let i = pairCount; i < newList.length; i++) added.push({ container, row: newList[i] });
    for (let i = pairCount; i < oldList.length; i++) removed.push({ container, row: oldList[i] });
  }
  for (const [container, oldList] of oldMap) {
    if (!newMap.has(container)) {
      for (const row of oldList) removed.push({ container, row });
    }
  }

  return { ok: true, oldMonthKey, newMonthKey, added, removed, changed, headers };
}
