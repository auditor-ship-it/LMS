import { apiClient } from '../shared/auth/index.js';

/** GET /api/offlease?stage=1..8 — pending rows for that stage. */
export const getStageData = (stage) => apiClient.get('/offlease', { params: { stage } }).then((r) => r.data);

/** GET /api/offlease/:containerNo/stage/:stage — prefill data for the stage edit form. */
export const getStageDetail = (containerNo, stage) => apiClient.get(`/offlease/${encodeURIComponent(containerNo)}/stage/${stage}`).then((r) => r.data);

/** POST /api/offlease/:containerNo/stage/:stage — data = { col_N: value, ... } per stageFields. */
export const saveStage = (containerNo, stage, data) =>
  apiClient.post(`/offlease/${encodeURIComponent(containerNo)}/stage/${stage}`, data).then((r) => r.data.message);

/** GET /api/offlease/next-lease-id — preview only, used on Stage 1. */
export const getNextLeaseId = () => apiClient.get('/offlease/next-lease-id').then((r) => r.data.leaseId);
