/**
 * MONTHLY PO & AGREEMENT UPDATE DIGEST
 *
 * Explicit request 2026-10-21: one automated email on the 25th of every
 * month, highlighting which deployed containers need their PO and/or
 * Agreement updated — to pushpa.shetty@crystalgroup.in and
 * shivani.dhall@crystalgroup.in, same recipients as monthlyReport.service.js
 * (the established renewal/PO stakeholders). Read-only: this only reads the
 * same data the PO & Agreement Tracker page already shows and sends a
 * summary — it does not touch the Renew or Off-Lease workflow in any way.
 *
 * Skeleton (recipients list, idempotency state doc, testRecipient/now
 * pattern, buildXEmail -> sendMail, cron registration) copied from
 * monthlyReport.service.js — see that file for the reasoning behind each
 * piece; not repeated here.
 *
 * DATA SOURCE: dashboard.service.js's getPoAgreementTrackerData() — the same
 * read the PO & Agreement Tracker page uses (itself built on
 * getExpiryDataByFilter('pending', null), unscoped, every deployed
 * container). "Needs updating" is each date's OWN day-count against `now`
 * (overdue, or due within DUE_SOON_DAYS) — NOT getExpiryDataByFilter's own
 * `band`/`daysLeft`, which is deliberately computed from whichever of
 * Agreement/PO is EARLIER (see that function's own doc comment) and so
 * conflates the two; a PO-specific or Agreement-specific "needs updating"
 * list needs its own independent check against each date.
 */
import { getPoAgreementTrackerData } from './dashboard.service.js';
import { sendMail } from './email.service.js';
import { getCollection } from './mongo.service.js';
import { logger } from '../utils/logger.js';

const REPORT_RECIPIENTS = ['pushpa.shetty@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'mansi.agarwal@crystalgroup.in'];

const DUE_SOON_DAYS = 30;

const STATE_COLLECTION = '_runtime_config';
const STATE_ID = 'poAgreementDigestState';
const HISTORY_LIMIT = 24;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function monthLabel(now) {
  return `${MONTH_NAMES[now.getMonth()]} ${now.getFullYear()}`;
}
function monthKeyOf(now) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/** "YYYY-MM-DD" -> days until that date from `today` (negative = overdue), or null if blank/unparseable. */
function daysUntil(dateStr, today) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return Math.ceil((d - today) / 86400000);
}

