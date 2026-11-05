/**
 * DEPLOYED SUMMARY DIGEST — daily, 25th through 2nd of next month, 10:00 AM
 *
 * Explicit request 2026-10-23: an email showing the Deployed Summary page's
 * own numbers (Opening/Addition/Deletion/Net/Closing, the exact same
 * month-wise movement table shown on that page), with an Excel attachment
 * matching what its own "Export to Excel" button produces — to
 * pushpa.shetty@crystalgroup.in, shivani.dhall@crystalgroup.in and
 * mansi.agarwal@crystalgroup.in, same recipients as the other digests.
 * Separate from poAgreementDigest.service.js (that one is about which
 * containers need their PO/Agreement renewed — this one is the month-wise
 * deployed-container movement count).
 *
 * SCHEDULE CHANGED 2026-10-27 (explicit request: "25 to 2 date tak maild
 * jana chahiye hai subh 10 bhje") — from one email on the 25th to one EVERY
 * DAY from the 25th through the 2nd of the following month, at 10:00 AM
 * (jobs/index.js). Idempotency switched from a monthly key to a DAILY one
 * (lastSentDateKey, "YYYY-MM-DD") to match — the old monthly key would have
 * let only the very first of these 9 daily sends through.
 *
 * EXCEL ATTACHMENT: building moved out to deployedSummaryExcel.service.js
 * 2026-10-27, shared with the frontend's own "Export to Excel" button (via
 * a new on-demand download endpoint, dashboard.controller.js) so the two
 * can never show different numbers or drift apart. See that file's own
 * header comment for exactly what's in it (Summary / Deployed Containers /
 * one sheet per Billing Type / Changes vs last month) and the highlighting
 * color key.
 */
import { buildDeployedSummaryExcel } from './deployedSummaryExcel.service.js';
import { sendMail } from './email.service.js';
import { getCollection } from './mongo.service.js';
import { logger } from '../utils/logger.js';

