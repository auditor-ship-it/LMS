import { startSsoSession, confirmSsoCompany, saveSsoRenewal } from '../api/sso.api.js';

/** Kicks off the Sales OS SSO handoff — `searchParams` is the deep link's
 *  own URLSearchParams, forwarded as a plain object. */
export async function startSalesOsSso(searchParams) {
  return startSsoSession(Object.fromEntries(searchParams.entries()));
}

export async function confirmLeaseCompany(existingLeadId, companyName) {
  return confirmSsoCompany(existingLeadId, companyName);
}

export async function submitSalesOsRenewal(payload) {
  return saveSsoRenewal(payload);
}
