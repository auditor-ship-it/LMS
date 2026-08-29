import { apiClient } from '../shared/auth/index.js';

/**
 * "Renew & Document" — same real data/actions as the main app's Lease Expiry
 * page's "Renewed"/"Documents" sub-tabs, presented here as its own page per
 * the requested nav hierarchy.
 */

/** GET /api/expiry?filter=renewed|documents */
export const getRenewDocumentData = (filter = 'renewed') =>
  apiClient.get('/expiry', { params: { filter } }).then((r) => r.data);

/** POST /api/verify/renew-with-agreement — "Update Lease Period" action.
 *  `rowNum`: see saveExpiryAction's doc comment in expiry.api.js — same
 *  reasoning, this also targets a Deployed row by container number. */
export const renewWithAgreement = ({ containerNo, newDateString, agreementUrl = '', rowNum }) =>
  apiClient.post('/verify/renew-with-agreement', { containerNo, newDateString, agreementUrl, rowNum }).then((r) => r.data);

/** POST /api/expiry/renewal/complete-document-stage — "Complete Document Stage" action.
 *  `rowNum`: see renewWithAgreement's doc comment just above. */
export const completeRenewalDocStage = ({
  containerNo, renewedDate, validTill, signedCopyUrl, remarks, userEmail, poNo, poFileUrl, billingCycle, poValidity, rowNum
}) =>
  apiClient.post('/expiry/renewal/complete-document-stage', {
    containerNo, renewedDate, validTill, signedCopyUrl, remarks, userEmail, poNo, poFileUrl, billingCycle, poValidity, rowNum
  }).then((r) => r.data.result);
