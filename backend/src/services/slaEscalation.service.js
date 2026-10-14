/**
 * L7 — OFF-LEASE SLA ESCALATION (Issue #55)
 *
 * Nobody is currently notified when an off-lease stage breaches its SLA_MS
 * budget (offleaseSla.service.js) — it is only ever visible live, on the
 * Container Lookup screen. This job closes that gap: stage owner at breach,
 * backup after a grace period, manager after a second grace period.
 *
 * DATA TOUCHED: the Mongo mirror ONLY, via offlease.service.js's
 * getOffLeaseDashboardData (the same "list active off-lease containers"
 * source the KPI dashboard itself uses) and offleaseSla.service.js's
 * computeContainerSla (the SAME code path the Container Lookup controller
 * now also calls — see that function's doc comment). This is a "Class 3"
 * job (Mongo-only, no Sheets/FMS quota) — it must never gain a live Sheets
 * or FMS call; see jobs/index.js's own header for why Sheets read quota is
 * this app's scarcest resource.
 *
 * GATED behind `_runtime_config.featureFlags.slaEscalation` (default OFF).
 * Cheap to call every cycle while off — it logs and returns before listing
 * any containers.
 *
 * DEDUP: a unique index on `_sla_alerts` over
 * (containerNo, offLeaseId, stage, startedAt, level) is the actual
 * mechanism — this inserts the key BEFORE sending, and a duplicate-key
 * error (Mongo code 11000) on that insert means "already sent, skip" rather
 * than "an error". `startedAt` comes from the stage's own sla.startedAt (set
 * by applySla from the stage's own clock-start timestamp), so a stage that
 * resets into a new cycle gets a fresh key and escalates again if it
 * re-breaches.
 *
 * BASELINE ON FIRST RUN: if `_sla_alerts` has never been written to, the
 * very first invocation does not fire one escalation email per stage that
 * was ALREADY breached before this feature existed — it would be a flood of
 * backdated noise, not a useful alert. Instead it inserts a `level:
 * 'baseline'` dedup row for each currently-breached stage (so normal
 * escalation levels start fresh from "now" and don't instantly re-fire for
 * old breaches) and sends ONE summary email.
 *
 * TC-L7-1's "reminder at 75% of TAT, not delayed" is a different, EARLIER
 * signal than a breach — the issue's own "Technical approach" section never
 * actually describes a mechanism for it (only owner/backup/manager-at-breach
 * are designed there), which is an inconsistency in the issue as written.
 * Resolved here by building a small, separate reminder path
 * (offleaseSla.service.js's isSlaReminderDue) rather than silently dropping
 * TC-L7-1 or stretching the breach levels to cover a case they don't fit.
 */
import {
  computeContainerSla,
  classifyBreachLevel,
  isSlaReminderDue,
  isPlaceholderOrMissing,
  getSlaRouting,
  SLA_GRACE_MS
} from './offleaseSla.service.js';
import { getOffLeaseDashboardData } from './offlease.service.js';
import { sendMail } from './email.service.js';
import { getCollection } from './mongo.service.js';
import { logger } from '../utils/logger.js';

/* Same fallback address every other cross-team notification in this app
 * already uses when it has nobody better to send to (see
 * leaseExpiryDigest.service.js's own FALLBACK_EMAIL doc comment, and
 * offlease.service.js's/expiry.service.js's notification senders). Also
 * doubles as the "process owner" for the first-run baseline summary — a
 * TODO placeholder would be just as fake as not having one, and this one at
 * least already reaches a real, checked inbox. */
const FALLBACK_EMAIL = 'support@crystalgroup.in';

const ALERTS_COLLECTION = '_sla_alerts';
const FEATURE_FLAGS_COLLECTION = '_runtime_config';
const FEATURE_FLAGS_ID = 'featureFlags';

/* Lookup link — same "hardcode the known production frontend origin, no env
 * var" convention refunds.service.js's own REFUND_EMAIL_APP_URL already
 * uses (there is no FRONTEND_BASE_URL/APP_URL env var anywhere in this
 * codebase; env.js was read in full confirming this). Route path + query
 * param convention confirmed live in
 * frontend/src/pages/offLease/PipelineDashboard.jsx's own openRecord: `/off-
 * lease/record?container=...&leaseId=...`. */
