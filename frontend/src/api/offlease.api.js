import { apiClient } from '../shared/auth/index.js';

/** GET /api/offlease/approval — Pending Approval queue (between Stage 1 and Stage 2). */
export const getOffLeaseApprovalData = () => apiClient.get('/offlease/approval').then((r) => r.data);

/** POST /api/offlease/:containerNo/approval — status: 'Approved' | 'Rejected'. */
export const saveOffLeaseApprovalAction = (containerNo, status) =>
  apiClient.post(`/offlease/${encodeURIComponent(containerNo)}/approval`, { status }).then((r) => r.data.message);

/** GET /api/offlease/:containerNo/detail — container lookup. */
export const getOffLeaseContainerDetail = (containerNo) =>
  apiClient.get(`/offlease/${encodeURIComponent(containerNo)}/detail`).then((r) => r.data);

/** POST /api/offlease/tracking — add a deployed container into the Stage 1 queue. */
export const addToOffLeaseTracking = (containerNo) =>
  apiClient.post('/offlease/tracking', { containerNo }).then((r) => r.data.message);

/** GET /api/offlease/dashboard — pipeline overview (KPI counts + every active container's current stage). */
export const getOffLeaseDashboardData = () => apiClient.get('/offlease/dashboard').then((r) => r.data);
