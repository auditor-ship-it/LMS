import * as salesOsRenewal from '../services/salesOsRenewal.service.js';

/** GET /api/public/v1/sales-os/renewals — read-only, key-gated (scope
 *  "salesos"). See routes/public.routes.js and
 *  salesOsRenewal.service.js#listRenewalsForSalesOs. */
export async function listRenewals(req, res) {
  res.json({ data: await salesOsRenewal.listRenewalsForSalesOs(req.query) });
}
