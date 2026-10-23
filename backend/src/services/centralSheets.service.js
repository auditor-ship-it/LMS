/**
 * CENTRAL-DB MODE (DATA_SOURCE=central) — the spreadsheet tabs this app used
 * to read from Google Sheets (and their Mongo mirrors) are served from the
 * company PostgreSQL database instead: schema `lease`, one typed table per
 * tab, filled by scripts/central/load-lease.mjs from the central copy of the
 * workbooks (landing_sheets.rows, unformatted `raw` values).
 *
 * In this mode the app NEVER calls Google: no Sheets reads, no writes, no tab
 * creation, no mirror sync. App writes (approvals, remarks, moves, renewals,
 * ...) land in the same `lease` tables. With DATA_SOURCE unset this module is
 * inert and the app behaves exactly as before.
 *
 * Shape: every tab table has `row_number` (= the sheet row, 1 is the header
 * row and lives in lease.sheet_column), one typed column per sheet column
 * (text / double precision / boolean) and `_extra` jsonb for any cell whose
 * value does not fit its column's type, or that sits past the typed columns.
 * Reads rebuild exactly what values.get(UNFORMATTED_VALUE, dates as
 * FORMATTED_STRING) returned: arrays by position, '' for interior blanks,
 * trailing blanks/empty rows trimmed — so the existing index-based business
 * logic runs unchanged.
 *
 * This file is identical in LMS and Accounts-Collection (both read and write
 * the same `lease` tables, one shape).
 */
import pg from 'pg';
import { logger } from '../utils/logger.js';
import { EXTERNAL_SPREADSHEETS as X } from '../config/sheets.config.js';

export const isCentral = () => String(process.env.DATA_SOURCE || '').toLowerCase() === 'central';

const SCHEMA = 'lease';
const LEASE_WB = 'lease_workbook';

/* Spreadsheet id -> central workbook key (names used by the central sync). */
const WB_BY_ID = new Map(Object.entries({
  [X.MASTER_WORKBOOK?.ssId]: 'container_master',
  [X.CONSOLIDATE?.ssId]: 'fms_dispatch',
  [X.INVOICE_TEMPLATE?.ssId]: 'invoice_template',
  [X.INVOICE_ARCHIVE_2526?.ssId]: 'invoice_archive_2526',
  [X.SALE_EXEC?.ssId]: 'sales_exec_company_assigned'
}).filter(([k]) => k && k !== 'undefined'));

/* Mirror collections keyed by a natural column instead of row position (same
   as mongoSheetMapping.js in LMS) — only matters for the Mongo-shaped shim. */
const KEY_COL = { USER: 3, 'Team Accounts': 0, 'Sidebar Access': 0 };

let pool = null;
let ready = null;
const tabs = new Map();      // `${wb}\u0000${tab}` -> { wb, tab, table, cols: Map(ord -> {name,type}), headers: [] }
const tabByName = new Map(); // tab -> entry (lease workbook wins on a name clash)
const listeners = [];
const warnedMissing = new Set();

const q = (id) => `"${String(id).replace(/"/g, '""')}"`;

export function onCentralWrite(fn) { listeners.push(fn); }
function emitWrite(tab) { for (const fn of listeners) { try { fn(tab); } catch { /* listener errors never fail a write */ } } }

export function centralPool() {
  if (!pool) {
    const url = process.env.CENTRAL_DATABASE_URL;
    if (!url) throw new Error('DATA_SOURCE=central needs CENTRAL_DATABASE_URL');
    pool = new pg.Pool({ connectionString: url, max: Number(process.env.CENTRAL_DB_POOL_MAX) || 5 });
    pool.on('error', (e) => logger.error('[CENTRAL] idle client error:', e.message));
  }
  return pool;
}

