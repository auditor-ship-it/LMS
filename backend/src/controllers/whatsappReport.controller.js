/**
 * Thin controller for the Daily WhatsApp Report admin API — mirrors the
 * dashboard.controller.js/dashboard.routes.js split convention. Ported API
 * surface from the wa-kit reference (server/routes/dailyWhatsappReport.js).
 */
import { renderReportPng } from '../services/dailyReportImage.js';
import {
  buildReportTables,
  tablesToText,
  getSenderSession,
  listSenderGroups,
  getSettings,
  logoutSenderSession,
  sendDailyReport,
  startSenderSession,
  updateSettings
} from '../services/dailyWhatsappReportService.js';

export async function getOverview(req, res) {
  res.json({ settings: await getSettings(), session: getSenderSession() });
}

export async function getGroups(req, res) {
  try {
    res.json(await listSenderGroups());
  } catch (err) {
    const status = err.code === 'WHATSAPP_NOT_CONNECTED' ? 409 : 500;
    res.status(status).json({ error: err.message, code: err.code });
  }
}

export async function putSettings(req, res) {
  const by = req.user?.email || '';
  res.json(await updateSettings(req.body || {}, by));
}

export async function getStatus(req, res) {
  const settings = await getSettings();
  const s = getSenderSession();
  res.json({
    enabled: !!settings.enabled,
    status: s.status,
    connected: s.connected,
    connectedNumber: s.connectedNumber || null,
    lastRun: settings.lastRun || null
  });
}

export async function getSession(req, res) {
  res.json(getSenderSession());
}

export async function postSessionStart(req, res) {
  try {
    res.json(await startSenderSession());
  } catch (err) {
    res.status(500).json({ error: err.message, data: getSenderSession() });
  }
}

export async function postSessionLogout(req, res) {
  res.json(await logoutSenderSession());
}

export async function getPreview(req, res) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : undefined;
  const report = await buildReportTables(date);
  let imageDataUrl = null;
  try {
    imageDataUrl = `data:image/png;base64,${renderReportPng(report).toString('base64')}`;
  } catch (e) {
    console.error('[daily-whatsapp-report] preview image failed:', e.message);
  }
  res.json({ text: tablesToText(report), imageDataUrl });
}

export async function postSendNow(req, res) {
  try {
    const result = await sendDailyReport({ trigger: 'manual' });
    res.json({ data: result, message: result.allDelivered ? `Report sent to ${result.sentTo.join(', ')}` : 'Partly sent — see result for details' });
  } catch (err) {
    // TEMP DEBUG 2026-11-12 — remove once the "Network Error" report is root-caused.
    try {
      const fs = await import('node:fs');
      fs.appendFileSync('C:/Users/crpll/LMS/backend/whatsapp-send-debug.log',
        `${new Date().toISOString()} ${err?.stack || err}\n`);
    } catch {}
    const status = ['WHATSAPP_NOT_CONNECTED', 'NO_RECIPIENTS', 'GROUP_NOT_FOUND'].includes(err.code) ? 409 : 500;
    res.status(status).json({ error: err.message, code: err.code });
  }
}
