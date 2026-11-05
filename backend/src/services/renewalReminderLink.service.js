/**
 * RENEWAL REMINDER — PER-CONTAINER NO-LOGIN DEEP LINK
 *
 * Explicit request 2026-10-29/30 ("Every email action must be linked to its
 * specific container and client... never show unrelated clients' records
 * or options"): mints ONE signed link per container. Clicking it opens the
 * REAL, full Lease Expiry page (/lease-expiry) with that one container's
 * detail already selected — same page, same Renew/Off-Lease/Renew-via-
 * Sales-CRM buttons a logged-in user sees, with no manual login.
 *
 * REDESIGNED TWICE on 2026-10-30, in order:
 *  1. ("click the renew and offlease two button make one button and this
 *     action click the then open this") — was two separate links (one per
 *     action), each landing on a generic "Confirm X" page. Changed to ONE
 *     link per container, landing on a custom no-login detail page with
 *     Off-Lease/Renew as two buttons there.
 *  2. ("yes deeplink into the real lease expeiye but log not reqied") —
 *     that custom page was still a simplified REPLICA (no real file-upload
 *     Renew, no real Renew via Sales CRM, since that needs a real logged-in
 *     identity). This final version instead SSO's the clicker in — same
 *     mechanism already used for the Sales OS embeds (auth.service.js's
 *     empSsoLoginByEmail, added for this) — as the container's resolved
 *     KAM, then redirects into the REAL LeaseExpiryPage component itself
 *     (reused verbatim, not rebuilt), auto-selecting that one container.
 *     EXPLICIT SECURITY TRADE-OFF, confirmed with the user before building:
 *     this grants the clicker a REAL, FULL session as that KAM — not
 *     scoped to one container — same exposure the existing Sales OS SSO
 *     links already carry. If the KAM can't be resolved, this throws
 *     rather than silently signing in as someone else.
 *
 * Same no-login MINTING mechanism as the SD Refund review flow
 * (refunds.service.js's _mintRefundReviewLink/_verifyRefundReviewToken,
 * jwtLite.js), with its OWN secret (RENEWAL_REMINDER_LINK_SECRET) — one
 * leaked secret must not unlock the other flow's links, same reasoning
 * env.js already documents for refundReviewSecret vs salesCrmHandoffSecret.
 *
 * STOP CONDITION: an SSO-in is recorded in _renewal_reminder_actions (one
 * doc per container+row) the moment it succeeds — renewalReminderDigest
 * .service.js checks this before including a row, so a container someone
 * already opened isn't re-sent. This is a "was it opened" signal, not "was
 * it resolved" — Off-Lease/renewal completion still has its own natural
 * signal (Off-Lease Tracking existing / the date actually moving once
 * approved), checked independently in the digest.
 */
import { signJwt, verifyJwt } from '../utils/jwtLite.js';
import { env } from '../config/env.js';
import { accessDenied, notFound } from '../utils/AppError.js';
import { getExpiryDataByFilter } from './expiry.service.js';
import { getSalePersonResolver } from './salesCrmLeads.service.js';
import { canonicalSalePersonName, emailForSalePerson } from './salePersonAccess.service.js';
import { empSsoLoginByEmail } from './auth.service.js';
import { getCollection } from './mongo.service.js';
import { logger } from '../utils/logger.js';

const ACTIONS_COLLECTION = '_renewal_reminder_actions';
const TOKEN_TTL_SECS = 60 * 60 * 24 * 14; // 2 weeks — plenty for an email link to still be actionable

const REVIEW_BASE_URL = 'https://lease.crystalgrp.xyz/renewal-reminder-review';

/** Returns null (not a link) when RENEWAL_REMINDER_LINK_SECRET isn't set —
 *  callers fall back to the Phase 1 shared /lease-expiry link, same
 *  graceful-degrade posture refund review's own mint function has.
 *  container/row are ALSO carried as plain query params alongside the
 *  signed token — display-only, for the frontend to auto-select the right
 *  row once SSO'd in; never trusted for authorization, which is the
 *  token's job alone (ssoIntoLeaseExpiry re-derives both from it). */
export function mintRenewalReminderLink({ container, row }) {
  if (!env.renewalReminderLinkSecret) return null;
  const token = signJwt({ container, row }, env.renewalReminderLinkSecret, TOKEN_TTL_SECS);
  const url = new URL(REVIEW_BASE_URL);
  url.searchParams.set('token', token);
  url.searchParams.set('container', container);
  url.searchParams.set('row', String(row));
  return url.toString();
}

function verifyToken(token) {
  if (!env.renewalReminderLinkSecret) throw accessDenied('Review links are not enabled on this server.');
  try {
    return verifyJwt(token, env.renewalReminderLinkSecret);
  } catch (e) {
    throw accessDenied('This review link is invalid or has expired.');
  }
}

async function recordOpened(container, row, extra = {}) {
  await getCollection(ACTIONS_COLLECTION).updateOne(
    { container: String(container), row },
    { $set: { container: String(container), row, openedAt: new Date(), ...extra } },
    { upsert: true }
  );
}

/** Set of "container|row" strings already opened via a reminder link —
 *  used by renewalReminderDigest.service.js's stop condition. */
export async function getAlreadyActionedKeys() {
  const docs = await getCollection(ACTIONS_COLLECTION).find({}, { projection: { container: 1, row: 1 } }).toArray();
  return new Set(docs.map((d) => `${d.container}|${d.row}`));
}

/** Verifies the token, resolves the container's KAM (read-only Sales CRM
 *  lookup -> canonical name -> the 6-login email map, same chain the old
 *  "notify the KAM" flow used), and SSOs them in — returns a real session
 *  token + the container/row to land on. Throws (does not silently fall
 *  back to a different identity) when no KAM email is resolvable, or when
 *  that email isn't a mapped LMS login — a no-login link must not grant
 *  access to a made-up or wrong identity. */
export async function ssoIntoLeaseExpiry(token) {
  const { container, row } = verifyToken(token);

  const { data } = await getExpiryDataByFilter('pending', null);
  const item = data.find((d) => d._rowNum === row && String(d.row[0]) === String(container));
  if (!item) throw notFound('This container is no longer pending renewal (it may already have been actioned).');
  const clientName = String(item.row[2]);

  const resolveSalePerson = await getSalePersonResolver();
  const resolvedName = canonicalSalePersonName(resolveSalePerson(clientName) || '');
  const kamEmail = resolvedName ? emailForSalePerson(resolvedName) : null;
  if (!kamEmail) {
    throw accessDenied(`No mapped KAM login found for "${clientName}" — can't sign in. Open ${container} from inside the app instead.`);
  }

  const login = await empSsoLoginByEmail(kamEmail);
  if (!login.ok) {
    throw accessDenied(`${kamEmail} isn't a mapped LMS login — can't sign in. Open ${container} from inside the app instead.`);
  }

  await recordOpened(container, row, { ssoAs: login.email });
  logger.info(`[RENEWAL-REMINDER-LINK] SSO'd ${login.email} in for ${container}`);
  return { token: login.token, user: { empId: login.empId, name: login.name, email: login.email }, container, row };
}
