/**
 * Mongo -> Sheet push for manual edits of the Mongo sheet mirrors (MONGO_EDIT_PUSH=off|report|on, default off).
 *
 * The mirrors are rebuilt from the Sheet every reconcile cycle, so a developer's edit to a mirror doc
 * would be lost. Before the rebuild this does a three-way compare per row:
 *   M  = the row in Mongo now,  S0 = the Sheet row as of the last reconcile (hash snapshot),  S1 = the Sheet row now.
 *   M == S1                -> nothing to do (includes app writes already replayed to the Sheet)
 *   M != S0 and S1 == S0   -> manual Mongo edit, the Sheet untouched since: push the changed cells to the Sheet
 *   S1 != S0               -> the Sheet changed too: the Sheet wins (logged)
 * Only cell edits of rows that exist on both sides are pushed; Mongo-side row inserts/deletes are never pushed.
 * Pushed values go through googleSheets.service, so they reach central too (dual-write) and the rebuilt mirror.
 */
import crypto from 'node:crypto';
import { getCollection } from '../services/mongo.service.js';
import { batchUpdateValues, colLetter } from '../services/googleSheets.service.js';
import { normalizeKey } from '../config/mongoSheetMapping.js';
import { logger } from '../utils/logger.js';

export const SNAPSHOT_COLLECTION = '_mirror_snapshots';
const MAX_EDITS_PER_CYCLE = Number(process.env.MONGO_EDIT_PUSH_MAX) || 25;
export const pushMode = () => {
  const v = String(process.env.MONGO_EDIT_PUSH || 'off').toLowerCase();
  return v === 'on' || v === 'report' ? v : 'off';
};

const cell = (v) => (v == null ? '' : String(v));
const trimmed = (row) => { const a = (row || []).map(cell); while (a.length && a[a.length - 1] === '') a.pop(); return a; };
export const hashRow = (row) => crypto.createHash('sha1').update(JSON.stringify(trimmed(row))).digest('hex');

/** Pure planner. mongo: Map key->row; sheet: Map key->{ row, rowNum }; snapshot: Map key->hash (or null = no baseline yet). */
export function planPush({ mongo, sheet, snapshot, max = MAX_EDITS_PER_CYCLE }) {
  const edits = []; let conflicts = 0;
  if (!snapshot) return { edits, conflicts, noBaseline: true };
  for (const [key, mRow] of mongo) {
    const s = sheet.get(key);
    if (!s) continue;
    const hM = hashRow(mRow), hS = hashRow(s.row), h0 = snapshot.get(key);
    if (hM === hS || h0 == null) continue;
    if (hS !== h0) { conflicts++; continue; }
    const a = trimmed(mRow), b = trimmed(s.row);
    const cells = [];
    for (let c = 0; c < Math.max(a.length, b.length); c++) if ((a[c] ?? '') !== (b[c] ?? '')) cells.push({ col: c, value: a[c] ?? '' });
    if (cells.length) edits.push({ key, rowNum: s.rowNum, cells, mRow });
  }
  return { edits, conflicts, tooMany: edits.length > max };
}

const keyOf = (sheetName, mapping, row, i) => (mapping.fullRefresh ? `row_${i}` : normalizeKey(sheetName, row[mapping.naturalKeyColumn]));

/** Returns the Sheet rows to reconcile Mongo with (edited rows replaced by the pushed Mongo rows). */
export async function applyManualMongoEdits(sheetName, mapping, sheetRows) {
  const mode = pushMode();
  if (mode === 'off') return sheetRows;
  const snapCol = getCollection(SNAPSHOT_COLLECTION);
  const saveSnapshot = (rows) => snapCol.updateOne({ _id: sheetName }, { $set: { pairs: rows.map((r, i) => [keyOf(sheetName, mapping, r, i), hashRow(r)]).filter(([k]) => k), savedAt: new Date() } }, { upsert: true });

  const prev = await snapCol.findOne({ _id: sheetName });
  const snapshot = prev?.pairs ? new Map(prev.pairs) : null;
  const sheet = new Map();
  sheetRows.forEach((r, i) => { const k = keyOf(sheetName, mapping, r, i); if (k) sheet.set(k, { row: r, rowNum: i + 2 }); });
  const docs = await getCollection(sheetName).find({ _id: { $ne: '__meta__' }, deletedAt: null }, { projection: { key: 1, row: 1 } }).toArray();
  const mongo = new Map(docs.filter((d) => Array.isArray(d.row)).map((d) => [d.key, d.row]));

  const { edits, conflicts, noBaseline, tooMany } = planPush({ mongo, sheet, snapshot });
  if (noBaseline) logger.info(`[MONGO-PUSH] ${sheetName}: first run, baseline saved`);
  if (conflicts) logger.warn(`[MONGO-PUSH] ${sheetName}: ${conflicts} row(s) changed in both Mongo and the Sheet — the Sheet wins`);
  if (tooMany) {
    logger.error(`[MONGO-PUSH] ${sheetName}: ${edits.length} Mongo edits in one cycle (> ${MAX_EDITS_PER_CYCLE}) — refusing to push, the Sheet wins. Check for a bulk change.`);
    await saveSnapshot(sheetRows);
    return sheetRows;
  }
  if (edits.length) {
    const summary = edits.map((e) => `${e.key}@row${e.rowNum}[${e.cells.map((c) => colLetter(c.col)).join(',')}]`).join(' ');
    if (mode === 'report') {
      logger.warn(`[MONGO-PUSH] REPORT ONLY ${sheetName}: would push ${edits.length} edit(s): ${summary}`);
      await saveSnapshot(sheetRows);
      return sheetRows;
    }
    const updates = edits.flatMap((e) => e.cells.map((c) => ({ range: `'${sheetName}'!${colLetter(c.col)}${e.rowNum}`, values: [[c.value]] })));
    await batchUpdateValues(updates, mapping.ssId);
    logger.info(`[MONGO-PUSH] ${sheetName}: pushed ${edits.length} Mongo edit(s) to the Sheet: ${summary}`);
    const byKey = new Map(edits.map((e) => [e.key, e.mRow]));
    sheetRows = sheetRows.map((r, i) => byKey.get(keyOf(sheetName, mapping, r, i)) ?? r);
  }
  await saveSnapshot(sheetRows);
  return sheetRows;
}
