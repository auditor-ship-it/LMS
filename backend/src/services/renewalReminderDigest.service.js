/**
 * AGREEMENT/PO RENEWAL REMINDER DIGEST
 *
 * Explicit request 2026-10-29: an automated reminder for every deployed
 * container whose Agreement or PO is within 15 days of expiry or already
 * overdue. Table listing each qualifying container's No, Client Name,
 * Location, Order No, the relevant date and its overdue/due-soon status,
 * plus a single per-row "Open" link — see renewalReminderLink.service.js
 * for what clicking it does (as of the final 2026-10-30 redesign: SSOs the
 * clicker in as the container's resolved KAM and lands them on the REAL
 * Lease Expiry page with that container already selected — not a separate
 * replica page). Falls back to a shared /lease-expiry link for a row when
 * no-login links aren't configured (RENEWAL_REMINDER_LINK_SECRET unset).
 *
 * BUG FOUND AND FIXED 2026-10-30: the previous version of this file read
 * `item.container`/`item.clientName` — fields that don't exist anywhere on
 * getExpiryDataByFilter's returned items (confirmed by grep — only
 * `item.row[0]`/`item.row[2]` do). Both were `undefined`, which this
 * file's own `td()` helper rendered as "-" — so the "table format" sent
 * 2026-10-29 almost certainly showed blank Container/Client columns, never
 * actually visually verified before being reported as fixed (only the
 * summary counts in the server log were checked, which don't depend on
 * either field). Corrected to `item.row[0]`/`item.row[2]` throughout, and
 * Location (`item.row[5]`)/Order No (`item.row[1]`) added the same way,
 * confirmed live via a direct script read of getExpiryDataByFilter's own
 * column layout before writing this.
 *
 * STOP CONDITION:
 *  - "Documents Pending" (item.actionStatus) — an active renewal in
 *    progress (draft or awaiting approval). Once Approved,
 *    decideRenewalApproval overwrites Agreement Valid Till/PO Validity and
 *    clears this status, so the date-window check then stops matching on
 *    its own.
 *  - Any row in Off-Lease Tracking for the container — off-lease already
 *    initiated. (addToOffLeaseTracking also flips the Deployed sheet's own
 *    Status to "Off-Lease", which getExpiryDataByFilter's 'pending' filter
 *    excludes entirely — this check is a second, independent safety net,
 *    not the only thing guarding against it.)
 *  - A container already recorded in renewalReminderLink.service.js's
 *    _renewal_reminder_actions — opened via a reminder link already (the
 *    SSO itself is the signal; there's no separate "action confirmed" step
 *    anymore now that clicking lands on the real, authenticated page).
 *
 * RECIPIENT: auditor@crystalgroup.in only, for now — explicit instruction
 * 2026-10-29/30. Production (the container's own KAM + a shared inbox
 * CC'd) is a deliberate follow-up, not built speculatively here.
 */
import { getExpiryDataByFilter } from './expiry.service.js';
import { getSheetDataFromMongo } from './mongoSheetData.service.js';
import { sendMail } from './email.service.js';
import { SHEETS } from '../config/sheets.config.js';
import { mintRenewalReminderLink, getAlreadyActionedKeys } from './renewalReminderLink.service.js';
import { logger } from '../utils/logger.js';

const TO_RECIPIENTS = ['auditor@crystalgroup.in'];

const DUE_SOON_DAYS = 15;
const APP_ORIGIN = 'https://lease.crystalgrp.xyz';
const LEASE_EXPIRY_URL = `${APP_ORIGIN}/lease-expiry`;

/** "YYYY-MM-DD" -> days until that date from `today` (negative = overdue), or null if blank/unparseable. */
function daysUntil(dateStr, today) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return Math.ceil((d - today) / 86400000);
}

