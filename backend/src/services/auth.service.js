/**
 * Port of api.js lines ~1990-2304 (empLogin/empSession/empLogout/empHeartbeat/
 * empRequestOtp/empResetPassword/getEmpLoginActivity + the __login_log /
 * "Login Time Log" bookkeeping).
 *
 * DEVIATION (agreed with user): the original required the browser's signed-in
 * Google Workspace account to match the employee's registered email as a
 * second factor (Session.getActiveUser()). That has no Node equivalent
 * without adding real Google Sign-In, which was explicitly deferred — this
 * port authenticates on Employee ID/Email + password only. OTP reset and 6h
 * sliding session semantics are otherwise preserved exactly. The original's
 * failed-attempt lockout (5 tries -> 15 min lock) was removed on request.
 */
import crypto from 'crypto';
import { getSheetData, updateCell, appendRow } from './googleSheets.service.js';
import { getSheetDataFromMongo } from './mongoSheetData.service.js';
import { getCollection } from './mongo.service.js';
import { SHEETS } from '../config/sheets.config.js';
import { safeStr } from '../utils/format.js';
import { cacheGet, cachePut, cacheRemove } from '../utils/memoryCache.js';
import { withSheetLock } from '../utils/sheetMutex.js';
import { sendMail } from './email.service.js';
import { logger } from '../utils/logger.js';

const AUTH_COL_NAME = 0;
const AUTH_COL_EMPID = 1;
const AUTH_COL_PASSWORD = 2;
const AUTH_COL_EMAIL = 3;
const AUTH_SESSION_SECS = 21600; // 6h
const AUTH_OTP_SECS = 600; // 10 min
const AUTH_OTP_MAX_TRIES = 5;

/**
 * Login sessions live in Mongo, not the in-process cache (utils/memoryCache.js)
 * that lock/fail/OTP state still uses — a session is the one piece of auth
 * state that must survive a backend restart. Before this, every restart
 * (deploy, crash, or just `node --watch` picking up a save during dev) wiped
 * every session's session invisibly: requireAuth() would 401 instead of
 * showing real data, and pages with a bare empty-state (Lease Expiry) showed
 * "no data" with nothing telling the user to log back in. Confirmed
 * 2026-08-05. TTL index does the 6h sliding expiry — same lifetime semantics
 * as the old cachePut(..., AUTH_SESSION_SECS), just durable.
 */
const SESSION_COLLECTION = '_auth_sessions';
let sessionIndexEnsured = false;
async function _ensureSessionIndex() {
  if (sessionIndexEnsured) return;
  sessionIndexEnsured = true;
  try {
    await getCollection(SESSION_COLLECTION).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  } catch (e) { logger.error('[AUTH] Failed to ensure session TTL index:', e?.message || e); }
}
function _sessionExpiry() {
  return new Date(Date.now() + AUTH_SESSION_SECS * 1000);
}

