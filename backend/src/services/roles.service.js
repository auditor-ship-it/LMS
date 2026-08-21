/**
 * Ported from LMS.js lines ~264-520: dynamic, admin-editable Roles & Access
 * system layered ADDITIVELY on top of the static ACTION_PERMISSIONS map
 * (config/permissions.config.js). A grant here can only ever ADD access
 * relative to the static map, never remove it.
 *
 * Sheets (auto-created + seeded on first use):
 *   "Team Accounts"  — Email | Name | All Access | one column per PERMISSION_KEYS
 *   "Sidebar Access" — Email | one column per SIDEBAR_KEYS
 */
import {
  getSheetData,
  insertSheetIfMissing,
  deleteSheetIfExists,
  appendRow,
  updateCell,
  updateRange,
  deleteRows,
  colLetter
} from './googleSheets.service.js';
import { withSheetLock } from '../utils/sheetMutex.js';
import { SHEETS } from '../config/sheets.config.js';
import { PERMISSION_KEYS, SIDEBAR_KEYS, ROLES_ADMIN_EMAILS } from '../config/permissions.config.js';
import { safeStr } from '../utils/format.js';
import { cacheGet, cachePut, cacheRemove } from '../utils/memoryCache.js';
import { accessDenied } from '../utils/AppError.js';

/**
 * SHEETS-FIRST (reverted 2026-08-21). Every read/write in this file goes
 * directly to the live Google Sheet; Mongo is not consulted for reads or
 * writes here at all — Roles & Access is low-traffic admin-only data, so
 * the quota cost of always reading live is negligible, and manual edits to
 * either sheet are visible immediately.
 */

const TEAM_SHEET = SHEETS.TEAM_ACCOUNTS;
const SIDEBAR_SHEET = SHEETS.SIDEBAR_ACCESS;
const TEAM_HEADER = ['Email', 'Name', 'All Access', ...PERMISSION_KEYS.map((p) => p.label)];
const SIDEBAR_HEADER = ['Email', ...SIDEBAR_KEYS.map((p) => p.label)];

export function isRolesAdmin(email) {
  return ROLES_ADMIN_EMAILS.includes(email);
}

export function assertRolesAdmin(email) {
  if (!isRolesAdmin(email)) throw accessDenied('ACCESS_DENIED: Roles & Access is restricted to admins.');
}

function vec(trueKeys) {
  const o = {};
  for (const p of PERMISSION_KEYS) o[p.key] = trueKeys.includes(p.key);
  return o;
}

function accessSeedData() {
  const ALL = PERMISSION_KEYS.map((p) => p.key);
  const OFFLEASE_ALL = ['offlease1', 'offlease2', 'offlease3', 'offlease4', 'offlease5', 'offlease6', 'offlease7', 'offlease8', 'offlease9'];
  return [
    { email: 'intern@crystalgroup.in', perms: vec(ALL), allAccess: false },
    { email: 'shivani.dhall@crystalgroup.in', perms: vec(ALL), allAccess: false },
    { email: 'pushpa.shetty@crystalgroup.in', perms: vec(ALL), allAccess: false },
    { email: 'swati.barot@crystalgroup.in', perms: vec(ALL), allAccess: false },
    { email: 'support@crystalgroup.in', perms: vec(ALL), allAccess: false },
    { email: 'pc@crystalgroup.in', perms: vec(ALL), allAccess: false },
    { email: 'crystaladmin@crystalgroup.in', perms: vec(ALL.filter((k) => k !== 'offlease7')), allAccess: false },
    { email: 'sc@crystalgroup.in', perms: vec(['verify', 'approve', 'expiry', 'renew', 'document'].concat(OFFLEASE_ALL)), allAccess: false },
    { email: 'crm@crystalgroup.in', perms: vec(['expiry', 'renew', 'document', 'offleaseapproval'].concat(OFFLEASE_ALL)), allAccess: false },
    { email: 'dmo@crystalgroup.in', perms: vec(['expiry', 'renew', 'document', 'offleaseapproval', 'billing'].concat(OFFLEASE_ALL)), allAccess: false },
    { email: 'mansi.agarwal@crystalgroup.in', perms: vec(['renew', 'document', 'offleaseapproval', 'billing'].concat(OFFLEASE_ALL)), allAccess: false },
    { email: 'ar@crystalgroup.in', perms: vec(['renew', 'document', 'offleaseapproval', 'receivables'].concat(OFFLEASE_ALL)), allAccess: false },
    { email: 'kshirod.khatua@crystalgroup.in', perms: vec(OFFLEASE_ALL), allAccess: false },
    { email: 'service@crystalgroup.in', perms: vec(OFFLEASE_ALL), allAccess: false },
    { email: 'aa@crystalgroup.in', perms: vec(ALL), allAccess: true }
  ];
}

