/**
 * Daily WhatsApp Report — "Sale Person — Contract Expiry Summary".
 *
 * Ported STRUCTURE-wise from the wa-kit reference
 * (server/services/dailyWhatsappReportService.js): settings get/save (via
 * this app's own getCollection() instead of the kit's Mongoose model),
 * sendDailyReport(), the scheduler/watchdog helpers, istDayBounds, and the
 * cv/bad/warnIf/num/pruneEmptyColumns/tablesToText helpers the kit's own
 * README says to keep.
 *
 * buildReportTables() is entirely NEW — it does not reuse any of Sales OS's
 * own report tables (Activity Summary / KAM calls / NBD leads). It replicates
 * the exact column-matching/grouping logic already live in
 * frontend/src/pages/reports/ReportsPage.jsx's own salePersonExpirySummary
 * (lines ~183-229 there), so this WhatsApp report can never disagree with
 * what that page already shows.
 *
 * The sender session is a single, fixed identity (REPORT_SENDER) — never an
 * individual employee's own WhatsApp login, so linking/relinking it never
 * logs anyone else out.
 */
import { getCollection } from './mongo.service.js';
import { getExpiryDataByFilter } from './expiry.service.js';
import { getMyTasks } from './tasks.service.js';
import { renderReportPng } from './dailyReportImage.js';
import {
  sendWhatsAppImage,
  sendWhatsAppText,
  getWhatsAppSession,
  startWhatsAppSession,
  logoutWhatsAppSession,
  listWhatsAppGroups
} from './whatsappEngine.js';
import { logger } from '../utils/logger.js';

const SETTINGS_COLLECTION = '_daily_whatsapp_report_settings';
const DEFAULT_TO_NUMBERS = ['919321774772'];

/** Fixed session identity for the report sender — never an agent's own WhatsApp. */
export const REPORT_SENDER = Object.freeze({ username: 'daily-whatsapp-report-sender', agentName: 'Daily Report Sender' });

/** Don't fire a scheduled report more than this long after its time (e.g. server was down). */
const LATE_WINDOW_MIN = 180;
/** A failed / in-flight scheduled send is retried after this long. */
const RETRY_AFTER_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function digitsOnly(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length > 10 && d.startsWith('0')) d = d.replace(/^0+/, '');
  return d.length === 10 ? `91${d}` : d;
}

export async function getSettings() {
  const col = getCollection(SETTINGS_COLLECTION);
  let s = await col.findOne({ key: 'default' });
  if (!s) {
    await col.updateOne(
      { key: 'default' },
      {
        $setOnInsert: {
          key: 'default',
          enabled: false,
          sendTimes: ['17:30'],
          toNumbers: [...DEFAULT_TO_NUMBERS],
          lastSentSlots: [],
          lastRun: null,
          createdAt: new Date()
        }
      },
      { upsert: true }
    );
    s = await col.findOne({ key: 'default' });
  }
  // Rows saved before a field existed don't carry it — fill in defaults here,
  // same convention as the wa-kit reference's own getSettings().
  return {
    ...s,
    enabled: !!s.enabled,
    sendTimes: Array.isArray(s.sendTimes) && s.sendTimes.length ? [...s.sendTimes].sort() : ['17:30'],
    toNumbers: Array.isArray(s.toNumbers) && s.toNumbers.length ? s.toNumbers : [...DEFAULT_TO_NUMBERS],
    groups: Array.isArray(s.groups) ? s.groups : [],
    lastSentSlots: Array.isArray(s.lastSentSlots) ? s.lastSentSlots : []
  };
}

