import {
  getStageData, getStageDetail, saveStage, saveStage1Invoice, getNextLeaseId, saveMoveToStage, saveSendBack, getMoveHistory,
  saveHold, saveSendBackToStage1, saveSendRejectedToStage1
} from '../api/stage.api.js';
import { invalidate } from '../shared/dataBus.js';

export async function fetchStageList(stage, filter) {
  return getStageData(stage, filter);
}
export async function fetchStageDetail(containerNo, stage, rowNum) {
  return getStageDetail(containerNo, stage, rowNum);
}
/* Every write below invalidates('off-lease') on success — the single choke
   point every stage mutation (form submit, move, hold, send-back) already
   passes through, so wiring it here reaches all of them at once rather than
   at each call site. Off-Lease Efficiency (and any other kept-alive page
   reading the same data) subscribes via useAutoRefresh and refetches
   immediately, instead of waiting for its own up-to-3-minute poll. See
   dataBus.js's own doc comment for why this exists at all — KeepAlivePages
   means an already-mounted page never sees another page's write on its own. */
export async function submitStage(containerNo, stage, data, rowNum) {
  const res = await saveStage(containerNo, stage, data, rowNum);
  invalidate('off-lease');
  return res;
}
export async function submitStage1Invoice(containerNo, data, rowNum) {
  const res = await saveStage1Invoice(containerNo, data, rowNum);
  invalidate('off-lease');
  return res;
}
export async function fetchNextLeaseId() {
  return getNextLeaseId();
}
export async function submitMoveToStage(containerNo, payload) {
  const res = await saveMoveToStage(containerNo, payload);
  invalidate('off-lease');
  return res;
}
export async function submitSendBack(containerNo, rowNum) {
  const res = await saveSendBack(containerNo, rowNum);
  invalidate('off-lease');
  return res;
}
export async function fetchMoveHistory(containerNo, leaseId) {
  return getMoveHistory(containerNo, leaseId);
}
export async function submitHold(containerNo, remarks, rowNum) {
  const res = await saveHold(containerNo, remarks, rowNum);
  invalidate('off-lease');
  return res;
}
export async function submitSendBackToStage1(containerNo, rowNum) {
  const res = await saveSendBackToStage1(containerNo, rowNum);
  invalidate('off-lease');
  return res;
}
export async function submitSendRejectedToStage1(containerNo, rowNum) {
  const res = await saveSendRejectedToStage1(containerNo, rowNum);
  invalidate('off-lease');
  return res;
}
