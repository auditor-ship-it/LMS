import { getVerifyData, saveVerifyAction, saveVerifyFollowUp } from '../api/verify.api.js';

export async function fetchVerifyList() {
  return getVerifyData();
}
export async function approveVerify(containerNo, payload) {
  return saveVerifyAction(containerNo, payload);
}
export async function addVerifyFollowUp(containerNo, payload) {
  return saveVerifyFollowUp(containerNo, payload);
}
