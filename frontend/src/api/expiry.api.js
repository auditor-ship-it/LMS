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

/** POST /api/expiry/remark — save / clear the Lease Expiry comment for one
 *  Deployed row. Resolves to { result, remark }. Always pass `rowNum`
 *  (item._rowNum) — same exact-row rule as saveExpiryAction. */
export const saveExpiryRemark = (containerNo, remark, rowNum) =>
  apiClient.post('/expiry/remark', { containerNo, remark, rowNum }).then((r) => r.data);

/** GET /api/expiry/renewal-companies/containers?company=... — every still-
 *  live container under that exact company name, for the "Renew via Sales
 *  CRM" picker. */
export const getCompanyContainers = (company) =>
  apiClient.get('/expiry/renewal-companies/containers', { params: { company } }).then((r) => r.data);

/** POST /api/expiry/renewal-link — mints the signed handoff link to the
 *  Sales CRM's own renewal form for the selected containers. Resolves to
 *  { url, containers, expiresInSecs }. */
export const createRenewalLink = (company, containers) =>
  apiClient.post('/expiry/renewal-link', { company, containers }).then((r) => r.data);

/** POST /api/expiry/export-sheet — turns the caller's own already-filtered
 *  table into a brand-new standalone Google Sheet. Resolves to
 *  { url, spreadsheetId }. */
export const exportToGoogleSheet = (title, headers, rows) =>
  apiClient.post('/expiry/export-sheet', { title, headers, rows }).then((r) => r.data);