const LOOKUP_APP_URL = 'https://lease.crystalgrp.xyz/off-lease/record';

function lookupLink(containerNo, offLeaseId) {
  const q = new URLSearchParams({ container: containerNo });
  if (offLeaseId) q.set('leaseId', offLeaseId);
  return `${LOOKUP_APP_URL}?${q}`;
}

/* =====================================================================
   Feature flags — same "_runtime_config, one fixed-id doc, code default
   always present as fallback" convention as runtimeSecrets.js/
   monthlyReport.service.js/offleaseSla.service.js's own getSlaRouting.
===================================================================== */
const FEATURE_FLAG_DEFAULTS = { slaEscalation: false, slaEscalationCeo: false };

async function getFeatureFlags() {
  try {
    const doc = await getCollection(FEATURE_FLAGS_COLLECTION).findOne({ _id: FEATURE_FLAGS_ID });
    return { ...FEATURE_FLAG_DEFAULTS, ...(doc || {}) };
  } catch (e) {
    logger.error('[SLA-ESCALATION] Could not load feature flags from Mongo (defaulting OFF):', e?.message || e);
    return { ...FEATURE_FLAG_DEFAULTS };
  }
}

/* =====================================================================
   Dedup index — same lazy "ensure once per process" pattern
   apiKeys.service.js's own ensureIndex uses.
===================================================================== */
let indexEnsured = false;
async function ensureAlertsIndex() {
  if (indexEnsured) return;
  indexEnsured = true;
  try {
    await getCollection(ALERTS_COLLECTION).createIndex(
      { containerNo: 1, offLeaseId: 1, stage: 1, startedAt: 1, level: 1 },
      { unique: true, name: 'sla_alert_dedup' }
    );
  } catch (e) {
    logger.error('[SLA-ESCALATION] Failed to ensure _sla_alerts unique index:', e?.message || e);
  }
}

/** Every stage this scanner cares about, in the one shape it needs for both
 *  the breach-level stages (detail.stages, each already carrying its own
 *  `.sla` from applySla) and the approval gate (detail.approvalSla is the
 *  sla object directly, with no wrapping stage entry) — folded into one
 *  list so the rest of the scan doesn't need two separate code paths. */
function stageSlaEntries(computed) {
  const entries = (computed.detail?.stages || [])
    .filter((s) => s.sla)
    .map((s) => ({ stageKey: s.stage, stageName: s.label || String(s.stage), sla: s.sla }));
  if (computed.approvalSla) {
    entries.push({ stageKey: 'approval', stageName: 'Intimation Approval', sla: computed.approvalSla });
  }
  return entries;
}

/** Pure — the exact shape inserted into `_sla_alerts`. The dedup key Mongo's
 *  unique index actually enforces is (containerNo, offLeaseId, stage,
 *  startedAt, level); exported so this shape (and therefore the dedup key
 *  it produces for a given input) can be unit tested without a real Mongo
 *  connection — see slaEscalation.test.js TC-L7-4. */
export function buildAlertDoc({ containerNo, offLeaseId, stage, startedAt, level, to, cc, overdueBy }) {
  return {
    containerNo,
    offLeaseId: offLeaseId || '',
    stage: String(stage),
    startedAt,
    level,
    to,
    cc: cc || [],
    overdueBy: overdueBy || '',
    sentAt: new Date().toISOString(),
    ok: null // filled in after the send attempt
  };
}

/** Inserts the dedup key BEFORE sending — the insert succeeding is what
 *  authorizes the send; a duplicate-key error means "already sent, skip"
 *  and the caller never sends. Never throws for a duplicate key; any OTHER
 *  Mongo error is logged and also treated as "skip the send" (sending
 *  without a reliable dedup record would risk a flood on the next run that
 *  retries after a transient error). */
async function tryClaimAlert(doc) {
  try {
    await getCollection(ALERTS_COLLECTION).insertOne(doc);
    return true;
  } catch (e) {
    if (e?.code !== 11000) {
      logger.error('[SLA-ESCALATION] _sla_alerts insert failed (treating as already-sent, skipping send):', e?.message || e);
    }
    return false;
  }
}

