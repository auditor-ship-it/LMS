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

/** GET /api/public/v1/sales-os/renewal-stats?employeeCode=X or
 *  ?employeeCodes=X,Y,Z — per-salesperson dashboard numbers (pending,
 *  overdue, awaiting approval, approved this month). Read-only, same
 *  "salesos" key scope. See salesOsRenewal.service.js#getRenewalStats. */
export async function renewalStats(req, res) {
  const single = String(req.query.employeeCode || '').trim();
  const codes = single
    ? [single]
    : String(req.query.employeeCodes || '').split(',').map((s) => s.trim()).filter(Boolean);

  const data = await Promise.all(codes.map(async (code) => {
    try {
      return await salesOsRenewal.getRenewalStats(code);
    } catch (e) {
      return { status: 'error', employeeCode: code, message: e?.message || 'Lookup failed' };
    }
  }));
  res.json({ data });
}

/** GET /api/public/v1/sales-os/renewal-log?employeeCode=X&year=&month= — the
 *  "Total renewals" scorecard's own count + click-through detail rows, for
 *  one salesperson. Read-only, same "salesos" key scope. See
 *  salesOsRenewal.service.js#getRenewalLog. */
export async function renewalLog(req, res) {
  res.json(await salesOsRenewal.getRenewalLog(req.query.employeeCode, { year: req.query.year, month: req.query.month }));
}

/** GET /api/public/v1/sales-os/renewal-pipeline?employeeCode=X or
 *  ?employeeCodes=X,Y,Z — every renewal currently draft/rejected/awaiting
 *  approval/approved for one or more salespeople, sourced from Lease's own
 *  live pages rather than the SSO-submission audit log — see
 *  salesOsRenewal.service.js#getRenewalPipeline for why that distinction
 *  matters. Same batch shape as renewalStats above. Read-only, same
 *  "salesos" key scope. */
export async function renewalPipeline(req, res) {
  const single = String(req.query.employeeCode || '').trim();
  const codes = single
    ? [single]
    : String(req.query.employeeCodes || '').split(',').map((s) => s.trim()).filter(Boolean);

  const data = await Promise.all(codes.map(async (code) => {
    try {
      return await salesOsRenewal.getRenewalPipeline(code);
    } catch (e) {
      return { status: 'error', employeeCode: code, message: e?.message || 'Lookup failed' };
    }
  }));
  res.json({ data });
}
