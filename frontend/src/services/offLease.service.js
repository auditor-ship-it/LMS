import {
  getOffLeaseApprovalData, saveOffLeaseApprovalAction, getOffLeaseContainerDetail,
  addToOffLeaseTracking, getOffLeaseDashboardData,
  getMovementSourceContainers, getMovementSourceContainer, getStage9Movements, saveStage9Movement,
  getRemarkThread, addRemark, updateRemark, deleteRemark
} from '../api/offlease.api.js';

export async function fetchApprovalQueue() {
  return getOffLeaseApprovalData();
}
export async function decideApproval(containerNo, status) {
  return saveOffLeaseApprovalAction(containerNo, status);
}
export async function lookupContainer(containerNo, leaseId) {
  return getOffLeaseContainerDetail(containerNo, leaseId);
}
export async function trackContainer(containerNo) {
  return addToOffLeaseTracking(containerNo);
}
export async function fetchOffLeaseDashboard() {
  return getOffLeaseDashboardData();
}

/* Dashboard live remarks. */
export async function fetchRemarkThread(containerNo, leaseId) {
  return getRemarkThread(containerNo, leaseId);
}
export async function postRemark(containerNo, leaseId, html) {
  return addRemark(containerNo, leaseId, html);
}
export async function editRemark(containerNo, remarkId, html) {
  return updateRemark(containerNo, remarkId, html);
}
export async function removeRemark(containerNo, remarkId) {
  return deleteRemark(containerNo, remarkId);
}

/* Stage 9 — container movement log. */
export async function fetchMovementContainers() {
  return getMovementSourceContainers();
}
export async function fetchMovementContainer(containerNo) {
  return getMovementSourceContainer(containerNo);
}
export async function fetchMovements() {
  return getStage9Movements();
}
export async function submitMovement(payload) {
  return saveStage9Movement(payload);
}
