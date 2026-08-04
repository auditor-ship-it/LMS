import { google } from 'googleapis';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { touchSource } from '../utils/requestContext.js';

/** Every exported function below that actually calls the Sheets API goes
 *  through this first — the one place that makes "did this request touch
 *  Google Sheets" visible in the terminal, for every domain, migrated or not. */
function logSheetsAccess(operation, sheetName, ssId = env.googleSheetId) {
  touchSource('sheets');
  logger.debug(`[SHEETS] ${operation} | Spreadsheet: ${ssId} | Sheet: ${sheetName}`);
}

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive'
];

let _authClient = null;
let _sheetsClient = null;

function getAuthClient() {
  if (!_authClient) {
    _authClient = new google.auth.JWT({
      email: env.googleClientEmail,
      key: env.googlePrivateKey,
      scopes: SCOPES
    });
    logger.info('[SYNC] Google Sheets connection established');
  }
  return _authClient;
}

export function getSheetsClient() {
  if (!_sheetsClient) {
    _sheetsClient = google.sheets({ version: 'v4', auth: getAuthClient() });
  }
  return _sheetsClient;
}

export function getDriveAuthClient() {
  return getAuthClient();
}

export function colLetter(idx0) {
  let n = idx0 + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Cache of sheetName -> numeric sheetId, per spreadsheet.
const sheetIdCache = new Map();

export async function getSheetId(sheetName, ssId = env.googleSheetId) {
  const cacheKey = `${ssId}::${sheetName}`;
  if (sheetIdCache.has(cacheKey)) return sheetIdCache.get(cacheKey);
  logSheetsAccess('getSheetId (spreadsheets.get)', sheetName, ssId);
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: ssId });
  const sheet = (meta.data.sheets || []).find((s) => s.properties.title === sheetName);
  if (!sheet) throw new Error(`Sheet not found: '${sheetName}'`);
  sheetIdCache.set(cacheKey, sheet.properties.sheetId);
  return sheet.properties.sheetId;
}

export function clearSheetIdCache() {
  sheetIdCache.clear();
}

/**
 * Reads the full used range of a sheet. Returns { headers, rows, values }
 * where `values` is the raw 2D array (headers included as values[0]).
 */
export async function getSheetData(sheetName, ssId = env.googleSheetId, range = 'A1:ZZ') {
  logSheetsAccess('getSheetData (values.get)', sheetName, ssId);
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId,
    range: `'${sheetName}'!${range}`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING'
  });
  const values = res.data.values || [];
  const headers = values[0] || [];
  const rows = values.slice(1);
  return { headers, rows, values };
}

export async function getRange(sheetName, a1Range, ssId = env.googleSheetId) {
  logSheetsAccess(`getRange (values.get ${a1Range})`, sheetName, ssId);
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId,
    range: `'${sheetName}'!${a1Range}`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING'
  });
  return res.data.values || [];
}

export async function appendRow(sheetName, rowArray, ssId = env.googleSheetId) {
  logSheetsAccess('appendRow (values.append)', sheetName, ssId);
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: ssId,
    range: `'${sheetName}'!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [rowArray] }
  });
  const updatedRange = res.data.updates?.updatedRange || '';
  const m = updatedRange.match(/![A-Z]+(\d+):/);
  const rowNum = m ? Number(m[1]) : null;
  return { rowNum };
}

export async function appendRows(sheetName, rows2D, ssId = env.googleSheetId) {
  logSheetsAccess(`appendRows (values.append x${rows2D?.length || 0})`, sheetName, ssId);
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: ssId,
    range: `'${sheetName}'!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows2D }
  });
}

