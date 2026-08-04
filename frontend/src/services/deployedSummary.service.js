import { getDeployedSummary, getDeployedDetail } from '../api/dashboard.api.js';

export async function fetchDeployedSummary() {
  return getDeployedSummary();
}
export async function fetchDeployedDetail(month, category, type, size) {
  return getDeployedDetail(month, category, type, size);
}