let seeded = false;
let sidebarHeaderChecked = false;

/**
 * SIDEBAR_KEYS grew (renewDocument/offLease appended) after the live
 * "Sidebar Access" sheet was already seeded in production — insertSheetIfMissing
 * only writes a header row when the sheet doesn't exist yet, so a plain config
 * change here would never reach the live sheet. Same self-heal pattern as
 * offlease.service.js's _ensureOffLeaseSheet: compare live header width to
 * SIDEBAR_HEADER.length, append whatever's missing. Runs once per process.
 */
async function _ensureSidebarHeaderWidth() {
  if (sidebarHeaderChecked) return;
  sidebarHeaderChecked = true;
  const { headers } = await getSheetData(SIDEBAR_SHEET, undefined, 'A1:ZZ1').catch(() => ({ headers: [] }));
  if (!headers.length) return; // sheet doesn't exist yet — insertSheetIfMissing above handles that case
  if (headers.length >= SIDEBAR_HEADER.length) return;
  const missing = SIDEBAR_HEADER.slice(headers.length);
  await updateRange(SIDEBAR_SHEET, `${colLetter(headers.length)}1:${colLetter(SIDEBAR_HEADER.length - 1)}1`, [missing]);
}

/** Seeds the two sheets once (only if Team Accounts has no data rows yet). */
export async function ensureRolesSeeded() {
  await _ensureSidebarHeaderWidth();
  if (seeded) return;

  // Migration guard: an old ROLE-based schema (Email | Name | Role) may exist.
  // Detect by 3rd header ("Role" vs "All Access") and wipe + reseed fresh.
  const existing = await getSheetData(TEAM_SHEET).catch(() => null);
  if (existing && existing.headers.length) {
    const hdr3 = safeStr(existing.headers[2]).trim().toLowerCase();
    if (hdr3 === 'role') {
      await deleteSheetIfExists(TEAM_SHEET);
      await deleteSheetIfExists(SIDEBAR_SHEET);
      await deleteSheetIfExists(SHEETS.ROLE_PERMISSIONS_LEGACY);
    }
  }

  await insertSheetIfMissing(TEAM_SHEET, TEAM_HEADER);
  const team = await getSheetData(TEAM_SHEET);
  if (team.rows.length >= 1) { seeded = true; return; } // already seeded

  await insertSheetIfMissing(SIDEBAR_SHEET, SIDEBAR_HEADER);

  const seed = accessSeedData();
  const teamRows = seed.map((r) => [r.email, '', r.allAccess, ...PERMISSION_KEYS.map((p) => !!r.perms[p.key])]);
  const sidebarRows = seed.map((r) => [r.email, ...SIDEBAR_KEYS.map(() => true)]);

  for (const row of teamRows) await appendRow(TEAM_SHEET, row);
  for (const row of sidebarRows) await appendRow(SIDEBAR_SHEET, row);

  seeded = true;
}

const TEAM_CACHE_KEY = 'access_team_v2';
const SIDEBAR_CACHE_KEY = 'access_sidebar_v2';
const ROLES_CACHE_TTL = 300; // 5 min, matches original

export function clearRolesCache() {
  cacheRemove(TEAM_CACHE_KEY);
  cacheRemove(SIDEBAR_CACHE_KEY);
}

/** email(lowercased) -> { name, allAccess, perms:{key:bool} } */
export async function loadTeamPermTable() {
  const hit = cacheGet(TEAM_CACHE_KEY);
  if (hit) return hit;
  await ensureRolesSeeded();
  const { rows } = await getSheetData(TEAM_SHEET);
  const out = {};
  for (const row of rows) {
    const email = safeStr(row[0]).trim().toLowerCase();
    if (!email) continue;
    const perms = {};
    PERMISSION_KEYS.forEach((p, k) => { perms[p.key] = row[3 + k] === true; });
    out[email] = { name: safeStr(row[1]), allAccess: row[2] === true, perms };
  }
  cachePut(TEAM_CACHE_KEY, out, ROLES_CACHE_TTL);
  return out;
}

