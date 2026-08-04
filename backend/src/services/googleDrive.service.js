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
    fields: 'id, webViewLink, webContentLink'
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
    await drive.files.delete({ fileId });
  } catch (e) {
    // Mirrors original's best-effort cleanup-on-failure semantics.
  }
}

export function extractFileId(url) {
  if (!url) return null;
  const m = String(url).match(/[-\w]{25,}/);
  return m ? m[0] : null;
}