export async function updateSettings(patch, byUser) {
  const $set = { updatedBy: byUser || '', updatedAt: new Date() };
  if (patch.enabled !== undefined) $set.enabled = !!patch.enabled;
  if (patch.sendTimes !== undefined) {
    const list = [...new Set((Array.isArray(patch.sendTimes) ? patch.sendTimes : String(patch.sendTimes).split(/[,;\s]+/))
      .map((t) => String(t || '').trim()).filter(Boolean))].sort();
    if (!list.length || list.some((t) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) {
      const err = new Error('Send times must be HH:MM (24-hour), e.g. 17:30');
      err.status = 400;
      throw err;
    }
    $set.sendTimes = list;
  }
  if (patch.toNumbers !== undefined) {
    const raw = Array.isArray(patch.toNumbers) ? patch.toNumbers : String(patch.toNumbers).split(/[,;\n]+/);
    const list = [...new Set(raw.map(digitsOnly).filter((n) => n.length >= 11))];
    $set.toNumbers = list.length ? list : [...DEFAULT_TO_NUMBERS];
  }
  if (patch.groups !== undefined) {
    const list = (Array.isArray(patch.groups) ? patch.groups : [])
      .filter((g) => g && /^[\d-]+@g\.us$/.test(String(g.id || '')))
      .map((g) => ({ id: String(g.id), name: String(g.name || g.id).slice(0, 200) }));
    $set.groups = [...new Map(list.map((g) => [g.id, g])).values()];
  }
  await getCollection(SETTINGS_COLLECTION).updateOne({ key: 'default' }, { $set }, { upsert: true });
  return getSettings();
}

// ---------------------------------------------------------------------------
// Sender session (QR link)
// ---------------------------------------------------------------------------

export function getSenderSession() {
  return getWhatsAppSession(REPORT_SENDER);
}
export function startSenderSession() {
  return startWhatsAppSession(REPORT_SENDER);
}
export function logoutSenderSession() {
  return logoutWhatsAppSession(REPORT_SENDER);
}
export function listSenderGroups() {
  return listWhatsAppGroups(REPORT_SENDER);
}

// ---------------------------------------------------------------------------
// Report content — Sale Person — Contract Expiry Summary
// ---------------------------------------------------------------------------

function istDayBounds(dateKey) {
  return {
    start: new Date(`${dateKey}T00:00:00.000+05:30`),
    end: new Date(`${dateKey}T23:59:59.999+05:30`)
  };
}

function toISTDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  const d = parts.find((p) => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

function formatReportDate(dateKey) {
  const d = new Date(`${dateKey}T12:00:00+05:30`);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric'
  }).format(d);
}

/** A cell is a plain value or { v, tone } — tone 'bad' = red, 'warn' = orange. Kept per wa-kit README §4. */
export const cv = (c) => (c && typeof c === 'object' ? c.v : c);
const bad = (v) => ({ v, tone: 'bad' });
// eslint-disable-next-line no-unused-vars
const warnIf = (v) => (Number(v) > 0 ? { v, tone: 'warn' } : v);
const num = (label, extra = {}) => ({ label, align: 'right', ...extra });

/** Drop numeric columns that are zero in every row — kept per wa-kit README §4, unused by this single table but kept available. */
function pruneEmptyColumns(table) {
  const keepIdx = table.columns
    .map((c, i) => ({ c, i }))
    .filter(({ c, i }) => i === 0 || c.keep || table.rows.some((r) => { const v = cv(r[i]); return v !== 0 && v !== '' && v != null; }))
    .map(({ i }) => i);
  return {
    ...table,
    columns: keepIdx.map((i) => table.columns[i]),
    rows: table.rows.map((r) => keepIdx.map((i) => r[i])),
    totalRow: table.totalRow ? keepIdx.map((i) => table.totalRow[i]) : null
  };
}

/**
 * "Live Off-Lease Pipeline — Stage 1 to Stage 5" — explicit request
 * 2026-11-12 ("same this is for send the whatsapp same"), added as a SECOND
 * table on this same report. One row per stage, named by that stage's
 * actual responsible person — mirrors ReportsPage.jsx's own
 * OFFLEASE_STAGE_OWNERS exactly (same owner names, same taskKeys), with
 * counts read off getMyTasks(null) (the same GET /tasks/mine data source My
 * Task's own scorecards and that report table use), so this can never
 * disagree with either of those.
 */
const OFFLEASE_STAGE_OWNERS = [
  { stage: 'Stage 1', label: 'Off-Lease Intimation', owner: 'Christopher', taskKey: 'olStage1' },
  { stage: 'Stage 1A', label: 'Pending Approval', owner: 'Pushpa', taskKey: 'offleaseApproval' },
  { stage: 'Stage 2', label: 'Transportation', owner: 'Kshirod Khatua', taskKey: 'olStage6' },
  { stage: 'Stage 3', label: 'Gate In', owner: 'Nikhil', taskKey: 'olStage7' },
  { stage: 'Stage 4', label: 'Inspection Checklist', owner: 'Sitaram', taskKey: 'olStage3' },
  { stage: 'Stage 5', label: 'Final Billing', owner: 'Shivani', taskKey: 'olStage5' }
];

async function buildOffLeasePipelineTable() {
  const tasks = await getMyTasks(null);
  const rows = OFFLEASE_STAGE_OWNERS.map((s) => [`${s.stage} — ${s.label}`, s.owner, Number(tasks?.[s.taskKey]) || 0]);
  return {
    title: 'Live Off-Lease Pipeline — Stage 1 to Stage 5',
    columns: [{ label: 'Stage' }, { label: 'Name' }, num('Pending Count')],
    rows,
    note: ''
  };
}

/**
 * The single "Sale Person — Contract Expiry Summary" table — replicates the
 * exact logic of ReportsPage.jsx's own salePersonExpirySummary useMemo:
 * among OVERDUE containers only (item.band === 'overdue'), grouped by Sale
 * Person (blank -> 'Unassigned'), distinct client count + how many are
 * overdue by more than 30/90 days. Sorted worst-first by over90 then over30
 * then name, with 'Unassigned' always pinned last regardless of its counts.
 *
 * `dateKey`/`settings` are accepted (not used by this single-table report)
 * to match the shape the wa-kit reference's buildReportTables(dateKey,
 * settings) call sites expect.
 */
