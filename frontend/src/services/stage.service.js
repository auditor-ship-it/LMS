import { getStageData, getStageDetail, saveStage, getNextLeaseId, saveMoveToStage, saveSendBack, getMoveHistory } from '../api/stage.api.js';

export async function fetchStageList(stage) {
  return getStageData(stage);
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
