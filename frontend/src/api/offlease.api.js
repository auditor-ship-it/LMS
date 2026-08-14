import { apiClient } from '../shared/auth/index.js';

/** GET /api/offlease/approval — Pending Approval queue (between Stage 1 and Stage 2). */
export const getOffLeaseApprovalData = () => apiClient.get('/offlease/approval').then((r) => r.data);

/** POST /api/offlease/:containerNo/approval — status: 'Approved' | 'Rejected'. */
export const saveOffLeaseApprovalAction = (containerNo, status) =>
  apiClient.post(`/offlease/${encodeURIComponent(containerNo)}/approval`, { status }).then((r) => r.data.message);

/** GET /api/offlease/:containerNo/outstanding — Tally outstanding, proxied
 *  through our backend so the Accounts & Collection credentials stay server-side. */
export const getOutstanding = (containerNo, clientName) =>
  apiClient
    .get(`/offlease/${encodeURIComponent(containerNo)}/outstanding`, { params: { clientName: clientName || '' } })
    .then((r) => r.data);

/** GET /api/offlease/:containerNo/detail — container lookup. `leaseId` picks
 *  one record when the container has been off-leased more than once. */
export const getOffLeaseContainerDetail = (containerNo, leaseId) =>
  apiClient
    .get(`/offlease/${encodeURIComponent(containerNo)}/detail`, leaseId ? { params: { leaseId } } : undefined)
    .then((r) => r.data);

/** POST /api/offlease/tracking — add a deployed container into the Stage 1 queue. */
export const addToOffLeaseTracking = (containerNo) =>
  apiClient.post('/offlease/tracking', { containerNo }).then((r) => r.data.message);

/** GET /api/offlease/dashboard — pipeline overview (KPI counts + every active container's current stage). */
export const getOffLeaseDashboardData = () => apiClient.get('/offlease/dashboard').then((r) => r.data);

/* ---- Dashboard live remarks ---- */

/** GET /api/offlease/:containerNo/remarks — full thread, newest first. */
export const getRemarkThread = (containerNo, leaseId) =>
  apiClient
    .get(`/offlease/${encodeURIComponent(containerNo)}/remarks`, { params: { leaseId: leaseId || '' } })
    .then((r) => r.data.remarks || []);

/** POST /api/offlease/:containerNo/remarks — appends one remark. `html` is
 *  sanitised server-side; whatever comes back is what was stored. */
export const addRemark = (containerNo, leaseId, html) =>
  apiClient.post(`/offlease/${encodeURIComponent(containerNo)}/remarks`, { leaseId, html }).then((r) => r.data.remark);

/** PUT/DELETE /api/offlease/:containerNo/remarks/:remarkId — author (or a
 *  roles admin) only; the server rejects anyone else. */
export const updateRemark = (containerNo, remarkId, html) =>
  apiClient.put(`/offlease/${encodeURIComponent(containerNo)}/remarks/${encodeURIComponent(remarkId)}`, { html }).then((r) => r.data.remark);

export const deleteRemark = (containerNo, remarkId) =>
  apiClient.delete(`/offlease/${encodeURIComponent(containerNo)}/remarks/${encodeURIComponent(remarkId)}`).then((r) => r.data);

/* ---- Stage 9: container movement log ---- */

/** GET /api/offlease/stage2/containers — every container pending at Stage 2,
 *  read fresh, for the Stage 9 Container No dropdown. */
export const getMovementSourceContainers = () =>
  apiClient.get('/offlease/stage2/containers').then((r) => r.data.containers || []);

/** GET /api/offlease/stage2/container/:containerNo — auto-fill lookup.
 *  Returns { multiple: true, matches } when a container is pending under more
 *  than one lease. */
export const getMovementSourceContainer = (containerNo) =>
  apiClient.get(`/offlease/stage2/container/${encodeURIComponent(containerNo)}`).then((r) => r.data);

/** GET /api/offlease/stage9/movements — logged movements, newest first. */
export const getStage9Movements = () => apiClient.get('/offlease/stage9/movements').then((r) => r.data);

/** POST /api/offlease/stage9/movements — appends one row to the Stage 9 sheet. */
export const saveStage9Movement = (payload) =>
  apiClient.post('/offlease/stage9/movements', payload).then((r) => r.data);
