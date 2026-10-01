/**
 * REFUNDS (OFF-LEASE BILLS) — explicit request 2026-09-30.
 *
 * A vendor-bill submission form, in its own sheet ("Offlease Bills " —
 * trailing space is real, see sheets.config.js). Submission itself follows
 * this codebase's other append-only logs (offleaseRemarks/offleaseMoveHistory/
 * stage9): write straight to Sheets, then appendMongoMirrorRow patches the
 * Mongo mirror instantly. Unlike those pure logs, a submitted row is no
 * longer untouched afterward — the sequential HOD -> CEO -> Accounts
 * approval workflow below (explicit request, same day) updates that SAME
 * row's own approval columns in place as each stage decides, the same
 * row-by-position ("row_N") pattern expiry.service.js's decideRenewalApproval
 * already uses for the Renew & Document approval workflow.
 *
 * Timestamp and the submitting user's email are captured server-side, not
 * taken from the request body — the "User" field on the form is a free-text
 * name (who the bill is being raised for/by), a separate thing from the
 * authenticated caller recorded here for audit.
 */
import { appendRow, insertSheetIfMissing, batchUpdateValues, getSheetData, updateRange, colLetter, ensureColumnCount } from './googleSheets.service.js';
import { getSheetDataFromMongo, appendMongoMirrorRow, patchMongoMirrorRow } from './mongoSheetData.service.js';
import { SHEETS } from '../config/sheets.config.js';
import { safeStr } from '../utils/format.js';
import { AppError, notFound, accessDenied } from '../utils/AppError.js';
import { withSheetLock } from '../utils/sheetMutex.js';
import { checkActionPermission } from './permissions.service.js';
import { sendMail } from './email.service.js';
import { signJwt, verifyJwt } from '../utils/jwtLite.js';
import { env } from '../config/env.js';

const REFUNDS_SHEET = SHEETS.REFUNDS;

/* Every stage notifies the SAME placeholder inbox for now — explicit
 * instruction 2026-09-30 ("same ceo and accounts emails send mails same
 * emails id support@crystalgroup.in"): real, distinct HOD/CEO/Accounts
 * mailboxes aren't set up yet, so all three stages' notifications go here
 * until that changes. */
const APPROVAL_NOTIFY_EMAIL = 'support@crystalgroup.in';

/* Exact header sequence/names given 2026-09-30 for columns 0-21 — matches
 * an external reference sheet the user is aligning this to. The approval
 * columns (22-33) are appended after, unaffected by this reordering. */
export const REFUNDS_HEADERS = [
  'Timestamp', 'Submitted By Email', 'User', 'Invoice Number', 'Invoice Date',
  'Bill received by User', 'Name of Vendor', 'Full Amount', 'Amount to Payment',
  'Payment Due Date', 'Payment Type', 'Payment Terms', 'Invoice with Supporting/Statement',
  'PI', 'Department', 'Ledger Head',
  'SD Amount to be Refunded', 'SD Calculation', 'Cancelled Cheque',
  'Client Email Confirmation', 'Client Ledger', 'Attachments Link',
  'HOD Approval Status', 'HOD Approval Remarks', 'HOD Approval Date', 'HOD Approver Email',
  'CEO Approval Status', 'CEO Approval Remarks', 'CEO Approval Date', 'CEO Approver Email',
  'Accounts Approval Status', 'Accounts Approval Remarks', 'Accounts Approval Date', 'Accounts Approver Email',
  /* Added 2026-10-01, explicit request — a no-login review link, written
   * directly into the sheet (and emailed) the moment each stage becomes
   * actionable, matching the reference "Bill & Compliance Portal" the user
   * pointed at. See mintRefundReviewLink/decideRefundApprovalViaLink below. */
  'HOD Review Link', 'CEO Review Link', 'Accounts Review Link'
];

/* Sequential stage order: hod -> ceo -> accounts. `next` is the stage whose
 * Status gets set to 'Pending' the moment this one is Approved — that's what
 * makes the NEXT stage actionable; nothing else in this file threads that
 * state through, it all falls out of "read whichever stage's Status is
 * currently 'Pending'". */
