import { getApproveLeaseData, saveApproveLeaseByContainer } from '../api/approve.api.js';

export async function fetchApproveList() {
  return getApproveLeaseData();
}
export async function decideApproval(containerNo, payload) {
  return saveApproveLeaseByContainer(containerNo, payload);
}