/** 1-based row number, full row overwrite starting at column A. */
export async function updateRow(sheetName, rowNum, rowArray, ssId = env.googleSheetId) {
  logSheetsAccess(`updateRow (values.update row ${rowNum})`, sheetName, ssId);
  const sheets = getSheetsClient();
  const endCol = colLetter(Math.max(rowArray.length - 1, 0));
  await sheets.spreadsheets.values.update({
    spreadsheetId: ssId,
    range: `'${sheetName}'!A${rowNum}:${endCol}${rowNum}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [rowArray] }
  });
}

/** 1-based row number, 0-based column index. */
export async function updateCell(sheetName, rowNum, col0, value, ssId = env.googleSheetId) {
  logSheetsAccess(`updateCell (values.update row ${rowNum} col ${colLetter(col0)})`, sheetName, ssId);
  const sheets = getSheetsClient();
  const col = colLetter(col0);
  await sheets.spreadsheets.values.update({
    spreadsheetId: ssId,
    range: `'${sheetName}'!${col}${rowNum}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] }
  });
}

export async function updateRange(sheetName, a1Range, values2D, ssId = env.googleSheetId) {
  logSheetsAccess(`updateRange (values.update ${a1Range})`, sheetName, ssId);
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: ssId,
    range: `'${sheetName}'!${a1Range}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: values2D }
  });
}

export async function batchUpdateValues(updates, ssId = env.googleSheetId) {
  // updates: [{ range: "'Sheet'!A2:B2", values: [[...]] }, ...]
  const sheetNames = [...new Set((updates || []).map((u) => (u.range.match(/^'([^']+)'/) || [])[1] || '?'))].join(', ');
  logSheetsAccess(`batchUpdateValues (values.batchUpdate x${updates?.length || 0})`, sheetNames, ssId);
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: ssId,
    requestBody: { valueInputOption: 'USER_ENTERED', data: updates }
  });
}

/** Deletes 1-based row numbers (any order/duplicates handled), batched, highest-first so indices stay valid. */
export async function deleteRows(sheetName, rowNums, ssId = env.googleSheetId) {
  if (!rowNums || !rowNums.length) return;
  logSheetsAccess(`deleteRows (batchUpdate x${rowNums.length})`, sheetName, ssId);
  const sheetId = await getSheetId(sheetName, ssId);
  const uniqueSorted = [...new Set(rowNums)].sort((a, b) => b - a);
  const sheets = getSheetsClient();
  const requests = uniqueSorted.map((rowNum) => ({
    deleteDimension: {
      range: {
        sheetId,
        dimension: 'ROWS',
        startIndex: rowNum - 1,
        endIndex: rowNum
      }
    }
  }));
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: ssId,
    requestBody: { requests }
  });
}

export async function deleteSheetIfExists(sheetName, ssId = env.googleSheetId) {
  logSheetsAccess('deleteSheetIfExists (spreadsheets.get)', sheetName, ssId);
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: ssId });
  const sheet = (meta.data.sheets || []).find((s) => s.properties.title === sheetName);
  if (!sheet) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: ssId,
    requestBody: { requests: [{ deleteSheet: { sheetId: sheet.properties.sheetId } }] }
  });
  clearSheetIdCache();
}

export async function insertSheetIfMissing(sheetName, headerRow, ssId = env.googleSheetId) {
  logSheetsAccess('insertSheetIfMissing (spreadsheets.get)', sheetName, ssId);
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: ssId });
  const exists = (meta.data.sheets || []).some((s) => s.properties.title === sheetName);
  if (exists) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: ssId,
    requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] }
  });
  clearSheetIdCache();
  if (headerRow && headerRow.length) {
    await updateRow(sheetName, 1, headerRow, ssId);
  }
}

/** Case-insensitive header lookup: returns 0-based column index or -1. */
export function findColByHeader(headers, name) {
  const target = String(name).trim().toLowerCase();
  return headers.findIndex((h) => String(h || '').trim().toLowerCase() === target);
}

/** Finds the first header matching any of several candidate names (case-insensitive substring). */
export function findColByHeaderPatterns(headers, patterns) {
  const lc = headers.map((h) => String(h || '').trim().toLowerCase());
  for (const p of patterns) {
    const idx = lc.findIndex((h) => h.indexOf(String(p).toLowerCase()) !== -1);
    if (idx !== -1) return idx;
  }
  return -1;
}
