/**
 * Write-behind worker (DATA_SOURCE=central + CENTRAL_SHEETS_MIRROR=on): replays every write the
 * app made to the central lease tables onto the real Google Sheet, so the Sheet stays a
 * one-way mirror of central after cutover. Ops come from lease.sheet_outbox in id order; a tab
 * whose op fails is retried with backoff and blocks only its own later ops (row numbers depend
 * on order). Reads never touch Google; the app's requests never wait on this worker.
 */
import { centralPool, runAgainstGoogle, mirrorToSheets, ssIdForWorkbook } from '../services/centralSheets.service.js';
import * as gs from '../services/googleSheets.service.js';
import { isGoogleQuotaError } from '../middlewares/errorHandler.js';
import { logger } from '../utils/logger.js';

const POLL_MS = Number(process.env.SHEETS_MIRROR_POLL_MS) || 5000;
const BATCH = 200;
const BASE_DELAY_MS = 15000;
const MAX_DELAY_MS = 15 * 60 * 1000;
const LOCK_KEY = 727001;

/** Applies one queued op to Google. `g` is injectable for tests. */
export async function applyOp(op, g = gs) {
  const ssId = ssIdForWorkbook(op.workbook_key);
  const p = op.payload;
  if (op.op === 'write') {
    const rows = p.values || [];
    const width = Math.max(1, ...rows.map((r) => (r || []).length));
    await g.ensureColumnCount(op.tab, p.startCol + width, ssId);
    const a1 = `${g.colLetter(p.startCol)}${p.startRow}:${g.colLetter(p.startCol + width - 1)}${p.startRow + rows.length - 1}`;
    await g.updateRange(op.tab, a1, rows, ssId);
  } else if (op.op === 'append') {
    await g.appendRows(op.tab, p.values || [], ssId);
  } else if (op.op === 'delete') {
    await g.deleteRows(op.tab, p.rowNums || [], ssId);
  } else {
    throw new Error(`unknown op '${op.op}'`);
  }
}

let pausedUntil = 0;
let timer = null;

export async function drainOnce(g = gs) {
  if (Date.now() < pausedUntil) return { applied: 0, paused: true };
  const client = await centralPool().connect();
  let applied = 0;
  try {
    const { rows: [lock] } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
    if (!lock.ok) return { applied: 0, otherWorker: true };
    try {
      const { rows } = await client.query(
        'SELECT id, workbook_key, tab, op, payload, attempts, retry_after FROM lease.sheet_outbox WHERE done_at IS NULL ORDER BY id LIMIT $1', [BATCH]);
      const blocked = new Set();
      for (const op of rows) {
        const key = `${op.workbook_key}\u0000${op.tab}`;
        if (blocked.has(key)) continue;
        if (op.retry_after && new Date(op.retry_after).getTime() > Date.now()) { blocked.add(key); continue; }
        try {
          await runAgainstGoogle(() => applyOp(op, g));
          await client.query('UPDATE lease.sheet_outbox SET done_at = now(), last_error = NULL WHERE id = $1', [op.id]);
          applied++;
        } catch (e) {
          blocked.add(key);
          const attempts = op.attempts + 1;
          const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(op.attempts, 10));
          await client.query('UPDATE lease.sheet_outbox SET attempts = $2, retry_after = now() + ($3 || \' milliseconds\')::interval, last_error = $4 WHERE id = $1',
            [op.id, attempts, String(delay), String(e?.message || e).slice(0, 500)]);
          logger.error(`[SHEETS-MIRROR] op ${op.id} (${op.op} ${op.tab}) failed, attempt ${attempts}: ${e?.message || e}`);
          if (isGoogleQuotaError?.(e)) { pausedUntil = Date.now() + 5 * 60 * 1000; break; }
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    }
  } finally {
    client.release();
  }
  return { applied };
}

export function startSheetsWriteBehind() {
  if (!mirrorToSheets()) return;
  logger.info(`[SHEETS-MIRROR] write-behind to Google Sheets ENABLED (poll ${POLL_MS} ms)`);
  const tick = async () => {
    try { const r = await drainOnce(); if (r.applied) logger.info(`[SHEETS-MIRROR] replayed ${r.applied} op(s)`); }
    catch (e) { logger.error('[SHEETS-MIRROR] drain failed:', e.message); }
    timer = setTimeout(tick, POLL_MS);
  };
  timer = setTimeout(tick, POLL_MS);
}

export function stopSheetsWriteBehind() { if (timer) clearTimeout(timer); timer = null; }
