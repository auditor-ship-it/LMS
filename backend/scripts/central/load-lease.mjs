#!/usr/bin/env node
/**
 * Loader / rebuild job for the central `lease` schema — the ONE writer of the
 * spreadsheet-derived tables that LMS and Accounts-Collection read in
 * DATA_SOURCE=central mode (see src/services/centralSheets.service.js).
 *
 * Source: landing_sheets.rows (the central, read-only copy of the Google
 * workbooks made by crystal-data-platform's sync). Uses `raw` (unformatted
 * values: numbers, booleans, dates as displayed text) and only falls back to
 * `cells` (display text, best-effort un-formatted) where `raw` is NULL.
 *
 * For every tab in SPEC it (re)creates one typed table lease.<tab_slug>
 * (row_number + one text/double precision/boolean column per sheet column +
 * _extra jsonb for cells that do not fit), fills it, records headers in
 * lease.sheet_column, and verifies every row reads back exactly as the source
 * (row counts + cell-by-cell).
 *
 * Google is never called. The landing copy is only read.
 *
 * SAFETY: once the apps run in central mode they write these tables, so a
 * re-load would overwrite their work. A tab the apps have written since its
 * last load (sheet_tab.app_written_at > loaded_at) is refused unless --force.
 *
 *   node scripts/central/load-lease.mjs --db postgres://admin@host/crystal [--source <landing db url>] [--only "Deployed sheet"]
 *        [--alias lease_workbook=<other landing key>] [--emit-ddl ddl.sql] [--force] [--dry-run]
 *
 * Run as a role that can SET ROLE lease_owner (the migration admin). Apply
 * db/central/0001_lease_schema.sql first.
 */
import pg from 'pg';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, def = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes(name);
const DB = opt('--db', process.env.CENTRAL_ADMIN_DATABASE_URL);
const SOURCE = opt('--source', DB); // where landing_sheets lives (the same database on the VPS)
const ONLY = opt('--only');
const FORCE = flag('--force');
const DRY = flag('--dry-run');
const EMIT = opt('--emit-ddl');
const ALIAS = Object.fromEntries(args.flatMap((a, i) => (a === '--alias' ? [args[i + 1].split('=')] : [])));
if (!DB) { console.error('usage: --db <postgres url> (or CENTRAL_ADMIN_DATABASE_URL)'); process.exit(2); }

/* Every tab either app reads or writes (sheets.config.js SHEETS + external
   workbooks). `create: true` = make an empty table even when the copy lacks
   the tab, because the app creates/appends it on first use. Unused hidden
   bookkeeping tabs (__api_keys/__api_usage/__api_admin_audit/__api_idempotency,
   182k rows of old API usage) are deliberately left out — no code reads them. */
const LEASE_TABS = [
  'New Lease', 'Deployed sheet', 'Operation sheet', 'Billing Sales', 'Receivables', 'Renewal Log',
  'Off-Lease Tracking', 'Dispute Approval', 'New Lease Other Order type', 'Approve billing for invoice',
  'Receivables other order Type', 'Transportion', 'Control', 'Client Db', 'New lease reff', 'Team Accounts',
  'Sidebar Access', 'Role Permissions', 'USER', 'Stage 9 Movement', 'Off-Lease Remarks', 'Off-Lease Move History',
  'Renew Remarks', '__login_log', 'Login Time Log', ' Invoice PO', 'Offlease Bills', 'Stage 1', 'Stage 3 '
];
const SPEC = [
  { wb: 'lease_workbook', tabs: LEASE_TABS, create: true },
  { wb: 'container_master', tabs: ['Master Sheet', 'container_master_logs'] },
  { wb: 'fms_dispatch', tabs: ['STAGE-8', 'STAGE-9', 'STAGE-10', 'STAGE1', 'STAGE2', 'STAGE3', 'STAGE4', 'STAGE7', 'STAGE5.1', 'Consoldate Data'] },
  { wb: 'invoice_template', tabs: [/^invoicetemplate/i] },
  { wb: 'invoice_archive_2526', tabs: ['Merge_invoices', /^invoicetemplate/i] }
];
const PREFIX = { lease_workbook: '', container_master: 'cm_', fms_dispatch: 'fms_', invoice_template: 'it_', invoice_archive_2526: 'ia_' };

