/**
 * "Renew via Sales CRM" — Lease Expiry hands a renewal off to the Sales
 * CRM's own renewal-entry form (the salesperson-facing form with
 * Grade/Rev Share/Type/LM/Client Name/Product rows/Signed-addendum-upload)
 * instead of the ops team re-typing company and container details the sales
 * side already has to fill in there anyway.
 *
 * Two independently-optional pieces, both required for the handoff to
 * actually skip a second login (see env.js's comment on both vars):
 *   1. Where the form lives (SALES_CRM_RENEWAL_FORM_URL).
 *   2. A secret shared with whoever adds token verification on the Sales
 *      CRM side (SALES_CRM_HANDOFF_SECRET) — that app's code is out of
 *      reach from here, so this half can only mint a correct, standard
 *      HS256 JWT (utils/jwtLite.js) and wait for the other side to verify
 *      it. Until it does, the link still opens the form once the URL is
 *      set, just without the auto-login.
 *
 * Container selection is scoped to ONE company by an EXACT (case/space
 * normalized) match against the Deployed sheet's own Customer Name column —
 * deliberately not the fuzzy matching salesCrmLeads.service.js uses for the
 * Sales CRM join. That fuzzy pass is fine for "which salesperson owns this
 * lead" (a wrong guess there is silently corrected by the CRM being the
 * source of truth); here a wrong guess would hand a salesperson a PICKER
 * LIST for the wrong company, and whatever they select feeds straight into
 * a renewal PO. Get it from the row already on screen — the one Lease
 * Expiry itself is already rendering that Customer Name for — no reason to
 * fuzzy-guess when the exact string is right there.
 */
import { signJwt } from '../utils/jwtLite.js';
import { AppError } from '../utils/AppError.js';
import { env } from '../config/env.js';
import { SHEETS } from '../config/sheets.config.js';
import { safeStr, parseDate } from '../utils/format.js';
import { _deployedRawValues, _expiryOrderNoMap, _resolveOrderNo, findHeaderCol } from './expiry.service.js';

const normCompany = (v) => safeStr(v).trim().toLowerCase();
const normStatus = (v) => safeStr(v).trim().toLowerCase().replace(/[\s-]/g, '');

/**
 * All of ONE company's containers that are still live (not off-lease),
 * newest-expiring first — the picker's source list. `company` must be the
 * exact Customer Name string as Lease Expiry already displays it.
 */
export async function getCompanyContainers(company) {
  const key = normCompany(company);
  if (!key) return [];

  const { values } = await _deployedRawValues();
  if (values.length < 2) return [];
  const headers = values[0];
  const rows = values.slice(1);

  const custCol = findHeaderCol(headers, 'customer name', 'client name');
  const validCol = findHeaderCol(headers, 'agreement valid upto') !== -1
    ? findHeaderCol(headers, 'agreement valid upto')
    : (() => { for (let h = 0; h <= 14; h++) { if (String(headers[h] || '').toLowerCase().includes('valid')) return h; } return -1; })();
  const statusCol = 22; // 'Status' — same fixed index the rest of expiry.service.js uses

  if (custCol === -1) return [];

  const ordMap = await _expiryOrderNoMap();
  const today = new Date(); today.setHours(0, 0, 0, 0);

  const out = [];
  for (const row of rows) {
    const containerNo = safeStr(row[0]).trim();
    if (!containerNo) continue;
    if (normCompany(row[custCol]) !== key) continue;
    if (normStatus(row[statusCol]) === 'offlease') continue;

    const validRaw = validCol !== -1 ? row[validCol] : '';
    const validDate = parseDate(validRaw);
    const daysLeft = validDate ? Math.ceil((validDate - today) / 86400000) : null;

    out.push({
      containerNo,
      orderNo: _resolveOrderNo(ordMap, containerNo, row[custCol]),
      validUpto: safeStr(validRaw),
      daysLeft
    });
  }

  out.sort((a, b) => (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity));
  return out;
}

/**
 * Mints the signed handoff link. `containers` is re-validated against the
 * SAME company lookup above — never trusts the caller's list at face value,
 * so a tampered request body can't smuggle a different company's container
 * into someone else's renewal token.
 */
export async function createRenewalLink(user, company, containers) {
  if (!env.salesCrmRenewalFormUrl || !env.salesCrmHandoffSecret) {
    throw new AppError(
      'Renew via Sales CRM is not configured on this server yet (SALES_CRM_RENEWAL_FORM_URL / SALES_CRM_HANDOFF_SECRET). Ask an admin to set these in the backend .env — see README.md.',
      503
    );
  }
  const companyName = safeStr(company).trim();
  if (!companyName) throw new AppError('Company is required.');

  const requested = (Array.isArray(containers) ? containers : [containers]).map((c) => safeStr(c).trim()).filter(Boolean);
  if (!requested.length) throw new AppError('Select at least one container.');

  const valid = await getCompanyContainers(companyName);
  const validSet = new Set(valid.map((v) => v.containerNo));
  const chosen = requested.filter((c) => validSet.has(c));
  if (!chosen.length) throw new AppError(`None of the selected containers currently belong to "${companyName}" on the Deployed sheet.`);

  const token = signJwt(
    { sub: user.empId, name: user.name, email: user.email, company: companyName, containers: chosen },
    env.salesCrmHandoffSecret,
    env.salesCrmHandoffTtlSecs
  );

  const url = new URL(env.salesCrmRenewalFormUrl);
  url.searchParams.set('token', token);
  return { url: url.toString(), containers: chosen, expiresInSecs: env.salesCrmHandoffTtlSecs };
}