async function markAlertResult(doc, ok) {
  try {
    await getCollection(ALERTS_COLLECTION).updateOne(
      { containerNo: doc.containerNo, offLeaseId: doc.offLeaseId, stage: doc.stage, startedAt: doc.startedAt, level: doc.level },
      { $set: { ok } }
    );
  } catch (e) { /* best-effort bookkeeping only — the dedup already happened via the insert */ }
}

function stageLabel(stageKey, stageName) {
  return stageName && stageName !== String(stageKey) ? `${stageName} (stage ${stageKey})` : `Stage ${stageKey}`;
}

function buildEscalationEmail({ level, container, offLeaseId, clientName, stageName, stageKey, overdueBy }) {
  const link = lookupLink(container, offLeaseId);
  const levelLabel = { owner: 'Owner', backup: 'Backup', manager: 'Manager' }[level] || level;
  const subject = `[SLA ${levelLabel === 'Owner' ? 'Breach' : 'Escalation'}] ${stageLabel(stageKey, stageName)} overdue — ${container}`;
  const body = [
    `${stageLabel(stageKey, stageName)} is overdue for container ${container}${offLeaseId ? ` (${offLeaseId})` : ''}.`,
    `Client: ${clientName || '-'}`,
    `Overdue by: ${overdueBy || '-'}`,
    `Escalation level: ${levelLabel}`,
    '',
    `Lookup: ${link}`
  ].join('\n');
  const html = `
    <p>${stageLabel(stageKey, stageName)} is overdue for container <strong>${container}</strong>${offLeaseId ? ` (${offLeaseId})` : ''}.</p>
    <p>
      Client: ${clientName || '-'}<br/>
      Overdue by: <strong>${overdueBy || '-'}</strong><br/>
      Escalation level: <strong>${levelLabel}</strong>
    </p>
    <p><a href="${link}">Open in Container Lookup</a></p>
  `;
  return { subject, body, html };
}

function buildReminderEmail({ container, offLeaseId, clientName, stageName, stageKey }) {
  const link = lookupLink(container, offLeaseId);
  const subject = `[SLA Reminder] ${stageLabel(stageKey, stageName)} at 75% of TAT — ${container}`;
  const body = [
    `${stageLabel(stageKey, stageName)} has used 75% of its time budget for container ${container}${offLeaseId ? ` (${offLeaseId})` : ''}.`,
    `Client: ${clientName || '-'}`,
    'This is not yet a breach — a heads-up so it doesn\'t become one.',
    '',
    `Lookup: ${link}`
  ].join('\n');
  const html = `
    <p>${stageLabel(stageKey, stageName)} has used 75% of its time budget for container <strong>${container}</strong>${offLeaseId ? ` (${offLeaseId})` : ''}.</p>
    <p>Client: ${clientName || '-'}</p>
    <p>This is not yet a breach — a heads-up so it doesn't become one.</p>
    <p><a href="${link}">Open in Container Lookup</a></p>
  `;
  return { subject, body, html };
}

/** Resolves the address(es) to notify for one stage/level. Returns
 *  `{ to, cc }` or `null` if the config for this stage/level is missing —
 *  TC-L7-5. `owner` is always cc'd once escalation reaches backup/manager,
 *  so the original owner stays in the loop rather than being dropped from
 *  the thread. */
export function resolveRecipients(routing, stageKey, level) {
  const row = routing[stageKey];
  if (!row) return null;
  const to = row[level];
  if (isPlaceholderOrMissing(to)) return null;
  const cc = [];
  if (level === 'backup' && !isPlaceholderOrMissing(row.owner)) cc.push(row.owner);
  if (level === 'manager') {
    if (!isPlaceholderOrMissing(row.owner)) cc.push(row.owner);
    if (!isPlaceholderOrMissing(row.backup)) cc.push(row.backup);
  }
  return { to, cc };
}

