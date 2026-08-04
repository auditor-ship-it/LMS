import { apiClient } from '../shared/auth/index.js';

/** GET /api/expiry?filter=pending — the "Lease Expiry" page's own dedicated pending-only view. */
export const getExpiryData = (filter = 'pending') =>
  apiClient.get('/expiry', { params: { filter } }).then((r) => r.data);

/** POST /api/expiry/action — Renew | Off-Lease row action. */
export const saveExpiryAction = (rowId, timestamp, status) =>
  apiClient.post('/expiry/action', { rowId, timestamp, status }).then((r) => r.data.result);