const STAGES = {
  hod: { label: 'HOD', permission: 'refundsApprovalHod', statusCol: 22, remarksCol: 23, dateCol: 24, approverCol: 25, reviewLinkCol: 34, next: 'ceo' },
  ceo: { label: 'CEO', permission: 'refundsApprovalCeo', statusCol: 26, remarksCol: 27, dateCol: 28, approverCol: 29, reviewLinkCol: 35, next: 'accounts' },
  accounts: { label: 'Accounts', permission: 'refundsApprovalAccounts', statusCol: 30, remarksCol: 31, dateCol: 32, approverCol: 33, reviewLinkCol: 36, next: null }
};

/** Widens the live sheet's header row to match REFUNDS_HEADERS whenever the
 *  array grows past what's already there — BUG FOUND AND FIXED 2026-09-30
 *  (Team Accounts hit this exact "exceeds grid limits" failure earlier the
 *  same day; see roles.service.js's _ensureTeamHeaderWidth for the full
 *  story) taught that the values API cannot write outside a sheet's actual
 *  grid dimensions, so ensureColumnCount must run before writing new header
 *  cells, not just when the new columns happen to already exist. Runs once
 *  per process (cheap no-op after that, matching ensureRolesSeeded's own
 *  `seeded` flag pattern), called from both write paths below. */
let refundsHeaderChecked = false;
async function _ensureRefundsHeaderWidth() {
  if (refundsHeaderChecked) return;
  refundsHeaderChecked = true;
  const { headers } = await getSheetData(REFUNDS_SHEET).catch(() => ({ headers: [] }));
  if (!headers.length) return; // sheet doesn't exist yet — insertSheetIfMissing (on first append) handles that case
  if (headers.length >= REFUNDS_HEADERS.length) return;
  const startCol = headers.length;
  const missing = REFUNDS_HEADERS.slice(startCol);
  await ensureColumnCount(REFUNDS_SHEET, REFUNDS_HEADERS.length);
  await updateRange(REFUNDS_SHEET, `${colLetter(startCol)}1:${colLetter(REFUNDS_HEADERS.length - 1)}1`, [missing]);
}

/* No-login review links — explicit request 2026-10-01 ("without any login
 * the link should be there"), matching the reference Bill & Compliance
 * Portal's own HOD/CEO/Accounts Review Link columns. Same signed-token
 * mechanism as the Sales CRM handoff (utils/jwtLite.js), own dedicated
 * secret (env.refundReviewSecret) — see env.js's own comment for why a
 * shared secret would be wrong here. Returns null (not a broken link) when
 * the secret isn't configured, so callers can fall back to the old
 * session-required page instead of emailing/writing an unusable URL. */
const REFUND_REVIEW_BASE_URL = 'https://lease.crystalgrp.xyz/refund-review';
// 60 days, not the Sales CRM handoff's short-lived few minutes — these links
// sit in a sheet cell and an inbox indefinitely until someone actually acts
// on them, which can plausibly take weeks for a slow-moving approval.
const REFUND_REVIEW_TOKEN_TTL_SECS = 60 * 60 * 24 * 60;

function _mintRefundReviewLink(rowNum, stage) {
  if (!env.refundReviewSecret) return null;
  const token = signJwt({ rowNum, stage }, env.refundReviewSecret, REFUND_REVIEW_TOKEN_TTL_SECS);
  return `${REFUND_REVIEW_BASE_URL}?rowNum=${rowNum}&stage=${stage}&token=${encodeURIComponent(token)}`;
}

/** Throws if `token` doesn't verify, is expired, or doesn't match this exact
 *  rowNum+stage pair (a HOD link can't be replayed against the CEO stage, or
 *  against a different row, even if somehow still validly signed). */
function _verifyRefundReviewToken(token, rowNum, stage) {
  if (!env.refundReviewSecret) throw accessDenied('Review links are not enabled on this server.');
  let payload;
  try {
    payload = verifyJwt(token, env.refundReviewSecret);
  } catch (e) {
    throw accessDenied('This review link is invalid or has expired.');
  }
  if (Number(payload.rowNum) !== Number(rowNum) || payload.stage !== stage) {
    throw accessDenied('This review link does not match the requested entry.');
  }
}

const isMissingSheet = (e) => String(e?.message || '').includes('Unable to parse range');