const REPORT_RECIPIENTS = ['pushpa.shetty@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'mansi.agarwal@crystalgroup.in'];

const STATE_COLLECTION = '_runtime_config';
const STATE_ID = 'deployedSummaryDigestState';
const HISTORY_LIMIT = 24;

function buildDigestEmail({ latest, recentCount, finalBillingCount, diff }) {
  const subject = `Deployed Summary – ${latest.month}`;
  const changesLine = diff.ok
    ? `${diff.added.length} added, ${diff.removed.length} removed, and ${diff.changed.length} row(s) with a field changed vs ${diff.oldMonthKey}`
    : `no comparison available yet (${diff.reason})`;

  const card = (label, value, color) => `
    <td style="padding:12px 18px;border:1px solid #ddd;${color ? `background:${color};` : ''}">
      <div style="font-family:Arial,sans-serif;font-size:11.5px;color:#666;">${label}</div>
      <div style="font-family:Arial,sans-serif;font-size:22px;font-weight:bold;">${value}</div>
    </td>`;

  const html = `
    <h2 style="font-family:Arial,sans-serif;">Deployed Summary – ${latest.month}</h2>
    <table style="border-collapse:collapse;margin-bottom:20px;">
      <tr>
        ${card('Currently Deployed', latest.closing.total, '#eef3ff')}
        ${card(`${latest.month} Addition`, latest.addition.total, '#eafaf0')}
        ${card(`${latest.month} Deletion`, latest.deletion.total, '#fdecea')}
        ${card(`${latest.month} Net`, latest.net.total, '#f5f5f5')}
      </tr>
    </table>
    <p style="font-family:Arial,sans-serif;font-size:12.5px;">
      Opening: <b>${latest.opening.total}</b> &nbsp;+&nbsp;
      Addition: <b>${latest.addition.total}</b> &nbsp;-&nbsp;
      Deletion: <b>${latest.deletion.total}</b> &nbsp;=&nbsp;
      Closing: <b>${latest.closing.total}</b>
    </p>
    <p style="font-family:Arial,sans-serif;font-size:11.5px;color:#777;">
      Attached as Excel: the full month-wise movement table, the complete list of every currently deployed container (now with PO No/PO Validity and Last Updated), a separate sheet per Billing Type, ${recentCount} row(s) highlighted yellow for a change in the last 30 days (based on this app's own Renewal/Off-Lease/Approval timestamps — a hand-edit made directly in the spreadsheet outside the app won't be caught), ${finalBillingCount} approved-off-lease container(s) highlighted red whose Final Billing Date is ${latest.month} or later (not yet passed), and a "Changes vs last month" sheet: ${changesLine}.
    </p>
  `;

  const body = [
    `Deployed Summary – ${latest.month}`, '',
    `Opening Deployed: ${latest.opening.total}`,
    `Addition: ${latest.addition.total}`,
    `Deletion: ${latest.deletion.total}`,
    `Net Movement: ${latest.net.total}`,
    `Closing Deployed: ${latest.closing.total}`, '',
    `Attached as Excel: the full month-wise movement table, the complete container list (PO No/PO Validity + Last Updated added), a sheet per Billing Type, ${recentCount} row(s) highlighted for a change in the last 30 days, ${finalBillingCount} approved-off-lease row(s) highlighted red for a Final Billing Date in ${latest.month} or later, and a "Changes vs last month" sheet: ${changesLine}.`
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

async function recordRun({ dateKey, closing, ok, error }) {
  try {
    const entry = { dateKey, closing, ok, error: error || null, sentAt: new Date().toISOString() };
    await getCollection(STATE_COLLECTION).updateOne(
      { _id: STATE_ID },
      { $set: ok ? { lastSentDateKey: dateKey } : {}, $push: { history: { $each: [entry], $slice: -HISTORY_LIMIT } } },
      { upsert: true }
    );
  } catch (e) {
    logger.error('[DEPLOYED-SUMMARY-DIGEST] Could not record run state (non-fatal):', e?.message || e);
  }
}

/**
 * Builds and sends the digest for "today".
 *
 * @param {object} [opts]
 * @param {string} [opts.testRecipient] - send to this ONE address instead of
 *   the real recipient list, subject prefixed "[TEST]", never checked
 *   against or recorded into the idempotency state.
 * @param {Date} [opts.now] - override "today" for testing (only affects the
 *   idempotency dateKey, not which month's data is sent — that always
 *   follows the live data's own latest row).
 */
export async function sendDeployedSummaryDigest({ testRecipient, now } = {}) {
  const today = now ? new Date(now) : new Date();
  const dateKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  if (!testRecipient) {
    const state = await getState();
    if (state?.lastSentDateKey === dateKey) {
      logger.info(`[DEPLOYED-SUMMARY-DIGEST] ${dateKey} already sent — skipping duplicate run.`);
      return { ok: true, dateKey, skipped: true };
    }
  }

  try {
    const { buffer, filename, latest, recentCount, finalBillingCount, diff } = await buildDeployedSummaryExcel({ now });

    const { subject, body, html } = buildDigestEmail({ latest, recentCount, finalBillingCount, diff });
    const finalSubject = testRecipient ? `[TEST] ${subject}` : subject;
    const to = testRecipient || REPORT_RECIPIENTS.join(', ');

    const res = await sendMail({
      to, subject: finalSubject, body, html,
      attachments: [{ filename, content: buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }]
    });
    logger.info(`[DEPLOYED-SUMMARY-DIGEST] ${latest.month} (${dateKey}) — Closing: ${latest.closing.total}, recently updated: ${recentCount}, final billing this month: ${finalBillingCount} -> ${to} — ${res.ok ? 'sent' : `FAILED: ${res.error}`}`);

    if (!testRecipient) {
      await recordRun({ dateKey, closing: latest.closing.total, ok: res.ok, error: res.error });
    }

    return { ok: res.ok, dateKey, month: latest.month, closing: latest.closing.total, recentCount, finalBillingCount, error: res.error };
  } catch (e) {
    const error = e?.message || String(e);
    logger.error(`[DEPLOYED-SUMMARY-DIGEST] ${dateKey} FAILED to build/send:`, error);
    if (!testRecipient) {
      await recordRun({ dateKey, closing: null, ok: false, error });
    }
    return { ok: false, dateKey, error };
  }
}