export async function isKnownTeamAccount(email) {
  try {
    const table = await loadTeamPermTable();
    return !!table[String(email).trim().toLowerCase()];
  } catch (e) { return false; }
}

/** email(lowercased) -> { sidebarKey: bool } */
export async function loadSidebarTable() {
  const hit = cacheGet(SIDEBAR_CACHE_KEY);
  if (hit) return hit;
  await ensureRolesSeeded();
  const { rows } = await getSheetData(SIDEBAR_SHEET);
  const out = {};
  for (const row of rows) {
    const email = safeStr(row[0]).trim().toLowerCase();
    if (!email) continue;
    const vis = {};
    SIDEBAR_KEYS.forEach((s, k) => { vis[s.key] = row[1 + k] === true; });
    out[email] = vis;
  }
  cachePut(SIDEBAR_CACHE_KEY, out, ROLES_CACHE_TTL);
  return out;
}

/** ADDITIVE: OR'd with the hardcoded ACTION_PERMISSIONS in permissions.service.js. */
export async function dynamicHasPermission(email, type) {
  try {
    const table = await loadTeamPermTable();
    const acct = table[String(email).trim().toLowerCase()];
    if (!acct) return false;
    if (acct.allAccess) return true;
    return !!acct.perms[type];
  } catch (e) { return false; }
}

/** Returns null ("no opinion") if the email isn't in the sheet at all. */
export async function dynamicSidebarVisible(email, tabId) {
  try {
    const table = await loadSidebarTable();
    const vis = table[String(email).trim().toLowerCase()];
    if (!vis || !(tabId in vis)) return null;
    return !!vis[tabId];
  } catch (e) { return null; }
}

/* ==== Admin-facing CRUD — every call re-asserts admin; every write clears the cache. ==== */

/**
 * SIDEBAR_KEYS (permissions.config.js) is the FULL 15-column schema shared
 * with the original app (Dashboard/Billing Sales/Pending Billing/Receivables/
 * Monthly Statement/Outstanding View/Report/Billing Approval/Dispute
 * Approval/Approval Summary — Accounts & Collection's pages, not this app's).
 * Lease Management's own Sidebar.jsx only ever reads 4 of these keys
 * (myTask/verify/approve/expiry — see constants/nav.js's sidebarKey fields);
 * every other column in the admin's Sidebar grid toggled something with no
 * effect here, which is exactly what was reported as confusing/broken.
 *
 * Fix is display-only, on purpose: this filters what the ADMIN UI *shows*,
 * not SIDEBAR_KEYS itself — loadSidebarTable()/saveEmailSidebar() below still
 * index into the full, unfiltered array, so the live Sheet's column
 * positions (fixed by the original app's schema) are untouched. Filtering
 * the source array instead would shift every later key onto the wrong
 * column and silently corrupt Sidebar Access data.
 *
 * Same problem, same fix, on the action-permissions grid: PERMISSION_KEYS'
 * billing/receivables entries gate Accounts & Collection's own pages —
 * confirmed unused anywhere in this app's frontend (no canAct('billing')/
 * canAct('receivables') call exists here) — so they're excluded from display
 * the same way, leaving saveEmailPermission's column math against the full
 * array untouched.
 *
 * offlease2/offlease4 joined them 2026-08-18 for the same reason, confirmed
 * the same way: Stage 2 (Lifting/Arrival) and Stage 4 (Quotation/Order) were
 * retired from the live workflow, StagePageBase is only ever reached with a
 * stage number OffLeasePage's own tab strip offers (constants/stages.js'
 * STAGES, which excludes both), and no other route passes stageNumber 2 or 4
 * — so canAct('offlease2')/canAct('offlease4') can never be evaluated by any
 * reachable screen. Their DATA is still preserved and shown on the container
 * report; only the now-meaningless permission toggle is hidden.
 *
 * offlease9 is DIFFERENT and included at the requester's explicit choice, not
 * by the same "confirmed unused" reasoning as the other three: Stage9Page.jsx
 * actively calls canAct('offlease9') and is routed — hiding it here does not
 * disable that check, it only removes the admin's ability to grant/revoke it
 * through this grid. Whoever is in ACTION_PERMISSIONS.offleasedashboard's
 * sibling, offlease9, in permissions.config.js keeps working exactly as
 * today; nobody's access changes, but a NEW hire can no longer be added to
 * Stage 9 without a code change (or offlease9 being taken back out of this
 * set) until this is revisited.
 */
