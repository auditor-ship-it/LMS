import * as expiryService from '../services/expiry.service.js';
import { refreshSalesCrmLeadIndex } from '../services/salesCrmLeads.service.js';
import { cacheRemoveByPrefix } from '../utils/memoryCache.js';

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

/**
 * POST /api/expiry/sale-person/refresh — the "Sync Sale Person" button.
 *
 * Re-reads the Sales CRM's lead collection right now instead of waiting for
 * the 30-minute cache to lapse, so a reassignment made seconds ago is visible
 * on the next page load. READ-ONLY on the CRM side (see salesCrmDb.js).
 *
 * Being a non-GET, responseCache.middleware.js clears the cached /api/expiry
 * GETs for EVERY user on success, so one person pressing the button fixes the
 * page for the whole team. My Task's own 60s counts are dropped here too —
 * its "Expired"/"Renew Pending" tiles are Sale-Person-scoped, so they move
 * with the assignments.
 */
export async function refreshSalePersons(req, res) {
  const result = await refreshSalesCrmLeadIndex();
  cacheRemoveByPrefix('mytasks_v1');
  res.json(result);
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
