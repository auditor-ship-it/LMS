import {
  getStageData, getStageDetail, saveStage, getNextLeaseId, saveMoveToStage, saveSendBack, getMoveHistory,
  saveHold, saveSendBackToStage1, saveSendRejectedToStage1
} from '../api/stage.api.js';

export async function fetchStageList(stage, filter) {
  return getStageData(stage, filter);
}
export async function fetchStageDetail(containerNo, stage, rowNum) {
  return getStageDetail(containerNo, stage, rowNum);
}
export async function submitStage(containerNo, stage, data, rowNum) {
  return saveStage(containerNo, stage, data, rowNum);
}
export async function fetchNextLeaseId() {
  return getNextLeaseId();
}
export async function submitMoveToStage(containerNo, payload) {
  return saveMoveToStage(containerNo, payload);
}
export async function submitSendBack(containerNo, rowNum) {
  return saveSendBack(containerNo, rowNum);
}
export async function fetchMoveHistory(containerNo, leaseId) {
  return getMoveHistory(containerNo, leaseId);
}
export async function submitHold(containerNo, remarks, rowNum) {
  return saveHold(containerNo, remarks, rowNum);
}
export async function submitSendBackToStage1(containerNo, rowNum) {
  return saveSendBackToStage1(containerNo, rowNum);
}
export async function submitSendRejectedToStage1(containerNo, rowNum) {
  return saveSendRejectedToStage1(containerNo, rowNum);
}
