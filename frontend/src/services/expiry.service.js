import { getExpiryData, saveExpiryAction, refreshSalePersons } from '../api/expiry.api.js';

export async function fetchExpiryList() {
  return getExpiryData('pending');
}
export async function actionExpiryRow(rowId, timestamp, status) {
  return saveExpiryAction(rowId, timestamp, status);
}

/** Pull the latest company -> salesperson assignments from the Sales CRM.
 *  Read-only: it refreshes what this app SHOWS, it never reassigns anyone. */
export async function syncSalePersons() {
  return refreshSalePersons();
}
