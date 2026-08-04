import { apiClient } from '../shared/auth/index.js';

/** Deployed containers summary: opening/addition/deletion/net/closing per month. */
export const getDeployedSummary = () => apiClient.get('/dashboard/deployed-summary').then((r) => r.data);

/** Container-level drill-down for one deployed-summary month/category/type/size cell. */
export const getDeployedDetail = (month, category, type, size) =>
  apiClient.get('/dashboard/deployed-detail', { params: { month, category, type, size } }).then((r) => r.data);
