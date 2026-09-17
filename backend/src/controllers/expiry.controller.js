import * as expiryService from '../services/expiry.service.js';
import { refreshSalesCrmLeadIndex } from '../services/salesCrmLeads.service.js';
import { getCompanyContainers, createRenewalLink } from '../services/renewalHandoff.service.js';
import { exportRowsToGoogleSheet } from '../services/sheetExport.service.js';
import { cacheRemoveByPrefix } from '../utils/memoryCache.js';

/** GET /api/expiry?filter=pending|renewed|documents
 *  req.user (never a query/body field) determines which rows come back —
 *  see salePersonAccess.service.js. */
export async function list(req, res) {
  const filterType = req.query.filter || 'pending';
  res.json(await expiryService.getExpiryDataByFilter(filterType, req.user));
}

/** GET /api/expiry/renewal-log — Renewal Log rows for the month-wise report.
 *  req.user determines which rows come back for a scoped Sales Executive —
 *  see salePersonAccess.service.js, same mechanism as list() above. */
export async function renewalLog(req, res) {
  res.json(await expiryService.getRenewalLogReport(req.user));
}

/** GET /api/expiry/new-lease-report — New Lease rows for the month-wise report.
 *  req.user determines which rows come back for a scoped Sales Executive —
 *  see salePersonAccess.service.js, same mechanism as list() above. */
export async function newLeaseReport(req, res) {
  res.json(await expiryService.getNewLeaseReport(req.user));
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

/** GET /api/expiry/renewal-companies/containers?company=... — the "Renew via
 *  Sales CRM" picker's source list: every still-live container under that
 *  exact company name. Read-only, open to any signed-in caller (same
 *  convention as list() above). */
export async function companyContainers(req, res) {
  res.json(await getCompanyContainers(req.query.company));
}

/** POST /api/expiry/renewal-link — mints the signed handoff URL to the Sales
 *  CRM's own renewal form. req.user supplies the identity baked into the
 *  token (empId/name/email) — never a body field, so a caller can only ever
 *  mint a link that identifies THEM. See renewalHandoff.service.js. */
export async function renewalLink(req, res) {
  const { company, containers } = req.body;
  res.json(await createRenewalLink(req.user, company, containers));
}

/** POST /api/expiry/documents/upload — `rowNum` (item._rowNum from the list)
 *  addresses this exact Deployed row; see expiry.service.js's
 *  _resolveDeployedRow doc comment for why container number alone isn't
 *  safe (a container can have more than one Deployed row). */
export async function uploadDocument(req, res) {
  const { base64Data, mimeType, fileName, containerNo, docType, rowNum } = req.body;
  res.json(await expiryService.uploadAndSaveDeployedDocument(base64Data, mimeType, fileName, containerNo, docType, req.user.email, rowNum));
}

/** POST /api/expiry/documents/complete — completeDocumentStage (LMS.js 1441) */
export async function completeDocumentStage(req, res) {
  const { containerNo, rowNum } = req.body;
  res.json({ result: await expiryService.completeDocumentStageFast(containerNo, req.user.email, rowNum) });
}

/** POST /api/expiry/action — saveExpiryAction (LMS.js 1467) */
export async function saveAction(req, res) {
  const { rowId, timestamp, status, rowNum } = req.body;
  res.json({ result: await expiryService.saveExpiryActionFast(rowId, timestamp, status, req.user.email, rowNum) });
}

/** POST /api/expiry/remark — Lease Expiry free-text comment for one Deployed
 *  row (`rowNum` = item._rowNum). Does not change renewal / off-lease status. */
export async function saveRemark(req, res) {
  const { containerNo, remark, rowNum } = req.body;
  res.json(await expiryService.saveExpiryRemarkFast(containerNo, remark, req.user.email, rowNum));
}

/** POST /api/expiry/export-sheet — turns whatever headers/rows the caller
 *  already has on screen into a brand-new Google Sheet (see
 *  sheetExport.service.js). Never reads app data itself — the frontend
 *  sends exactly what it's already rendering (already scoped/filtered),
 *  same trust level as a client-side Excel export. */
export async function exportToGoogleSheet(req, res) {
  const { title, headers, rows } = req.body;
  res.json(await exportRowsToGoogleSheet(title, headers, rows));
}

/** POST /api/expiry/renewal/complete-document-stage — completeDocStage (LMS.js 5892) */
export async function completeRenewalDocStage(req, res) {
  const { containerNo, renewedDate, validTill, signedCopyUrl, remarks, userEmail, poNo, poFileUrl, billingCycle, poValidity, rowNum } = req.body;
  res.json({
    result: await expiryService.completeDocStage(
      containerNo, renewedDate, validTill, signedCopyUrl, remarks,
      userEmail || req.user.email, poNo, poFileUrl, billingCycle, req.user.email, poValidity, rowNum
    )
  });
}
