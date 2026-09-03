/**
 * OFF-LEASE DASHBOARD REMARKS
 *
 * A live comment thread per off-lease record, written on the dashboard itself
 * rather than read out of the stage columns. Stage remarks belong to a stage
 * and are frozen once that stage completes; these are the running commentary
 * on the record and can be added at any point.
 *
 * Append-only in its own sheet, like Stage 9 — a record accumulates remarks,
 * nothing is overwritten, and every entry keeps who wrote it and when. The
 * dashboard shows the newest plus a count of the rest.
 *
 * Keyed on container + lease ID because a container can be off-leased under
 * two leases at once and their commentary must not merge.
 */
import { getSheetData, appendRow, insertSheetIfMissing, updateRange, deleteRows } from './googleSheets.service.js';
import { SHEETS } from '../config/sheets.config.js';
import { ROLES_ADMIN_EMAILS } from '../config/permissions.config.js';
import { safeStr } from '../utils/format.js';
import { AppError, accessDenied } from '../utils/AppError.js';
import { withSheetLock } from '../utils/sheetMutex.js';
import { userHasAction } from './permissions.service.js';
import { cacheGet, cachePut, cacheRemove } from '../utils/memoryCache.js';

const R_SHEET = SHEETS.OFF_LEASE_REMARKS;

/* `Remark ID` is column A and is what edit/delete target. Rows are append-only
   and a container can hold many remarks, so position is not a stable handle —
   deleting one row shifts every row after it, and a concurrent delete would
   otherwise make an edit land on someone else's remark.

   `Stage` (col I) added 2026-09-02, APPENDED rather than inserted alongside
   the other identity columns — every existing row simply reads blank for it,
   no migration needed, and every fixed-index read below (r[0]..r[7]) stays
   correct for rows written before this column existed. Blank = the original
   dashboard-wide "running commentary on the record" thread (see this file's
   header comment); a real internal stage number = a remark scoped to that
   one stage, written from StageDetailModal instead of the dashboard. */
export const R_HEADERS = [
  'Remark ID', 'Container No', 'Lease ID', 'Remark', 'Remark Text', 'Timestamp', 'Entered By', 'Edited On', 'Stage'
];

/** Anyone who can work ANY off-lease stage may comment. Deliberately not a new
 *  permission key: PERMISSION_KEYS is read positionally against the live Team
 *  Accounts sheet, so every addition is a column that has to be created there
 *  before it grants anything. */
const REMARK_PERMS = ['offlease1', 'offlease2', 'offlease3', 'offlease4', 'offlease5', 'offlease6', 'offlease7', 'offlease8', 'offlease9'];

const isMissingSheet = (e) => String(e?.message || '').includes('Unable to parse range');

