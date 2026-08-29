import { getExpiryData, saveExpiryAction, refreshSalePersons } from '../api/expiry.api.js';

export async function fetchExpiryList() {
  return getExpiryData('pending');
}
export async function actionExpiryRow(rowId, timestamp, status, rowNum) {
  return saveExpiryAction(rowId, timestamp, status, rowNum);
}

/** Pull the latest company -> salesperson assignments from the Sales CRM.
 *  Read-only: it refreshes what this app SHOWS, it never reassigns anyone. */
export async function syncSalePersons() {
  return refreshSalePersons();
}
