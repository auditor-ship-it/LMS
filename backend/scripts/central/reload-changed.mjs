#!/usr/bin/env node
/**
 * Reloads only the lease.* tabs whose Sheet copy changed since they were last loaded
 * (landing_sheets.rows.synced_at moves only when a row changes). Meant to run every few
 * minutes (systemd timer) BEFORE cutover, so hand edits in the Google Sheets reach central.
 * It calls load-lease.mjs per changed tab; that loader refuses a tab the apps have written
 * since its last load (app_written_at), so after cutover this job does nothing harmful —
 * but disable the timer anyway.
 *
 *   node reload-changed.mjs --db <postgres url> [--dry-run]
 */
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const DB = opt('--db') || process.env.CENTRAL_ADMIN_DATABASE_URL;
const DRY = args.includes('--dry-run');
if (!DB) { console.error('usage: --db <postgres url>'); process.exit(2); }

const c = new pg.Client({ connectionString: DB });
await c.connect();
const { rows } = await c.query(`
  SELECT t.workbook_key, t.tab, t.loaded_at,
         (SELECT max(r.synced_at) FROM landing_sheets.rows r
           WHERE r.workbook_key = coalesce(t.source_workbook_key, t.workbook_key) AND r.tab = t.tab) AS landing_at
  FROM lease.sheet_tab t WHERE t.loaded_at IS NOT NULL ORDER BY 1, 2`);
await c.end();

const changed = rows.filter((r) => r.landing_at && new Date(r.landing_at) > new Date(r.loaded_at));
const stamp = new Date().toISOString();
console.log(`${stamp} reload-changed: ${rows.length} tabs checked, ${changed.length} changed`);
const loader = path.join(path.dirname(fileURLToPath(import.meta.url)), 'load-lease.mjs');
let failed = 0;
for (const r of changed) {
  console.log(`${stamp} reloading ${r.workbook_key} / ${JSON.stringify(r.tab)} (landing ${new Date(r.landing_at).toISOString()} > loaded ${new Date(r.loaded_at).toISOString()})`);
  if (DRY) continue;
  const out = spawnSync(process.execPath, [loader, '--db', DB, '--only', r.tab], { encoding: 'utf8' });
  const line = (out.stdout || '').split('\n').find((l) => l.includes(`'${r.tab}'`) && l.includes('│')) || '';
  console.log(line.replace(/\s+/g, ' ').trim() || (out.stderr || '').slice(0, 300));
  if (out.status !== 0 || /refus|fail|mismatch/i.test(line)) failed++;
}
process.exit(failed ? 1 : 0);