const pad2 = (n) => String(n).padStart(2, '0');
const dmyTime = (d) => `${safeStr(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

const key = (container, leaseId) =>
  `${safeStr(container).trim().toUpperCase()}::${safeStr(leaseId).trim().toUpperCase()}`;

/* ------------------------------------------------------------- sanitising */

/** Inline formatting only — enough for a comment, nothing that can execute,
 *  load a resource, or break the page out of its cell. */
const ALLOWED_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'br', 'p', 'ul', 'ol', 'li']);

/**
 * Strips the stored HTML down to the allow-list, dropping EVERY attribute.
 *
 * This runs on the way IN, so the sheet only ever holds safe markup — the
 * dashboard renders these remarks as HTML, and a stored <script>, <img onerror>
 * or style="" would otherwise execute in every viewer's browser. Attributes go
 * wholesale rather than selectively: there is no attribute this editor needs,
 * and an allow-list of none cannot be got around.
 */
export function sanitizeRemarkHtml(html) {
  return String(html ?? '')
    // Element content that is never displayable but would still run/apply.
    .replace(/<(script|style|iframe|object|embed|svg|math)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (tag, name) => {
      const t = String(name).toLowerCase();
      if (!ALLOWED_TAGS.has(t)) return '';
      return tag.startsWith('</') ? `</${t}>` : (t === 'br' ? '<br>' : `<${t}>`);
    })
    .trim();
}

/** The same remark as plain text — what search matches on, and what the
 *  Excel/PDF exports and any non-HTML surface show. */
export function remarkToText(html) {
  return String(html ?? '')
    .replace(/<(br|\/p|\/li|\/ul|\/ol)\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ----------------------------------------------------------------- reading */

/** Every remark ever written, oldest first as the sheet holds them.
 *  `_rowNum` is the 1-based sheet row, used only by edit/delete. */
async function readAll() {
  try {
    const { rows } = await getSheetData(R_SHEET);
    return rows
      .map((r, i) => ({
        id: safeStr(r[0]),
        containerNo: safeStr(r[1]),
        leaseId: safeStr(r[2]),
        html: safeStr(r[3]),
        text: safeStr(r[4]),
        timestamp: safeStr(r[5]),
        enteredBy: safeStr(r[6]),
        editedOn: safeStr(r[7]),
        stage: safeStr(r[8]),
        _rowNum: i + 2
      }))
      .filter((r) => r.containerNo.trim() !== '');
  } catch (e) {
    if (isMissingSheet(e)) return [];
    throw e;
  }
}

/* The SHEET READ is cached, not the derived views — the dashboard index and a
   hover thread both want the same rows, and reading twice meant two live
   round-trips. On a project that already exhausts the per-minute read quota a
   miss is not ~0.5s but tens of seconds of retry backoff, which is what left
   the hover popover stuck on "Loading…". Dropped on every write, so a remark
   just saved, edited or deleted is reflected at once. */
const ROWS_CACHE_KEY = 'offlease:remark-rows';
const ROWS_TTL_SECONDS = 60; // seconds: cachePut multiplies by 1000 itself

function invalidateIndex() { cacheRemove(ROWS_CACHE_KEY); }

async function readAllCached() {
  const hit = cacheGet(ROWS_CACHE_KEY);
  if (hit) return hit;
  const rows = await readAll();
  cachePut(ROWS_CACHE_KEY, rows, ROWS_TTL_SECONDS);
  return rows;
}

/**
 * { "CONTAINER::LEASE": { latest, count } } for the dashboard, which needs one
 * lookup per record and must not read the sheet once per row.
 *
 * Dashboard-wide remarks only (blank Stage) — a remark added from a stage's
 * own detail modal belongs to that stage, not to this record-wide thread, and
 * must not silently become "the latest remark" shown on the dashboard cell.
 */
export async function getRemarkIndex() {
  const index = {};
  for (const r of (await readAllCached()).filter((r) => !r.stage.trim())) {
    const k = key(r.containerNo, r.leaseId);
    const cur = index[k];
    // Append-only, so the last row for a key is the newest.
    index[k] = { latest: r, count: (cur?.count || 0) + 1 };
  }
  return index;
}

/** The full thread for one record, newest first.
 *
 * `stage`, when given (an internal stage number, as a string or number), scopes
 * this to just that stage's own remarks — StageDetailModal's use. Omitted
 * (undefined/null/''), every remark for the record is returned regardless of
 * stage — the dashboard's own use, unchanged from before the Stage column
 * existed. */
export async function getRemarkThread(containerNo, leaseId, stage) {
  const k = key(containerNo, leaseId);
  const stageWanted = stage === undefined || stage === null ? '' : safeStr(stage).trim();
  return (await readAllCached())
    .filter((r) => key(r.containerNo, r.leaseId) === k)
    .filter((r) => !stageWanted || r.stage.trim() === stageWanted)
    .reverse();
}

/* ----------------------------------------------------------------- writing */

async function assertCanRemark(userEmail) {
  const allowed = await Promise.all(REMARK_PERMS.map((p) => userHasAction(userEmail, p)));
  if (!allowed.some(Boolean)) throw accessDenied();
}

/** Cleans and validates the body once, for both add and edit. */
function prepareBody(html) {
  const clean = sanitizeRemarkHtml(html);
  const text = remarkToText(clean);
  if (!text) throw new AppError('Remark cannot be empty');
  return { clean, text };
}

let remarkSeq = 0;
/** Unique enough without a uuid dependency: time, a per-process counter (two
 *  remarks in the same millisecond) and randomness (two processes). */
function newRemarkId() {
  remarkSeq = (remarkSeq + 1) % 1000;
  return `R${Date.now().toString(36)}${remarkSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
}