export async function buildReportTables(dateKey = toISTDateKey(new Date()), _settingsIn = null) {
  const { headers, data } = await getExpiryDataByFilter('pending', null);

  const salePersonColIdx = headers.findIndex((h) => /^sale person$/i.test(String(h || '').trim()));
  const customerColIdx = headers.findIndex((h) => /^(customer name|client name)$/i.test(String(h || '').trim()));

  const map = new Map();
  for (const item of data || []) {
    if (item.band !== 'overdue') continue;
    const rawName = salePersonColIdx >= 0 ? String((item.row || [])[salePersonColIdx] || '').trim() : '';
    const name = rawName || 'Unassigned';
    if (!map.has(name)) map.set(name, { clients: new Set(), over30: 0, over90: 0 });
    const entry = map.get(name);
    const client = customerColIdx >= 0 ? String((item.row || [])[customerColIdx] || '').trim() : '';
    if (client) entry.clients.add(client);
    const magnitude = -item.daysLeft;
    if (magnitude > 30) entry.over30 += 1;
    if (magnitude > 90) entry.over90 += 1;
  }

  const summary = [...map.entries()]
    .map(([name, v]) => ({ name, clientCount: v.clients.size, over30: v.over30, over90: v.over90 }))
    .sort((a, b) => {
      if (a.name === 'Unassigned') return 1;
      if (b.name === 'Unassigned') return -1;
      return b.over90 - a.over90 || b.over30 - a.over30 || a.name.localeCompare(b.name);
    });

  const rows = summary.map((r) => [r.name, r.clientCount, r.over30, r.over90 > 0 ? bad(r.over90) : r.over90]);

  const table = {
    title: 'Sale Person — Contract Expiry Summary',
    columns: [
      { label: 'Sale Person' },
      num('Client Count'),
      num('Contract Expired >30 Days'),
      num('Contract Expired >90 Days', { tone: 'bad-if-positive' })
    ],
    rows,
    note: rows.length ? '' : 'No overdue leases.'
  };

  const offLeaseTable = await buildOffLeasePipelineTable().catch(() => null);

  return {
    title: `Daily Report — ${formatReportDate(dateKey)}`,
    // No FRONTEND_URL/APP_URL env var exists in this app's env.js today — see
    // the implementation note in this file's PR; omitted rather than
    // hardcoding a guess. dailyReportImage.js only prints the "Full details"
    // line when report.link is truthy.
    link: '',
    tables: [pruneEmptyColumns(table), ...(offLeaseTable ? [pruneEmptyColumns(offLeaseTable)] : [])]
  };
}