/** "YYYY-MM-DD" -> "DD-MM-YYYY", same convention poAgreementDigest.service.js uses. */
function formatDisplayDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}-${m}-${y}`;
}

function statusLabel(days) {
  return days < 0 ? `Overdue by ${Math.abs(days)}d` : `Due in ${days}d`;
}

export async function sendRenewalReminderDigest() {
  const { data: items } = await getExpiryDataByFilter('pending', null);

  const [{ rows: olRows }, alreadyActioned] = await Promise.all([
    getSheetDataFromMongo(SHEETS.OFF_LEASE_TRACKING),
    getAlreadyActionedKeys()
  ]);
  const trackedContainers = new Set(olRows.map((r) => String(r[0] || '').trim().toUpperCase()).filter(Boolean));

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const rows = [];

  for (const item of items) {
    const container = String(item.row[0] || '').trim();
    if (!container) continue;

    const isDocsPending = String(item.actionStatus || '').trim().toLowerCase() === 'documents pending';
    if (isDocsPending) continue;
    if (trackedContainers.has(container.toUpperCase())) continue;
    if (alreadyActioned.has(`${container}|${item._rowNum}`)) continue;

    const agrDays = daysUntil(item.agreementDate, today);
    const poDays = daysUntil(item.poDate, today);
    const candidateDays = [agrDays, poDays].filter((d) => d !== null);
    if (!candidateDays.length) continue;

    // Whichever of the two dates is more urgent (smaller days-until) is the
    // one shown — a container with both due just shows its nearer one.
    const minDays = Math.min(...candidateDays);
    if (minDays > DUE_SOON_DAYS) continue;
    const dateStr = agrDays === minDays ? item.agreementDate : item.poDate;
    const dateLabel = agrDays === minDays ? 'Agreement' : 'PO';

    const link = mintRenewalReminderLink({ container, row: item._rowNum }) || LEASE_EXPIRY_URL;

    rows.push({
      container, clientName: String(item.row[2] || '').trim(),
      location: String(item.row[5] || '').trim(), orderNo: String(item.row[1] || '').trim(),
      dateStr, dateLabel, daysLeft: minDays, statusText: statusLabel(minDays),
      link
    });
  }

  if (!rows.length) {
    logger.info('[RENEWAL-REMINDER-DIGEST] nothing due or overdue — skipped');
    return;
  }

  // Most urgent (most overdue, or soonest due) first — same ordering as
  // poAgreementDigest.service.js's own table.
  rows.sort((a, b) => a.daysLeft - b.daysLeft);
  const overdueCount = rows.filter((r) => r.daysLeft < 0).length;
  const dueSoonCount = rows.length - overdueCount;

  const subject = `Agreement/PO Renewal Reminder — ${rows.length} container(s) need action`;
  const summaryLine = `${overdueCount} overdue, ${dueSoonCount} due within ${DUE_SOON_DAYS} days.`;

  const th = (s) => `<th style="padding:8px 12px;border:1px solid #ddd;background:#f4f4f4;font-size:12.5px;text-align:left;white-space:nowrap;">${s}</th>`;
  const td = (s, overdue) => `<td style="padding:8px 12px;border:1px solid #ddd;font-size:12.5px;${overdue ? 'color:#c0392b;font-weight:bold;' : ''}">${s === '' || s == null ? '-' : s}</td>`;
  const linkBtn = (href, label) => `<a href="${href}" style="display:inline-block;padding:5px 11px;background:#1e3a8a;color:#fff;border-radius:4px;text-decoration:none;font-family:Arial,sans-serif;font-weight:bold;font-size:11.5px;margin-right:6px;">${label}</a>`;

  const table = `
    <table style="border-collapse:collapse;font-family:Arial,sans-serif;margin-top:16px;">
      <tr>${th('Container')}${th('Client')}${th('Location')}${th('Order No')}${th('Due On')}${th('Status')}${th('')}</tr>
      ${rows.map((r) => `<tr>${td(r.container)}${td(r.clientName)}${td(r.location)}${td(r.orderNo)}${td(`${r.dateLabel}: ${formatDisplayDate(r.dateStr)}`, r.daysLeft < 0)}${td(r.statusText, r.daysLeft < 0)}<td style="padding:8px 12px;border:1px solid #ddd;white-space:nowrap;">${linkBtn(r.link, 'Open')}</td></tr>`).join('')}
    </table>
  `;

  const body = `${summaryLine}\n\n`
    + rows.map((r) => `${r.container} | ${r.clientName} | ${r.location} | ${r.orderNo} | ${r.dateLabel} ${formatDisplayDate(r.dateStr)} | ${r.statusText}\n  Open: ${r.link}`).join('\n') + '\n';

  const html = `
    <p>${summaryLine}</p>
    ${table}
  `;

  await sendMail({ to: TO_RECIPIENTS.join(', '), subject, body, html });
  logger.info(`[RENEWAL-REMINDER-DIGEST] sent — ${overdueCount} overdue, ${dueSoonCount} due soon`);
}
