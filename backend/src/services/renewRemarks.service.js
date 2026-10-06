/**
 * RENEW APPROVAL PENDING REMARKS
 *
 * A live comment thread per row on the Renew Approval Pending page (explicit
 * request 2026-10-05: "click the row and open then remarks comment option").
 * Same shape as Off-Lease's dashboard remarks (offleaseRemarks.service.js —
 * sanitizeRemarkHtml/remarkToText are reused from there verbatim, HTML
 * sanitising has nothing Off-Lease-specific about it), but kept as its own
 * sheet/service rather than sharing Off-Lease's: that one is gated by
 * Off-Lease's own offlease1-9 permissions, and reusing it here would let
 * anyone with Off-Lease access (but no Renew & Document access) read or post
 * into a Renew Approval Pending thread, and vice versa.
 *
 * Keyed on container + ROW NUMBER, not lease ID — the Deployed sheet this
 * page reads from (expiry.service.js's getExpiryDataByFilter) has no lease ID
 * column, but a container can still carry more than one row on it across
 * renewal cycles (an old row is never deleted — see that file's own doc
 * comment), so row number is what disambiguates them here instead.
 *
 * Append-only, like every other comment-thread sheet in this app — nothing is
 * overwritten, every entry keeps who wrote it and when.
 */
import { getSheetData, appendRow, insertSheetIfMissing, updateRange, deleteRows } from './googleSheets.service.js';
import { getSheetDataFromMongo, appendMongoMirrorRow } from './mongoSheetData.service.js';
import { SHEETS } from '../config/sheets.config.js';
import { safeStr } from '../utils/format.js';
import { AppError, accessDenied, notFound } from '../utils/AppError.js';
import { withSheetLock } from '../utils/sheetMutex.js';
import { userHasAction } from './permissions.service.js';
import { isRolesAdmin } from './roles.service.js';
import { cacheGet, cachePut, cacheRemove } from '../utils/memoryCache.js';
import { sanitizeRemarkHtml, remarkToText } from './offleaseRemarks.service.js';
import { getExpiryDataByFilter } from './expiry.service.js';

const R_SHEET = SHEETS.RENEW_REMARKS;

/* `Remark ID` is column A and is what edit/delete target — rows are
   append-only and a container can hold many remarks, so position alone is
   not a stable handle (see offleaseRemarks.service.js's identical note). */
export const R_HEADERS = [
  'Remark ID', 'Container No', 'Row Num', 'Remark', 'Remark Text', 'Timestamp', 'Entered By', 'Edited On'
];

/** Anyone who can submit, complete, or approve a renewal may comment —
 *  mirrors offleaseRemarks.service.js's "any desk permission" rule. */
const REMARK_PERMS = ['document', 'renew', 'renewApproval'];

const isMissingSheet = (e) => String(e?.message || '').includes('Unable to parse range');

const pad2 = (n) => String(n).padStart(2, '0');
const dmyTime = (d) => `${safeStr(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

const key = (container, rowNum) =>
  `${safeStr(container).trim().toUpperCase()}::${safeStr(rowNum).trim()}`;

/* ----------------------------------------------------------------- reading */

function _mapRemarkRows(rows) {
  return rows
    .map((r, i) => ({
      id: safeStr(r[0]),
      containerNo: safeStr(r[1]),
      rowNum: safeStr(r[2]),
      html: safeStr(r[3]),
      text: safeStr(r[4]),
      timestamp: safeStr(r[5]),
      enteredBy: safeStr(r[6]),
      editedOn: safeStr(r[7]),
      _rowNum: i + 2
    }))
    .filter((r) => r.containerNo.trim() !== '');
}

/** LIVE read — only the write path (edit/delete) needs this, to resolve the
 *  exact row an action targets (see offleaseRemarks.service.js's identical
 *  readAll/readAllFromMirror split and its doc comment on why). */
async function readAll() {
  try {
    const { rows } = await getSheetData(R_SHEET);
    return _mapRemarkRows(rows);
  } catch (e) {
    if (isMissingSheet(e)) return [];
    throw e;
  }
}

async function readAllFromMirror() {
  const { rows } = await getSheetDataFromMongo(R_SHEET);
  return _mapRemarkRows(rows);
}

const ROWS_CACHE_KEY = 'renew:remark-rows';
const ROWS_TTL_SECONDS = 60;

function invalidateIndex() { cacheRemove(ROWS_CACHE_KEY); }

async function readAllCached() {
  const hit = cacheGet(ROWS_CACHE_KEY);
  if (hit) return hit;
  const rows = await readAllFromMirror();
  cachePut(ROWS_CACHE_KEY, rows, ROWS_TTL_SECONDS);
  return rows;
}

/** Confirms this container+rowNum is actually in the CALLER's own visible
 *  Renew Approval Pending list before showing or accepting a comment on it —
 *  same confidentiality boundary the page itself enforces (sale-person
 *  scoping, via getExpiryDataByFilter), rather than a fresh, separately
 *  maintained access check. A row that has moved on (approved/rejected since)
 *  simply 404s here, same as it would disappear from the page. */
async function assertVisible(containerNo, rowNum, user) {
  const rows = (await getExpiryDataByFilter('approval', user)).data || [];
  const want = key(containerNo, rowNum);
  const hit = rows.some((r) => key(r.row?.[0], r._rowNum) === want);
  if (!hit) throw notFound(`Not found: ${safeStr(containerNo)}`);
}

/** The full thread for one row, newest first. */
export async function getRenewRemarkThread(containerNo, rowNum, user) {
  await assertVisible(containerNo, rowNum, user);
  const k = key(containerNo, rowNum);
  return (await readAllCached())
    .filter((r) => key(r.containerNo, r.rowNum) === k)
    .reverse();
}

/* ----------------------------------------------------------------- writing */

async function assertCanRemark(userEmail) {
  const allowed = await Promise.all(REMARK_PERMS.map((p) => userHasAction(userEmail, p)));
  if (!allowed.some(Boolean)) throw accessDenied();
}

function prepareBody(html) {
  const clean = sanitizeRemarkHtml(html);
  const text = remarkToText(clean);
  if (!text) throw new AppError('Remark cannot be empty');
  return { clean, text };
}

let remarkSeq = 0;
function newRemarkId() {
  remarkSeq = (remarkSeq + 1) % 1000;
  return `R${Date.now().toString(36)}${remarkSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
}