const slug = (s) => String(s ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const q = (id) => `"${String(id).replace(/"/g, '""')}"`;

/* Display text -> value, ONLY used where `raw` is NULL (rows synced before raw existed). */
const NUM_RE = /^\s*(-|\()?\s*[₹$]?\s*(-)?\s*([0-9]{1,3}(,[0-9]{2,3})*|[0-9]+)(\.[0-9]+)?\s*(%)?\s*\)?\s*$/;
function unformat(v) {
  if (typeof v !== 'string') return v;
  if (v === 'TRUE') return true; if (v === 'FALSE') return false;
  const m = NUM_RE.exec(v);
  if (!m || /^0[0-9]/.test(v.trim())) return v;
  if (!/[₹$,%]/.test(v) && !/^-?[0-9]+(\.[0-9]+)?$/.test(v.trim())) return v;
  let n = Number(v.replace(/[₹$,%()\s]/g, ''));
  if (!Number.isFinite(n)) return v;
  if (m[1] === '(' || m[1] === '-' || m[2] === '-') n = -Math.abs(n);
  if (m[6] === '%') n /= 100;
  return n;
}
const kind = (v) => (typeof v === 'number' ? 'double precision' : typeof v === 'boolean' ? 'boolean' : 'text');
const fits = (v, t) => kind(v) === t && (typeof v !== 'number' || Number.isFinite(v));
const trim = (a) => { const o = Array.from(a || [], (v) => (v == null ? '' : v)); while (o.length && o[o.length - 1] === '') o.pop(); return o; };

const db = new pg.Client({ connectionString: DB });
await db.connect();
const srcDb = SOURCE === DB ? db : new pg.Client({ connectionString: SOURCE });
if (srcDb !== db) await srcDb.connect();
const ddlOut = [];
const report = [];

async function tabsOf(spec) {
  const src = ALIAS[spec.wb] || spec.wb;
  const { rows } = await srcDb.query('SELECT tab FROM landing_sheets.tabs WHERE workbook_key = $1', [src]);
  const have = rows.map((r) => r.tab);
  const out = [];
  for (const t of spec.tabs) {
    if (t instanceof RegExp) { for (const h of have.filter((x) => t.test(x))) out.push({ tab: h, present: true }); continue; }
    out.push({ tab: t, present: have.includes(t) });
  }
  if (!have.length) report.push({ workbook: spec.wb, tab: '*', status: 'WORKBOOK NOT IN CENTRAL COPY — apps serve its tabs as empty' });
  return { src, list: out };
}

async function loadTab(wb, src, tab, present, create) {
  if (ONLY && tab !== ONLY) return;
  if (!present && !create) { report.push({ workbook: wb, tab, status: 'missing in copy — skipped (apps serve it as empty)' }); return; }
  const table = (PREFIX[wb] + slug(tab)).slice(0, 60) || `${PREFIX[wb]}tab`;
  const { rows: src_rows } = await srcDb.query(
    `SELECT row_number, cells, raw FROM landing_sheets.rows
     WHERE workbook_key = $1 AND tab = $2 AND deleted_at IS NULL ORDER BY row_number`, [src, tab]);
  let fromCells = 0;
  const values = new Map();
  for (const r of src_rows) {
    if (r.raw != null) values.set(r.row_number, trim(r.raw));
    else { fromCells++; values.set(r.row_number, trim((r.cells || []).map(unformat))); }
  }
  const header = values.get(1) || [];
  const data = [...values.entries()].filter(([n]) => n > 1);

  // Column types: the type of >= 90% of a column's non-empty values, else text.
  const width = Math.max(header.length, ...data.map(([, v]) => v.length), 0);
  const cols = [];
  for (let c = 0; c < width; c++) {
    const n = { text: 0, 'double precision': 0, boolean: 0 }; let tot = 0;
    for (const [, v] of data) if (v[c] !== undefined && v[c] !== '') { n[kind(v[c])]++; tot++; }
    let type = 'text';
    for (const k of ['double precision', 'boolean']) if (tot && n[k] / tot >= 0.9) type = k;
    cols.push({ ord: c, name: `c${String(c).padStart(3, '0')}_${slug(header[c]) || 'col'}`.slice(0, 63), type, header: header[c] ?? '' });
  }

  await db.query('BEGIN');
  try {
    await db.query('SET LOCAL ROLE lease_owner');
    const { rows: prev } = await db.query('SELECT loaded_at, app_written_at FROM lease.sheet_tab WHERE workbook_key = $1 AND tab = $2', [wb, tab]);
    if (prev[0]?.app_written_at && (!prev[0].loaded_at || prev[0].app_written_at > prev[0].loaded_at) && !FORCE) {
      await db.query('ROLLBACK');
      report.push({ workbook: wb, tab, table, status: 'REFUSED — apps have written this table since its last load (use --force to overwrite)' });
      return;
    }
    const ddl = [`CREATE TABLE IF NOT EXISTS lease.${q(table)} (row_number integer NOT NULL, _extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT ${q(`${table.slice(0, 55)}_pkey`)} PRIMARY KEY (row_number))`];
    // Existing typed columns keep their type (values that no longer fit go to _extra).
    const { rows: existing } = await db.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'lease' AND table_name = $1`, [table]);
    const exType = new Map(existing.map((r) => [r.column_name, r.data_type]));
    for (const c of cols) {
      if (exType.has(c.name)) c.type = exType.get(c.name);
      else ddl.push(`ALTER TABLE lease.${q(table)} ADD COLUMN IF NOT EXISTS ${q(c.name)} ${c.type}`);
    }
    ddl.push(`COMMENT ON TABLE lease.${q(table)} IS ${db.escapeLiteral(`${wb} / ${tab}: one row per sheet row (row_number = sheet row; row 1 = headers in lease.sheet_column); loaded by scripts/central/load-lease.mjs`)}`);
    for (const s of ddl) { ddlOut.push(`${s};`); if (!DRY) await db.query(s); }
    if (DRY) { await db.query('ROLLBACK'); report.push({ workbook: wb, tab, table, rows: data.length, status: 'dry-run' }); return; }

    // Columns that exist in the table but no longer in the sheet header still exist; only the ordinals below are typed.
    await db.query(`TRUNCATE lease.${q(table)}`);
    const byOrd = new Map(cols.map((c) => [c.ord, c]));
    let extraCells = 0;
    for (let i = 0; i < data.length; i += 200) {
      const chunk = data.slice(i, i + 200);
      const params = []; const tuples = [];
      for (const [rn, v] of chunk) {
        const rec = new Array(cols.length).fill(null); const extra = {};
        v.forEach((val, c) => {
          if (val === '' || val == null) return;
          const col = byOrd.get(c);
          if (col && fits(val, col.type)) rec[c] = val; else { extra[c] = val; extraCells++; }
        });
        const base = params.length;
        params.push(rn, JSON.stringify(extra), ...rec);
        tuples.push(`(${[`$${base + 1}`, `$${base + 2}::jsonb`, ...rec.map((_, k) => `$${base + 3 + k}`)].join(',')})`);
      }
      if (tuples.length) {
        await db.query(`INSERT INTO lease.${q(table)} (row_number, _extra${cols.map((c) => `, ${q(c.name)}`).join('')}) VALUES ${tuples.join(',')}`, params);
      }
    }
    await db.query(
      `INSERT INTO lease.sheet_tab (workbook_key, tab, table_name, loaded_at, source_rows, source_workbook_key)
       VALUES ($1,$2,$3, now(), $4, $5)
       ON CONFLICT (workbook_key, tab) DO UPDATE SET table_name = EXCLUDED.table_name, loaded_at = now(),
         source_rows = EXCLUDED.source_rows, source_workbook_key = EXCLUDED.source_workbook_key, app_written_at = NULL`,
      [wb, tab, table, data.length, src]);
    await db.query('DELETE FROM lease.sheet_column WHERE table_name = $1', [table]);
    for (const c of cols) {
      await db.query('INSERT INTO lease.sheet_column (table_name, ordinal, header, column_name, data_type) VALUES ($1,$2,$3::jsonb,$4,$5)',
        [table, c.ord, JSON.stringify(c.header), c.name, c.type]);
    }

    // Verification: counts + every row reads back exactly as the source.
    const { rows: back } = await db.query(`SELECT * FROM lease.${q(table)} ORDER BY row_number`);
    let mismatch = 0; let example = null;
    const srcByRn = new Map(data);
    for (const r of back) {
      const arr = [];
      for (const c of cols) if (r[c.name] != null) arr[c.ord] = r[c.name];
      for (const [k, v] of Object.entries(r._extra)) arr[Number(k)] = v;
      const a = JSON.stringify(trim(arr)); const b = JSON.stringify(srcByRn.get(r.row_number));
      if (a !== b) { mismatch++; example ??= { row: r.row_number, loaded: a.slice(0, 200), source: b?.slice(0, 200) }; }
    }
    if (back.length !== data.length || mismatch) throw new Error(`verify failed for ${tab}: ${back.length}/${data.length} rows, ${mismatch} mismatched ${JSON.stringify(example)}`);
    await db.query('COMMIT');
    report.push({ workbook: wb, tab, table, rows: data.length, columns: cols.length,
      typed: cols.filter((c) => c.type !== 'text').length, extraCells, rowsFromDisplayText: fromCells,
      status: present ? 'loaded + verified' : 'created empty (tab not in copy; app creates it on first use)' });
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

for (const spec of SPEC) {
  const { src, list } = await tabsOf(spec);
  for (const { tab, present } of list) await loadTab(spec.wb, src, tab, present, !!spec.create);
}
if (EMIT) writeFileSync(EMIT, `-- generated by scripts/central/load-lease.mjs --emit-ddl (do not edit by hand)\nSET ROLE lease_owner;\n${ddlOut.join('\n')}\nRESET ROLE;\n`);
console.table(report);
const fallback = report.reduce((a, r) => a + (r.rowsFromDisplayText || 0), 0);
if (fallback) console.log(`NOTE: ${fallback} rows had no raw values in the copy and were un-formatted from display text (best effort).`);
await db.end();
if (srcDb !== db) await srcDb.end();
