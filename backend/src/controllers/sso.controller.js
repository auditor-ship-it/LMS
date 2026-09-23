import * as salesOsRenewal from '../services/salesOsRenewal.service.js';

/** POST /api/sso/sales-os/session — unauthenticated entry point for the
 *  Sales OS deep link (employeeCode-only SSO, no password). See
 *  salesOsRenewal.service.js#startSalesOsSession. */
export async function startSession(req, res) {
  const params = { ...req.query, ...req.body };
  res.json(await salesOsRenewal.startSalesOsSession(params));
}

/** POST /api/sso/lease-expiry/session — employeeCode-only SSO for the plain
 *  Lease Expiry embed (Sales OS's "Lease" section), no lead/company context
 *  required. See salesOsRenewal.service.js#startEmployeeSession. */
export async function startEmployeeSession(req, res) {
  const params = { ...req.query, ...req.body };
  res.json(await salesOsRenewal.startEmployeeSession(params));
}

/** POST /api/sso/sales-os/confirm-company — the ambiguous-match picker's submit. */
export async function confirmCompany(req, res) {
  const { existingLeadId, companyName } = req.body;
  res.json(await salesOsRenewal.confirmCompany(existingLeadId, companyName));
}

/** POST /api/sso/sales-os/renewal — saves the completed renewal.
 *  req.user comes from the SSO session established by startSession above. */
export async function saveRenewal(req, res) {
  res.json(await salesOsRenewal.saveRenewal(req.user, req.body));
}
