import { startSsoSession, startLeaseExpirySsoSession, confirmSsoCompany, saveSsoRenewal } from '../api/sso.api.js';

/** Kicks off the Sales OS SSO handoff — `searchParams` is the deep link's
 *  own URLSearchParams, forwarded as a plain object. */
export async function startSalesOsSso(searchParams) {
  return startSsoSession(Object.fromEntries(searchParams.entries()));
}

/** Kicks off the plain Lease Expiry embed's SSO (no lead/company context). */
export async function startLeaseExpirySso(searchParams) {
  return startLeaseExpirySsoSession(Object.fromEntries(searchParams.entries()));
}

export async function confirmLeaseCompany(existingLeadId, companyName) {
  return confirmSsoCompany(existingLeadId, companyName);
}

export async function submitSalesOsRenewal(payload) {
  return saveSsoRenewal(payload);
}