const pad2 = (n) => String(n).padStart(2, '0');
const dmyTime = (d) => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

function _mapRow(r, rowNum) {
  const hodStatus = safeStr(r[STAGES.hod.statusCol]);
  const ceoStatus = safeStr(r[STAGES.ceo.statusCol]);
  const accountsStatus = safeStr(r[STAGES.accounts.statusCol]);

  /* Which stage (if any) is actionable right now — the frontend uses this to
   * decide whose Approve/Reject buttons to show on a given row, alongside
   * its own canAct(STAGES[stage].permission) check. */
  let currentStage = 'done';
  if (hodStatus === 'Rejected' || ceoStatus === 'Rejected' || accountsStatus === 'Rejected') currentStage = 'rejected';
  else if (hodStatus !== 'Approved') currentStage = 'hod';
  else if (ceoStatus !== 'Approved') currentStage = 'ceo';
  else if (accountsStatus !== 'Approved') currentStage = 'accounts';

  return {
    _rowNum: rowNum,
    timestamp: safeStr(r[0]),
    userEmail: safeStr(r[1]),
    user: safeStr(r[2]),
    invoiceNumber: safeStr(r[3]),
    invoiceDate: safeStr(r[4]),
    billReceivedBy: safeStr(r[5]),
    vendorName: safeStr(r[6]),
    invoiceAmount: safeStr(r[7]),
    amountToPay: safeStr(r[8]),
    paymentDueDate: safeStr(r[9]),
    paymentType: safeStr(r[10]),
    paymentTerms: safeStr(r[11]),
    invoiceFileUrl: safeStr(r[12]),
    piFileUrl: safeStr(r[13]),
    department: safeStr(r[14]),
    ledgerHead: safeStr(r[15]),
    sdAmountToBeRefunded: safeStr(r[16]),
    sdCalculation: safeStr(r[17]),
    cancelledChequeUrl: safeStr(r[18]),
    clientEmailConfirmationUrl: safeStr(r[19]),
    clientLedgerUrl: safeStr(r[20]),
    attachmentsUrl: safeStr(r[21]),
    currentStage,
    hodStatus, hodRemarks: safeStr(r[STAGES.hod.remarksCol]), hodDate: safeStr(r[STAGES.hod.dateCol]), hodApprover: safeStr(r[STAGES.hod.approverCol]), hodReviewLink: safeStr(r[STAGES.hod.reviewLinkCol]),
    ceoStatus, ceoRemarks: safeStr(r[STAGES.ceo.remarksCol]), ceoDate: safeStr(r[STAGES.ceo.dateCol]), ceoApprover: safeStr(r[STAGES.ceo.approverCol]), ceoReviewLink: safeStr(r[STAGES.ceo.reviewLinkCol]),
    accountsStatus, accountsRemarks: safeStr(r[STAGES.accounts.remarksCol]), accountsDate: safeStr(r[STAGES.accounts.dateCol]), accountsApprover: safeStr(r[STAGES.accounts.approverCol]), accountsReviewLink: safeStr(r[STAGES.accounts.reviewLinkCol])
  };
}

/** Read access is broader than submit access — an HOD/CEO/Accounts approver
 *  clicking their email's deep link needs to see this list (and their own
 *  pending entry) without necessarily holding the base 'refunds' (submit)
 *  permission at all. Fails closed if the caller holds none of the four.
 *
 *  `email === null` means the public API (routes/public.routes.js's reuse()),
 *  not an unauthenticated LMS session — a request only reaches here at all
 *  once requirePublicApiKey has already confirmed the caller's key carries
 *  the 'refunds' domain scope, so this mirrors every other public-API read
 *  (leases, offlease, ...) in treating a null caller as "already authorized,
 *  show the unfiltered data" rather than re-running the internal per-email
 *  permission check against a caller that was never an LMS user to begin with. */
async function _assertCanViewRefunds(email) {
  if (email === null) return;
  const grants = await Promise.all([
    checkActionPermission('refunds', email).then(() => true, () => false),
    checkActionPermission('refundsApprovalHod', email).then(() => true, () => false),
    checkActionPermission('refundsApprovalCeo', email).then(() => true, () => false),
    checkActionPermission('refundsApprovalAccounts', email).then(() => true, () => false)
  ]);
  if (!grants.some(Boolean)) await checkActionPermission('refunds', email); // throws accessDenied
}

