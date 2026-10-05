import {
  getRenewDocumentData, completeRenewalDocStage, saveRenewalDraft, getApprovalPendingData, decideRenewalApproval, sendBackToPending,
  getRenewRemarkThread, addRenewRemark, updateRenewRemark, deleteRenewRemark
} from '../api/renewDocument.api.js';

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
export async function submitSendBackToPending(containerNo, rowNum) {
  return sendBackToPending(containerNo, rowNum);
}
export async function fetchRenewRemarkThread(containerNo, rowNum) {
  return getRenewRemarkThread(containerNo, rowNum);
}
export async function postRenewRemark(containerNo, rowNum, html) {
  return addRenewRemark(containerNo, rowNum, html);
}
export async function editRenewRemark(remarkId, html) {
  return updateRenewRemark(remarkId, html);
}
export async function removeRenewRemark(remarkId) {
  return deleteRenewRemark(remarkId);
}
