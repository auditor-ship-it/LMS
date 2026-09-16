/**
 * Sales OS (Crystal Sales CRM's Existing Leads / KAM screen) -> Lease
 * Management renewal handoff. This is the INBOUND direction: Sales OS deep
 * links a salesperson straight into this app (no password — see
 * auth.service.js#empSsoLogin), the salesperson picks which of that
 * company's LIVE containers a renewal covers, fills in terms per container,
 * and the result is stored HERE (never back in Sales OS Mongo). Sales OS
 * later reads it back via GET /api/public/v1/sales-os/renewals
 * (routes/public.routes.js, key-gated same as every other public API read).
 *
 * This is the mirror image of the already-live "Renew via Sales CRM" handoff
 * (renewalHandoff.service.js), which mints a link FROM this app TO the Sales
 * CRM. Both share the same partner, the same dependency-free HS256 JWT
 * helper (utils/jwtLite.js) and the same "never trust the client's container
 * list, re-validate against a fresh live read" discipline.
 *
 * STORAGE: two new, non-sheet-mirrored Mongo collections (same convention as
 * auth.service.js's _auth_sessions / apiKeys.service.js's _api_keys — this is
 * operational integration state, not spreadsheet data):
 *   _sales_os_company_links — existingLeadId -> resolved Deployed company
 *     name, so a repeat SSO open for the same lead skips straight to the
 *     (freshly re-fetched) container list instead of re-matching.
 *   _sales_os_renewals — the saved renewals themselves, source of truth.
 * Each saved renewal ALSO gets mirrored into the existing "Renewal Log"
 * sheet tab, one row per container, via expiry.service.js's existing
 * _logRenewal appender — reused as-is, not reimplemented.
 */
import { ObjectId } from 'mongodb';
import { getCollection } from './mongo.service.js';
import { findLeads, isSalesCrmConfigured } from '../config/salesCrmDb.js';
import { verifyJwt } from '../utils/jwtLite.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { safeStr, toNum } from '../utils/format.js';
import { normClientName } from '../utils/normalize.js';
import { _deployedRawValues, findHeaderCol, _logRenewal } from './expiry.service.js';
import { getCompanyContainers } from './renewalHandoff.service.js';
import { uploadToDrive } from './googleDrive.service.js';
import { empSsoLogin } from './auth.service.js';

const COMPANY_LINKS_COLLECTION = '_sales_os_company_links';
const RENEWALS_COLLECTION = '_sales_os_renewals';

const normCompany = (v) => safeStr(v).trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Verifies (or soft-accepts) the Sales OS deep link's params.
 *
 * SOFT LAUNCH: Sales OS's current deep link (already built, per the
 * integration spec) has no signature. If a `token` param IS present, it is
 * verified strictly against SALES_CRM_HANDOFF_SECRET (the same secret this
 * app already uses to SIGN the opposite-direction handoff — one shared
 * secret with this partner, not two) and a bad/expired signature is a hard
 * rejection. If absent, the plain query params are accepted as-is, loudly
 * logged, so the feature works today and Sales OS can start signing links
 * later with zero further change on this side. Every field is still
 * independently validated downstream regardless (employeeCode against USER,
 * companyName against Deployed) — this step only concerns whether the LINK
 * ITSELF was tamper-proof in transit.
 */
export function verifyInboundParams(query) {
  const token = safeStr(query?.token).trim();
  if (token) {
    if (!env.salesCrmHandoffSecret) {
      throw new AppError('Sales OS SSO is not fully configured on this server (SALES_CRM_HANDOFF_SECRET is unset) — cannot verify a signed link.', 503);
    }
    try {
      const payload = verifyJwt(token, env.salesCrmHandoffSecret);
      return { ...payload, _signed: true };
    } catch (e) {
      throw new AppError(`Invalid or expired SSO link (${e?.message || 'bad signature'}). Ask Sales OS to re-send it.`, 401);
    }
  }
  logger.warn('[SALES-OS-SSO] Unsigned deep link accepted (no "token" param) — ask Sales OS to sign with SALES_CRM_HANDOFF_SECRET when ready.');
  return {
    employeeCode: query?.employeeCode, existingLeadId: query?.existingLeadId, companyName: query?.companyName,
    clientName: query?.clientName, lm: query?.lm, grade: query?.grade, sector: query?.sector,
    successType: query?.successType, requestId: query?.requestId, _signed: false
  };
}

