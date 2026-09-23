import { apiClient } from '../shared/auth/index.js';

/** POST /api/sso/sales-os/session — the Sales OS deep link's entry point.
 *  `params` is the deep link's own query string, forwarded as-is (whatever
 *  Sales OS put on the URL, signed `token` included when present). No
 *  Authorization header is sent for this one call — there is no session yet,
 *  this call IS what creates one. Resolves to
 *  { token, user, context, companyMatch, containers }. */
export const startSsoSession = (params) =>
  apiClient.post('/sso/sales-os/session', params).then((r) => r.data);

/** POST /api/sso/lease-expiry/session — plain employeeCode SSO for the
 *  Lease Expiry embed, no lead/company context. Resolves to { token, user }. */
export const startLeaseExpirySsoSession = (params) =>
  apiClient.post('/sso/lease-expiry/session', params).then((r) => r.data);

/** POST /api/sso/sales-os/confirm-company — submits the user's pick from an
 *  ambiguous company match. Resolves to { companyMatch, containers }. */
export const confirmSsoCompany = (existingLeadId, companyName) =>
  apiClient.post('/sso/sales-os/confirm-company', { existingLeadId, companyName }).then((r) => r.data);

/** POST /api/sso/sales-os/renewal — saves the completed renewal. */
export const saveSsoRenewal = (payload) =>
  apiClient.post('/sso/sales-os/renewal', payload).then((r) => r.data);
