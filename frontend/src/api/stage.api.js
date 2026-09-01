import { apiClient } from '../shared/auth/index.js';

/** GET /api/offlease?stage=1..8 — pending rows for that stage. `filter`
 *  ('hold') is only meaningful for Stage 1 — see saveHold's doc comment. */
export const getStageData = (stage, filter) =>
  apiClient.get('/offlease', { params: filter ? { stage, filter } : { stage } }).then((r) => r.data);

/** GET /api/offlease/:containerNo/stage/:stage — prefill data for the stage
 *  edit form. `rowNum` (item._rowNum from the list this was opened from) —
 *  Container No is not unique in Off-Lease Tracking (a container re-leased
 *  after an earlier cycle keeps its old row alongside the new one), so
 *  without it this can silently pre-fill a DIFFERENT lease's data for the
 *  same container. Always pass it when known. */
export const getStageDetail = (containerNo, stage, rowNum) =>
  apiClient.get(`/offlease/${encodeURIComponent(containerNo)}/stage/${stage}`, rowNum ? { params: { rn: rowNum } } : undefined).then((r) => r.data);

/** POST /api/offlease/:containerNo/stage/:stage — data = { col_N: value, ... }
 *  per stageFields. `rowNum`: see getStageDetail's doc comment above — same
 *  reasoning, this time for the write, where a wrong-row match corrupts
 *  real data instead of just displaying it wrong. */
export const saveStage = (containerNo, stage, data, rowNum) =>
  apiClient.post(`/offlease/${encodeURIComponent(containerNo)}/stage/${stage}`, { ...data, rowNum }).then((r) => r.data.message);

/** GET /api/offlease/next-lease-id — preview only, used on Stage 1. */
export const getNextLeaseId = () => apiClient.get('/offlease/next-lease-id').then((r) => r.data.leaseId);

/** POST /api/offlease/:containerNo/move-to-stage — Stage 2 (Transportation)
 *  manual alternate-disposition move. `reason` is 'Client to Client' or
 *  'Other'. Both need `date` + `moveToStage` (a display stage number: 3, 4
 *  or 5). Client to Client needs `newClientName` (`clientScope` and
 *  `arrivalDate` optional); Other needs `commentType`. `remarks` is common
 *  to both. `rowNum`: see getStageDetail's doc comment. */
export const saveMoveToStage = (containerNo, { reason, newClientName, clientScope, arrivalDate, commentType, remarks, date, moveToStage, rowNum }) =>
  apiClient.post(`/offlease/${encodeURIComponent(containerNo)}/move-to-stage`, { reason, newClientName, clientScope, arrivalDate, commentType, remarks, date, moveToStage, rowNum })
    .then((r) => r.data.message);

/** POST /api/offlease/:containerNo/send-back — reverses an active Move To
 *  Stage jump, returning the record to Stage 2. `rowNum`: see
 *  getStageDetail's doc comment. */
export const saveSendBack = (containerNo, rowNum) =>
  apiClient.post(`/offlease/${encodeURIComponent(containerNo)}/send-back`, { rowNum }).then((r) => r.data.message);

/** GET /api/offlease/:containerNo/move-history — full Move To Stage / Send
 *  Back audit trail for one record, newest first. */
export const getMoveHistory = (containerNo, leaseId) =>
  apiClient.get(`/offlease/${encodeURIComponent(containerNo)}/move-history`, leaseId ? { params: { leaseId } } : undefined)
    .then((r) => r.data.history || []);

/** POST /api/offlease/:containerNo/hold — Stage 1 (Intimation) Hold: parks
 *  a still-pending record in Stage 1's own Hold view (GET ?stage=1&filter=hold)
 *  instead of the normal pending queue. Same row, no duplicate. `remarks`
 *  is optional free text (why it's on hold). `rowNum`: see getStageDetail's
 *  doc comment. */
export const saveHold = (containerNo, remarks, rowNum) =>
  apiClient.post(`/offlease/${encodeURIComponent(containerNo)}/hold`, { remarks, rowNum }).then((r) => r.data.message);

/** POST /api/offlease/:containerNo/hold/send-back — reverses an active
 *  Hold, returning the record to Stage 1's normal pending queue. `rowNum`:
 *  see getStageDetail's doc comment. */
export const saveSendBackToStage1 = (containerNo, rowNum) =>
  apiClient.post(`/offlease/${encodeURIComponent(containerNo)}/hold/send-back`, { rowNum }).then((r) => r.data.message);

/** POST /api/offlease/:containerNo/reject/send-back — reverses a Rejected
 *  approval decision (Stage 1A/Approval), returning the record to Stage 1's
 *  own pending queue (Stage 1's Reject tab). `rowNum`: see getStageDetail's
 *  doc comment. */
export const saveSendRejectedToStage1 = (containerNo, rowNum) =>
  apiClient.post(`/offlease/${encodeURIComponent(containerNo)}/reject/send-back`, { rowNum }).then((r) => r.data.message);
