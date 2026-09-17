/**
 * "Export to Google Sheet" — turns a table already rendered on screen into
 * a real, standalone Google Sheet, as opposed to the client-side .xlsx
 * download other pages in this app already offer (DeployedSummaryPage.jsx).
 * Deliberately generic (headers/rows, not tied to Lease Expiry's own
 * columns) so any other list page can reuse it later without a new backend
 * function.
 *
 * The file is created directly inside the app's Shared Drive folder
 * (GOOGLE_DRIVE_FOLDER_ID) via the Drive API rather than via
 * sheets.spreadsheets.create — Google no longer lets a service account
 * create files in its own personal Drive space (0 storage quota there since
 * 2024), which is where spreadsheets.create always lands a new file first.
 * Creating it straight inside a Shared Drive folder avoids that entirely and
 * means it inherits the folder's existing sharing immediately, matching
 * uploadToDrive's own reasoning in googleDrive.service.js.
 *
 * Creates a BRAND-NEW spreadsheet — this never writes into any of the
 * app's own tracked sheets (Deployed sheet, Off-Lease Tracking, ...).
 *
 * Trust model: the caller already has these exact headers/rows on screen
 * (Lease Expiry's own scoping/CRM-resolution/canonicalization already ran
 * server-side before the frontend ever built this payload) — this endpoint
 * doesn't read or reveal anything the caller doesn't already have, the same
 * trust level as a client-side Excel export. It only ever WRITES a new,
 * independent file; nothing here can be used to read or alter existing data.
 */
import { google } from 'googleapis';
import { getDriveAuthClient, getSheetsClient } from './googleSheets.service.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';

const MAX_ROWS = 5000; // sanity guard, not a real limit this feature is expected to hit

let _driveClient = null;
function getDriveClient() {
  if (!_driveClient) {
    _driveClient = google.drive({ version: 'v3', auth: getDriveAuthClient() });
  }
  return _driveClient;
}

export async function exportRowsToGoogleSheet(title, headers, rows) {
  if (!Array.isArray(headers) || !headers.length) throw new AppError('headers is required');
  if (!Array.isArray(rows)) throw new AppError('rows is required');
  if (rows.length > MAX_ROWS) throw new AppError(`Too many rows to export at once (max ${MAX_ROWS}).`);
  if (!env.googleDriveFolderId) {
    throw new AppError('GOOGLE_DRIVE_FOLDER_ID is not configured — share a Drive folder with the service account and set it in backend/.env. See README.md.');
  }

  const safeTitle = String(title || 'Export').trim().slice(0, 200) || 'Export';

  const created = await getDriveClient().files.create({
    requestBody: {
      name: safeTitle,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [env.googleDriveFolderId]
    },
    supportsAllDrives: true,
    fields: 'id, webViewLink'
  });
  const spreadsheetId = created.data.id;

  // Cells arrive from the frontend's already-rendered table — coerce
  // defensively (blank cells render as null/undefined there, never as a
  // real value Sheets can accept).
  const values = [headers, ...rows].map((r) => (Array.isArray(r) ? r : []).map((c) => (c == null ? '' : c)));
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "'Sheet1'!A1",
    valueInputOption: 'USER_ENTERED',
    requestBody: { values }
  });

  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          updateSheetProperties: {
            properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount'
          }
        }]
      }
    });
  } catch {
    // Cosmetic only — the sheet is already fully usable without the frozen header row.
  }

  return { url: created.data.webViewLink, spreadsheetId };
}