/** Every bill ever submitted, newest first. Mongo-mirror-backed, never live
 *  Sheets. `_rowNum` (the live sheet row, derived from the mirror's own
 *  position-keyed `row_N`) is what decideRefundApproval below re-targets and
 *  re-validates against a fresh live read before writing — same "Mongo for
 *  display, live re-read before a write" split this codebase uses
 *  everywhere else a row-accurate action follows a list read. */
export async function getRefundEntries(userEmail) {
  await _assertCanViewRefunds(userEmail);
  const { rows } = await getSheetDataFromMongo(REFUNDS_SHEET);
  return rows
    .map((r, i) => _mapRow(r, i + 2))
    .filter((r) => r.invoiceNumber || r.vendorName)
    .reverse();
}

export async function addRefundEntry(payload, userEmail) {
  await checkActionPermission('refunds', userEmail);

  const user = safeStr(payload.user).trim();
  const invoiceNumber = safeStr(payload.invoiceNumber).trim();
  const vendorName = safeStr(payload.vendorName).trim();
  const invoiceAmount = safeStr(payload.invoiceAmount).trim();
  const amountToPay = safeStr(payload.amountToPay).trim();
  const department = safeStr(payload.department).trim();

  if (!user) throw new AppError('User is required');
  if (!invoiceNumber) throw new AppError('Invoice Number is required');
  if (!vendorName) throw new AppError('Vendor Name is required');
  if (!invoiceAmount) throw new AppError('Invoice Amount is required');
  if (!amountToPay) throw new AppError('Amount to Pay is required');
  if (!department) throw new AppError('Department is required');

  const row = [
    dmyTime(new Date()),
    userEmail || '',
    user,
    invoiceNumber,
    safeStr(payload.invoiceDate).trim(),
    safeStr(payload.billReceivedBy).trim(),
    vendorName,
    invoiceAmount,
    amountToPay,
    safeStr(payload.paymentDueDate).trim(),
    safeStr(payload.paymentType).trim(),
    safeStr(payload.paymentTerms).trim(),
    safeStr(payload.invoiceFileUrl).trim(),
    safeStr(payload.piFileUrl).trim(),
    department,
    safeStr(payload.ledgerHead).trim(),
    safeStr(payload.sdAmountToBeRefunded).trim(),
    safeStr(payload.sdCalculation).trim(),
    safeStr(payload.cancelledChequeUrl).trim(),
    safeStr(payload.clientEmailConfirmationUrl).trim(),
    safeStr(payload.clientLedgerUrl).trim(),
    safeStr(payload.attachmentsUrl).trim(),
    // Approval columns — HOD starts 'Pending' the moment this is submitted;
    // CEO/Accounts stay blank until HOD approves.
    'Pending', '', '', '',
    '', '', '', '',
    '', '', '', '',
    // Review Link columns (HOD/CEO/Accounts) — filled in below once rowNum
    // is known; appendRow needs the row number before a link can be minted.
    '', '', ''
  ];

  await _ensureRefundsHeaderWidth();

  return withSheetLock(REFUNDS_SHEET, async () => {
    /* Append first, create only on failure — same reasoning as every other
       append-only log in this codebase: creating eagerly costs a full
       spreadsheets.get per save. */
    let rowNum;
    try {
      ({ rowNum } = await appendRow(REFUNDS_SHEET, row));
    } catch (e) {
      if (!isMissingSheet(e)) throw e;
      await insertSheetIfMissing(REFUNDS_SHEET, REFUNDS_HEADERS);
      ({ rowNum } = await appendRow(REFUNDS_SHEET, row));
    }

    // Mint + write the HOD review link now that the row number is known —
    // explicit request 2026-10-01 ("without any login the link should be
    // there"), written directly into the sheet, not just emailed.
    const hodLink = _mintRefundReviewLink(rowNum, 'hod');
    if (hodLink) {
      await updateRange(REFUNDS_SHEET, `${colLetter(STAGES.hod.reviewLinkCol)}${rowNum}:${colLetter(STAGES.hod.reviewLinkCol)}${rowNum}`, [[hodLink]]);
      row[STAGES.hod.reviewLinkCol] = hodLink;
    }

    await appendMongoMirrorRow(REFUNDS_SHEET, row);

    try {
      await _sendRefundStageEmail('pending', 'hod', row, rowNum);
    } catch (e) { console.error('[REFUND-APPROVAL-EMAIL]', e.message); }

    return { message: 'SAVED', entry: _mapRow(row, rowNum ?? null) };
  });
}