/** "YYYY-MM-DD" -> "DD-MM-YYYY", matching this app's own date display convention elsewhere. */
function formatDisplayDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}-${m}-${y}`;
}

function statusLabel(days) {
  return days < 0 ? `Overdue by ${Math.abs(days)}d` : `Due in ${days}d`;
}

/**
 * Every deployed container whose Agreement and/or PO date is overdue or due
 * within DUE_SOON_DAYS, as of `today`. A container can appear in one list,
 * both, or neither — the two checks are fully independent, same as the PO &
 * Agreement Tracker page's own Agreement-wise/PO-wise split.
 */
function splitNeedsUpdate(containers, today) {
  const agreementRows = [];
  const poRows = [];
  for (const c of containers) {
    const agrDays = daysUntil(c.agreementDate, today);
    if (agrDays !== null && agrDays <= DUE_SOON_DAYS) {
      agreementRows.push({ ...c, daysLeft: agrDays, statusText: statusLabel(agrDays) });
    }
    const poDays = daysUntil(c.poDate, today);
    if (poDays !== null && poDays <= DUE_SOON_DAYS) {
      poRows.push({ ...c, daysLeft: poDays, statusText: statusLabel(poDays) });
    }
  }
  // Most urgent (most overdue, or soonest due) first.
  const bySoonest = (a, b) => a.daysLeft - b.daysLeft;
  agreementRows.sort(bySoonest);
  poRows.sort(bySoonest);
  return { agreementRows, poRows };
}

function buildDigestEmail({ label, agreementRows, poRows }) {
  const subject = `PO & Agreement Update Digest – ${label}`;
  const total = agreementRows.length + poRows.length;

  const th = (s) => `<th style="padding:8px 12px;border:1px solid #ddd;background:#f4f4f4;font-size:12.5px;text-align:left;white-space:nowrap;">${s}</th>`;
  const td = (s, overdue) => `<td style="padding:8px 12px;border:1px solid #ddd;font-size:12.5px;${overdue ? 'color:#c0392b;font-weight:bold;' : ''}">${s === '' || s == null ? '-' : s}</td>`;

  const agreementTable = agreementRows.length
    ? `<table style="border-collapse:collapse;font-family:Arial,sans-serif;margin-bottom:20px;">
        <tr>${th('Container')}${th('Client')}${th('Agreement Valid Till')}${th('Status')}</tr>
        ${agreementRows.map((r) => `<tr>${td(r.container)}${td(r.clientName)}${td(formatDisplayDate(r.agreementDate), r.daysLeft < 0)}${td(r.statusText, r.daysLeft < 0)}</tr>`).join('')}
      </table>`
    : `<p style="font-family:Arial,sans-serif;">No Agreements are overdue or due within ${DUE_SOON_DAYS} days.</p>`;

  const poTable = poRows.length
    ? `<table style="border-collapse:collapse;font-family:Arial,sans-serif;">
        <tr>${th('Container')}${th('Client')}${th('PO No')}${th('PO Valid Till')}${th('Status')}</tr>
        ${poRows.map((r) => `<tr>${td(r.container)}${td(r.clientName)}${td(r.poNo)}${td(formatDisplayDate(r.poDate), r.daysLeft < 0)}${td(r.statusText, r.daysLeft < 0)}</tr>`).join('')}
      </table>`
    : `<p style="font-family:Arial,sans-serif;">No POs are overdue or due within ${DUE_SOON_DAYS} days.</p>`;

  const html = `
    <h2 style="font-family:Arial,sans-serif;">PO &amp; Agreement Update Digest – ${label}</h2>
    <table style="border-collapse:collapse;font-family:Arial,sans-serif;margin-bottom:20px;">
      <tr>${th('Agreements needing update')}${td(agreementRows.length)}</tr>
      <tr>${th('POs needing update')}${td(poRows.length)}</tr>
      <tr>${th('Total')}${td(total)}</tr>
    </table>
    <h3 style="font-family:Arial,sans-serif;">Agreement — needs update (overdue or due within ${DUE_SOON_DAYS} days)</h3>
    ${agreementTable}
    <h3 style="font-family:Arial,sans-serif;">PO — needs update (overdue or due within ${DUE_SOON_DAYS} days)</h3>
    ${poTable}
    <p style="font-family:Arial,sans-serif;font-size:11.5px;color:#777;">Full list with search/filter: PO &amp; Agreement Tracker page in the Lease Management System.</p>
  `;

  const body = [
    `PO & Agreement Update Digest – ${label}`, '',
    `Agreements needing update: ${agreementRows.length}`,
    `POs needing update: ${poRows.length}`,
    `Total: ${total}`, '',
    `AGREEMENT (overdue or due within ${DUE_SOON_DAYS} days)`, ...(agreementRows.length
      ? agreementRows.map((r) => `${r.container} | ${r.clientName} | Valid Till ${formatDisplayDate(r.agreementDate)} | ${r.statusText}`)
      : [`No Agreements are overdue or due within ${DUE_SOON_DAYS} days.`]),
    '', `PO (overdue or due within ${DUE_SOON_DAYS} days)`, ...(poRows.length
      ? poRows.map((r) => `${r.container} | ${r.clientName} | PO ${r.poNo || '-'} | Valid Till ${formatDisplayDate(r.poDate)} | ${r.statusText}`)
      : [`No POs are overdue or due within ${DUE_SOON_DAYS} days.`])
  ].join('\n');

  return { subject, body, html };
}

async function getState() {
  try {
    return await getCollection(STATE_COLLECTION).findOne({ _id: STATE_ID });
  } catch (e) {
    return null;
  }
}

async function recordRun({ monthKey, agreementCount, poCount, ok, error }) {
  try {
    const entry = { monthKey, agreementCount, poCount, ok, error: error || null, sentAt: new Date().toISOString() };
    await getCollection(STATE_COLLECTION).updateOne(
      { _id: STATE_ID },
      { $set: ok ? { lastSentMonthKey: monthKey } : {}, $push: { history: { $each: [entry], $slice: -HISTORY_LIMIT } } },
      { upsert: true }
    );
  } catch (e) {
    logger.error('[PO-AGREEMENT-DIGEST] Could not record run state (non-fatal):', e?.message || e);
  }
}

/**
 * Builds and sends the digest for the month `now` falls in (real runs always
 * call this with no `now` — it defaults to the actual current date; a fixed
 * `now` is only for ad-hoc verification).
 *
 * @param {object} [opts]
 * @param {string} [opts.testRecipient] - send to this ONE address instead of
 *   the real pushpa/shivani list, subject prefixed "[TEST]", and never
 *   checked against or recorded into the idempotency state.
 * @param {Date} [opts.now] - override "today" for testing.
 */
export async function sendPoAgreementDigest({ testRecipient, now } = {}) {
  const today = now ? new Date(now) : new Date();
  today.setHours(0, 0, 0, 0);
  const label = monthLabel(today);
  const monthKey = monthKeyOf(today);

  if (!testRecipient) {
    const state = await getState();
    if (state?.lastSentMonthKey === monthKey) {
      logger.info(`[PO-AGREEMENT-DIGEST] ${monthKey} (${label}) already sent — skipping duplicate run.`);
      return { ok: true, monthKey, label, skipped: true };
    }
  }

  try {
    const { containers } = await getPoAgreementTrackerData();
    const { agreementRows, poRows } = splitNeedsUpdate(containers, today);

    const { subject, body, html } = buildDigestEmail({ label, agreementRows, poRows });
    const finalSubject = testRecipient ? `[TEST] ${subject}` : subject;
    const to = testRecipient || REPORT_RECIPIENTS.join(', ');

    const res = await sendMail({ to, subject: finalSubject, body, html });
    logger.info(`[PO-AGREEMENT-DIGEST] ${monthKey} (${label}) — Agreement: ${agreementRows.length}, PO: ${poRows.length} -> ${to} — ${res.ok ? 'sent' : `FAILED: ${res.error}`}`);

    if (!testRecipient) {
      await recordRun({ monthKey, agreementCount: agreementRows.length, poCount: poRows.length, ok: res.ok, error: res.error });
    }

    return { ok: res.ok, monthKey, label, agreementCount: agreementRows.length, poCount: poRows.length, error: res.error };
  } catch (e) {
    const error = e?.message || String(e);
    logger.error(`[PO-AGREEMENT-DIGEST] ${monthKey} (${label}) FAILED to build/send:`, error);
    if (!testRecipient) {
      await recordRun({ monthKey, agreementCount: 0, poCount: 0, ok: false, error });
    }
    return { ok: false, monthKey, label, error };
  }
}
