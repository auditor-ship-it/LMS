/**
 * RENEWAL REMINDER — PER-CONTAINER NO-LOGIN ACTION LINKS
 *
 * Explicit request 2026-10-29/30 ("Every email action must be linked to its
 * specific container and client... never show unrelated clients' records
 * or options"): mints ONE signed link per container (not per-action — see
 * the 2026-10-30 redesign note below), so clicking it opens a detail view
 * scoped to that one container, matching the real in-app Lease Expiry
 * detail panel's own layout (Identity/Dates & Validity/Documents/Sales),
 * with Off-Lease and Renew as the two choices on that one page.
 *
 * Same no-login mechanism as the SD Refund review flow
 * (refunds.service.js's _mintRefundReviewLink/_verifyRefundReviewToken,
 * jwtLite.js), with its OWN secret (RENEWAL_REMINDER_LINK_SECRET) — one
 * leaked secret must not unlock the other flow's links, same reasoning
 * env.js already documents for refundReviewSecret vs salesCrmHandoffSecret.
 *
 * REDESIGNED 2026-10-30 ("click the renew and offlease two button make one
 * button and this action click the then open this"): originally minted a
 * SEPARATE link per action (renew vs offlease), each landing on a generic
 * "Confirm X" page. Now mints ONE link per container; the no-login page
 * itself shows the container's detail (richer, matching the in-app panel)
 * and both actions as buttons there — same idea as the real Lease Expiry
 * detail panel's Off-Lease/Renew via Sales CRM pair, just reachable with no
 * login for exactly this one container.
 *
 * WHY "RENEW" HERE STILL ISN'T A DIRECT SALES-CRM HANDOFF: the real
 * "Renew via Sales CRM" button (renewalHandoff.service.js's
 * createRenewalLink) signs the LOGGED-IN user's own identity (empId/name/
 * email) into its token — that's who the Sales CRM attributes the renewal
 * entry to. A no-login context has no such identity to sign, and minting
 * one with a fake/synthetic identity would misattribute a real renewal
 * record. So "Renew" here instead resolves the container's KAM (read-only
 * Sales CRM lookup) and emails THEM a link into Lease Expiry — they click
 * the real "Renew via Sales CRM" button themselves, under their own login,
 * same as always. "Off-Lease" has no such identity requirement
 * (addToOffLeaseTracking only takes an optional free-text personName), so
 * it's a real, direct, no-login action — same as before this redesign.
 *
 * Every confirmed action is recorded in _renewal_reminder_actions (one doc
 * per container+row+action), which renewalReminderDigest.service.js checks
 * before including a row — this is what makes requirement 7 (no duplicate
 * reminders for an action already completed) possible for "renew", where
 * nothing else changes the moment a KAM is merely notified (unlike
 * "offlease", which already flips the Deployed sheet's own Status to
 * "Off-Lease" and so naturally drops out of getExpiryDataByFilter('pending')
 * on its own — this collection is still checked for it too, as a second,
 * independent safety net).
 */
import { signJwt, verifyJwt } from '../utils/jwtLite.js';
import { env } from '../config/env.js';
import { AppError, notFound, accessDenied } from '../utils/AppError.js';
import { getExpiryDataByFilter } from './expiry.service.js';
import { addToOffLeaseTracking } from './offlease.service.js';
import { getSalePersonResolver } from './salesCrmLeads.service.js';
import { canonicalSalePersonName, emailForSalePerson } from './salePersonAccess.service.js';
import { sendMail } from './email.service.js';
import { getCollection } from './mongo.service.js';
import { logger } from '../utils/logger.js';

const ACTIONS_COLLECTION = '_renewal_reminder_actions';
const TOKEN_TTL_SECS = 60 * 60 * 24 * 14; // 2 weeks — plenty for an email link to still be actionable

const APP_ORIGIN = 'https://lease.crystalgrp.xyz';
const LEASE_EXPIRY_URL = `${APP_ORIGIN}/lease-expiry`;
const offLeaseRecordUrl = (container, row) => `${APP_ORIGIN}/off-lease/record?container=${encodeURIComponent(container)}&row=${row}`;

