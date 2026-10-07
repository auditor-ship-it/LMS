/**
 * MONTHLY RENEW & OFF-LEASE REPORT
 *
 * Explicit request 2026-10-07: one automated email on the 1st of every month,
 * covering the COMPLETE PREVIOUS CALENDAR MONTH's renewal approvals and
 * off-lease activity — to pushpa.shetty@crystalgroup.in and
 * shivani.dhall@crystalgroup.in. Read-only: this only reads existing data
 * (Renewal Log, the Off-Lease dashboard) and sends a summary — it does not
 * touch the Renew or Off-Lease workflow in any way.
 *
 * DATA SOURCES (reused, not duplicated):
 *  - Renew: expiry.service.js's getRenewalLogReport(null) — the Renewal Log
 *    sheet, append-only, one row per renewal APPROVAL (see _logRenewal's own
 *    call site: it only ever runs from decideRenewalApproval's 'approved'
 *    branch — a row existing here already means "Approved", there is no
 *    other state to filter on). Already resolves Sale Person (CRM-based) the
 *    same way the in-app Agreement Renewal Report does.
 *  - Off-Lease: offlease.service.js's getOffLeaseDashboardData(null) — the
 *    same data the Off-Lease dashboard/Reports page reads, filtered here to
 *    containers RAISED (Stage 1 intimation date) within the target month —
 *    see collectOffLeaseRows' own doc comment for why this isn't gated on
 *    full completion the way Renew's "completed/approved" is.
 *
 * Both reads pass `null` for `user` — same "unscoped, every row, admin-style"
 * convention leaseExpiryDigest.service.js already uses for its own
 * whole-company daily digest, not a per-salesperson report.
 *
 * MONTH BOUNDARY: "Renewed/Approved on" and "Off-Lease completed on" are both
 * read from the sheet's own recorded timestamp (parsed back via this file's
 * own parseAnyTimestamp, below) — never the date this job happens to run on,
 * per the explicit request's own date-filtering rule.
 */
import { getRenewalLogReport } from './expiry.service.js';
import { getOffLeaseDashboardData } from './offlease.service.js';
import { sendMail } from './email.service.js';
import { getCollection } from './mongo.service.js';
import { parseDmyTime } from '../utils/format.js';
import { logger } from '../utils/logger.js';

/**
 * Both source timestamps (Renewal Log's own column, and an Off-Lease stage's
 * `timestamp`) are supposed to be dmyTime's "dd/MM/yyyy HH:mm:ss", but real
 * data confirmed live 2026-10-07 also holds two older shapes from before
 * call sites were switched to dmyTime: a dash-separated "dd-MM-yyyy HH:mm"
 * and raw ISO strings ("2026-09-23T10:26:40.557Z") — parseDmyTime alone
 * returned null for the MAJORITY of real rows, which silently zeroed out
 * this report. Tries, in order: parseDmyTime (slash), the same digit pattern
 * with a dash delimiter, then a native Date parse (handles ISO and anything
 * else JS already understands) — same "fall back to new Date(s)" escape
 * hatch parseDmyTime's own doc comment names for exactly this situation.
 */
function parseAnyTimestamp(s) {
  if (!s) return null;
  const slash = parseDmyTime(s);
  if (slash) return slash;

  const m = String(s).trim().match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [, dd, mo, yy, hh, mi, ss] = m;
    let year = parseInt(yy, 10);
    if (year < 100) year += 2000;
    const d = new Date(year, parseInt(mo, 10) - 1, parseInt(dd, 10), hh ? parseInt(hh, 10) : 0, mi ? parseInt(mi, 10) : 0, ss ? parseInt(ss, 10) : 0);
    if (!isNaN(d.getTime())) return d;
  }

  const native = new Date(s);
  return isNaN(native.getTime()) ? null : native;
}

const REPORT_RECIPIENTS = ['pushpa.shetty@crystalgroup.in', 'shivani.dhall@crystalgroup.in'];

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

/** The STATE doc this job's idempotency check reads/writes — same
 *  "_runtime_config, one fixed-id doc" convention runtimeSecrets.js already
 *  uses, rather than a new collection for one boolean. */
const STATE_COLLECTION = '_runtime_config';
const STATE_ID = 'monthlyReportState';
/* How many past runs to keep inline on the state doc for a quick "did this
   actually run, and what happened" check without a separate log viewer —
   this job fires once a month, so even years of history here stays tiny. */
const HISTORY_LIMIT = 24;

/** The calendar month immediately before `now` — `{ year, month0 (0-based),
 *  label: "August 2026", monthKey: "2026-08", start, end }`. `start`/`end`
 *  bound the WHOLE month, start of day 1 through end of the last day. */
