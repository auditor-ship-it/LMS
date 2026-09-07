/**
 * Daily "Lease Expiry" digest — one email per sales executive listing the
 * leases assigned to them that need a Renew/Off-Lease decision. Explicit
 * request 2026-09-04.
 *
 * Reuses getExpiryDataByFilter('pending', null) — the SAME unscoped read the
 * Lease Expiry page itself falls back to for an admin — called with no user
 * so salePersonScopeFor(null) returns null and every salesperson's rows come
 * back in one pass, rather than one scoped fetch per person (which would
 * also require faking a req.user-shaped object for each of the 6 known
 * logins and still miss anyone outside that map).
 */
import { getExpiryDataByFilter } from './expiry.service.js';
import { emailForSalePerson, canonicalSalePersonName } from './salePersonAccess.service.js';
import { sendMail } from './email.service.js';
import { logger } from '../utils/logger.js';

/* Any salesperson name that isn't one of the 6 explicitly mapped logins
 * (emailForSalePerson returns null) has no known inbox — their leases are
 * bundled into one email here instead of silently dropped. Explicit request
 * 2026-09-04; same fallback address every other cross-team notification in
 * this app already uses (see offlease.service.js's _sendOffLeaseNotification,
 * expiry.service.js's _sendRenewalNotification). */
const FALLBACK_EMAIL = 'support@crystalgroup.in';

/* overdue = already expired; critical/warning = expiring within 30 days —
 * both need a Renew/Off-Lease decision, not just what's already lapsed.
 * 'safe' rows are excluded — nothing actionable yet. Explicit request
 * 2026-09-04. */
const DIGEST_BANDS = new Set(['overdue', 'critical', 'warning']);
const BAND_LABEL = { overdue: 'Overdue', critical: 'Critical (≤ 7 days)', warning: 'Expiring soon (≤ 30 days)' };
const BAND_ORDER = { overdue: 0, critical: 1, warning: 2 };

/** First header matching `name` (case/space-insensitive, substring), or -1.
 *  Same by-header lookup convention as expiry.service.js's own
 *  findHeaderCol — the Deployed sheet has had columns inserted/removed by
 *  hand before, so a hardcoded position would silently read the wrong
 *  column. Substring, not exact match — the live header is "Agreement Valid
 *  Upto", not "Valid Upto" (confirmed live 2026-09-04: getExpiryDataByFilter
 *  returns ["Container No","Order No","Customer Name","Size","Type",
 *  "Location","City","Deployed Date","Agreement Valid Upto","Agreement PDF",
 *  "Sale Person","PO","PO PDF","PO Validity","Rate","Billing Cycle"] — there
 *  is no "Lease ID" column on this sheet at all, unlike Off-Lease Tracking). */
function findCol(headers, name) {
  const target = name.trim().toLowerCase();
  return headers.findIndex((h) => String(h || '').trim().toLowerCase().includes(target));
}

/**
 * Every in-scope Lease Expiry row, grouped by the live Sale Person name —
 * the same CRM-resolved value the Lease Expiry page itself displays (see
 * getExpiryDataByFilter's own "LIVE SALE PERSON" doc comment), not the
 * sheet's possibly-stale cell.
 *
 * @returns {Map<string, Array>} salesperson name (or 'Unassigned') -> rows
 */
export async function buildLeaseExpiryDigestGroups() {
  const { headers, data } = await getExpiryDataByFilter('pending', null);
  const salePersonIdx = findCol(headers, 'sale person');
  const containerIdx = findCol(headers, 'container no');
  const orderNoIdx = findCol(headers, 'order no');
  const clientIdx = findCol(headers, 'customer name');
  const validUptoIdx = findCol(headers, 'valid upto'); // matches "Agreement Valid Upto"

  const groups = new Map();
  for (const item of data) {
    if (!DIGEST_BANDS.has(item.band)) continue;
    const rawName = salePersonIdx >= 0 ? String(item.row[salePersonIdx] || '').trim() : '';
    // Canonicalize known alternate spellings (e.g. "Lavina" -> "Laveena") so
    // the same person's leases land in one group under one address, not two.
    const name = canonicalSalePersonName(rawName);
    const key = name || 'Unassigned';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      container: containerIdx >= 0 ? item.row[containerIdx] : '',
      orderNo: orderNoIdx >= 0 ? item.row[orderNoIdx] : '',
      client: clientIdx >= 0 ? item.row[clientIdx] : '',
      validUpto: validUptoIdx >= 0 ? item.row[validUptoIdx] : '',
      daysLeft: item.daysLeft,
      band: item.band
    });
  }
  // Most urgent first within each person's own list: overdue, then critical,
  // then warning; ties broken by daysLeft ascending.
  for (const rows of groups.values()) {
    rows.sort((a, b) => (BAND_ORDER[a.band] - BAND_ORDER[b.band]) || (Number(a.daysLeft) - Number(b.daysLeft)));
  }
  return groups;
}

