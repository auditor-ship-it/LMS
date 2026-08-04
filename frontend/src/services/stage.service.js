import { getStageData, getStageDetail, saveStage, getNextLeaseId } from '../api/stage.api.js';

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
