import {
  startSsoSession, startLeaseExpirySsoSession, startRenewDocumentSsoSession, startApprovalPendingSsoSession,
  confirmSsoCompany, saveSsoRenewal, saveSsoRenewalDraft
} from '../api/sso.api.js';

/** Kicks off the Sales OS SSO handoff — `searchParams` is the deep link's
 *  own URLSearchParams, forwarded as a plain object. */
export async function startSalesOsSso(searchParams) {
  return startSsoSession(Object.fromEntries(searchParams.entries()));
}

/** Kicks off the plain Lease Expiry embed's SSO (no lead/company context). */
export async function startLeaseExpirySso(searchParams) {
  return startLeaseExpirySsoSession(Object.fromEntries(searchParams.entries()));
}

/** Kicks off the Renew & Document embed's SSO. */
export async function startRenewDocumentSso(searchParams) {
  return startRenewDocumentSsoSession(Object.fromEntries(searchParams.entries()));
}

/** Kicks off the Approval Pending embed's SSO. */
export async function startApprovalPendingSso(searchParams) {
  return startApprovalPendingSsoSession(Object.fromEntries(searchParams.entries()));
}

export async function confirmLeaseCompany(existingLeadId, companyName) {
  return confirmSsoCompany(existingLeadId, companyName);
}

export async function submitSalesOsRenewal(payload) {
  return saveSsoRenewal(payload);
}

export async function saveSalesOsRenewalDraft(payload) {
  return saveSsoRenewalDraft(payload);
}