export async function addRenewRemark({ containerNo, rowNum, html }, userEmail, user) {
  await assertCanRemark(userEmail);
  await assertVisible(containerNo, rowNum, user);

  const container = safeStr(containerNo).trim().toUpperCase();
  if (!container) throw new AppError('Container number is required');

  const { clean, text } = prepareBody(html);
  const id = newRemarkId();
  const row = [id, container, safeStr(rowNum).trim(), clean, text, dmyTime(new Date()), userEmail || '', ''];

  return withSheetLock(R_SHEET, async () => {
    try {
      await appendRow(R_SHEET, row);
    } catch (e) {
      if (!isMissingSheet(e)) throw e;
      await insertSheetIfMissing(R_SHEET, R_HEADERS);
      await appendRow(R_SHEET, row);
    }
    await appendMongoMirrorRow(R_SHEET, row);
    invalidateIndex();
    return {
      message: 'SAVED',
      remark: { id, containerNo: container, rowNum: row[2], html: clean, text, timestamp: row[5], enteredBy: row[6] }
    };
  });
}

/** Edit and delete are limited to the remark's own author, plus roles admins
 *  — same reasoning as offleaseRemarks.service.js's identical assertOwns. */
async function assertOwns(remark, userEmail) {
  const mine = safeStr(remark.enteredBy).trim().toLowerCase() === safeStr(userEmail).trim().toLowerCase();
  if (mine) return;
  if (await isRolesAdmin(safeStr(userEmail).trim().toLowerCase())) return;
  throw accessDenied('You can only edit or delete your own remarks.');
}

async function findById(id) {
  const wanted = safeStr(id).trim().toUpperCase();
  if (!wanted) throw new AppError('Remark ID is required');
  const hit = (await readAll()).find((r) => r.id.trim().toUpperCase() === wanted);
  if (!hit) throw new AppError(`Remark not found: ${id}`, 404);
  return hit;
}

export async function updateRenewRemark(id, html, userEmail) {
  await assertCanRemark(userEmail);
  const { clean, text } = prepareBody(html);

  return withSheetLock(R_SHEET, async () => {
    const hit = await findById(id);
    await assertOwns(hit, userEmail);
    await updateRange(R_SHEET, `D${hit._rowNum}:E${hit._rowNum}`, [[clean, text]]);
    await updateRange(R_SHEET, `H${hit._rowNum}:H${hit._rowNum}`, [[dmyTime(new Date())]]);
    invalidateIndex();
    return { message: 'UPDATED', remark: { ...hit, html: clean, text } };
  });
}

export async function deleteRenewRemark(id, userEmail) {
  await assertCanRemark(userEmail);

  return withSheetLock(R_SHEET, async () => {
    const hit = await findById(id);
    await assertOwns(hit, userEmail);
    await deleteRows(R_SHEET, [hit._rowNum]);
    invalidateIndex();
    return { message: 'DELETED', id: hit.id };
  });
}
