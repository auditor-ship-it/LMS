import { getRefunds, createRefund, decideRefundApproval } from '../api/refunds.api.js';

export async function fetchRefunds() {
  return getRefunds();
}
export async function submitRefund(payload) {
  return createRefund(payload);
}
export async function submitRefundApprovalDecision(payload) {
  return decideRefundApproval(payload);
}
