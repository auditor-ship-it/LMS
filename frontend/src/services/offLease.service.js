import {
  getOffLeaseApprovalData, saveOffLeaseApprovalAction, sendRejectedToStage1, getOffLeaseContainerDetail,
  addToOffLeaseTracking, getOffLeaseDashboardData,
  getMovementSourceContainers, getMovementSourceContainer, getStage9Movements, saveStage9Movement,
  getRemarkThread, addRemark, updateRemark, deleteRemark
} from '../api/offlease.api.js';

export async function fetchApprovalQueue() {
  return getOffLeaseApprovalData();
}
export async function decideApproval(containerNo, status, remarks, rowNum) {
  return saveOffLeaseApprovalAction(containerNo, status, remarks, rowNum);
}
export async function sendRejectedBackToStage1(containerNo, rowNum) {
  return sendRejectedToStage1(containerNo, rowNum);
}
export async function lookupContainer(containerNo, leaseId) {
  return getOffLeaseContainerDetail(containerNo, leaseId);
}
export async function trackContainer(containerNo, deployedRow, remarks, personName) {
  return addToOffLeaseTracking(containerNo, deployedRow, remarks, personName);
}
export async function fetchOffLeaseDashboard() {
  return getOffLeaseDashboardData();
}

/* Dashboard live remarks — `stage` optional, scopes to a stage's own thread. */
export async function fetchRemarkThread(containerNo, leaseId, stage) {
  return getRemarkThread(containerNo, leaseId, stage);
}
export async function postRemark(containerNo, leaseId, html, stage) {
  return addRemark(containerNo, leaseId, html, stage);
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