/**
 * Pushpa-approval-style sequential decision — explicit request 2026-09-30.
 * `stage` is 'hod' | 'ceo' | 'accounts', fixed by which stage's own
 * Approve/Reject button the caller clicked (RefundsPage.jsx), not chosen
 * here. Guarded on that stage's own Status column actually being 'Pending' —
 * the same INVALID_STATE convention decideRenewalApproval uses — so a stale
 * page (already decided by someone else, or not yet this stage's turn)
 * can't silently double-apply or jump the sequence.
 *
 * Live re-read, not the Mongo mirror — this is the write path; see
 * getRefundEntries' own doc comment for why the split exists.
 *
 * `opts.skipPermissionCheck` — set only by decideRefundApprovalViaLink below,
 * for a no-login review-link decision: the signed token (already verified by
 * the caller) IS the authorization there, standing in for a real LMS
 * permission check that has no email to check against. `callerEmail` is
 * still written into the Approver Email column either way — the link path
 * just passes a descriptive label ("HOD (via review link)") instead of a
 * real address.
 */
export async function decideRefundApproval(rowNum, stage, decision, remarks, callerEmail, opts = {}) {
  const cfg = STAGES[stage];
  if (!cfg) throw new AppError(`stage must be one of: ${Object.keys(STAGES).join(', ')}`);
  if (decision !== 'approved' && decision !== 'rejected') throw new AppError('decision must be "approved" or "rejected"');
  if (!opts.skipPermissionCheck) await checkActionPermission(cfg.permission, callerEmail);
  await _ensureRefundsHeaderWidth();

  return withSheetLock(REFUNDS_SHEET, async () => {
    const { rows } = await getSheetData(REFUNDS_SHEET);
    const row = rows[rowNum - 2];
    if (!row) throw notFound(`Refund entry row ${rowNum} not found`);
    if (safeStr(row[cfg.statusCol]) !== 'Pending') return 'INVALID_STATE';

    const stamp = dmyTime(new Date());
    const status = decision === 'approved' ? 'Approved' : 'Rejected';
    const updates = [
      { range: `'${REFUNDS_SHEET}'!${colLetter(cfg.statusCol)}${rowNum}`, values: [[status]] },
      { range: `'${REFUNDS_SHEET}'!${colLetter(cfg.remarksCol)}${rowNum}`, values: [[remarks || '']] },
      { range: `'${REFUNDS_SHEET}'!${colLetter(cfg.dateCol)}${rowNum}`, values: [[stamp]] },
      { range: `'${REFUNDS_SHEET}'!${colLetter(cfg.approverCol)}${rowNum}`, values: [[callerEmail || '']] }
    ];
    // Approving hands it to the next stage by marking THAT stage 'Pending' —
    // this is the only place that ever happens, so "which stage is
    // actionable" always falls out of reading the Status columns themselves.
    if (decision === 'approved' && cfg.next) {
      updates.push({ range: `'${REFUNDS_SHEET}'!${colLetter(STAGES[cfg.next].statusCol)}${rowNum}`, values: [['Pending']] });
    }

    await batchUpdateValues(updates);
    await patchMongoMirrorRow(REFUNDS_SHEET, rowNum, updates);

    // Overlay what was just written onto the pre-write row read above, so the
    // notification email reflects the just-applied decision, not the stale
    // snapshot — same overlay technique offlease.service.js's stage-1
    // notification block and expiry.service.js use for the same reason.
    const updatedRow = row.slice();
    updatedRow[cfg.statusCol] = status;
    updatedRow[cfg.remarksCol] = remarks || '';
    updatedRow[cfg.dateCol] = stamp;
    updatedRow[cfg.approverCol] = callerEmail || '';
    if (decision === 'approved' && cfg.next) updatedRow[STAGES[cfg.next].statusCol] = 'Pending';

    try {
      if (decision === 'rejected') {
        await _sendRefundStageEmail('rejected', stage, updatedRow, rowNum, { remarks });
      } else if (cfg.next) {
        await _sendRefundStageEmail('pending', cfg.next, updatedRow, rowNum);
      } else {
        await _sendRefundStageEmail('completed', stage, updatedRow, rowNum);
      }
    } catch (e) { console.error('[REFUND-APPROVAL-EMAIL]', e.message); }

    return 'OK';
  });
}

