import * as salesOsRenewal from '../services/salesOsRenewal.service.js';

/** GET /api/public/v1/sales-os/renewals — read-only, key-gated (scope
 *  "salesos"). See routes/public.routes.js and
 *  salesOsRenewal.service.js#listRenewalsForSalesOs. */
export async function listRenewals(req, res) {
  res.json({ data: await salesOsRenewal.listRenewalsForSalesOs(req.query) });
}

/** GET /api/public/v1/sales-os/company-match?companyNames=a,b,c — lets Sales
 *  OS pre-check, for a batch of KAM company names, which ones have a Lease
 *  match (to drive their own "Lease" nav section). Read-only, same "salesos"
 *  key scope. See salesOsRenewal.service.js#matchCompanies. */
export async function companyMatch(req, res) {
  res.json({ data: await salesOsRenewal.matchCompanies(req.query.companyNames) });
}
