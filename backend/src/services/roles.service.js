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
  appendRow
} from './googleSheets.service.js';
import { getSheetDataFromMongo } from './mongoSheetData.service.js';
import { writeThrough } from './writeThrough.service.js';
import { SHEETS } from '../config/sheets.config.js';
import { normalizeKey } from '../config/mongoSheetMapping.js';
import { PERMISSION_KEYS, SIDEBAR_KEYS, ROLES_ADMIN_EMAILS } from '../config/permissions.config.js';
import { safeStr } from '../utils/format.js';
import { cacheGet, cachePut, cacheRemove } from '../utils/memoryCache.js';
import { accessDenied } from '../utils/AppError.js';

/**
 * MONGO MIGRATION NOTE: ensureRolesSeeded() below still reads/writes the
 * live Google Sheet directly (getSheetData/insertSheetIfMissing/
 * deleteSheetIfExists/appendRow) — it's a one-time bootstrap check that
 * only ever does anything the very first time these two tabs don't exist
 * yet (both are already seeded in production, confirmed by the one-time
 * sync). Everything downstream of seeding (loadTeamPermTable/
 * loadSidebarTable and the four write functions) now reads/writes Mongo
 * (getSheetDataFromMongo / writeThrough) — Sheets stays in sync via the
 * outbox worker + jobs/sheetsReconcile.job.js, not inline in these calls.
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
  const OFFLEASE_ALL = ['offlease1', 'offlease2', 'offlease3', 'offlease4', 'offlease5', 'offlease6', 'offlease7', 'offlease8'];
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

/** Seeds the two sheets once (only if Team Accounts has no data rows yet). */
export async function ensureRolesSeeded() {
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
  const { rows } = await getSheetDataFromMongo(TEAM_SHEET);
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
  const { rows } = await getSheetDataFromMongo(SIDEBAR_SHEET);
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

export async function getRolesAndAccessData(callerEmail) {
  assertRolesAdmin(callerEmail);
  await ensureRolesSeeded();
  const team = await loadTeamPermTable();
  const sidebar = await loadSidebarTable();
  const emails = Object.keys(team).sort();
  const teamList = emails.map((e) => ({ email: e, name: team[e].name }));
  return { emails, permKeys: PERMISSION_KEYS, sidebarKeys: SIDEBAR_KEYS, emailPerms: team, emailSidebar: sidebar, team: teamList };
}

export async function saveEmailPermission(callerEmail, email, key, value) {
  assertRolesAdmin(callerEmail);
  email = safeStr(email).trim().toLowerCase();
  const keys = PERMISSION_KEYS.map((p) => p.key);
  if (key !== 'allAccess' && !keys.includes(key)) throw new Error('Unknown permission key');
  const col0 = key === 'allAccess' ? 2 : 3 + keys.indexOf(key);

  const result = await writeThrough({
    collection: TEAM_SHEET,
    filter: { key: normalizeKey(TEAM_SHEET, email) },
    update: { $set: { [`row.${col0}`]: !!value } },
    mode: 'update',
    actor: callerEmail,
    sheetPush: {
      targetSheet: TEAM_SHEET, operation: 'update', handler: 'roles.saveEmailPermission',
      payload: { email, key, value: !!value }
    }
  });
  if (!result.matched) throw new Error(`Email not found: ${email}`);

  clearRolesCache();
  return 'OK';
}

export async function saveEmailSidebar(callerEmail, email, key, value) {
  assertRolesAdmin(callerEmail);
  email = safeStr(email).trim().toLowerCase();
  const keys = SIDEBAR_KEYS.map((p) => p.key);
  const idx = keys.indexOf(key);
  if (idx === -1) throw new Error('Unknown sidebar key');

  const result = await writeThrough({
    collection: SIDEBAR_SHEET,
    filter: { key: normalizeKey(SIDEBAR_SHEET, email) },
    update: { $set: { [`row.${1 + idx}`]: !!value } },
    mode: 'update',
    actor: callerEmail,
    sheetPush: {
      targetSheet: SIDEBAR_SHEET, operation: 'update', handler: 'roles.saveEmailSidebar',
      payload: { email, key, value: !!value }
    }
  });
  if (!result.matched) throw new Error(`Email not found: ${email}`);

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
  await writeThrough({
    collection: TEAM_SHEET,
    update: { key: normalizeKey(TEAM_SHEET, email), row: tRow },
    mode: 'insert',
    actor: callerEmail,
    sheetPush: { targetSheet: TEAM_SHEET, operation: 'insert', handler: 'roles.addTeamAccount', payload: { email, name } }
  });

  const sRow = [email, ...SIDEBAR_KEYS.map(() => true)];
  await writeThrough({
    collection: SIDEBAR_SHEET,
    update: { key: normalizeKey(SIDEBAR_SHEET, email), row: sRow },
    mode: 'insert',
    actor: callerEmail,
    sheetPush: { targetSheet: SIDEBAR_SHEET, operation: 'insert', handler: 'roles.addTeamAccount', payload: { email, name } }
  });

  clearRolesCache();
  return 'OK';
}

export async function removeTeamAccount(callerEmail, email) {
  assertRolesAdmin(callerEmail);
  email = safeStr(email).trim().toLowerCase();

  const tResult = await writeThrough({
    collection: TEAM_SHEET,
    filter: { key: normalizeKey(TEAM_SHEET, email) },
    mode: 'delete',
    actor: callerEmail,
    sheetPush: { targetSheet: TEAM_SHEET, operation: 'delete', handler: 'roles.removeTeamAccount', payload: { email } }
  });
  await writeThrough({
    collection: SIDEBAR_SHEET,
    filter: { key: normalizeKey(SIDEBAR_SHEET, email) },
    mode: 'delete',
    actor: callerEmail,
    sheetPush: { targetSheet: SIDEBAR_SHEET, operation: 'delete', handler: 'roles.removeTeamAccount', payload: { email } }
  });

  clearRolesCache();
  if (!tResult.matched) throw new Error(`Email not found: ${email}`);
  return 'OK';
}