// Points at the dedicated approval page (RefundsApprovalPage.jsx), not the
// plain Refunds submission page — explicit request 2026-09-30 ("refund
// approval new tab and show navigation"), same "separate approval page"
// split as Renew & Document / Renew Approval Pending.
const REFUND_EMAIL_APP_URL = 'https://lease.crystalgrp.xyz/refunds-approval';

/** Colored pill matching the "Level/Status/Timestamp/Comment" Approval
 *  Status table the user asked to match — explicit request 2026-09-30
 *  ("show approval status, show all data"). */
function _approvalStatusPill(status) {
  const s = (status || '').trim();
  if (s === 'Approved') return '<span style="display:inline-block;padding:3px 10px;border-radius:12px;background:#dcfce7;color:#16a34a;font-weight:bold;font-size:12px;">&#9989; Approved</span>';
  if (s === 'Rejected') return '<span style="display:inline-block;padding:3px 10px;border-radius:12px;background:#fee2e2;color:#dc2626;font-weight:bold;font-size:12px;">&#10060; Rejected</span>';
  if (s === 'Pending') return '<span style="display:inline-block;padding:3px 10px;border-radius:12px;background:#fef3c7;color:#b45309;font-weight:bold;font-size:12px;">&#9203; Pending</span>';
  return '<span style="display:inline-block;padding:3px 10px;border-radius:12px;background:#f1f5f9;color:#64748b;font-weight:bold;font-size:12px;">&mdash;</span>';
}

/** One shared sender for all three "pending your approval" emails plus the
 *  rejection and final-completion notices — same vertical-table HTML
 *  convention as expiry.service.js's _sendRenewalApprovalRequestEmail /
 *  _sendRenewalRejectionEmail, PLUS an "Approval Status" table (Level/
 *  Status/Timestamp/Comment per stage) matching the reference design given
 *  2026-09-30. Shows every field on the bill, not a subset — same request.
 *  Every recipient is APPROVAL_NOTIFY_EMAIL for now (see that constant's own
 *  comment). */