// Same shared team inbox every other digest in this file's family already uses
// (leaseExpiryDigest.service.js's own CC_RECIPIENTS) — reused here as both
// the Renew fallback (KAM unresolved) and the Off-Lease CRM notification list.
const SHARED_TEAM_RECIPIENTS = ['shivani.dhall@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'pushpa.shetty@crystalgroup.in'];

const REVIEW_BASE_URL = `${APP_ORIGIN}/renewal-reminder-review`;

/** Returns null (not a link) when RENEWAL_REMINDER_LINK_SECRET isn't set —
 *  callers fall back to the Phase 1 shared /lease-expiry link, same
 *  graceful-degrade posture refund review's own mint function has. */
export function mintRenewalReminderLink({ container, row }) {
  if (!env.renewalReminderLinkSecret) return null;
  const token = signJwt({ container, row }, env.renewalReminderLinkSecret, TOKEN_TTL_SECS);
  return `${REVIEW_BASE_URL}?token=${encodeURIComponent(token)}`;
}

function verifyToken(token) {
  if (!env.renewalReminderLinkSecret) throw accessDenied('Review links are not enabled on this server.');
  try {
    return verifyJwt(token, env.renewalReminderLinkSecret);
  } catch (e) {
    throw accessDenied('This review link is invalid or has expired.');
  }
}

async function resolveItem(container, row) {
  const { data } = await getExpiryDataByFilter('pending', null);
  const item = data.find((d) => d._rowNum === row && String(d.row[0]) === String(container));
  if (!item) throw notFound('This container is no longer pending renewal (it may already have been actioned).');
  return item;
}

/** Re-reads the container's identity live from getExpiryDataByFilter —
 *  never trusts anything beyond the token's own signed {container, row},
 *  same reasoning getRefundEntryForReview re-reads its sheet rather than
 *  trusting display fields baked into an old token. Deliberately leaves
 *  out Rate — explicit request 2026-10-30 ("rate nahi jana chahiye hai"),
 *  made for the Off-Lease notification email but applied here too since
 *  this no-login page is, if anything, an even more exposed surface than
 *  an email sent to a known recipient. */
export async function getLinkTarget(token) {
  const { container, row } = verifyToken(token);
  const item = await resolveItem(container, row);
  return {
    container: String(item.row[0]),
    orderNo: String(item.row[1]),
    clientName: String(item.row[2]),
    size: String(item.row[3]),
    type: String(item.row[4]),
    location: String(item.row[5]),
    city: String(item.row[6]),
    deployedDate: String(item.row[7]),
    agreementDate: item.agreementDate,
    agreementUrl: item.agreementUrl || '',
    poNo: item.poNo || '',
    poPdfUrl: item.poPdfUrl || '',
    poDate: item.poDate,
    billingCycle: String(item.row[15] || ''),
    salePerson: String(item.row[10] || ''),
    daysLeft: item.daysLeft,
    band: item.band
  };
}

async function recordAction(container, row, action, extra = {}) {
  await getCollection(ACTIONS_COLLECTION).updateOne(
    { container: String(container), row, action },
    { $set: { container: String(container), row, action, confirmedAt: new Date(), ...extra } },
    { upsert: true }
  );
}

/** Set of "container|row|action" strings already confirmed — used by
 *  renewalReminderDigest.service.js's stop condition. */
export async function getAlreadyActionedKeys() {
  const docs = await getCollection(ACTIONS_COLLECTION).find({}, { projection: { container: 1, row: 1, action: 1 } }).toArray();
  return new Set(docs.map((d) => `${d.container}|${d.row}|${d.action}`));
}

async function confirmRenew(container, row, clientName) {
  const resolveSalePerson = await getSalePersonResolver();
  const resolvedName = canonicalSalePersonName(resolveSalePerson(clientName) || '');
  const kamEmail = resolvedName ? emailForSalePerson(resolvedName) : null;

  const to = kamEmail || SHARED_TEAM_RECIPIENTS.join(', ');
  const assignedTo = kamEmail ? resolvedName : 'the shared team (no mapped KAM email found)';
  const subject = `Renewal assigned — ${container}`;
  const body = `Container ${container} (${clientName}) needs its Agreement/PO renewed.\n\nOpen Lease Expiry to process it (use "Renew via Sales CRM" there): ${LEASE_EXPIRY_URL}\n`;
  const html = `
    <p>Container <strong>${container}</strong> (${clientName}) needs its Agreement/PO renewed.</p>
    <p style="margin-top:16px;"><a href="${LEASE_EXPIRY_URL}" style="display:inline-block;padding:12px 24px;background:#1e3a8a;color:#fff;border-radius:6px;text-decoration:none;font-family:Arial,sans-serif;font-weight:bold;">Open Lease Expiry</a></p>
  `;
  await sendMail({ to, subject, body, html });

  await recordAction(container, row, 'renew', { assignedTo });
  logger.info(`[RENEWAL-REMINDER-LINK] renew confirmed for ${container} — assigned to ${assignedTo}`);
  return { assignedTo };
}

async function confirmOffLease(container, row, clientName) {
  const result = await addToOffLeaseTracking(container, row, 'Added via automated renewal reminder', 'Renewal Reminder System', '');
  if (result !== 'OK' && result !== 'ALREADY_EXISTS') {
    throw new AppError(`Could not start off-lease for ${container}: ${result}`);
  }

  const recordUrl = offLeaseRecordUrl(container, row);
  const subject = `Off-Lease started — ${container} — Stage 1 needs completing`;
  const body = `Container ${container} (${clientName}) has been added to Off-Lease. Please complete Stage 1 Intimation.\n\nOpen the record: ${recordUrl}\n`;
  const html = `
    <p>Container <strong>${container}</strong> (${clientName}) has been added to Off-Lease. Please complete Stage 1 Intimation.</p>
    <p style="margin-top:16px;"><a href="${recordUrl}" style="display:inline-block;padding:12px 24px;background:#1e3a8a;color:#fff;border-radius:6px;text-decoration:none;font-family:Arial,sans-serif;font-weight:bold;">Open Stage 1</a></p>
  `;
  await sendMail({ to: SHARED_TEAM_RECIPIENTS.join(', '), subject, body, html });

  await recordAction(container, row, 'offlease', { trackResult: result });
  logger.info(`[RENEWAL-REMINDER-LINK] offlease confirmed for ${container} (${result})`);
  return { tracked: true };
}

/** `action` now comes from the request itself (which button was clicked on
 *  the detail page), not the token — the token only ever scopes WHICH
 *  container, never which action, since both are offered on the same page
 *  now (see this file's own 2026-10-30 redesign note). */
export async function confirmRenewalReminderAction(token, action) {
  if (action !== 'renew' && action !== 'offlease') throw new AppError('action must be "renew" or "offlease"');
  const { container, row } = verifyToken(token);
  const item = await resolveItem(container, row);
  const clientName = String(item.row[2]);

  return action === 'renew'
    ? confirmRenew(container, row, clientName)
    : confirmOffLease(container, row, clientName);
}
