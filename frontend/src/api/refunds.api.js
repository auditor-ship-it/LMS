import { apiClient } from '../shared/auth/index.js';

/**
 * "Refunds" (Off-Lease Bills) — explicit request 2026-09-30. Saves to the
 * live "Offlease Bills " tab; Timestamp and the caller's email are stamped
 * server-side, never sent from here.
 */

/** GET /api/refunds — every bill ever submitted, newest first. */
export const getRefunds = () => apiClient.get('/refunds').then((r) => r.data);

/** POST /api/refunds — submit a new bill. */
export const createRefund = (payload) => apiClient.post('/refunds', payload).then((r) => r.data);

/** POST /api/refunds/decide-approval — HOD/CEO/Accounts decision. `stage` is
 *  'hod' | 'ceo' | 'accounts', `decision` is 'approved' | 'rejected'. */
export const decideRefundApproval = ({ rowNum, stage, decision, remarks }) =>
  apiClient.post('/refunds/decide-approval', { rowNum, stage, decision, remarks }).then((r) => r.data.result);