async function _sendRefundStageEmail(kind, stage, row, rowNum, extra = {}) {
  const entry = _mapRow(row, null);
  const stageLabel = STAGES[stage]?.label || stage;
  /* Deep link straight to this entry's review view, pre-selected to the
   * stage that actually needs to act — explicit request 2026-09-30 ("click
   * the link then... open only all data and remarks and approval and
   * reject"). Only meaningful for 'pending' (an action is actually waiting);
   * rejected/completed link to the plain page, nothing left to decide. */
  const actionUrl = kind === 'pending' && rowNum
    ? `${REFUND_EMAIL_APP_URL}?rowNum=${rowNum}&stage=${stage}`
    : REFUND_EMAIL_APP_URL;
  const fields = [
    ['User', entry.user],
    ['Invoice Number', entry.invoiceNumber],
    ['Invoice Date', entry.invoiceDate || '-'],
    ['Bill Received By', entry.billReceivedBy || '-'],
    ['Vendor Name', entry.vendorName],
    ['Invoice Amount', entry.invoiceAmount],
    ['Amount to Pay', entry.amountToPay],
    ['Payment Due Date', entry.paymentDueDate || '-'],
    ['Payment Type', entry.paymentType || '-'],
    ['Payment Terms', entry.paymentTerms || '-'],
    ['Invoice File', entry.invoiceFileUrl || '-'],
    ['PI', entry.piFileUrl || '-'],
    ['Department', entry.department],
    ['Ledger Head', entry.ledgerHead || '-'],
    ['SD Amount to be Refunded', entry.sdAmountToBeRefunded || '-'],
    ['SD Calculation', entry.sdCalculation || '-'],
    ['Cancelled Cheque', entry.cancelledChequeUrl || '-'],
    ['Client Email Confirmation', entry.clientEmailConfirmationUrl || '-'],
    ['Client Ledger', entry.clientLedgerUrl || '-'],
    ['Attachments', entry.attachmentsUrl || '-'],
    ['Submitted By', entry.userEmail]
  ];

  const approvalRows = [
    ['HOD', entry.hodStatus, entry.hodDate, entry.hodRemarks],
    ['CEO', entry.ceoStatus, entry.ceoDate, entry.ceoRemarks],
    ['Accounts', entry.accountsStatus, entry.accountsDate, entry.accountsRemarks]
  ];

  let subject, intro;
  if (kind === 'pending') {
    subject = `Refund Approval Needed (${stageLabel}) – ${entry.invoiceNumber || 'Unknown Invoice'}`;
    intro = `A refund bill needs ${stageLabel} approval in the Refunds page.`;
  } else if (kind === 'rejected') {
    subject = `Refund Rejected (${stageLabel}) – ${entry.invoiceNumber || 'Unknown Invoice'}`;
    intro = `${stageLabel} rejected this refund bill.${extra.remarks ? ` Remarks: ${extra.remarks}` : ''}`;
  } else {
    subject = `Refund Fully Approved – ${entry.invoiceNumber || 'Unknown Invoice'}`;
    intro = 'This refund bill has been approved at every stage (HOD, CEO, Accounts).';
  }

  const th = (s) => `<td style="padding:8px 12px;border:1px solid #ddd;background:#f4f4f4;font-weight:bold;font-size:13px;white-space:nowrap;">${s}</td>`;
  const isUrl = (s) => /^https?:\/\//i.test(String(s || ''));
  const td = (s) => `<td style="padding:8px 12px;border:1px solid #ddd;font-size:13px;">${s && s !== '-' ? (isUrl(s) ? `<a href="${s}">${s}</a>` : s) : '-'}</td>`;

  const ath = (s) => `<th style="padding:10px 14px;border:1px solid #ddd;background:#1e3a8a;color:#fff;font-size:12.5px;text-align:left;">${s}</th>`;
  const atd = (s) => `<td style="padding:10px 14px;border:1px solid #ddd;font-size:13px;">${s || '-'}</td>`;
  const approvalTableHtml = `
    <h3 style="font-family:Arial,sans-serif;margin:20px 0 8px;">Approval Status</h3>
    <table style="border-collapse:collapse;font-family:Arial,sans-serif;">
      <tr>${ath('Level')}${ath('Status')}${ath('Timestamp')}${ath('Comment')}</tr>
      ${approvalRows.map(([level, status, date, remarks]) => `<tr>${atd(level)}<td style="padding:10px 14px;border:1px solid #ddd;">${_approvalStatusPill(status)}</td>${atd(date || '-')}${atd(remarks || '-')}</tr>`).join('')}
    </table>
  `;
  const approvalTableText = 'Approval Status:\n'
    + approvalRows.map(([level, status, date, remarks]) => `  ${level}: ${status || 'Not yet reached'} | ${date || '-'} | ${remarks || '-'}`).join('\n') + '\n';

  const body = `${intro}\n\n` + fields.map(([label, val]) => `${label}: ${val || '-'}`).join('\n') + '\n\n' + approvalTableText
    + `\nReview & take action: ${actionUrl}\n`;
  const html = `
    <p>${intro}</p>
    <table style="border-collapse:collapse;font-family:Arial,sans-serif;">
      ${fields.map(([label, val]) => `<tr>${th(label)}${td(val)}</tr>`).join('')}
    </table>
    ${approvalTableHtml}
    <p style="margin-top:20px;">
      <a href="${actionUrl}" style="display:inline-block;padding:12px 24px;background:#1e3a8a;color:#fff;border-radius:6px;text-decoration:none;font-family:Arial,sans-serif;font-weight:bold;">Review &amp; Take Action &rarr;</a>
    </p>
  `;

  await sendMail({ to: APPROVAL_NOTIFY_EMAIL, subject, body, html });
  console.log(`[REFUND-APPROVAL-EMAIL] ${kind}/${stage} sent for ${entry.invoiceNumber}`);
}