function previousMonthRange(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-based CURRENT month
  const month0 = m === 0 ? 11 : m - 1;
  const year = m === 0 ? y - 1 : y;
  const start = new Date(year, month0, 1, 0, 0, 0, 0);
  const end = new Date(year, month0 + 1, 0, 23, 59, 59, 999); // day 0 of next month = last day of this one
  const monthKey = `${year}-${String(month0 + 1).padStart(2, '0')}`;
  return { year, month0, label: `${MONTH_NAMES[month0]} ${year}`, monthKey, start, end };
}

function inRange(timestampString, start, end) {
  const d = parseAnyTimestamp(timestampString);
  if (!d) return false;
  return d >= start && d <= end;
}

/** Every Renewal Log row approved within [start, end]. */
async function collectRenewRows(start, end) {
  const { data } = await getRenewalLogReport(null);
  return data
    .filter((r) => inRange(r.timestamp, start, end))
    .map((r) => ({
      timestamp: r.timestamp,
      container: r.container,
      clientName: r.clientName,
      poNo: r.poNo,
      validTill: r.validTill,
      updatedBy: r.updatedBy,
      saleExec: r.saleExec,
      // Every Renewal Log row IS an approval — see this file's header note.
      approvalStatus: 'Approved'
    }));
}

/**
 * Every off-lease case RAISED within [start, end] — i.e. its Stage 1
 * (Off-Lease Intimation) date falls in the target month, same
 * "Off-Lease Intimation Date (col 10), never a future projection" field the
 * dashboard's own month-wise grouping already uses (see
 * offlease.service.js's `intimationDate` doc comment).
 *
 * Deliberately NOT gated on full Stage 8 completion the way Renew's own
 * "completed/approved" is: the original request only puts that qualifier on
 * the Renew section ("Renew cases completed/approved"), not the Off-Lease
 * one ("Total number of Off-Lease cases") — and confirmed live 2026-10-07,
 * EVERY off-lease record in the current dataset is still mid-pipeline (zero
 * have reached stageClass 'done' at all), so a completion-only filter would
 * make this report permanently empty. "Current/final status" below reports
 * wherever each case actually stands, whatever that is this month.
 */
async function collectOffLeaseRows(start, end) {
  const { items } = await getOffLeaseDashboardData(null);
  const rows = [];
  for (const it of items) {
    if (!inRange(it.intimationDate, start, end)) continue;
    // The latest stage with an actual remark recorded, if any — stage order,
    // not array order, so a later stage's remark wins over an earlier one.
    const withRemark = [...(it.stages || [])].reverse().find((s) => s.done && s.remark);
    rows.push({
      offLeaseDate: it.intimationDate,
      container: it.container,
      leaseId: it.leaseId,
      clientName: it.clientName,
      raisedBy: it.raisedBy,
      currentStage: it.currentStage,
      remark: withRemark?.remark || ''
    });
  }
  return rows;
}

function money(v) { return v == null || v === '' ? '' : v; }