export async function addOffLeaseRemark({ containerNo, leaseId, html, stage }, userEmail) {
  await assertCanRemark(userEmail);

  const container = safeStr(containerNo).trim().toUpperCase();
  if (!container) throw new AppError('Container number is required');

  const { clean, text } = prepareBody(html);
  const id = newRemarkId();
  const stageVal = stage === undefined || stage === null ? '' : safeStr(stage).trim();
  const row = [id, container, safeStr(leaseId).trim(), clean, text, dmyTime(new Date()), userEmail || '', '', stageVal];

  return withSheetLock(R_SHEET, async () => {
    /* Append first, create only on failure — creating eagerly costs a full
       spreadsheets.get per save, and this project already exhausts the
       per-minute read quota. */
    try {
      await appendRow(R_SHEET, row);
    } catch (e) {
      if (!isMissingSheet(e)) throw e;
      await insertSheetIfMissing(R_SHEET, R_HEADERS);
      await appendRow(R_SHEET, row);
    }
    invalidateIndex();
    return {
      message: 'SAVED',
      remark: { id, containerNo: container, leaseId: row[2], html: clean, text, timestamp: row[5], enteredBy: row[6], stage: stageVal }
    };
  });
}

/**
 * Edit and delete are limited to the remark's OWN author, plus roles admins.
 *
 * These are somebody's words with their name against them: letting any user
 * with off-lease access rewrite another person's comment would make the
 * attribution meaningless. Admins keep a way to remove content that has to go.
 */
function assertOwns(remark, userEmail) {
  const mine = safeStr(remark.enteredBy).trim().toLowerCase() === safeStr(userEmail).trim().toLowerCase();
  if (mine) return;
  if (ROLES_ADMIN_EMAILS.includes(safeStr(userEmail).trim().toLowerCase())) return;
  throw accessDenied('You can only edit or delete your own remarks.');
}

async function findById(id) {
  const wanted = safeStr(id).trim().toUpperCase();
  if (!wanted) throw new AppError('Remark ID is required');
  const hit = (await readAll()).find((r) => r.id.trim().toUpperCase() === wanted);
  if (!hit) throw new AppError(`Remark not found: ${id}`, 404);
  return hit;
}

export async function updateOffLeaseRemark(id, html, userEmail) {
  await assertCanRemark(userEmail);
  const { clean, text } = prepareBody(html);

  return withSheetLock(R_SHEET, async () => {
    /* Re-read INSIDE the lock: the row number came from a read taken before
       the lock, and a concurrent delete would have shifted every row after
       it — writing to the stale number would overwrite a different remark. */
    const hit = await findById(id);
    assertOwns(hit, userEmail);
    // Body columns only (D:E), plus the edited stamp — the original author and
    // creation time are the record and are never rewritten.
    await updateRange(R_SHEET, `D${hit._rowNum}:E${hit._rowNum}`, [[clean, text]]);
    await updateRange(R_SHEET, `H${hit._rowNum}:H${hit._rowNum}`, [[dmyTime(new Date())]]);
    invalidateIndex();
    return { message: 'UPDATED', remark: { ...hit, html: clean, text } };
  });
}

export async function deleteOffLeaseRemark(id, userEmail) {
  await assertCanRemark(userEmail);

  return withSheetLock(R_SHEET, async () => {
    const hit = await findById(id);
    assertOwns(hit, userEmail);
    await deleteRows(R_SHEET, [hit._rowNum]);
    invalidateIndex();
    return { message: 'DELETED', id: hit.id };
  });
}
