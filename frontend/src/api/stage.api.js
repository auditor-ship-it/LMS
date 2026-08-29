import { apiClient } from '../shared/auth/index.js';

/** GET /api/offlease?stage=1..8 — pending rows for that stage. `filter`
 *  ('hold') is only meaningful for Stage 1 — see saveHold's doc comment. */
export const getStageData = (stage, filter) =>
  apiClient.get('/offlease', { params: filter ? { stage, filter } : { stage } }).then((r) => r.data);

/** GET /api/offlease/:containerNo/stage/:stage — prefill data for the stage edit form. */
export const getStageDetail = (containerNo, stage) => apiClient.get(`/offlease/${encodeURIComponent(containerNo)}/stage/${stage}`).then((r) => r.data);

/** POST /api/offlease/:containerNo/stage/:stage — data = { col_N: value, ... } per stageFields. */
export const saveStage = (containerNo, stage, data) =>
  apiClient.post(`/offlease/${encodeURIComponent(containerNo)}/stage/${stage}`, data).then((r) => r.data.message);

/** GET /api/offlease/next-lease-id — preview only, used on Stage 1. */
export const getNextLeaseId = () => apiClient.get('/offlease/next-lease-id').then((r) => r.data.leaseId);

/** POST /api/offlease/:containerNo/move-to-stage — Stage 2 (Transportation)
 *  manual alternate-disposition move. `reason` is 'Client to Client' or
 *  'Other'. Both need `date` + `moveToStage` (a display stage number: 3, 4
 *  or 5). Client to Client needs `newClientName` (`clientScope` and
 *  `arrivalDate` optional); Other needs `commentType`. `remarks` is common
 *  to both. */
export const saveMoveToStage = (containerNo, { reason, newClientName, clientScope, arrivalDate, commentType, remarks, date, moveToStage }) =>
  apiClient.post(`/offlease/${encodeURIComponent(containerNo)}/move-to-stage`, { reason, newClientName, clientScope, arrivalDate, commentType, remarks, date, moveToStage })
    .then((r) => r.data.message);

/** POST /api/offlease/:containerNo/send-back — reverses an active Move To
 *  Stage jump, returning the record to Stage 2. */
export const saveSendBack = (containerNo) =>
  apiClient.post(`/offlease/${encodeURIComponent(containerNo)}/send-back`).then((r) => r.data.message);

/** GET /api/offlease/:containerNo/move-history — full Move To Stage / Send
 *  Back audit trail for one record, newest first. */
export const getMoveHistory = (containerNo, leaseId) =>
  apiClient.get(`/offlease/${encodeURIComponent(containerNo)}/move-history`, leaseId ? { params: { leaseId } } : undefined)
    .then((r) => r.data.history || []);

/** POST /api/offlease/:containerNo/hold — Stage 1 (Intimation) Hold: parks
 *  a still-pending record in Stage 1's own Hold view (GET ?stage=1&filter=hold)
 *  instead of the normal pending queue. Same row, no duplicate. `remarks`
 *  is optional free text (why it's on hold). */
export const saveHold = (containerNo, remarks) =>
  apiClient.post(`/offlease/${encodeURIComponent(containerNo)}/hold`, { remarks }).then((r) => r.data.message);

/** POST /api/offlease/:containerNo/hold/send-back — reverses an active
 *  Hold, returning the record to Stage 1's normal pending queue. */
export const saveSendBackToStage1 = (containerNo) =>
  apiClient.post(`/offlease/${encodeURIComponent(containerNo)}/hold/send-back`).then((r) => r.data.message);

/** POST /api/offlease/:containerNo/reject/send-back — reverses a Rejected
 *  approval decision (Stage 1A/Approval), returning the record to Stage 1's
 *  own pending queue (Stage 1's Reject tab). */
export const saveSendRejectedToStage1 = (containerNo) =>
  apiClient.post(`/offlease/${encodeURIComponent(containerNo)}/reject/send-back`).then((r) => r.data.message);
