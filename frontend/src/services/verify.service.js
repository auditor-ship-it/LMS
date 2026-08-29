import { getVerifyData, saveVerifyAction, saveVerifyFollowUp, editVerifyLease, uploadVerifyDocument } from '../api/verify.api.js';

export async function fetchVerifyList() {
  return getVerifyData();
}
export async function approveVerify(containerNo, payload) {
  return saveVerifyAction(containerNo, payload);
}
export async function addVerifyFollowUp(containerNo, payload) {
  return saveVerifyFollowUp(containerNo, payload);
}
export async function submitAgreementEdit(containerNo, updates, rowNum) {
  return editVerifyLease(containerNo, updates, rowNum);
}
export async function uploadAgreementDocument(payload) {
  return uploadVerifyDocument(payload);
}