/** Loads the tab registry. Call once at boot (idempotent, cheap). */
export async function initCentral() {
  if (!isCentral()) return;
  if (!ready) {
    ready = (async () => {
      const db = centralPool();
      const { rows: t } = await db.query(`SELECT workbook_key, tab, table_name FROM ${SCHEMA}.sheet_tab`);
      const { rows: c } = await db.query(`SELECT table_name, ordinal, header, column_name, data_type FROM ${SCHEMA}.sheet_column ORDER BY table_name, ordinal`);
      tabs.clear(); tabByName.clear();
      const byTable = new Map();
      for (const r of t) {
        const e = { wb: r.workbook_key, tab: r.tab, table: r.table_name, cols: new Map(), headers: [] };
        tabs.set(`${e.wb}\u0000${e.tab}`, e);
        byTable.set(e.table, e);
        if (!tabByName.has(e.tab) || e.wb === LEASE_WB) tabByName.set(e.tab, e);
      }
      for (const r of c) {
        const e = byTable.get(r.table_name);
        if (!e) continue;
        e.headers[r.ordinal] = r.header ?? '';
        if (r.column_name) e.cols.set(r.ordinal, { name: r.column_name, type: r.data_type });
      }
      logger.info(`[CENTRAL] DATA_SOURCE=central — ${tabs.size} tabs from schema ${SCHEMA}; Google Sheets/Drive are never called in this mode`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

export function workbookOf(ssId) {
  if (!ssId || ssId === process.env.GOOGLE_SHEET_ID) return LEASE_WB;
  return WB_BY_ID.get(ssId) || `unknown:${String(ssId).slice(0, 8)}`;
}

function entryFor(tab, ssId) {
  const wb = workbookOf(ssId);
  const e = tabs.get(`${wb}\u0000${tab}`);
  if (!e) {
    const k = `${wb}/${tab}`;
    if (!warnedMissing.has(k)) {
      warnedMissing.add(k);
      logger.warn(`[CENTRAL] tab '${tab}' of workbook ${wb} is not in the central copy — served as empty (see MIGRATION.md)`);
    }
  }
  return e || null;
}

/* Mongo collections that were (or could be) Sheets mirrors — named after a tab. In central
   mode they are served by the central tables even when a tab is absent from the copy (then
   empty), so the stale Mongo mirror is never read. Keep in step with load-lease.mjs SPEC. */
const MIRROR_NAMES = new Set([
  'New Lease', 'Deployed sheet', 'Operation sheet', 'Billing Sales', 'Receivables', 'Renewal Log',
  'Off-Lease Tracking', 'Dispute Approval', 'New Lease Other Order type', 'Approve billing for invoice',
  'Receivables other order Type', 'Transportion', 'Control', 'Client Db', 'New lease reff', 'Team Accounts',
  'Sidebar Access', 'Role Permissions', 'USER', 'Stage 9 Movement', 'Off-Lease Remarks', 'Off-Lease Move History',
  'Renew Remarks', '__login_log', 'Login Time Log', ' Invoice PO', 'Offlease Bills', 'Stage 1', 'Stage 3 ',
  'Master Sheet', 'container_master_logs',
  'STAGE-8', 'STAGE-9', 'STAGE-10', 'STAGE1', 'STAGE2', 'STAGE3', 'STAGE4', 'STAGE7', 'STAGE5.1', 'Consoldate Data'
]);
export function isSheetMirrorName(name) { return MIRROR_NAMES.has(name) || tabByName.has(name); }

/** A tab by name alone (what the old mirror collections were called), any workbook. */
export async function centralGetByName(name) {
  await initCentral();
  const e = tabByName.get(name);
  if (!e) {
    if (!warnedMissing.has(`*/${name}`)) {
      warnedMissing.add(`*/${name}`);
      logger.warn(`[CENTRAL] tab '${name}' is not in the central copy — served as empty (see MIGRATION.md)`);
    }
    return { headers: [], rows: [], values: [] };
  }
  const values = await readAll(e);
  while (values.length > 1 && !values[values.length - 1].length) values.pop();
  return { headers: values[0] || [], rows: values.slice(1), values };
}

export function listCentralTabs(ssId) {
  const wb = workbookOf(ssId);
  return [...tabs.values()].filter((e) => e.wb === wb).map((e) => e.tab);
}

/* ---------- reading ---------- */

function trimRow(arr) {
  let n = arr.length;
  while (n > 0 && (arr[n - 1] === '' || arr[n - 1] == null)) n--;
  const out = arr.slice(0, n);
  for (let i = 0; i < out.length; i++) if (out[i] == null) out[i] = '';
  return out;
}

/** All sheet rows of a tab as values.get would return 'A1:ZZ' — index 0 = header row. */
async function readAll(e) {
  const db = centralPool();
  const [{ rows }, { rows: hdr }] = await Promise.all([
    db.query(`SELECT * FROM ${SCHEMA}.${q(e.table)} ORDER BY row_number`),
    // headers re-read every time: the other app may have written one
    db.query(`SELECT ordinal, header FROM ${SCHEMA}.sheet_column WHERE table_name = $1`, [e.table])
  ]);
  for (const h of hdr) e.headers[h.ordinal] = h.header ?? '';
  const byNum = new Map();
  let max = 1;
  for (const r of rows) {
    const arr = [];
    for (const [ord, col] of e.cols) { const v = r[col.name]; if (v != null) arr[ord] = v; }
    for (const [k, v] of Object.entries(r._extra || {})) if (v != null) arr[Number(k)] = v;
    const t = trimRow(arr);
    if (t.length) { byNum.set(r.row_number, t); if (r.row_number > max) max = r.row_number; }
  }
  const out = [trimRow(e.headers.slice())];
  for (let n = 2; n <= max; n++) out.push(byNum.get(n) || []);
  return out;
}

function colIndex(letters) {
  let n = 0;
  for (const ch of String(letters).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Parses 'A1:ZZ', 'G2:G', 'B2', 'A:Z', 'AC2:AC13' -> 0-based inclusive bounds (Infinity = open). */
export function parseA1(a1) {
  const m = String(a1 || 'A1:ZZ').replace(/\$/g, '').match(/^([A-Z]*)(\d*)(?::([A-Z]*)(\d*))?$/i);
  if (!m) return { r0: 0, c0: 0, r1: Infinity, c1: Infinity };
  const r0 = m[2] ? Number(m[2]) - 1 : 0;
  const c0 = m[1] ? colIndex(m[1]) : 0;
  const single = m[3] === undefined;
  const c1 = single ? c0 : (m[3] ? colIndex(m[3]) : Infinity);
  const r1 = single ? (m[2] ? r0 : Infinity) : (m[4] ? Number(m[4]) - 1 : Infinity);
  return { r0, c0, r1, c1 };
}

/** values.get of `a1` on `tab` — same 2D shape Google returned (trailing blanks trimmed). */
export async function centralGetValues(tab, a1 = 'A1:ZZ', ssId) {
  await initCentral();
  const e = entryFor(tab, ssId);
  if (!e) return [];
  const all = await readAll(e);
  const { r0, c0, r1, c1 } = parseA1(a1);
  const out = [];
  for (let r = r0; r < all.length && r <= r1; r++) out.push(trimRow((all[r] || []).slice(c0, c1 === Infinity ? undefined : c1 + 1)));
  while (out.length && !out[out.length - 1].length) out.pop();
  return out;
}

/** Same { headers, rows, values } shape as getSheetData / getSheetDataFromMongo. */
export async function centralGetSheetData(tab, ssId, a1 = 'A1:ZZ') {
  const values = await centralGetValues(tab, a1, ssId);
  return { headers: values[0] || [], rows: values.slice(1), values };
}

/* ---------- writing ---------- */

/* What USER_ENTERED would store: numbers and booleans typed as text become
   numbers/booleans; everything else stays as written. */
function userEntered(v) {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (/^(true|false)$/i.test(s)) return s.toUpperCase() === 'TRUE';
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(s) && s.length < 16) return Number(s);
  return v;
}
const fits = (v, type) => (type === 'double precision' ? typeof v === 'number' && Number.isFinite(v)
  : type === 'boolean' ? typeof v === 'boolean' : typeof v === 'string');

async function tx(fn) {
  const c = await centralPool().connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

const markWritten = (c, e) => c.query(`UPDATE ${SCHEMA}.sheet_tab SET app_written_at = now() WHERE table_name = $1`, [e.table]);

async function writeHeaderCells(c, e, startCol, vals) {
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (v == null) continue;
    const ord = startCol + i;
    const h = userEntered(v);
    await c.query(`INSERT INTO ${SCHEMA}.sheet_column (table_name, ordinal, header) VALUES ($1,$2,$3::jsonb)
      ON CONFLICT (table_name, ordinal) DO UPDATE SET header = EXCLUDED.header`, [e.table, ord, JSON.stringify(h)]);
    e.headers[ord] = h;
  }
}

/* One sheet row's cells (null = leave the cell alone, '' = clear it, like values.update). */
async function writeRowCells(c, e, rowNum, startCol, vals) {
  const set = new Map(); const extraSet = {}; const extraDel = [];
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] === undefined || vals[i] === null) continue;
    const ord = startCol + i;
    const v = userEntered(vals[i]);
    const col = e.cols.get(ord);
    if (v === '') { if (col) set.set(col.name, null); extraDel.push(String(ord)); continue; }
    if (col && fits(v, col.type)) { set.set(col.name, v); extraDel.push(String(ord)); } else { if (col) set.set(col.name, null); extraSet[ord] = v; }
  }
  if (!set.size && !extraDel.length && !Object.keys(extraSet).length) return;
  const names = [...set.keys()];
  const params = [rowNum, ...set.values(), JSON.stringify(extraSet), extraDel];
  const nX = names.length + 2; const nD = names.length + 3;
  const ins = names.map((n, i) => `$${i + 2}`);
  await c.query(
    `INSERT INTO ${SCHEMA}.${q(e.table)} AS t (row_number${names.map((n) => `, ${q(n)}`).join('')}, _extra)
     VALUES ($1${ins.map((p) => `, ${p}`).join('')}, $${nX}::jsonb)
     ON CONFLICT (row_number) DO UPDATE SET ${names.map((n) => `${q(n)} = EXCLUDED.${q(n)}, `).join('')}
       _extra = (t._extra - $${nD}::text[]) || $${nX}::jsonb`, params);
}

function requireTab(tab, ssId, op) {
  const e = entryFor(tab, ssId);
  if (!e) throw Object.assign(new Error(`[CENTRAL] ${op}: tab '${tab}' (${workbookOf(ssId)}) is not in the central database`), { status: 503 });
  return e;
}

/** values.update / batchUpdate of a rectangle starting at (startRow 1-based, startCol 0-based). */
export async function centralWriteRange(tab, startRow, startCol, values2D, ssId, client) {
  await initCentral();
  const e = requireTab(tab, ssId, 'write');
  const run = async (c) => {
    for (let r = 0; r < (values2D || []).length; r++) {
      const rowNum = startRow + r;
      const vals = values2D[r] || [];
      if (rowNum === 1) await writeHeaderCells(c, e, startCol, vals);
      else await writeRowCells(c, e, rowNum, startCol, vals);
    }
    await markWritten(c, e);
  };
  if (client) await run(client); else await tx(run);
  emitWrite(tab);
}

/** Parses "'Tab'!B5:C6" / "Tab!B5" into { tab, startRow, startCol }. */
export function parseQualifiedRange(range) {
  const m = String(range).match(/^(?:'((?:[^']|'')+)'|([^!]+))!(.+)$/);
  if (!m) return null;
  const tab = (m[1] ?? m[2]).replace(/''/g, "'");
  const b = parseA1(m[3]);
  return { tab, startRow: b.r0 + 1, startCol: b.c0 };
}

export async function centralBatchUpdate(updates, ssId) {
  await initCentral();
  const parsed = (updates || []).map((u) => ({ ...parseQualifiedRange(u.range), values: u.values }));
  const bad = parsed.find((p) => !p.tab);
  if (bad) throw new Error('[CENTRAL] batchUpdate: unparseable range');
  await tx(async (c) => {
    for (const p of parsed) await centralWriteRange(p.tab, p.startRow, p.startCol, p.values, ssId, c);
  });
}

/** values.append: after the last non-empty row. Returns the first written sheet row. */
export async function centralAppendRows(tab, rows2D, ssId) {
  await initCentral();
  const e = requireTab(tab, ssId, 'append');
  const first = await tx(async (c) => {
    await c.query(`LOCK TABLE ${SCHEMA}.${q(e.table)} IN SHARE ROW EXCLUSIVE MODE`);
    const { rows } = await c.query(
      `SELECT max(row_number) AS m FROM ${SCHEMA}.${q(e.table)} t
       WHERE t._extra <> '{}'::jsonb OR jsonb_strip_nulls(to_jsonb(t) - 'row_number' - '_extra') <> '{}'::jsonb`);
    const hasHeader = e.headers.some((h) => h !== '' && h != null);
    const start = (rows[0].m ?? (hasHeader ? 1 : 0)) + 1;
    for (let i = 0; i < rows2D.length; i++) {
      if (start + i === 1) await writeHeaderCells(c, e, 0, rows2D[i] || []);
      else await writeRowCells(c, e, start + i, 0, rows2D[i] || []);
    }
    await markWritten(c, e);
    return start;
  });
  emitWrite(tab);
  return first;
}

/** deleteDimension ROWS: removes the rows and shifts the ones below up, like the sheet does. */
export async function centralDeleteRows(tab, rowNums, ssId) {
  await initCentral();
  const e = requireTab(tab, ssId, 'deleteRows');
  const desc = [...new Set(rowNums)].filter((n) => n > 1).sort((a, b) => b - a);
  await tx(async (c) => {
    for (const rn of desc) {
      await c.query(`DELETE FROM ${SCHEMA}.${q(e.table)} WHERE row_number = $1`, [rn]);
      // shift up in two steps (via negative numbers) so the primary key never collides mid-update
      await c.query(`UPDATE ${SCHEMA}.${q(e.table)} SET row_number = -(row_number - 1) WHERE row_number > $1`, [rn]);
      await c.query(`UPDATE ${SCHEMA}.${q(e.table)} SET row_number = -row_number WHERE row_number < 0`);
    }
    await markWritten(c, e);
  });
  emitWrite(tab);
}

/** insertSheetIfMissing: never creates anything. A registered tab with no header yet gets one. */
export async function centralEnsureHeader(tab, headerRow, ssId) {
  await initCentral();
  const e = entryFor(tab, ssId);
  if (!e) return;
  if (headerRow?.length && !e.headers.some((h) => h !== '' && h != null)) {
    await tx(async (c) => { await writeHeaderCells(c, e, 0, headerRow); await markWritten(c, e); });
    emitWrite(tab);
  }
}

/* ---------- Mongo-mirror shim ----------
   Both apps also read/patch the old Mongo mirror collections directly
   (getCollection('Deployed sheet').updateOne({ key: 'row_5' }, { $set: { 'row.21': x } }), ...).
   In central mode those collections ARE the central tables: this object
   implements the handful of calls the code makes, with both mirror shapes
   (LMS `key: 'row_N'` and Accounts-Collection numeric `_id: N`). */
function docsFrom(tab, values) {
  const kc = KEY_COL[tab];
  return values.slice(1).map((row, i) => ({
    _id: i,
    key: kc == null ? `row_${i}` : String(row[kc] ?? '').trim().toLowerCase(),
    row, deletedAt: null
  }));
}

export function centralMirrorCollection(tab) {
  const resolveTab = () => tabByName.get(tab);
  const readValues = async () => (await centralGetByName(tab)).values;
  const match = (d, f = {}) => {
    if (f.key !== undefined && typeof f.key !== 'object' && d.key !== f.key) return false;
    if (typeof f._id === 'number' && d._id !== f._id) return false;
    if (f._id === '__meta__') return false;
    return true;
  };
  const cursor = (p) => ({ toArray: () => p, sort() { return this; }, project() { return this; }, limit() { return this; } });
  const rowNumFor = async (filter) => {
    const docs = docsFrom(tab, await readValues());
    if (typeof filter._id === 'number') return filter._id + 2;
    const k = filter.key;
    if (typeof k === 'string' && /^row_\d+$/.test(k) && KEY_COL[tab] == null) return Number(k.slice(4)) + 2;
    const d = docs.find((x) => x.key === k);
    return d ? d._id + 2 : null;
  };
  return {
    collectionName: tab,
    find(filter = {}) { return cursor(readValues().then((v) => docsFrom(tab, v).filter((d) => match(d, filter)))); },
    async findOne(filter = {}) {
      const v = await readValues();
      if (filter._id === '__meta__') return v.length ? { _id: '__meta__', headers: v[0] || [], syncedAt: new Date(), v: Date.now() } : null;
      return docsFrom(tab, v).find((d) => match(d, filter)) || null;
    },
    async countDocuments(filter = {}) { return docsFrom(tab, await readValues()).filter((d) => match(d, filter)).length; },
    async updateOne(filter = {}, update = {}, opts = {}) {
      await initCentral();
      const e = resolveTab();
      if (!e) return { matchedCount: 0, modifiedCount: 0 };
      const set = update.$set || {};
      if (filter._id === '__meta__') {
        if (Array.isArray(set.headers)) { await centralWriteRange(e.tab, 1, 0, [set.headers], workbookSsId(e)); }
        return { matchedCount: 1, modifiedCount: Array.isArray(set.headers) ? 1 : 0 };
      }
      let rn = await rowNumFor(filter);
      if (rn == null) {
        if (!opts.upsert || !Array.isArray(set.row)) return { matchedCount: 0, modifiedCount: 0 };
        const at = await centralAppendRows(e.tab, [set.row], workbookSsId(e));
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: at - 2 };
      }
      const cells = [];
      if (Array.isArray(set.row)) {
        const width = Math.max(set.row.length, e.headers.length, ...[...e.cols.keys()].map((k) => k + 1));
        for (let i = 0; i < width; i++) cells[i] = set.row[i] == null ? '' : set.row[i];
      }
      for (const [k, v] of Object.entries(set)) {
        const m = k.match(/^row\.(\d+)$/);
        if (m) cells[Number(m[1])] = v == null ? '' : v;
      }
      if (cells.length) await centralWriteRange(e.tab, rn, 0, [cells], workbookSsId(e));
      return { matchedCount: 1, modifiedCount: cells.length ? 1 : 0 };
    },
    async insertOne(doc) {
      const e = resolveTab();
      if (e && Array.isArray(doc?.row)) await centralAppendRows(e.tab, [doc.row], workbookSsId(e));
      return { insertedId: null };
    },
    // Only the retired sync paths (reconcile / full mirror rewrite) call these; never touch central data from them.
    async updateMany() { logger.warn(`[CENTRAL] ignored updateMany on mirror '${tab}'`); return { matchedCount: 0, modifiedCount: 0 }; },
    async deleteMany() { logger.warn(`[CENTRAL] ignored deleteMany on mirror '${tab}'`); return { deletedCount: 0 }; },
    async deleteOne() { logger.warn(`[CENTRAL] ignored deleteOne on mirror '${tab}'`); return { deletedCount: 0 }; },
    async bulkWrite() { logger.warn(`[CENTRAL] ignored bulkWrite on mirror '${tab}'`); return {}; },
    async insertMany() { logger.warn(`[CENTRAL] ignored insertMany on mirror '${tab}'`); return {}; },
    async createIndex() { return null; },
    async drop() { logger.warn(`[CENTRAL] ignored drop on mirror '${tab}'`); return false; }
  };
}

/* The shim addresses tabs by their own workbook, not by an ssId. */
function workbookSsId(e) {
  if (e.wb === LEASE_WB) return undefined;
  for (const [id, wb] of WB_BY_ID) if (wb === e.wb) return id;
  return undefined;
}

/** Refuses a Google call in central mode — used where code reached for the raw API client. */
export function googleDisabled(what) {
  return Object.assign(new Error(`${what} is not available with DATA_SOURCE=central (Google is never called in this mode)`), { status: 503 });
}