const SUBJECT = 'Lease Expiry — Action Required: Renew or Off-Lease';

/** Same vertical-table HTML convention as offlease.service.js's
 *  _sendOffLeaseNotification / expiry.service.js's _sendRenewalNotification,
 *  adapted to a multi-row table (one row per lease, not one row per field). */
function buildDigestEmail(salesperson, rows) {
  const th = (s) => `<th style="padding:8px 12px;border:1px solid #ddd;background:#f4f4f4;font-size:13px;text-align:left;">${s}</th>`;
  const td = (s, bold) => `<td style="padding:8px 12px;border:1px solid #ddd;font-size:13px;${bold ? 'font-weight:bold;color:#b00020;' : ''}">${s === '' || s == null ? '-' : s}</td>`;
  const rowHtml = (r) => `<tr>${td(r.container)}${td(r.client)}${td(r.orderNo)}${td(r.validUpto)}${td(BAND_LABEL[r.band] || r.band, r.band === 'overdue')}</tr>`;

  const html = rows.length
    ? `
      <p>Hi ${salesperson},</p>
      <p>The following leases assigned to you need a decision — <strong>Renew</strong> or <strong>Off-Lease</strong> — in the Lease Management System:</p>
      <table style="border-collapse:collapse;font-family:Arial,sans-serif;">
        <tr>${th('Container No')}${th('Client Name')}${th('Order No')}${th('Valid Upto')}${th('Status')}</tr>
        ${rows.map(rowHtml).join('')}
      </table>
      <p>Please take action on the Lease Expiry page at your earliest.</p>
    `
    : `<p>Hi ${salesperson},</p><p>No leases currently need a Renew/Off-Lease decision.</p>`;

  const body = [
    `Hi ${salesperson},`, '',
    rows.length
      ? 'The following leases assigned to you need a decision — Renew or Off-Lease:'
      : 'No leases currently need a Renew/Off-Lease decision.',
    '',
    ...rows.map((r) => `${r.container} | ${r.client} | Order ${r.orderNo} | Valid Upto ${r.validUpto} | ${BAND_LABEL[r.band] || r.band}`),
    ...(rows.length ? ['', 'Please take action on the Lease Expiry page at your earliest.'] : [])
  ].join('\n');

  return { subject: SUBJECT, body, html };
}

/**
 * Sends the digest — one email per salesperson group.
 *
 * @param {object} [opts]
 * @param {string} [opts.testOnly] - restrict the run to this ONE salesperson
 *   name (e.g. "Gauri"); every other group is skipped entirely.
 * @param {string} [opts.testRecipient] - override the resolved/fallback
 *   address with this one instead (and prefix the subject "[TEST]") — for a
 *   manual test send that never reaches a real salesperson's inbox.
 * @returns {Promise<Array<{salesperson, email, count, ok}>>}
 */
export async function sendLeaseExpiryDigest({ testOnly, testRecipient } = {}) {
  const groups = await buildLeaseExpiryDigestGroups();
  const results = [];
  for (const [salesperson, rows] of groups) {
    if (testOnly && salesperson !== testOnly) continue;
    const email = testRecipient || emailForSalePerson(salesperson) || FALLBACK_EMAIL;
    const { subject, body, html } = buildDigestEmail(salesperson, rows);
    const finalSubject = testRecipient ? `[TEST] ${subject}` : subject;
    const res = await sendMail({ to: email, subject: finalSubject, body, html });
    logger.info(`[LEASE-EXPIRY-DIGEST] ${salesperson} (${rows.length} leases) -> ${email} — ${res.ok ? 'sent' : `FAILED: ${res.error}`}`);
    results.push({ salesperson, email, count: rows.length, ok: res.ok });
  }
  /* testOnly for a salesperson with zero in-scope rows today still sends one
     email (an empty-state message) — a manual test send must prove the
     pipeline actually works even when there happens to be nothing to
     report, rather than silently no-op. */
  if (testOnly && !results.length) {
    const email = testRecipient || emailForSalePerson(testOnly) || FALLBACK_EMAIL;
    const { subject, body, html } = buildDigestEmail(testOnly, []);
    const finalSubject = testRecipient ? `[TEST] ${subject}` : subject;
    const res = await sendMail({ to: email, subject: finalSubject, body, html });
    logger.info(`[LEASE-EXPIRY-DIGEST] ${testOnly} (0 leases) -> ${email} — ${res.ok ? 'sent' : `FAILED: ${res.error}`}`);
    results.push({ salesperson: testOnly, email, count: 0, ok: res.ok });
  }
  return results;
}
