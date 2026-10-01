import { getRefunds, createRefund, decideRefundApproval, getRefundReviewEntry, decideRefundReview } from '../api/refunds.api.js';

export async function fetchRefunds() {
  return getRefunds();
}
export async function submitRefund(payload) {
  return createRefund(payload);
}
export async function submitRefundApprovalDecision(payload) {
  return decideRefundApproval(payload);
}
export async function fetchRefundReviewEntry(payload) {
  return getRefundReviewEntry(payload);
}
export async function submitRefundReviewDecision(payload) {
  return decideRefundReview(payload);
}
