import { apiClient } from '../shared/auth/index.js';

/** GET /api/expiry/renewal-log — Renewal Log rows for the month-wise report. */
export const getRenewalLog = () => apiClient.get('/expiry/renewal-log').then((r) => r.data);

/** GET /api/expiry/new-lease-report — New Lease rows for the month-wise report. */
export const getNewLeaseReport = () => apiClient.get('/expiry/new-lease-report').then((r) => r.data);

/** GET /api/expiry?filter=pending — the "Lease Expiry" page's own dedicated pending-only view. */
export const getExpiryData = (filter = 'pending') =>
  apiClient.get('/expiry', { params: { filter } }).then((r) => r.data);

/** POST /api/expiry/sale-person/refresh — re-reads the Sales CRM's company ->
 *  salesperson assignments right now, instead of waiting for the server's
 *  30-minute cache to lapse. Resolves to { companies, syncedAt }. */
export const refreshSalePersons = () =>
  apiClient.post('/expiry/sale-person/refresh').then((r) => r.data);

/** POST /api/expiry/action — Renew | Off-Lease row action. */
export const saveExpiryAction = (rowId, timestamp, status) =>
  apiClient.post('/expiry/action', { rowId, timestamp, status }).then((r) => r.data.result);
