import { getExpiryData, saveExpiryAction } from '../api/expiry.api.js';

export async function fetchExpiryList() {
  return getExpiryData('pending');
}
export async function actionExpiryRow(rowId, timestamp, status) {
  return saveExpiryAction(rowId, timestamp, status);
}