/** Every distinct Deployed "Customer Name", deduped case/space-insensitively
 *  (first-seen casing wins for display) — the candidate pool for matching a
 *  KAM companyName to a Lease company. There is no separate Company table in
 *  this codebase; the Deployed sheet's own customer names ARE the Lease
 *  company master. */
async function listDistinctDeployedCompanies() {
  const { values } = await _deployedRawValues();
  if (values.length < 2) return [];
  const headers = values[0];
  const custCol = findHeaderCol(headers, 'customer name', 'client name');
  if (custCol === -1) return [];
  const seen = new Map();
  for (const row of values.slice(1)) {
    const name = safeStr(row[custCol]).trim();
    if (!name) continue;
    const key = normCompany(name);
    if (!seen.has(key)) seen.set(key, name);
  }
  return [...seen.entries()].map(([key, name]) => ({ key, name }));
}

/**
 * Matches a KAM companyName to a Lease (Deployed sheet) company. Exact pass
 * first, then an UNAMBIGUOUS fuzzy pass via normClientName (utils/normalize.js)
 * — the same exact-then-unambiguous-fuzzy discipline salesCrmLeads.service.js
 * already uses for company joins with this same partner, deliberately not a
 * distance-scored fuzzy match: a wrong guess here would hand a salesperson
 * the wrong company's containers to renew.
 */
export async function resolveLeaseCompany(companyNameRaw) {
  const input = safeStr(companyNameRaw).trim();
  if (!input) return { status: 'none', candidates: [] };

  const companies = await listDistinctDeployedCompanies();
  const inputKey = normCompany(input);

  const exact = companies.find((c) => c.key === inputKey);
  if (exact) return { status: 'matched', companyName: exact.name, matchedVia: 'exact' };

  const inputFuzzy = normClientName(input);
  const fuzzyMatches = inputFuzzy ? companies.filter((c) => normClientName(c.name) === inputFuzzy) : [];
  if (fuzzyMatches.length === 1) return { status: 'matched', companyName: fuzzyMatches[0].name, matchedVia: 'fuzzy' };
  if (fuzzyMatches.length > 1) return { status: 'ambiguous', candidates: fuzzyMatches.map((c) => c.name) };
  return { status: 'none', candidates: [] };
}

/** Best-effort only: logs a warning if existingLeadId's own companyName (per
 *  the read-only Sales CRM cluster) disagrees with what the deep link said.
 *  Never blocks, never writes, degrades silently — same posture as every
 *  other caller of config/salesCrmDb.js. */
async function crossCheckExistingLead(existingLeadId, companyName) {
  if (!existingLeadId || !isSalesCrmConfigured()) return;
  let _id;
  try { _id = new ObjectId(String(existingLeadId)); } catch { return; }
  try {
    const [lead] = await findLeads({ _id }, { companyName: 1, assignedTo: 1 });
    if (lead?.companyName && normClientName(lead.companyName) !== normClientName(companyName)) {
      logger.warn(`[SALES-OS-SSO] existingLeadId ${existingLeadId}: Sales CRM has companyName "${lead.companyName}", deep link said "${companyName}".`);
    }
  } catch (e) {
    logger.warn(`[SALES-OS-SSO] Sales CRM cross-check failed (non-blocking): ${e?.message || e}`);
  }
}

async function saveCompanyLink(existingLeadId, companyNameRaw, resolvedCompanyName, matchedVia) {
  await getCollection(COMPANY_LINKS_COLLECTION).updateOne(
    { _id: String(existingLeadId) },
    { $set: { companyNameRaw: safeStr(companyNameRaw), resolvedCompanyName, matchedVia, matchedAt: new Date() } },
    { upsert: true }
  );
}

async function getCompanyLink(existingLeadId) {
  if (!existingLeadId) return null;
  return getCollection(COMPANY_LINKS_COLLECTION).findOne({ _id: String(existingLeadId) });
}

