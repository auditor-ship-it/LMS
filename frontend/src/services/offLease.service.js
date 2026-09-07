import {
  getOffLeaseApprovalData, saveOffLeaseApprovalAction, sendRejectedToStage1, getOffLeaseContainerDetail,
  addToOffLeaseTracking, getOffLeaseDashboardData,
  getMovementSourceContainers, getMovementSourceContainer, getStage9Movements, saveStage9Movement,
  getRemarkThread, addRemark, updateRemark, deleteRemark
} from '../api/offlease.api.js';
import { invalidate } from '../shared/dataBus.js';

export async function fetchApprovalQueue() {
  return getOffLeaseApprovalData();
}
/* invalidate('off-lease') on every real data write here — same 'off-lease'
   choke point stage.service.js's own stage mutations use, so Off-Lease
   Efficiency (and anything else subscribed via useAutoRefresh) refetches
   immediately instead of waiting out its own poll interval. Remarks and
   Stage 9's movement log are deliberately excluded — comments don't change
   any stage/TAT stat, and Stage 9 is its own append-only log outside the
   1..8 pipeline (see fetchMovements' doc comment). */
export async function decideApproval(containerNo, status, remarks, rowNum) {
  const res = await saveOffLeaseApprovalAction(containerNo, status, remarks, rowNum);
  invalidate('off-lease');
  return res;
}
export async function sendRejectedBackToStage1(containerNo, rowNum) {
  const res = await sendRejectedToStage1(containerNo, rowNum);
  invalidate('off-lease');
  return res;
}
export async function lookupContainer(containerNo, leaseId) {
  return getOffLeaseContainerDetail(containerNo, leaseId);
}
export async function trackContainer(containerNo, deployedRow, remarks, personName) {
  const res = await addToOffLeaseTracking(containerNo, deployedRow, remarks, personName);
  invalidate('off-lease');
  return res;
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
