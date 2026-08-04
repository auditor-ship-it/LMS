import { getOffLeaseApprovalData, saveOffLeaseApprovalAction, getOffLeaseContainerDetail, addToOffLeaseTracking, getOffLeaseDashboardData } from '../api/offlease.api.js';

export async function fetchApprovalQueue() {
  return getOffLeaseApprovalData();
}
export async function decideApproval(containerNo, status) {
  return saveOffLeaseApprovalAction(containerNo, status);
}
export async function lookupContainer(containerNo) {
  return getOffLeaseContainerDetail(containerNo);
}
export async function trackContainer(containerNo) {
  return addToOffLeaseTracking(containerNo);
}
export async function fetchOffLeaseDashboard() {
  return getOffLeaseDashboardData();
}
