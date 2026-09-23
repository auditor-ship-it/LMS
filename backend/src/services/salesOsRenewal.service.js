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
 * SAVING A RENEWAL DOES NOT INVENT A NEW WRITE PATH. `saveRenewal` below
 * calls the SAME two backend functions the in-app "Renew & Document" flow
 * calls when a human does this manually — expiry.service.js's
 * `saveExpiryAction` (Lease Expiry's own "Renew" button: moves a container
 * to "Documents Pending") followed by `completeDocStage` (the "Update
 * Agreement" form's own submit handler: writes Renewed Date/Valid
 * Till/Agreement/PO/Billing Cycle, updates Valid Upto, clears status, and
 * appends to the Renewal Log sheet). Both already exist, are already
 * correct, and are reused verbatim — see this file's own saveRenewal doc
 * comment for why the NON-fast (synchronous, live-Sheets) versions are used
 * here specifically, not the Mongo-first "Fast" variants the internal UI
 * calls.
 *
 * STORAGE: two new, non-sheet-mirrored Mongo collections (same convention as
 * auth.service.js's _auth_sessions / apiKeys.service.js's _api_keys — this is
 * operational integration state, not spreadsheet data):
 *   _sales_os_company_links — existingLeadId -> resolved Deployed company
 *     name, so a repeat SSO open for the same lead skips straight to the
 *     (freshly re-fetched) container list instead of re-matching.
 *   _sales_os_renewals — an AUDIT RECEIPT of what was written to the real
 *     sheet via the calls above, written only after they succeed. This is
 *     what GET /api/public/v1/sales-os/renewals reads back for Sales OS —
 *     it is a record of the write, not the write itself.
 */
import { ObjectId } from 'mongodb';
import { getCollection } from './mongo.service.js';
import { findLeads, isSalesCrmConfigured } from '../config/salesCrmDb.js';
import { verifyJwt } from '../utils/jwtLite.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { safeStr } from '../utils/format.js';
import { normClientName } from '../utils/normalize.js';
import { _deployedRawValues, findHeaderCol, saveExpiryAction, completeDocStage } from './expiry.service.js';
import { getCompanyContainers } from './renewalHandoff.service.js';
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

/**
 * GET /api/public/v1/sales-os/company-match — lets Sales OS's own backend
 * pre-compute, for each Existing Lead in its KAM list, whether a "Lease"
 * section should show for it, WITHOUT opening the SSO flow. Same matcher as
 * the SSO session hop (resolveLeaseCompany), just exposed read-only over the
 * public API. `companyNames` is a comma-separated list so a whole KAM page
 * can be checked in one call instead of one round trip per lead.
 */
