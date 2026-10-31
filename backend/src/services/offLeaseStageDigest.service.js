/**
 * OFF-LEASE STAGE-WISE PENDING DIGEST
 *
 * Explicit request 2026-10-31 ("stage wise pending task offlease ke mails
 * jana chhaiye... har stage ke responsible person ko alag mail... counts
 * and data"): one SEPARATE email per Off-Lease stage, to that stage's own
 * responsible person, listing what's currently pending there — count plus
 * the actual container/client list, not just a number. Sent twice daily,
 * 10:00 AM and 5:00 PM (jobs/index.js).
 *
 * STAGE OWNERS — exactly the table the user supplied live (not derived from
 * tasks.service.js's own MY_TASK_BY_EMAIL_BACKEND, which only covers 4 of
 * these 10 and uses a different Stage 1 address — sc@crystalgroup.in there
 * vs crm@crystalgroup.in here; this table is the authoritative one for this
 * digest specifically). Stage 7 (Payment Status) was not in that table and
 * is deliberately NOT included here — add it if/when an owner is given.
 *
 * DATA SOURCE: Stage 1/1A/2/3/4/5/6 all come from ONE call to
 * getOffLeaseDashboardData(null) (offlease.service.js) — the exact same
 * guaranteed-consistent per-row `pendingStages`/`stageClass` the Off-Lease
 * pipeline tabs and My Task counts already use, so this digest's numbers
 * can never drift from what the app itself shows. Stage 6A/6B/6C (HOD/
 * Accounts/CEO SD Refund approval) come from a separate call to
 * getRefundEntries(null) (refunds.service.js) — a different sheet
 * (Refunds, not Off-Lease Tracking) with its own `currentStage` field.
 * Both functions accept a null "caller" and return the full, unscoped data
 * — the same convention the public API's `reuse()` and this file's own
 * sibling digests already rely on.
 *
 * Each stage with zero pending items today is skipped entirely — same
 * "nothing to report, don't spam" posture renewalReminderDigest.service.js
 * uses, rather than sending an empty-table email to someone with nothing
 * to do.
 */
import { getOffLeaseDashboardData } from './offlease.service.js';
import { getRefundEntries } from './refunds.service.js';
import { sendMail } from './email.service.js';
import { logger } from '../utils/logger.js';

/* Internal Off-Lease stage number (offlease.service.js's OL_STAGE_INFO) that
 * each DISPLAY stage below maps to — same mapping OL_ACTIVE_STAGE_NUMS/
 * displayStageNum use elsewhere in this app. '1A' has no internal number of
 * its own (it's the approval gate between Stage 1 and Transportation) —
 * matched via stageClass === 'approval' instead, see buildOffLeaseStageGroups. */
const DISPLAY_TO_INTERNAL = { 1: 1, 2: 6, 3: 7, 4: 3, 5: 5, 6: 11 };

const STAGE_OWNERS = {
  1: { email: 'crm@crystalgroup.in', label: 'Stage 1 (Off-Lease Intimation)' },
  '1A': { email: 'pushpa.shetty@crystalgroup.in', label: 'Stage 1A (Intimation Approval)' },
  2: { email: 'kshirod.khatua@crystalgroup.in', label: 'Stage 2 (Transportation)' },
  3: { email: 'mum.depot@crystalgroup.in', label: 'Stage 3 (Gate In)' },
  4: { email: 'service@crystalgroup.in', label: 'Stage 4 (Inspection Checklist)' },
  5: { email: 'shivani.dhall@crystalgroup.in', label: 'Stage 5 (Billing Reconciliation)' },
  6: { email: 'crm@crystalgroup.in', label: 'Stage 6 (SD Refunds)' },
  '6A': { email: 'pushpa.shetty@crystalgroup.in', label: 'Stage 6A (HOD Approval)' },
  '6B': { email: 'shivani.dhall@crystalgroup.in', label: 'Stage 6B (Accounts Approval)' },
  '6C': { email: 'aa@crystalgroup.in', label: 'Stage 6C (CEO Approval)' }
};

/** `{ displayStage: [{ container, clientName, extra }] }` for stages
 *  1/1A/2/3/4/5/6 — all read from the one dashboard payload passed in. */
function buildOffLeaseStageGroups(items) {
  const groups = { 1: [], '1A': [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const it of items) {
    if (it.stageClass === 'approval') groups['1A'].push({ container: it.container, clientName: it.clientName });
    for (const [display, internal] of Object.entries(DISPLAY_TO_INTERNAL)) {
      if (it.pendingStages?.includes(internal)) groups[display].push({ container: it.container, clientName: it.clientName });
    }
  }
  return groups;
}

/** `{ '6A': [...], '6B': [...], '6C': [...] }` from the Refunds sheet's own
 *  currentStage ('hod'/'accounts'/'ceo') — see refunds.service.js's
 *  _mapRow for the exact field shape. */
function buildRefundStageGroups(entries) {
  const key = { hod: '6A', accounts: '6B', ceo: '6C' };
  const groups = { '6A': [], '6B': [], '6C': [] };
  for (const r of entries) {
    const g = key[r.currentStage];
    if (g) groups[g].push({ container: r.containerNo, clientName: r.clientName, vendorName: r.vendorName, amountToPay: r.amountToPay });
  }
  return groups;
}

function buildStageEmail(displayStage, rows) {
  const { label } = STAGE_OWNERS[displayStage];
  const hasExtra = rows.some((r) => r.vendorName != null);
  const th = (s) => `<th style="padding:8px 12px;border:1px solid #ddd;background:#f4f4f4;font-size:12.5px;text-align:left;">${s}</th>`;
  const td = (s) => `<td style="padding:8px 12px;border:1px solid #ddd;font-size:12.5px;">${s === '' || s == null ? '-' : s}</td>`;
  const table = `
    <table style="border-collapse:collapse;font-family:Arial,sans-serif;margin-top:16px;">
      <tr>${th('Container')}${th('Client')}${hasExtra ? `${th('Vendor')}${th('Amount')}` : ''}</tr>
      ${rows.map((r) => `<tr>${td(r.container)}${td(r.clientName)}${hasExtra ? `${td(r.vendorName)}${td(r.amountToPay)}` : ''}</tr>`).join('')}
    </table>
  `;
  const subject = `Off-Lease ${label} — ${rows.length} pending`;
  const body = `${label} — ${rows.length} pending:\n\n`
    + rows.map((r) => `${r.container} | ${r.clientName}${hasExtra ? ` | ${r.vendorName} | ${r.amountToPay}` : ''}`).join('\n') + '\n';
  const html = `<p>${label} — <b>${rows.length}</b> pending.</p>${table}`;
  return { subject, body, html };
}

export async function sendOffLeaseStageDigest() {
  const [{ items }, refundEntries] = await Promise.all([
    getOffLeaseDashboardData(null),
    getRefundEntries(null)
  ]);

  const groups = { ...buildOffLeaseStageGroups(items), ...buildRefundStageGroups(refundEntries) };

  let sent = 0;
  for (const [displayStage, owner] of Object.entries(STAGE_OWNERS)) {
    const rows = groups[displayStage] || [];
    if (!rows.length) continue;
    const { subject, body, html } = buildStageEmail(displayStage, rows);
    const res = await sendMail({ to: owner.email, subject, body, html });
    logger.info(`[OFFLEASE-STAGE-DIGEST] ${owner.label} (${rows.length} pending) -> ${owner.email} — ${res.ok ? 'sent' : `FAILED: ${res.error}`}`);
    sent++;
  }
  if (!sent) logger.info('[OFFLEASE-STAGE-DIGEST] nothing pending anywhere — skipped');
}
