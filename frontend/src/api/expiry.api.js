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

/** POST /api/expiry/action — Renew | Off-Lease row action. `rowNum`
 *  (item._rowNum from getExpiryData) addresses this exact Deployed row —
 *  Container No is not unique there (a reused container keeps its earlier
 *  row), so without it the backend falls back to matching by container
 *  number alone, which can silently act on a different lease's row. Always
 *  pass it when known. */
export const saveExpiryAction = (rowId, timestamp, status, rowNum) =>
  apiClient.post('/expiry/action', { rowId, timestamp, status, rowNum }).then((r) => r.data.result);
