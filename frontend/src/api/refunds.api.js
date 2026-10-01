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

/* -- No-login review link (explicit request 2026-10-01) ------------------
   Reached only via the signed ?rowNum=&stage=&token= link written into the
   sheet's HOD/CEO/Accounts "Review Link" columns — apiClient sends no
   Authorization header here since no token is stored in this tab, same as
   any other anonymous visitor; the link's own token is the real credential,
   carried in the query/body instead. */

/** GET /api/refund-review — fetch the one entry this link points at. */
export const getRefundReviewEntry = ({ rowNum, stage, token }) =>
  apiClient.get('/refund-review', { params: { rowNum, stage, token } }).then((r) => r.data);

/** POST /api/refund-review/decide — approve/reject via the signed link. */
export const decideRefundReview = ({ rowNum, stage, token, decision, remarks }) =>
  apiClient.post('/refund-review/decide', { rowNum, stage, token, decision, remarks }).then((r) => r.data.result);