const RELEVANT_SIDEBAR_KEYS = new Set(['myTask', 'verify', 'approve', 'expiry', 'renewDocument', 'offLease', 'deployedSummary']);
const IRRELEVANT_PERMISSION_KEYS = new Set(['billing', 'receivables', 'offlease2', 'offlease4', 'offlease9']);

export async function getRolesAndAccessData(callerEmail) {
  assertRolesAdmin(callerEmail);
  await ensureRolesSeeded();
  const team = await loadTeamPermTable();
  const sidebar = await loadSidebarTable();
  const emails = Object.keys(team).sort();
  const teamList = emails.map((e) => ({ email: e, name: team[e].name }));
  const visibleSidebarKeys = SIDEBAR_KEYS.filter((k) => RELEVANT_SIDEBAR_KEYS.has(k.key));
  const visiblePermKeys = PERMISSION_KEYS.filter((k) => !IRRELEVANT_PERMISSION_KEYS.has(k.key));
  return { emails, permKeys: visiblePermKeys, sidebarKeys: visibleSidebarKeys, emailPerms: team, emailSidebar: sidebar, team: teamList };
}

async function findRowIndexByEmail(sheetName, email) {
  const { rows } = await getSheetData(sheetName);
  for (let i = 0; i < rows.length; i++) {
    if (safeStr(rows[i][0]).trim().toLowerCase() === email) return i + 2; // 1-based, +1 for header
  }
  return -1;
}

export async function saveEmailPermission(callerEmail, email, key, value) {
  assertRolesAdmin(callerEmail);
  email = safeStr(email).trim().toLowerCase();
  const keys = PERMISSION_KEYS.map((p) => p.key);
  if (key !== 'allAccess' && !keys.includes(key)) throw new Error('Unknown permission key');
  const col0 = key === 'allAccess' ? 2 : 3 + keys.indexOf(key);

  await withSheetLock(TEAM_SHEET, async () => {
    const targetRow = await findRowIndexByEmail(TEAM_SHEET, email);
    if (targetRow === -1) throw new Error(`Email not found: ${email}`);
    await updateCell(TEAM_SHEET, targetRow, col0, !!value);
  });

  clearRolesCache();
  return 'OK';
}

export async function saveEmailSidebar(callerEmail, email, key, value) {
  assertRolesAdmin(callerEmail);
  email = safeStr(email).trim().toLowerCase();
  const keys = SIDEBAR_KEYS.map((p) => p.key);
  const idx = keys.indexOf(key);
  if (idx === -1) throw new Error('Unknown sidebar key');

  await withSheetLock(SIDEBAR_SHEET, async () => {
    const targetRow = await findRowIndexByEmail(SIDEBAR_SHEET, email);
    if (targetRow === -1) throw new Error(`Email not found: ${email}`);
    await updateCell(SIDEBAR_SHEET, targetRow, 1 + idx, !!value);
  });

  clearRolesCache();
  return 'OK';
}

export async function addTeamAccount(callerEmail, email, name) {
  assertRolesAdmin(callerEmail);
  email = safeStr(email).trim().toLowerCase();
  name = safeStr(name).trim();
  if (!email || !email.includes('@')) throw new Error('Valid email is required');
  const table = await loadTeamPermTable();
  if (table[email]) throw new Error(`Email already exists: ${email}`);

  const tRow = [email, name, false, ...PERMISSION_KEYS.map(() => false)];
  await withSheetLock(TEAM_SHEET, () => appendRow(TEAM_SHEET, tRow));

  const sRow = [email, ...SIDEBAR_KEYS.map(() => true)];
  await withSheetLock(SIDEBAR_SHEET, () => appendRow(SIDEBAR_SHEET, sRow));

  clearRolesCache();
  return 'OK';
}

export async function removeTeamAccount(callerEmail, email) {
  assertRolesAdmin(callerEmail);
  email = safeStr(email).trim().toLowerCase();

  let tFound = false;
  await withSheetLock(TEAM_SHEET, async () => {
    const targetRow = await findRowIndexByEmail(TEAM_SHEET, email);
    if (targetRow !== -1) { tFound = true; await deleteRows(TEAM_SHEET, [targetRow]); }
  });
  await withSheetLock(SIDEBAR_SHEET, async () => {
    const targetRow = await findRowIndexByEmail(SIDEBAR_SHEET, email);
    if (targetRow !== -1) await deleteRows(SIDEBAR_SHEET, [targetRow]);
  });

  clearRolesCache();
  if (!tFound) throw new Error(`Email not found: ${email}`);
  return 'OK';
}