/**
 * Runs one SLA-escalation scan. Safe to call on a fixed schedule — it is a
 * no-op (after a feature-flag check) when nothing is overdue, and the
 * feature-flag check itself is a single Mongo read.
 *
 * @param {Date} [now] injectable clock, for tests/manual backdating.
 * @returns {Promise<object>} a summary — never throws.
 */
export async function runSlaEscalation(now = new Date()) {
  const flags = await getFeatureFlags();
  if (!flags.slaEscalation) {
    logger.info('[SLA-ESCALATION] featureFlags.slaEscalation is OFF — skipping scan.');
    return { ok: true, skipped: true };
  }

  await ensureAlertsIndex();
  const routing = await getSlaRouting();

  const summary = { ok: true, skipped: false, baseline: false, containersScanned: 0, sent: 0, reminders: 0, baselined: 0, errors: 0 };

  let isBaselineRun = false;
  try {
    isBaselineRun = (await getCollection(ALERTS_COLLECTION).countDocuments({})) === 0;
  } catch (e) {
    logger.error('[SLA-ESCALATION] Could not check _sla_alerts for baseline state (assuming NOT first run, to avoid repeatedly re-baselining):', e?.message || e);
  }
  summary.baseline = isBaselineRun;

  let items;
  try {
    const dashboard = await getOffLeaseDashboardData(null); // unscoped, every active container — same convention leaseExpiryDigest/monthlyReport already use for a background scan
    items = dashboard.items || [];
  } catch (e) {
    logger.error('[SLA-ESCALATION] Could not load the off-lease dashboard — aborting this scan (will retry next cycle):', e?.message || e);
    return { ...summary, ok: false, error: e?.message || String(e) };
  }

  const active = items.filter((item) => !item.completed && !item.onHold);
  // `onHold` above is getOffLeaseDashboardData's own `_isOnHold(row)` result,
  // already computed per-row inside that function — see offlease.service.js
  // line ~4418/5237. No need to re-derive it from a raw row here.

  const baselineRows = []; // for the one first-run summary email
  const configIssues = []; // for the one admin alert — TC-L7-5

  for (const item of active) {
    summary.containersScanned++;
    try {
      const computed = await computeContainerSla(item.container, { leaseId: item.leaseId });
      if (!computed.found) continue; // resolvable race (e.g. just completed/removed) — not an error

      for (const { stageKey, stageName, sla } of stageSlaEntries(computed)) {
        // -- TC-L7-1: 75%-of-TAT reminder (not yet a breach) --------------
        // Config checked BEFORE claiming the dedup slot (unlike a normal
        // breach, where the slot is always claimed once a level is
        // reached) — a reminder with no owner configured must NOT burn its
        // dedup key, or it can never be sent later once an address is
        // added, since startedAt won't change until the stage's next cycle.
        if (isSlaReminderDue(sla, { now })) {
          const row = routing[stageKey];
          if (!row || isPlaceholderOrMissing(row.owner)) {
            configIssues.push({ container: item.container, offLeaseId: item.leaseId, stage: stageKey, level: 'reminder' });
            logger.error(`[SLA-ESCALATION] No owner configured for stage ${stageKey} — cannot send 75% reminder for ${item.container}.`);
          } else {
            const doc = buildAlertDoc({
              containerNo: item.container, offLeaseId: item.leaseId, stage: stageKey,
              startedAt: sla.startedAt, level: 'reminder', to: row.owner, overdueBy: ''
            });
            const claimed = await tryClaimAlert(doc);
            if (claimed) {
              const { subject, body, html } = buildReminderEmail({ container: item.container, offLeaseId: item.leaseId, clientName: item.clientName, stageName, stageKey });
              const res = await sendMail({ to: row.owner, subject, body, html });
              summary.reminders++;
              await markAlertResult(doc, res.ok);
            }
          }
        }

        // -- Breach escalation (owner / backup / manager) -----------------
        const level = classifyBreachLevel(sla, { graceMs: SLA_GRACE_MS, now });
        if (!level) continue;

        if (isBaselineRun) {
          const claimed = await tryClaimAlert(buildAlertDoc({
            containerNo: item.container, offLeaseId: item.leaseId, stage: stageKey,
            startedAt: sla.startedAt, level: 'baseline', to: null, overdueBy: sla.overdueBy
          }));
          if (claimed) {
            summary.baselined++;
            baselineRows.push({ container: item.container, offLeaseId: item.leaseId, clientName: item.clientName, stageName, stageKey, overdueBy: sla.overdueBy });
          }
          continue; // first run never sends a per-stage escalation email
        }

        const recipients = resolveRecipients(routing, stageKey, level);
        if (!recipients) {
          configIssues.push({ container: item.container, offLeaseId: item.leaseId, stage: stageKey, level });
          logger.error(`[SLA-ESCALATION] No ${level} address configured for stage ${stageKey} — cannot escalate ${item.container} (never crashes the scan).`);
          continue;
        }

        const doc = buildAlertDoc({
          containerNo: item.container, offLeaseId: item.leaseId, stage: stageKey,
          startedAt: sla.startedAt, level, to: recipients.to, cc: recipients.cc, overdueBy: sla.overdueBy
        });
        const claimed = await tryClaimAlert(doc);
        if (!claimed) continue; // already sent for this stage/startedAt/level — TC-L7-4

        const { subject, body, html } = buildEscalationEmail({
          level, container: item.container, offLeaseId: item.leaseId, clientName: item.clientName,
          stageName, stageKey, overdueBy: sla.overdueBy
        });
        const res = await sendMail({ to: recipients.to, cc: recipients.cc.length ? recipients.cc : undefined, subject, body, html });
        summary.sent++;
        await markAlertResult(doc, res.ok);
      }
    } catch (e) {
      // Per-container isolation — TC-L7-5 / the issue's own resilience
      // requirement: one bad container's Mongo read or compute error must
      // never abort the rest of the scan.
      summary.errors++;
      logger.error(`[SLA-ESCALATION] Container ${item?.container || '?'} failed (continuing scan):`, e?.message || e);
    }
  }

  if (isBaselineRun && baselineRows.length) {
    try {
      const subject = `[SLA Escalation] Baseline — ${baselineRows.length} already-overdue stage(s) found on first run`;
      const lines = baselineRows.map((r) => `${r.container}${r.offLeaseId ? ` (${r.offLeaseId})` : ''} — ${r.stageName || r.stageKey} — overdue by ${r.overdueBy}`);
      const body = [
        'SLA escalation is now live. These stages were ALREADY overdue before this feature existed, so they are recorded as a baseline and will NOT trigger an owner/backup/manager email for this existing breach — only a NEW breach (or this same stage starting a fresh cycle) will.',
        '', ...lines
      ].join('\n');
      const html = `<p>SLA escalation is now live. These stages were ALREADY overdue before this feature existed, so they are recorded as a baseline and will NOT trigger an owner/backup/manager email for this existing breach — only a NEW breach (or this same stage starting a fresh cycle) will.</p><ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul>`;
      await sendMail({ to: FALLBACK_EMAIL, subject, body, html });
    } catch (e) {
      logger.error('[SLA-ESCALATION] Failed to send baseline summary email (non-fatal):', e?.message || e);
    }
  }

  if (configIssues.length) {
    try {
      const subject = `[SLA Escalation] Routing config missing for ${configIssues.length} stage(s)`;
      const lines = configIssues.map((c) => `${c.container}${c.offLeaseId ? ` (${c.offLeaseId})` : ''} — stage ${c.stage} — level ${c.level}`);
      const body = ['One or more stages breached their SLA but have no configured recipient, so no escalation email could be sent for them:', '', ...lines, '', 'Fix: set real addresses in SLA_ROUTING (offleaseSla.service.js) or the _runtime_config "slaRouting" override doc.'].join('\n');
      await sendMail({ to: FALLBACK_EMAIL, subject, body, html: undefined });
    } catch (e) {
      logger.error('[SLA-ESCALATION] Failed to send config-missing admin alert (non-fatal):', e?.message || e);
    }
  }

  logger.info(`[SLA-ESCALATION] scan complete — containers=${summary.containersScanned} sent=${summary.sent} reminders=${summary.reminders} baselined=${summary.baselined} errors=${summary.errors}${isBaselineRun ? ' (baseline run)' : ''}`);
  return summary;
}
