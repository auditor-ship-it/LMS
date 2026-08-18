import * as expiryService from '../services/expiry.service.js';

/** GET /api/expiry?filter=pending|renewed|documents
 *  req.user (never a query/body field) determines which rows come back —
 *  see salePersonAccess.service.js. */
export async function list(req, res) {
  const filterType = req.query.filter || 'pending';
  res.json(await expiryService.getExpiryDataByFilter(filterType, req.user));
}

/** GET /api/expiry/renewal-log — Renewal Log rows for the month-wise report. */
export async function renewalLog(req, res) {
  res.json(await expiryService.getRenewalLogReport());
}

/** GET /api/expiry/new-lease-report — New Lease rows for the month-wise report. */
export async function newLeaseReport(req, res) {
  res.json(await expiryService.getNewLeaseReport());
}

/** POST /api/expiry/documents/upload */
export async function uploadDocument(req, res) {
  const { base64Data, mimeType, fileName, containerNo, docType } = req.body;
  res.json(await expiryService.uploadAndSaveDeployedDocument(base64Data, mimeType, fileName, containerNo, docType, req.user.email));
}

/** POST /api/expiry/documents/complete — completeDocumentStage (LMS.js 1441) */
export async function completeDocumentStage(req, res) {
  const { containerNo } = req.body;
  res.json({ result: await expiryService.completeDocumentStage(containerNo, req.user.email) });
}

/** POST /api/expiry/action — saveExpiryAction (LMS.js 1467) */
export async function saveAction(req, res) {
  const { rowId, timestamp, status } = req.body;
  res.json({ result: await expiryService.saveExpiryAction(rowId, timestamp, status, req.user.email) });
}

/** POST /api/expiry/renewal/complete-document-stage — completeDocStage (LMS.js 5892) */
export async function completeRenewalDocStage(req, res) {
  const { containerNo, renewedDate, validTill, signedCopyUrl, remarks, userEmail, poNo, poFileUrl, billingCycle, poValidity } = req.body;
  res.json({
    result: await expiryService.completeDocStage(
      containerNo, renewedDate, validTill, signedCopyUrl, remarks,
      userEmail || req.user.email, poNo, poFileUrl, billingCycle, req.user.email, poValidity
    )
  });
}