export async function matchCompanies(companyNamesRaw) {
  const names = String(companyNamesRaw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const name of names) {
    const m = await resolveLeaseCompany(name);
    out.push({ companyName: name, status: m.status, resolvedCompanyName: m.companyName || null, candidates: m.candidates || [] });
  }
  return out;
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

/**
 * Runs ONE container through the exact same sequence a human does manually:
 * Lease Expiry's "Renew" button (saveExpiryAction(..., 'Documents Pending',
 * ...)) IF it isn't already in that state, then Renew & Document's "Update
 * Agreement" form (completeDocStage(...)) — always. Both are called
 * SYNCHRONOUSLY against live Google Sheets (not the "Fast" Mongo-first
 * variants the internal routes use) deliberately: completeDocStage does its
 * own live Sheets read, and if saveExpiryAction had taken the Fast/outbox
 * path, that read could still see the OLD status for several seconds
 * (env.outboxPollMs) and fail with INVALID_STATE even though the transition
 * "already happened." Calling the plain versions back-to-back means the
 * second call is guaranteed to see the first call's write.
 *
 * Two real entry states reach this, and both are legitimate: a container
 * fresh off Lease Expiry's pending list (needs BOTH steps — the common case,
 * initiating a renewal straight from Sales OS with nothing done in Lease
 * yet), or one an ops user already clicked "Renew" on and is sitting in
 * Documents Pending waiting for exactly this paperwork (needs only the
 * second step — skipping straight to saveExpiryAction here would wrongly
 * return ALREADY_PROCESSED, since Update/column V is already stamped).
 * Anything else (mid some OTHER workflow state) is refused rather than
 * guessed at.
 *
 * `valid` is this container's entry from a FRESH getCompanyContainers() read
 * (never the caller's own claim) — supplies `rowNum` so both calls address
 * the exact Deployed row, same safety rule as every other write path in this
 * codebase (a container number alone is not unique across lease cycles).
 */
async function renewOneContainer(user, valid, form) {
  const containerNo = valid.containerNo;
  if (!form.renewedDate) throw new AppError(`${containerNo}: Renewed Date is required.`);
  if (!form.validTill) throw new AppError(`${containerNo}: Agreement Valid Till is required.`);

  const currentStatus = safeStr(valid.status).trim().toLowerCase();
  if (currentStatus === '') {
    const nowIso = new Date().toISOString();
    const moveResult = await saveExpiryAction(containerNo, nowIso, 'Documents Pending', user.email, valid.rowNum);
    if (moveResult === 'ALREADY_PROCESSED') {
      throw new AppError(`"${containerNo}" already has an action pending in Lease — refresh and try again.`);
    }
  } else if (currentStatus !== 'documents pending') {
    throw new AppError(`"${containerNo}" is currently "${valid.status}" in Lease, not ready for a renewal — ask Lease ops to check it.`);
  }
  // else: already "Documents Pending" — the Renew step already happened
  // (in-app or on an earlier attempt through this same flow), go straight
  // to completeDocStage below.

  const docResult = await completeDocStage(
    containerNo,
    form.renewedDate,
    form.validTill,
    form.signedCopyUrl || '',
    form.remarks || '',
    user.email,
    form.poNo || '',
    form.poFileUrl || '',
    form.billingCycle || '',
    user.email,
    form.poValidity || '',
    valid.rowNum
  );
  if (docResult === 'INVALID_STATE') {
    throw new AppError(`"${containerNo}" could not be completed — its status changed unexpectedly. Refresh and try again.`);
  }

  return {
    containerNo,
    renewedDate: form.renewedDate,
    validTill: form.validTill,
    signedCopyUrl: form.signedCopyUrl || '',
    poNo: form.poNo || '',
    poFileUrl: form.poFileUrl || '',
    billingCycle: form.billingCycle || '',
    poValidity: form.poValidity || '',
    remarks: form.remarks || ''
  };
}

/**
 * POST /api/sso/sales-os/renewal — the final save. `body.containers` is
 * EITHER one form per container ({containerNo, renewedDate, validTill, ...})
 * OR (bulk — the "one form applied to every selected container" mode the
 * real Update Agreement modal already supports) an array of container
 * numbers plus a single shared `form` object; both shapes are normalized to
 * one call per container below. Every container is re-validated against a
 * FRESH getCompanyContainers() read first — same defensive pattern as
 * renewalHandoff.service.js#createRenewalLink, never trust the client's
 * list. NOTE: this runs the SAME 'renew'/'expiry'-gated internal actions a
 * logged-in ops user would — the SSO'd salesperson's own LMS identity
 * (resolved by employeeCode) needs both permissions granted in Roles &
 * Access, or this throws ACCESS_DENIED exactly as it would in-app.
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

  const results = [];
  for (const raw of requestedLines) {
    const containerNo = safeStr(raw.containerNo).trim();
    const valid = validByNo.get(containerNo);
    if (!valid) throw new AppError(`"${containerNo}" is not currently a live container for "${link.resolvedCompanyName}" — refresh and try again.`);
    results.push(await renewOneContainer(user, valid, raw));
  }

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
    containers: results,
    requestId: safeStr(body.requestId).trim() || null,
    createdAt: new Date(),
    createdBy: user.email
  };

  const { insertedId } = await getCollection(RENEWALS_COLLECTION).insertOne(doc);
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
    // Each entry mirrors exactly what completeDocStage wrote to the Deployed
    // sheet for that container — see renewOneContainer above.
    containers: d.containers,
    createdAt: d.createdAt
  }));
}
