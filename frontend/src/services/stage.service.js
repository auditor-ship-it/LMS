import {
  getStageData, getStageDetail, saveStage, getNextLeaseId, saveMoveToStage, saveSendBack, getMoveHistory,
  saveHold, saveSendBackToStage1, saveSendRejectedToStage1
} from '../api/stage.api.js';

export async function fetchStageList(stage, filter) {
  return getStageData(stage, filter);
}
export async function fetchStageDetail(containerNo, stage) {
  return getStageDetail(containerNo, stage);
}
export async function submitStage(containerNo, stage, data) {
  return saveStage(containerNo, stage, data);
}
export async function fetchNextLeaseId() {
  return getNextLeaseId();
}
export async function submitMoveToStage(containerNo, payload) {
  return saveMoveToStage(containerNo, payload);
}
export async function submitSendBack(containerNo) {
  return saveSendBack(containerNo);
}
export async function fetchMoveHistory(containerNo, leaseId) {
  return getMoveHistory(containerNo, leaseId);
}
export async function submitHold(containerNo, remarks) {
  return saveHold(containerNo, remarks);
}
export async function submitSendBackToStage1(containerNo) {
  return saveSendBackToStage1(containerNo);
}
export async function submitSendRejectedToStage1(containerNo) {
  return saveSendRejectedToStage1(containerNo);
}