function authEq(a, b) {
  a = String(a == null ? '' : a);
  b = String(b == null ? '' : b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function authToken() {
  return crypto.randomBytes(32).toString('hex'); // 256-bit, same strength as original's two 128-bit halves
}

function authMaskEmail(e) {
  e = String(e || '');
  const at = e.indexOf('@');
  if (at < 2) return e ? e[0] + '***' + e.slice(at) : '';
  return e[0] + '***' + e[at - 1] + e.slice(at);
}

/** Find an employee row by a column value against the LIVE sheet — only for
 *  call sites that immediately write back using the returned `rowNum`
 *  (empResetPassword). A Mongo-sourced row order isn't guaranteed to match
 *  the live sheet, so this one specific write-adjacent lookup must stay live
 *  (see splendid-rolling-candy.md / [[lms_row_number_write_safety]]). */
async function authFind(colIdx, value) {
  const { rows } = await getSheetData(SHEETS.USER, undefined, 'A1:D');
  return authScanRows(rows, colIdx, value, true);
}

/** Same lookup, read-only — safe to serve from the Mongo mirror (USER is
 *  already key-mapped and actively synced). Used by login and OTP request,
 *  where nothing downstream writes back by row number. Fixes login hitting
 *  the live Sheets quota on every attempt (confirmed 2026-08-01). */
async function authFindMongo(colIdx, value) {
  const { rows } = await getSheetDataFromMongo(SHEETS.USER);
  return authScanRows(rows, colIdx, value, false);
}

function authScanRows(rows, colIdx, value, withRowNum) {
  const want = String(value == null ? '' : value).trim().toLowerCase();
  for (let i = 0; i < rows.length; i++) {
    const cell = String(rows[i][colIdx] == null ? '' : rows[i][colIdx]).trim().toLowerCase();
    if (cell === '' || cell !== want) continue;
    return {
      rowNum: withRowNum ? i + 2 : null,
      name: String(rows[i][AUTH_COL_NAME] || '').trim(),
      empId: String(rows[i][AUTH_COL_EMPID] || '').trim(),
      email: String(rows[i][AUTH_COL_EMAIL] || '').trim(),
      pw: String(rows[i][AUTH_COL_PASSWORD] == null ? '' : rows[i][AUTH_COL_PASSWORD]).trim()
    };
  }
  return null;
}

export async function empLogin(empId, password) {
  logger.info('[AUTH] Login request received');
  empId = String(empId == null ? '' : empId).trim();
  password = String(password == null ? '' : password);
  logger.info(`[AUTH] Username: ${empId}`);
  if (!empId || !password) {
    logger.warn('[AUTH] Login failed');
    logger.warn('[AUTH] Reason: Employee ID or password missing');
    return { ok: false, error: 'Enter Employee ID and password' };
  }

  logger.info('[AUTH] Fetching user record (USER sheet, via Mongo mirror)');
  const emp = (await authFindMongo(AUTH_COL_EMPID, empId)) || (await authFindMongo(AUTH_COL_EMAIL, empId));
  if (!emp) {
    logger.warn('[AUTH] Login failed');
    logger.warn('[AUTH] Reason: User not found');
    return { ok: false, error: 'Invalid Employee ID or password' };
  }
  logger.info('[AUTH] User found');

  const ok = authEq(emp.pw, password);
  if (!ok) {
    logger.warn('[AUTH] Login failed');
    logger.warn('[AUTH] Reason: Invalid password');
    return { ok: false, error: 'Invalid Employee ID or password' };
  }
  logger.info('[AUTH] Password validation successful');

  await _ensureSessionIndex();
  const token = authToken();
  const nowIso = new Date().toISOString();
  await getCollection(SESSION_COLLECTION).insertOne({
    _id: token, empId: emp.empId, name: emp.name, email: emp.email, at: nowIso, srow: null, expiresAt: _sessionExpiry()
  });
  await authLogEvent('login', emp);
  await authStartSession(token, emp);
  logger.info('[AUTH] Login successful');
  return { ok: true, token, name: emp.name, email: emp.email, empId: emp.empId, at: nowIso };
}

export async function empSession(token) {
  if (!token) return null;
  const doc = await getCollection(SESSION_COLLECTION).findOneAndUpdate(
    { _id: token },
    { $set: { expiresAt: _sessionExpiry() } }, // sliding refresh
    { returnDocument: 'after' }
  );
  if (!doc) return null;
  return { empId: doc.empId, name: doc.name, email: doc.email, at: doc.at };
}

export async function empLogout(token) {
  if (token) {
    try { await empHeartbeat(token); } catch (e) { /* finalize minutes-on-site best-effort */ }
    try {
      const doc = await getCollection(SESSION_COLLECTION).findOne({ _id: token });
      if (doc) await authLogEvent('logout', doc);
    } catch (e) { /* logging must never break logout */ }
    await getCollection(SESSION_COLLECTION).deleteOne({ _id: token }).catch(() => {});
  }
  return { ok: true };
}

async function authSessionSheetEnsured() {
  const { insertSheetIfMissing } = await import('./googleSheets.service.js');
  await insertSheetIfMissing(SHEETS.AUTH_SESSION_LOG, ['Employee ID', 'Name', 'Email', 'Login At', 'Last Seen', 'Minutes On Site']);
}

async function authStartSession(token, emp) {
  try {
    await authSessionSheetEnsured();
    const now = new Date().toISOString();
    const { rowNum } = await appendRow(SHEETS.AUTH_SESSION_LOG, [emp.empId, emp.name, emp.email, now, now, 0]);
    if (rowNum) await getCollection(SESSION_COLLECTION).updateOne({ _id: token }, { $set: { srow: rowNum } }).catch(() => {});
  } catch (e) { /* never break login */ }
}

export async function empHeartbeat(token) {
  try {
    if (!token) return false;
    const doc = await getCollection(SESSION_COLLECTION).findOne({ _id: token });
    if (!doc) return false;
    const row = doc.srow;
    if (!(row > 1)) return false;

    const { getRange } = await import('./googleSheets.service.js');
    const loginAtCell = await getRange(SHEETS.AUTH_SESSION_LOG, `D${row}:D${row}`);
    const loginAtStr = loginAtCell?.[0]?.[0];
    const loginAt = loginAtStr ? new Date(loginAtStr) : null;
    const now = new Date();
    const mins = loginAt && !isNaN(loginAt.getTime()) ? Math.max(0, Math.round((now - loginAt) / 60000)) : 0;

    await updateCell(SHEETS.AUTH_SESSION_LOG, row, 4, now.toISOString());
    await updateCell(SHEETS.AUTH_SESSION_LOG, row, 5, mins);
    await getCollection(SESSION_COLLECTION).updateOne({ _id: token }, { $set: { expiresAt: _sessionExpiry() } }).catch(() => {}); // keep session alive
    return true;
  } catch (e) { return false; }
}

async function authLogEvent(action, emp) {
  try {
    const { insertSheetIfMissing } = await import('./googleSheets.service.js');
    await insertSheetIfMissing(SHEETS.AUTH_LOG, ['Timestamp', 'Action', 'Employee ID', 'Name', 'Email']);
    await appendRow(SHEETS.AUTH_LOG, [new Date().toISOString(), action, emp?.empId || '', emp?.name || '', emp?.email || '']);
    // Row-cap trim (bounded retention) intentionally omitted from the hot path —
    // run as a periodic housekeeping job instead of on every login, to avoid a
    // full-sheet read on every request. See jobs/ for the equivalent of the
    // original's inline 100k-row trim if/when log volume grows.
  } catch (e) { /* logging must never break login */ }
}

export async function getEmpLoginActivity() {
  const { rows } = await getSheetData(SHEETS.AUTH_SESSION_LOG, undefined, 'A1:F').catch(() => ({ rows: [] }));
  if (!rows.length) return { summary: [], recent: [] };

  const by = {};
  const recent = [];
  for (const row of rows) {
    const empId = String(row[0] || '');
    const name = String(row[1] || '');
    const email = String(row[2] || '');
    const loginAt = row[3] || '';
    const lastSeen = row[4] || '';
    const mins = Number(row[5]) || 0;
    if (!empId && !email && !name) continue;
    const k = email || empId || name;
    if (!by[k]) by[k] = { email, name, empId, sessions: 0, minutes: 0, lastSeen: '', _ls: 0 };
    by[k].sessions++;
    by[k].minutes += mins;
    const lt = lastSeen ? new Date(lastSeen).getTime() : 0;
    if (lt > by[k]._ls) { by[k]._ls = lt; by[k].lastSeen = lastSeen; }
    recent.push({ empId, name, email, loginAt, lastSeen, minutes: mins });
  }
  const summary = Object.keys(by)
    .map((k) => ({ email: by[k].email, name: by[k].name, empId: by[k].empId, sessions: by[k].sessions, minutes: by[k].minutes, lastSeen: by[k].lastSeen }))
    .sort((a, b) => b.minutes - a.minutes);
  const recentTrimmed = recent.slice(-200).reverse(); // newest first
  return { summary, recent: recentTrimmed };
}

export async function empRequestOtp(idOrEmail) {
  idOrEmail = String(idOrEmail == null ? '' : idOrEmail).trim();
  if (!idOrEmail) return { ok: false, error: 'Enter your Employee ID or email' };

  const emp = (await authFindMongo(AUTH_COL_EMPID, idOrEmail)) || (await authFindMongo(AUTH_COL_EMAIL, idOrEmail));
  if (!emp || !emp.email) return { ok: true, email: '', sent: false, note: 'If the account exists, an OTP was sent.' }; // anti-enumeration

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  cachePut(`auth:otp:${emp.empId}`, JSON.stringify({ otp, tries: 0 }), AUTH_OTP_SECS);

  try {
    await sendMail({
      to: emp.email,
      subject: 'Your Lease System login OTP',
      body: `Hello ${emp.name || ''},\n\nYour one-time password (OTP) to reset your Lease System password is:\n\n    ${otp}\n\nIt expires in ${Math.round(AUTH_OTP_SECS / 60)} minutes and can be used once.\nIf you did not request this, ignore this email.\n\n— Lease Management System`
    });
  } catch (e) {
    return { ok: false, error: `OTP email failed: ${e?.message || String(e)}` };
  }
  return { ok: true, email: authMaskEmail(emp.email), sent: true, empId: emp.empId };
}

export async function empResetPassword(empId, otp, newPassword) {
  empId = String(empId == null ? '' : empId).trim();
  otp = String(otp == null ? '' : otp).trim();
  newPassword = String(newPassword == null ? '' : newPassword);
  if (!empId || !otp) return { ok: false, error: 'Enter the OTP' };
  if (newPassword.length < 4) return { ok: false, error: 'New password must be at least 4 characters' };

  const key = `auth:otp:${empId}`;
  const raw = cacheGet(key);
  if (!raw) return { ok: false, error: 'OTP expired or not requested. Request a new one.' };

  let rec;
  try { rec = JSON.parse(raw); } catch (e) { return { ok: false, error: 'OTP error. Request a new one.' }; }
  rec.tries = (rec.tries || 0) + 1;
  if (rec.tries > AUTH_OTP_MAX_TRIES) { cacheRemove(key); return { ok: false, error: 'Too many wrong OTPs. Request a new one.' }; }
  if (!authEq(rec.otp, otp)) { cachePut(key, JSON.stringify(rec), AUTH_OTP_SECS); return { ok: false, error: 'Wrong OTP' }; }

  const emp = await authFind(AUTH_COL_EMPID, empId);
  if (!emp) return { ok: false, error: 'Account not found' };

  await withSheetLock(SHEETS.USER, async () => {
    await updateCell(SHEETS.USER, emp.rowNum, AUTH_COL_PASSWORD, newPassword);
  });

  cacheRemove(key);
  return { ok: true };
}

/** Admin utility — port of addUserToLogin(), exposed via an admin-gated endpoint instead of "run once from the editor". */
export async function addUserToLogin(name, empId, password, email) {
  if (await authFindMongo(AUTH_COL_EMPID, empId)) return `Already exists (Employee ID ${empId})`;
  if (await authFindMongo(AUTH_COL_EMAIL, email)) return `Already exists (Email ${email})`;
  await appendRow(SHEETS.USER, [name, empId, password, email]);
  return `Added: ${name} | ID ${empId} | ${email}`;
}

export async function getCurrentUserFromToken(token) {
  if (!token) return 'unknown';
  const sess = await empSession(token);
  if (sess && sess.email) return String(sess.email).trim().toLowerCase();
  return 'unknown';
}
