import { uploadToDrive } from '../services/googleDrive.service.js';

/**
 * POST /api/uploads — generic base64 -> Google Drive URL uploader, matching
 * the original's uploadToDrive(base64Data, mimeType, fileName) Apps Script
 * function, which had NO permission check of its own (any signed-in caller
 * could call it; the actual save/write action that uses the resulting URL is
 * separately permission-gated, e.g. requirePermission('verify')/('renew')/
 * ('offlease3')/('billing')). Session auth only — see routes/upload.routes.js.
 *
 * Supersedes the earlier billing-only POST /api/billing/upload (still present
 * for backward compatibility with anything already calling it), which wrongly
 * required the 'billing' permission for uploads that have nothing to do with
 * billing (off-lease photos, renewal PO scans, etc).
 */
export async function uploadFile(req, res) {
  const { base64Data, mimeType, fileName } = req.body;
  if (!base64Data || !fileName) {
    return res.status(400).json({ error: 'base64Data and fileName are required' });
  }
  const url = await uploadToDrive(base64Data, mimeType, fileName);
  res.json({ url });
}
