import { getExpiryData, saveExpiryAction, refreshSalePersons, getCompanyContainers, createRenewalLink, saveExpiryRemark } from '../api/expiry.api.js';

export async function fetchExpiryList() {
  return getExpiryData('pending');
}
export async function actionExpiryRow(rowId, timestamp, status, rowNum) {
  return saveExpiryAction(rowId, timestamp, status, rowNum);
}

/** Persist the Lease Expiry comment for this exact Deployed row. */
export async function saveExpiryRowRemark(containerNo, remark, rowNum) {
  return saveExpiryRemark(containerNo, remark, rowNum);
}

/** Pull the latest company -> salesperson assignments from the Sales CRM.
 *  Read-only: it refreshes what this app SHOWS, it never reassigns anyone. */
export async function syncSalePersons() {
  return refreshSalePersons();
}

/** Every still-live container under `company`, for the "Renew via Sales
 *  CRM" picker. */
export async function fetchCompanyContainers(company) {
  return getCompanyContainers(company);
}

/** Mints the signed handoff link and returns { url, containers, expiresInSecs }. */
export async function requestRenewalLink(company, containers) {
  return createRenewalLink(company, containers);
}
