import { google } from 'googleapis';
import { Readable } from 'stream';
import { getDriveAuthClient } from './googleSheets.service.js';
import { env } from '../config/env.js';

let _driveClient = null;
function getDriveClient() {
  if (!_driveClient) {
    _driveClient = google.drive({ version: 'v3', auth: getDriveAuthClient() });
  }
  return _driveClient;
}

/**
 * Port of uploadToDrive(base64Data, mimeType, fileName) (LMS.js) — uploads to
 * the "Lease Attachments" equivalent folder (GOOGLE_DRIVE_FOLDER_ID) and
 * returns a shareable URL, same shape as the original's folder.createFile(blob).getUrl().
 */
export async function uploadToDrive(base64Data, mimeType, fileName) {
  if (!env.googleDriveFolderId) {
    throw new Error('GOOGLE_DRIVE_FOLDER_ID is not configured — share a Drive folder with the service account and set it in backend/.env. See README.md.');
  }
  const drive = getDriveClient();
  const buffer = Buffer.from(base64Data, 'base64');
  const stream = Readable.from(buffer);

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [env.googleDriveFolderId]
    },
    media: {
      mimeType,
      body: stream
    },
    fields: 'id, webViewLink, webContentLink',
    // Required for the target folder to be treated as living inside a Shared
    // Drive — without this, Drive API v3 tries to count the upload against
    // the service account's own personal storage, which is always 0 ("Service
    // Accounts do not have storage quota"). Still requires GOOGLE_DRIVE_FOLDER_ID
    // to actually be a folder inside a real Shared Drive (see error handling below).
    supportsAllDrives: true
  });

  // Make link-shareable within the org the same way the original relies on the
  // parent folder's inherited sharing — grant "anyone with the link, reader"
  // only if the folder itself doesn't already do so is out of scope here;
  // we rely on inherited folder permissions, matching the original's behavior
  // of relying on the "Lease Attachments" folder's own sharing settings.
  return res.data.webViewLink;
}

export async function deleteFromDrive(fileId) {
  const drive = getDriveClient();
  try {
    await drive.files.delete({ fileId, supportsAllDrives: true });
  } catch (e) {
    // Mirrors original's best-effort cleanup-on-failure semantics.
  }
}

export function extractFileId(url) {
  if (!url) return null;
  const m = String(url).match(/[-\w]{25,}/);
  return m ? m[0] : null;
}

/** Raw bytes of a Drive file, for embedding as an inline (cid) email
 *  attachment rather than a clickable link — see
 *  offlease.service.js's _sendOffLeaseInspectionEmail. Returns null on any
 *  failure (wrong permissions, deleted file, etc.) rather than throwing: a
 *  photo that can't be fetched should fall back to a link, not break the
 *  whole notification. */
export async function downloadFromDrive(fileId) {
  if (!fileId) return null;
  try {
    const drive = getDriveClient();
    const res = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );
    return Buffer.from(res.data);
  } catch (e) {
    return null;
  }
}
