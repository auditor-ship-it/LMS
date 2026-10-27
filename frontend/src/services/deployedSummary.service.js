import { getDeployedSummary, getDeployedDetail, getDeployedSummaryExport, getDeployedSummaryExportMonthCategories } from '../api/dashboard.api.js';

export async function fetchDeployedSummary() {
  return getDeployedSummary();
}
export async function fetchDeployedDetail(month, category, type, size) {
  return getDeployedDetail(month, category, type, size);
}
export async function fetchDeployedSummaryExport() {
  return getDeployedSummaryExport();
}
export async function fetchDeployedSummaryExportMonthCategories(month, type, size) {
  return getDeployedSummaryExportMonthCategories(month, type, size);
}