/**
 * Entry point for POST /api/sso/sales-os/session — the whole first hop:
 * verify the link, log the salesperson in by employeeCode alone, resolve (or
 * reuse a previously-confirmed) company match, and return that company's
 * live containers for the checklist step. One round trip so the frontend
 * can go straight from "opened the link" to "showing the checklist" for the
 * common (unambiguous) case.
 */
export async function startSalesOsSession(query) {
  const params = verifyInboundParams(query);

  const login = await empSsoLogin(params.employeeCode);
  if (!login.ok) throw new AppError(login.error || 'employee code not mapped', 401);

  const existingLeadId = safeStr(params.existingLeadId).trim();
  const companyNameRaw = safeStr(params.companyName || params.clientName).trim();
  if (!existingLeadId) throw new AppError('existingLeadId is required.', 400);
  if (!companyNameRaw) throw new AppError('companyName is required.', 400);

  crossCheckExistingLead(existingLeadId, companyNameRaw).catch(() => {});

  const existingLink = await getCompanyLink(existingLeadId);
  let companyMatch;
  if (existingLink?.resolvedCompanyName) {
    companyMatch = { status: 'matched', companyName: existingLink.resolvedCompanyName, matchedVia: existingLink.matchedVia || 'cached' };
  } else {
    companyMatch = await resolveLeaseCompany(companyNameRaw);
    if (companyMatch.status === 'matched') {
      await saveCompanyLink(existingLeadId, companyNameRaw, companyMatch.companyName, companyMatch.matchedVia);
    }
  }

  const containers = companyMatch.status === 'matched' ? await getCompanyContainers(companyMatch.companyName) : [];

  return {
    token: login.token,
    user: { empId: login.empId, name: login.name, email: login.email },
    context: {
      existingLeadId,
      companyNameRaw,
      clientName: safeStr(params.clientName || params.companyName).trim(),
      lm: safeStr(params.lm).trim(),
      grade: safeStr(params.grade).trim(),
      sector: safeStr(params.sector).trim(),
      successType: safeStr(params.successType || 'Renewal').trim(),
      requestId: safeStr(params.requestId).trim()
    },
    companyMatch,
    containers
  };
}

/** POST /api/sso/sales-os/confirm-company — the ambiguous-match picker's
 *  submit. `companyName` must be one of the candidates the session call
 *  returned; re-validated against the live Deployed company list here, never
 *  trusted at face value. */
export async function confirmCompany(existingLeadId, companyName) {
  const existingLeadIdStr = safeStr(existingLeadId).trim();
  const chosen = safeStr(companyName).trim();
  if (!existingLeadIdStr || !chosen) throw new AppError('existingLeadId and companyName are required.');

  const companies = await listDistinctDeployedCompanies();
  const match = companies.find((c) => c.key === normCompany(chosen));
  if (!match) throw new AppError(`"${chosen}" is not a known Lease company — pick one of the options shown.`);

  await saveCompanyLink(existingLeadIdStr, chosen, match.name, 'manual');
  const containers = await getCompanyContainers(match.name);
  return { companyMatch: { status: 'matched', companyName: match.name, matchedVia: 'manual' }, containers };
}

function buildContainerLine(input, validContainer) {
  const containerNo = safeStr(input.containerNo).trim();
  const fromDate = safeStr(input.fromDate).trim();
  const toDate = safeStr(input.toDate).trim();
  if (!fromDate || !toDate) throw new AppError(`${containerNo}: From Date and To Date are required.`);
  return {
    containerNo,
    product: validContainer.product || '',
    size: validContainer.size || '',
    location: validContainer.location || '',
    previousValidUpto: validContainer.validUpto || '',
    fromDate,
    toDate,
    monthlyRent: toNum(input.monthlyRent),
    totalValue: toNum(input.totalValue),
    remark: safeStr(input.remark).trim()
  };
}

/**
 * POST /api/sso/sales-os/renewal — the final save. Re-validates every
 * requested container against a FRESH getCompanyContainers() read (same
 * defensive pattern as renewalHandoff.service.js#createRenewalLink — never
 * trust the client's container list), persists the renewal, and mirrors one
 * Renewal Log sheet row per container via expiry.service.js's existing,
 * already-correct _logRenewal appender.
 */
