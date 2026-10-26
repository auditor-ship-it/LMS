/**
 * MONTHLY DEPLOYED SUMMARY DIGEST
 *
 * Explicit request 2026-10-23: a monthly email showing the Deployed Summary
 * page's own numbers (Opening/Addition/Deletion/Net/Closing, the exact same
 * month-wise movement table shown on that page), with an Excel attachment
 * matching what its own "Export to Excel" button produces — to
 * pushpa.shetty@crystalgroup.in, shivani.dhall@crystalgroup.in and
 * mansi.agarwal@crystalgroup.in, same recipients as the other monthly
 * digests. Separate from poAgreementDigest.service.js (that one is about
 * which containers need their PO/Agreement renewed — this one is the
 * month-wise deployed-container movement count).
 *
 * Skeleton (recipients list, idempotency state doc, testRecipient/now
 * pattern, cron registration) copied from poAgreementDigest.service.js.
 *
 * EXCEL ATTACHMENT: the page's own exportToExcel()
 * (frontend/src/pages/deployedSummary/DeployedSummaryPage.jsx) builds this
 * client-side with the `xlsx` (SheetJS) package from already-fetched JSON —
 * there was no server-side equivalent. This mirrors both of its sheets:
 * "Summary" (totals per month, not broken out by type/size — the page's own
 * type/size breakdown is a client-side filter on the same JSON, not
 * meaningful in a single static monthly snapshot) and "Deployed Containers"
 * (explicit request 2026-10-23: every currently-deployed container, not
 * just the totals — same getDeployedDetailData('closing') call and column
 * set the page's own export uses), using the same `xlsx` package added to
 * the backend for this purpose.
 */
import * as XLSX from 'xlsx';
import { getDeployedSummaryData, getDeployedDetailData } from './dashboard.service.js';
import { sendMail } from './email.service.js';
import { getCollection } from './mongo.service.js';
import { logger } from '../utils/logger.js';

const REPORT_RECIPIENTS = ['pushpa.shetty@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'mansi.agarwal@crystalgroup.in'];

const STATE_COLLECTION = '_runtime_config';
const STATE_ID = 'deployedSummaryDigestState';
const HISTORY_LIMIT = 24;

const SUMMARY_GROUPS = [
  ['opening', 'Opening Deployed'],
  ['addition', 'Addition'],
  ['deletion', 'Deletion'],
  ['net', 'Net Movement'],
  ['closing', 'Closing Deployed'],
];

const CONTAINER_HEADERS = [
  'Container', 'Order No', 'Client Code', 'Client Name', 'Size', 'Type',
  'Billing Type', 'Agreement PDF', 'PO PDF', 'Location', 'Deployed Date', 'Valid Upto'
];

function containerToRow(c) {
  return [
    c.container, c.orderNo, c.clientCode, c.clientName, c.size, c.type,
    c.billingType, c.agreementUrl, c.poAttachment, c.location, c.deployedDate, c.validUpto
  ];
}

function buildWorkbookBuffer(data, containers) {
  const summaryAoa = [['Category', ...data.months]];
  for (const [key, label] of SUMMARY_GROUPS) {
    summaryAoa.push([label, ...data.rows.map((r) => r[key].total)]);
  }
  const summaryWs = XLSX.utils.aoa_to_sheet(summaryAoa);

  const containersAoa = [CONTAINER_HEADERS, ...containers.map(containerToRow)];
  const containersWs = XLSX.utils.aoa_to_sheet(containersAoa);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, summaryWs, 'Summary');
  XLSX.utils.book_append_sheet(wb, containersWs, 'Deployed Containers');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function buildDigestEmail({ latest }) {
  const subject = `Deployed Summary – ${latest.month}`;

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
      Attached as Excel: the full month-wise movement table (all months), plus the complete list of every currently deployed container (Container No, Client, Size, Type, Location, Deployed Date, Valid Upto, etc.).
    </p>
  `;

  const body = [
    `Deployed Summary – ${latest.month}`, '',
    `Opening Deployed: ${latest.opening.total}`,
    `Addition: ${latest.addition.total}`,
    `Deletion: ${latest.deletion.total}`,
    `Net Movement: ${latest.net.total}`,
    `Closing Deployed: ${latest.closing.total}`, '',
    'Attached as Excel: the full month-wise movement table, plus the complete list of every currently deployed container.'
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

async function recordRun({ monthKey, closing, ok, error }) {
  try {
    const entry = { monthKey, closing, ok, error: error || null, sentAt: new Date().toISOString() };
    await getCollection(STATE_COLLECTION).updateOne(
      { _id: STATE_ID },
      { $set: ok ? { lastSentMonthKey: monthKey } : {}, $push: { history: { $each: [entry], $slice: -HISTORY_LIMIT } } },
      { upsert: true }
    );
  } catch (e) {
    logger.error('[DEPLOYED-SUMMARY-DIGEST] Could not record run state (non-fatal):', e?.message || e);
  }
}

/**
 * Builds and sends the digest for the CURRENT month (data.rows[0] — the
 * Deployed Summary data is already built latest-month-first).
 *
 * @param {object} [opts]
 * @param {string} [opts.testRecipient] - send to this ONE address instead of
 *   the real recipient list, subject prefixed "[TEST]", never checked
 *   against or recorded into the idempotency state.
 * @param {Date} [opts.now] - override "today" for testing (only affects the
 *   idempotency monthKey, not which month's data is sent — that always
 *   follows the live data's own latest row).
 */
export async function sendDeployedSummaryDigest({ testRecipient, now } = {}) {
  const today = now ? new Date(now) : new Date();
  const monthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

  if (!testRecipient) {
    const state = await getState();
    if (state?.lastSentMonthKey === monthKey) {
      logger.info(`[DEPLOYED-SUMMARY-DIGEST] ${monthKey} already sent — skipping duplicate run.`);
      return { ok: true, monthKey, skipped: true };
    }
  }

  try {
    const data = await getDeployedSummaryData();
    const latest = data.rows[0];
    if (!latest) throw new Error('No Deployed Summary data available');

    const { containers } = await getDeployedDetailData(latest.month, 'closing', null, null);

    const { subject, body, html } = buildDigestEmail({ latest });
    const finalSubject = testRecipient ? `[TEST] ${subject}` : subject;
    const to = testRecipient || REPORT_RECIPIENTS.join(', ');

    const buffer = buildWorkbookBuffer(data, containers);
    const filename = `Deployed-Summary-${latest.month.replace(/\s+/g, '-')}.xlsx`;

    const res = await sendMail({
      to, subject: finalSubject, body, html,
      attachments: [{ filename, content: buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }]
    });
    logger.info(`[DEPLOYED-SUMMARY-DIGEST] ${latest.month} — Closing: ${latest.closing.total} -> ${to} — ${res.ok ? 'sent' : `FAILED: ${res.error}`}`);

    if (!testRecipient) {
      await recordRun({ monthKey, closing: latest.closing.total, ok: res.ok, error: res.error });
    }

    return { ok: res.ok, monthKey, month: latest.month, closing: latest.closing.total, error: res.error };
  } catch (e) {
    const error = e?.message || String(e);
    logger.error(`[DEPLOYED-SUMMARY-DIGEST] ${monthKey} FAILED to build/send:`, error);
    if (!testRecipient) {
      await recordRun({ monthKey, closing: null, ok: false, error });
    }
    return { ok: false, monthKey, error };
  }
}