function buildReportEmail({ label, renewRows, offLeaseRows }) {
  const subject = `Monthly Renew & Off-Lease Report – ${label}`;
  const total = renewRows.length + offLeaseRows.length;

  const th = (s) => `<th style="padding:8px 12px;border:1px solid #ddd;background:#f4f4f4;font-size:12.5px;text-align:left;white-space:nowrap;">${s}</th>`;
  const td = (s) => `<td style="padding:8px 12px;border:1px solid #ddd;font-size:12.5px;">${s === '' || s == null ? '-' : s}</td>`;

  const renewTable = renewRows.length
    ? `<table style="border-collapse:collapse;font-family:Arial,sans-serif;margin-bottom:20px;">
        <tr>${th('Renewed / Approved On')}${th('Container No')}${th('Client Name')}${th('Sale Person')}${th('PO No')}${th('Valid Till')}${th('Approval Status')}${th('Updated By')}</tr>
        ${renewRows.map((r) => `<tr>${td(r.timestamp)}${td(r.container)}${td(r.clientName)}${td(r.saleExec)}${td(r.poNo)}${td(r.validTill)}${td(r.approvalStatus)}${td(r.updatedBy)}</tr>`).join('')}
      </table>`
    : `<p style="font-family:Arial,sans-serif;">No renewals were approved in ${label}.</p>`;

  const offLeaseTable = offLeaseRows.length
    ? `<table style="border-collapse:collapse;font-family:Arial,sans-serif;">
        <tr>${th('Off-Lease Date')}${th('Container No')}${th('Lease ID')}${th('Client Name')}${th('Raised By')}${th('Current Status')}${th('Remarks')}</tr>
        ${offLeaseRows.map((r) => `<tr>${td(r.offLeaseDate)}${td(r.container)}${td(r.leaseId)}${td(r.clientName)}${td(r.raisedBy)}${td(r.currentStage)}${td(r.remark)}</tr>`).join('')}
      </table>`
    : `<p style="font-family:Arial,sans-serif;">No off-lease cases were raised in ${label}.</p>`;

  const html = `
    <h2 style="font-family:Arial,sans-serif;">Monthly Renew &amp; Off-Lease Report – ${label}</h2>
    <table style="border-collapse:collapse;font-family:Arial,sans-serif;margin-bottom:20px;">
      <tr>${th('Total Renew')}${td(renewRows.length)}</tr>
      <tr>${th('Total Off-Lease')}${td(offLeaseRows.length)}</tr>
      <tr>${th('Total Combined Activities')}${td(total)}</tr>
    </table>
    <h3 style="font-family:Arial,sans-serif;">Renew</h3>
    ${renewTable}
    <h3 style="font-family:Arial,sans-serif;">Off-Lease</h3>
    ${offLeaseTable}
  `;

  const body = [
    `Monthly Renew & Off-Lease Report – ${label}`, '',
    `Total Renew: ${renewRows.length}`,
    `Total Off-Lease: ${offLeaseRows.length}`,
    `Total Combined Activities: ${total}`, '',
    'RENEW', ...(renewRows.length
      ? renewRows.map((r) => `${r.timestamp} | ${r.container} | ${r.clientName} | ${r.saleExec} | PO ${money(r.poNo)} | Valid Till ${r.validTill} | ${r.approvalStatus} | ${r.updatedBy}`)
      : [`No renewals were approved in ${label}.`]),
    '', 'OFF-LEASE', ...(offLeaseRows.length
      ? offLeaseRows.map((r) => `${r.offLeaseDate} | ${r.container} | ${r.leaseId} | ${r.clientName} | Raised by ${r.raisedBy} | ${r.currentStage}${r.remark ? ` | ${r.remark}` : ''}`)
      : [`No off-lease cases were raised in ${label}.`])
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

async function recordRun({ monthKey, renewCount, offLeaseCount, ok, error }) {
  try {
    const entry = {
      monthKey, renewCount, offLeaseCount, ok,
      error: error || null,
      sentAt: new Date().toISOString()
    };
    await getCollection(STATE_COLLECTION).updateOne(
      { _id: STATE_ID },
      {
        $set: ok ? { lastSentMonthKey: monthKey } : {},
        $push: { history: { $each: [entry], $slice: -HISTORY_LIMIT } }
      },
      { upsert: true }
    );
  } catch (e) {
    logger.error('[MONTHLY-REPORT] Could not record run state (non-fatal):', e?.message || e);
  }
}

/**
 * Builds and sends the monthly report for the calendar month before `now`
 * (real runs always call this with no `now` — it defaults to the actual
 * current date; a fixed `now` is only for ad-hoc verification).
 *
 * @param {object} [opts]
 * @param {string} [opts.testRecipient] - send to this ONE address instead of
 *   the real pushpa/shivani list, subject prefixed "[TEST]", and — crucially
 *   — never checked against or recorded into the idempotency state, so a
 *   manual test send can never block (or fake) the real monthly send.
 * @param {Date} [opts.now] - override "today" for testing a specific month.
 * @returns {Promise<{ok:boolean, monthKey:string, label:string, renewCount:number, offLeaseCount:number, error?:string}>}
 */
export async function sendMonthlyReport({ testRecipient, now } = {}) {
  const { label, monthKey, start, end } = previousMonthRange(now || new Date());

  if (!testRecipient) {
    const state = await getState();
    if (state?.lastSentMonthKey === monthKey) {
      logger.info(`[MONTHLY-REPORT] ${monthKey} (${label}) already sent — skipping duplicate run.`);
      return { ok: true, monthKey, label, skipped: true };
    }
  }

  try {
    const [renewRows, offLeaseRows] = await Promise.all([
      collectRenewRows(start, end),
      collectOffLeaseRows(start, end)
    ]);

    const { subject, body, html } = buildReportEmail({ label, renewRows, offLeaseRows });
    const finalSubject = testRecipient ? `[TEST] ${subject}` : subject;
    const to = testRecipient || REPORT_RECIPIENTS.join(', ');

    const res = await sendMail({ to, subject: finalSubject, body, html });
    logger.info(`[MONTHLY-REPORT] ${monthKey} (${label}) — Renew: ${renewRows.length}, Off-Lease: ${offLeaseRows.length} -> ${to} — ${res.ok ? 'sent' : `FAILED: ${res.error}`}`);

    if (!testRecipient) {
      await recordRun({ monthKey, renewCount: renewRows.length, offLeaseCount: offLeaseRows.length, ok: res.ok, error: res.error });
    }

    return { ok: res.ok, monthKey, label, renewCount: renewRows.length, offLeaseCount: offLeaseRows.length, error: res.error };
  } catch (e) {
    const error = e?.message || String(e);
    logger.error(`[MONTHLY-REPORT] ${monthKey} (${label}) FAILED to build/send:`, error);
    if (!testRecipient) {
      await recordRun({ monthKey, renewCount: 0, offLeaseCount: 0, ok: false, error });
    }
    return { ok: false, monthKey, label, error };
  }
}