export async function saveRenewal(user, body) {
  const existingLeadId = safeStr(body.existingLeadId).trim();
  if (!existingLeadId) throw new AppError('existingLeadId is required.');

  const link = await getCompanyLink(existingLeadId);
  if (!link?.resolvedCompanyName) {
    throw new AppError('No confirmed Lease company for this lead yet — resolve the company match first.');
  }

  const requestedLines = Array.isArray(body.containers) ? body.containers : [];
  if (!requestedLines.length) throw new AppError('Select at least one container.');

  const validContainers = await getCompanyContainers(link.resolvedCompanyName);
  const validByNo = new Map(validContainers.map((c) => [c.containerNo, c]));

  const lines = requestedLines.map((raw) => {
    const containerNo = safeStr(raw.containerNo).trim();
    const valid = validByNo.get(containerNo);
    if (!valid) throw new AppError(`"${containerNo}" is not currently a live container for "${link.resolvedCompanyName}" — refresh and try again.`);
    return buildContainerLine(raw, valid);
  });

  let signedAddendumUrl = '';
  if (body.addendum?.base64Data) {
    signedAddendumUrl = await uploadToDrive(body.addendum.base64Data, body.addendum.mimeType, body.addendum.fileName || `renewal-addendum-${Date.now()}`);
  }

  const totalValue = lines.reduce((sum, l) => sum + (l.totalValue || 0), 0);
  const doc = {
    existingLeadId,
    leaseCompanyName: link.resolvedCompanyName,
    companyNameRaw: link.companyNameRaw || '',
    clientName: safeStr(body.clientName || link.resolvedCompanyName).trim(),
    successType: safeStr(body.successType || 'Renewal').trim(),
    lm: safeStr(body.lm).trim(),
    employeeCode: safeStr(body.employeeCode || user.empId).trim(),
    empId: user.empId,
    empEmail: user.email,
    empName: user.name,
    containers: lines,
    totalValue,
    signedAddendumUrl: signedAddendumUrl || null,
    requestId: safeStr(body.requestId).trim() || null,
    createdAt: new Date(),
    createdBy: user.email
  };

  const { insertedId } = await getCollection(RENEWALS_COLLECTION).insertOne(doc);

  for (const line of lines) {
    await _logRenewal({
      container: line.containerNo,
      clientName: doc.clientName,
      poNo: '', poFileUrl: '', agreementUrl: doc.signedAddendumUrl || '',
      oldPoNo: '', oldPoFileUrl: '', oldAgreementUrl: '',
      validTill: line.toDate, userEmail: user.email, source: 'Sales OS Renewal'
    });
  }

  return { id: String(insertedId), ...doc };
}

/**
 * GET /api/public/v1/sales-os/renewals — the read-back for Sales OS
 * (routes/public.routes.js, gated by an X-Api-Key with the "salesos" read
 * scope — see apiKeys.service.js). `leaseCompanyId` is the Lease company's
 * display name string: this codebase has no separate company-id table, so
 * that name IS the id.
 */
export async function listRenewalsForSalesOs(query) {
  const filter = {};
  if (query.existingLeadId) filter.existingLeadId = safeStr(query.existingLeadId).trim();
  if (query.employeeCode) filter.employeeCode = safeStr(query.employeeCode).trim();
  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(query.from);
    if (query.to) filter.createdAt.$lte = new Date(query.to);
  }

  const docs = await getCollection(RENEWALS_COLLECTION).find(filter).sort({ createdAt: -1 }).limit(500).toArray();
  return docs.map((d) => ({
    id: String(d._id),
    existingLeadId: d.existingLeadId,
    leaseCompanyId: d.leaseCompanyName,
    companyName: d.leaseCompanyName,
    clientName: d.clientName,
    successType: d.successType,
    lm: d.lm,
    employeeCode: d.employeeCode,
    containers: d.containers,
    totalValue: d.totalValue,
    createdAt: d.createdAt,
    signedAddendumUrl: d.signedAddendumUrl || null
  }));
}
