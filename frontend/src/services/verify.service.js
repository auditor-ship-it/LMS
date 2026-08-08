import { getVerifyData, saveVerifyAction, saveVerifyFollowUp, getReturnDashboardData, editVerifyLease, uploadVerifyDocument } from '../api/verify.api.js';

export async function fetchVerifyList() {
  return getVerifyData();
}
export async function approveVerify(containerNo, payload) {
  return saveVerifyAction(containerNo, payload);
}
export async function addVerifyFollowUp(containerNo, payload) {
  return saveVerifyFollowUp(containerNo, payload);
}
export async function fetchReturnDashboard() {
  return getReturnDashboardData();
}
export async function submitAgreementEdit(containerNo, updates) {
  return editVerifyLease(containerNo, updates);
}
export async function uploadAgreementDocument(payload) {
  return uploadVerifyDocument(payload);
}
