import { apiClient } from '../shared/auth/index.js';

/** GET /api/approve — the same "Approve Lease" data source as the main app. */
export const getApproveLeaseData = () => apiClient.get('/approve').then((r) => r.data);

/** POST /api/approve/:containerNo/action — status: 'Approved' | 'Rejected'. */
export const saveApproveLeaseByContainer = (containerNo, { timestamp, status }) =>
  apiClient.post(`/approve/${encodeURIComponent(containerNo)}/action`, { timestamp, status }).then((r) => r.data);