/** Monospace text version (WhatsApp ``` block) — fallback if the image can't be made. Kept per wa-kit README §4. */
export function tablesToText(report) {
  const out = [`*${report.title}*`];
  for (const t of report.tables) {
    out.push('', `*${t.title}*`);
    if (!t.columns.length || !t.rows.length) {
      if (t.note) out.push(t.note);
      continue;
    }
    const body = [...t.rows, ...(t.totalRow ? [t.totalRow] : [])];
    const mark = (c) => {
      const tone = c && typeof c === 'object' ? c.tone : '';
      return String(cv(c)) + (tone === 'bad' ? ' !' : tone === 'warn' ? ' *' : '');
    };
    const all = [t.columns.map((c) => c.label), ...body].map((r) => r.map(mark));
    const widths = t.columns.map((_, i) => Math.max(...all.map((r) => r[i].length)));
    const fmt = (r) => r.map((v, i) => (t.columns[i].align === 'right' ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join(' | ');
    const rule = widths.map((w) => '-'.repeat(w)).join('-+-');
    const lines = [fmt(all[0]), rule, ...all.slice(1, 1 + t.rows.length).map(fmt)];
    if (t.totalRow) lines.push(rule, fmt(all[all.length - 1]));
    out.push('```' + lines.join('\n') + '```');
    if (t.note) out.push(`_${t.note.replace(/Red =/g, '! =').replace(/Orange =/g, '* =')}_`);
  }
  if (report.link) out.push('', `Full details: ${report.link}`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** Send the report now through the report-sender session. */
export async function sendDailyReport({ trigger = 'manual', dateKey, toOverride } = {}) {
  const settings = await getSettings();
  const groups = toOverride?.length ? [] : (settings.groups || []);
  let to = toOverride?.length ? [...toOverride] : [...(settings.toNumbers || [])];
  const record = async (lastRun) => {
    await getCollection(SETTINGS_COLLECTION).updateOne({ key: 'default' }, { $set: { lastRun } });
  };

  try {
    if (!to.length && !groups.length) {
      throw Object.assign(new Error('No "To" numbers or groups configured'), { code: 'NO_RECIPIENTS' });
    }

    let session = getSenderSession();
    if (session.status !== 'ready') {
      await startSenderSession();
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        session = getSenderSession();
        if (session.status === 'ready' || session.status === 'qr' || session.status === 'disconnected') break;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (session.status !== 'ready') {
      throw Object.assign(
        new Error('Report sender WhatsApp is not linked. Open Daily WhatsApp Report and scan the QR.'),
        { code: 'WHATSAPP_NOT_CONNECTED' }
      );
    }

    if (groups.some((g) => !g.id)) {
      const mine = await listSenderGroups();
      const norm = (v) => String(v || '').trim().toLowerCase();
      let changed = false;
      for (const g of groups) {
        if (g.id) continue;
        const hit = mine.find((m) => norm(m.name) === norm(g.name));
        if (!hit) {
          throw Object.assign(new Error(`The sender WhatsApp is not in a group named "${g.name}".`), { code: 'GROUP_NOT_FOUND' });
        }
        g.id = hit.id;
        changed = true;
      }
      if (changed) await getCollection(SETTINGS_COLLECTION).updateOne({ key: 'default' }, { $set: { groups } });
    }
    to = [...to, ...groups.map((g) => g.id)];

    const report = await buildReportTables(dateKey, settings);
    const text = tablesToText(report);
    const caption = report.link ? `*${report.title}*\n${report.link}` : `*${report.title}*`;

    let result;
    let png = null;
    try {
      png = renderReportPng(report);
    } catch (e) {
      logger.error('[daily-whatsapp-report] image render failed, sending text:', e.message);
    }
    if (png) {
      result = await sendWhatsAppImage(to.join(','), png, caption, REPORT_SENDER);
    } else {
      result = await sendWhatsAppText(to.join(','), text, REPORT_SENDER);
    }
    await record({
      at: new Date(),
      trigger,
      ok: result.allDelivered,
      sentTo: result.sentTo,
      failed: result.failedTo,
      error: result.allDelivered ? '' : 'Some recipients did not confirm'
    });
    logger.info(`[daily-whatsapp-report] ${trigger} send -> ${result.sentTo.join(', ') || 'none'}`);
    return { ...result, text };
  } catch (err) {
    await record({
      at: new Date(),
      trigger,
      ok: false,
      sentTo: [],
      failed: (err.results || []).map((r) => ({ to: r.to, error: r.error || '' })),
      error: err.message
    }).catch(() => {});
    logger.error(`[daily-whatsapp-report] ${trigger} send failed:`, err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

function istNowParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value);
  const m = Number(parts.find((p) => p.type === 'minute')?.value);
  return { dateKey: toISTDateKey(now), minutes: h * 60 + m };
}

/**
 * Checked every ~1 minute by the node-cron job in jobs/index.js (simpler
 * than the wa-kit reference's own setTimeout-based bootstrap). Sends at most
 * one slot per tick; a slot already sent today is skipped via lastSentSlots.
 */
export async function schedulerTick() {
  const settings = await getSettings();
  if (!settings?.enabled) return;
  const { dateKey, minutes } = istNowParts();
  const slot = settings.sendTimes.find((t) => {
    const [hh, mm] = String(t).split(':').map(Number);
    const due = hh * 60 + mm;
    return minutes >= due && minutes - due <= LATE_WINDOW_MIN && !settings.lastSentSlots.includes(`${dateKey} ${t}`);
  });
  if (!slot) return;
  const slotKey = `${dateKey} ${slot}`;

  // Atomic claim so two instances never both send.
  const claimed = await getCollection(SETTINGS_COLLECTION).findOneAndUpdate(
    {
      key: 'default',
      lastSentSlots: { $ne: slotKey },
      $or: [{ sendingSince: null }, { sendingSince: { $exists: false } }, { sendingSince: { $lt: new Date(Date.now() - RETRY_AFTER_MS) } }]
    },
    { $set: { sendingSince: new Date() } }
  );
  if (!claimed) return;

  try {
    await sendDailyReport({ trigger: 'schedule', dateKey });
    await getCollection(SETTINGS_COLLECTION).updateOne(
      { key: 'default' },
      { $set: { lastSentDateKey: dateKey, sendingSince: null }, $push: { lastSentSlots: { $each: [slotKey], $slice: -30 } } }
    );
  } catch {
    // Leave sendingSince set: acts as a back-off, retried after RETRY_AFTER_MS.
  }
}

let schedulerStarted = false;

/** Started from jobs/index.js, gated behind env.enableWhatsappReport (default OFF). */
export function startDailyWhatsappReportScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  logger.info('[daily-whatsapp-report] scheduler started');
}
