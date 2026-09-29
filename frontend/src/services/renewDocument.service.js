import { getRenewDocumentData, completeRenewalDocStage, saveRenewalDraft, getApprovalPendingData, decideRenewalApproval } from '../api/renewDocument.api.js';

export async function fetchDocumentList() {
  return getRenewDocumentData('documents');
}
export async function submitDocumentCompletion(payload) {
  return completeRenewalDocStage(payload);
}
export async function saveDocumentDraft(payload) {
  return saveRenewalDraft(payload);
}
export async function fetchApprovalPendingList() {
  return getApprovalPendingData();
}
export async function submitApprovalDecision(payload) {
  return decideRenewalApproval(payload);
}
