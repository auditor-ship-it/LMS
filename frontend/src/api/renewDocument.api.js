import { apiClient } from '../shared/auth/index.js';

/**
 * "Renew & Document" — same real data/actions as the main app's Lease Expiry
 * page's "Renewed"/"Documents" sub-tabs, presented here as its own page per
 * the requested nav hierarchy.
 */

/** GET /api/expiry?filter=documents */
export const getRenewDocumentData = (filter = 'documents') =>
  apiClient.get('/expiry', { params: { filter } }).then((r) => r.data);

/** POST /api/expiry/renewal/complete-document-stage — "Submit". REDESIGNED
 *  2026-09-29 (approval workflow): no longer completes the renewal directly
 *  — it stages everything and moves the record to Approval Pending, out of
 *  Renew & Document's own Pending list, until Pushpa Shetty decides. See
 *  completeDocStage's own doc comment on the backend. */
export const completeRenewalDocStage = ({
  containerNo, renewedDate, validTill, signedCopyUrl, remarks, userEmail, poNo, poFileUrl, billingCycle, poValidity, rowNum, poValue
}) =>
  apiClient.post('/expiry/renewal/complete-document-stage', {
    containerNo, renewedDate, validTill, signedCopyUrl, remarks, userEmail, poNo, poFileUrl, billingCycle, poValidity, rowNum, poValue
  }).then((r) => r.data.result);

/** POST /api/expiry/renewal/save-document-draft — "Save": persists whatever
 *  was entered as a draft, the record stays in Documents Pending, nothing
 *  required. See saveRenewalDraft's doc comment on the backend. */
export const saveRenewalDraft = ({
  containerNo, renewedDate, validTill, signedCopyUrl, remarks, poNo, poFileUrl, billingCycle, poValidity, rowNum, poValue
}) =>
  apiClient.post('/expiry/renewal/save-document-draft', {
    containerNo, renewedDate, validTill, signedCopyUrl, remarks, poNo, poFileUrl, billingCycle, poValidity, rowNum, poValue
  }).then((r) => r.data.result);

/** GET /api/expiry?filter=approval — renewals submitted, awaiting Pushpa
 *  Shetty's Approve/Reject decision. Explicit request 2026-09-29. */
export const getApprovalPendingData = () =>
  apiClient.get('/expiry', { params: { filter: 'approval' } }).then((r) => r.data);

/** POST /api/expiry/renewal/decide-approval — Pushpa's decision. `decision`
 *  is 'approved' or 'rejected'. `rowNum`: see getRenewDocumentData's doc
 *  comment above for why it addresses the exact Deployed row. */
export const decideRenewalApproval = ({ containerNo, decision, remarks, rowNum }) =>
  apiClient.post('/expiry/renewal/decide-approval', { containerNo, decision, remarks, rowNum }).then((r) => r.data.result);

/** POST /api/expiry/renewal/send-back-to-pending — "Send Back" to Lease
 *  Expiry, explicit request 2026-09-30. Reverses the Renew click that put
 *  this container into Documents Pending; see sendExpiryToPendingFast's own
 *  doc comment on the backend. */
export const sendBackToPending = (containerNo, rowNum) =>
  apiClient.post('/expiry/renewal/send-back-to-pending', { containerNo, rowNum }).then((r) => r.data.result);

/* Renew Approval Pending's own live-comment thread — explicit request
 * 2026-10-05, same shape as offlease.api.js's identical remark endpoints,
 * keyed by rowNum instead of leaseId (this sheet has no lease ID column). */

/** GET /api/expiry/renewal/:containerNo/remarks — full thread, newest first. */
export const getRenewRemarkThread = (containerNo, rowNum) =>
  apiClient
    .get(`/expiry/renewal/${encodeURIComponent(containerNo)}/remarks`, { params: { rn: rowNum } })
    .then((r) => r.data.remarks || []);

/** POST /api/expiry/renewal/:containerNo/remarks — appends one remark. */
export const addRenewRemark = (containerNo, rowNum, html) =>
  apiClient.post(`/expiry/renewal/${encodeURIComponent(containerNo)}/remarks`, { rowNum, html }).then((r) => r.data.remark);

/** PUT/DELETE /api/expiry/renewal/remarks/:remarkId — author (or a roles
 *  admin) only; the server rejects anyone else. */
export const updateRenewRemark = (remarkId, html) =>
  apiClient.put(`/expiry/renewal/remarks/${encodeURIComponent(remarkId)}`, { html }).then((r) => r.data.remark);

export const deleteRenewRemark = (remarkId) =>
  apiClient.delete(`/expiry/renewal/remarks/${encodeURIComponent(remarkId)}`).then((r) => r.data);
