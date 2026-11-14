/**
 * Ported from the wa-kit reference (server/services/whatsappBaileysService.js),
 * trimmed to only what the Daily WhatsApp Report needs: connect/QR, send
 * text, send image, list groups, logout, status. Dropped on purpose (Sales
 * OS extras the kit's own README flags as unrelated to this feature):
 * brochure/intro-sequence sending (sendWhatsAppIntro), the generic
 * attachment composer (sendWhatsAppCustom), Google-review QR helper, and
 * pairing-code login (QR scan alone is enough for one admin-managed sender
 * session).
 *
 * One WhatsApp login per "user key" — this app only ever uses a single,
 * fixed sender identity (REPORT_SENDER in dailyWhatsappReportService.js),
 * never an individual employee's own WhatsApp.
 */
import { useMongoAuthState } from './whatsappAuthStore.js';

import makeWASocket, {
  DisconnectReason,
  Browsers,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';

const logger = pino({ level: process.env.WHATSAPP_LOG_LEVEL || 'warn' });

/** @typedef {'idle'|'initializing'|'qr'|'authenticated'|'ready'|'disconnected'} WhatsAppSessionStatus */

/** @type {Map<string, any>} */
const sessions = new Map();

/** Per-session caches that must outlive a socket rebuild. */
const durableCaches = new Map();
function durableCachesFor(userKey) {
  let c = durableCaches.get(userKey);
  if (!c) {
    const counters = new Map();
    c = {
      sentMessages: new Map(),
      retryCounters: {
        get: (k) => counters.get(k),
        set: (k, v) => {
          counters.set(k, v);
          if (counters.size > 500) counters.delete(counters.keys().next().value);
        },
        del: (k) => counters.delete(k),
        flushAll: () => counters.clear()
      }
    };
    durableCaches.set(userKey, c);
  }
  return c;
}

export function resolveUserKey(userLike) {
  const username = String(userLike?.username || '').trim().toLowerCase();
  const userId = String(userLike?.userId || userLike?.id || '').trim();
  const raw = username || userId || 'anonymous';
  return raw.replace(/[^a-z0-9_-]/g, '_').slice(0, 64) || 'anonymous';
}

function sessionLabel(userLike, userKey) {
  return String(userLike?.agentName || userLike?.username || userKey || 'session').trim() || userKey;
}

function emptySession(userKey, label) {
  return {
    sock: null,
    status: /** @type {WhatsAppSessionStatus} */ ('idle'),
    qrDataUrl: null,
    lastError: null,
    connectedNumber: null,
    connectedName: null,
    progressMessage: null,
    startPromise: null,
    userKey,
    label: label || userKey,
    lastActivityAt: Date.now(),
    reconnectAttempts: 0,
    relinkAttempts: 0,
    closing: false,
    acks: new Map(),
    ackErrors: new Map(),
    sentMessages: durableCachesFor(userKey).sentMessages,
    retryCounters: durableCachesFor(userKey).retryCounters,
    auth: null,
    pendingSave: null
  };
}

function getOrCreateSession(userLike) {
  const userKey = resolveUserKey(userLike);
  let s = sessions.get(userKey);
  if (!s) {
    s = emptySession(userKey, sessionLabel(userLike, userKey));
    sessions.set(userKey, s);
  } else {
    s.label = sessionLabel(userLike, userKey);
  }
  s.lastActivityAt = Date.now();
  return s;
}

function snapshot(s) {
  const connectedUi = s.status === 'ready' || s.status === 'authenticated';
  return {
    status: s.status,
    qrDataUrl: s.status === 'qr' ? s.qrDataUrl : null,
    connectedNumber: s.connectedNumber,
    connectedName: s.connectedName,
    lastError: s.lastError,
    progressMessage: s.progressMessage,
    userKey: s.userKey,
    label: s.label,
    connected: connectedUi,
    canSend: s.status === 'ready'
  };
}

/** Digits-only E.164 body (no '+'), defaulting bare 10-digit inputs to India. */
export function normalizeNumber(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length > 10 && digits.startsWith('0')) digits = digits.replace(/^0+/, '');
  return digits.length === 10 ? `91${digits}` : digits;
}

/** Splits a comma/space/newline-separated recipient string into normalized numbers / group ids. */
export function parseRecipients(raw) {
  const out = [];
  for (const chunk of String(raw || '').split(/[,;/|\n]+/)) {
    if (/^[\d-]+@g\.us$/.test(chunk.trim())) {
      out.push(chunk.trim());
      continue;
    }
    const digits = normalizeNumber(chunk);
    if (digits.length >= 10 && digits.length <= 15) {
      out.push(digits);
      continue;
    }
    if (digits.length > 15) {
      for (const piece of chunk.trim().split(/\s+/)) {
        const n = normalizeNumber(piece);
        if (n.length >= 10 && n.length <= 15) out.push(n);
      }
    }
  }
  return [...new Set(out)];
}

/**
 * Load this session's auth state ONCE and reuse it across reconnects — see
 * the wa-kit reference's identical comment for why re-reading from Mongo on
 * every reconnect is a race that breaks a fresh scan.
 */
async function getAuthState(s) {
  if (!s.auth) {
    const { state, saveCreds, clearState } = await useMongoAuthState(s.userKey);
    s.auth = { state, saveCreds, clearState, keyStore: makeCacheableSignalKeyStore(state.keys, logger) };
  }
  return s.auth;
}

async function createSocket(s) {
  const { state, saveCreds, clearState, keyStore } = await getAuthState(s);

  const sock = makeWASocket({
    logger,
    auth: { creds: state.creds, keys: keyStore },
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    getMessage: async (key) => s.sentMessages.get(key?.id)?.message || undefined,
    msgRetryCounterCache: s.retryCounters
  });

  s.sock = sock;

  sock.ev.on('messages.update', (updates) => {
    for (const u of updates || []) {
      const id = u?.key?.id;
      const status = Number(u?.update?.status ?? 0);
      if (!id || !status) continue;
      s.acks.set(id, Math.max(s.acks.get(id) || 0, status));
    }
    if (s.acks.size > 500) {
      for (const k of [...s.acks.keys()].slice(0, s.acks.size - 500)) s.acks.delete(k);
    }
  });

  sock.ws.on('CB:ack,class:message', (node) => {
    const id = node?.attrs?.id;
    if (!id) return;
    if (node.attrs.error) {
      s.ackErrors.set(id, String(node.attrs.error));
    } else {
      s.acks.set(id, Math.max(s.acks.get(id) || 0, SERVER_ACK));
    }
    if (s.ackErrors.size > 200) s.ackErrors.delete(s.ackErrors.keys().next().value);
  });

  sock.ev.on('creds.update', () => {
    s.pendingSave = saveCreds().catch((err) => {
      console.error(`WhatsApp: failed to persist credentials (${s.userKey}):`, err.message);
    });
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      try {
        s.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 280 });
        s.status = 'qr';
        s.lastError = null;
        s.progressMessage = 'Scan this QR with your phone';
        console.log(`WhatsApp QR ready for ${s.label} (${s.userKey})`);
        if (process.env.WHATSAPP_QR_TERMINAL === '1') {
          console.log(await QRCode.toString(qr, { type: 'terminal', small: true }));
        }
      } catch (err) {
        s.lastError = err.message;
      }
    }

    if (connection === 'connecting' && s.status !== 'qr') {
      s.status = 'initializing';
      s.progressMessage = 'Connecting to WhatsApp...';
    }

    if (connection === 'open') {
      s.status = 'ready';
      s.qrDataUrl = null;
      s.lastError = null;
      s.progressMessage = null;
      s.reconnectAttempts = 0;
      s.relinkAttempts = 0;
      s.connectedNumber = String(sock.user?.id || '').split(':')[0].split('@')[0] || null;
      s.connectedName = sock.user?.name || sock.user?.verifiedName || null;
      console.log(`WhatsApp ready for ${s.label}: ${s.connectedName || ''} ${s.connectedNumber || ''}`);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.status ?? 0;
      s.sock = null;

      if (s.closing) return; // deliberate teardown

      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        s.connectedNumber = null;
        s.connectedName = null;
        s.qrDataUrl = null;
        await clearState().catch(() => {});
        s.auth = null;
        console.warn(`WhatsApp logged out (${s.userKey}) - credentials cleared`);

        s.relinkAttempts = (s.relinkAttempts || 0) + 1;
        if (s.relinkAttempts > 3) {
          s.status = 'disconnected';
          s.lastError = 'WhatsApp kept rejecting this login. Click Disconnect and try again.';
          return;
        }

        s.status = 'initializing';
        s.lastError = null;
        s.progressMessage = 'Previous login expired - fetching a fresh QR...';
        setTimeout(() => {
          if (s.sock || s.closing) return;
          createSocket(s).catch((err) => {
            s.status = 'disconnected';
            s.lastError = err.message;
          });
        }, 300);
        return;
      }

      s.reconnectAttempts += 1;
      if (s.reconnectAttempts > 6) {
        s.status = 'disconnected';
        s.lastError = 'WhatsApp kept dropping the connection. Try connecting again.';
        console.warn(`WhatsApp giving up reconnect (${s.userKey})`);
        return;
      }

      s.status = 'initializing';
      s.progressMessage = 'Reconnecting to WhatsApp...';
      const delay = statusCode === DisconnectReason.restartRequired ? 250 : Math.min(1000 * 2 ** (s.reconnectAttempts - 1), 15000);
      setTimeout(() => {
        if (s.sock || s.closing) return;
        createSocket(s).catch((err) => {
          s.status = 'disconnected';
          s.lastError = err.message;
        });
      }, delay);
    }
  });

  return sock;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

const LIVE_STATUSES = new Set(['initializing', 'qr', 'authenticated', 'ready']);

export function getWhatsAppSession(userLike) {
  return snapshot(getOrCreateSession(userLike));
}

export async function startWhatsAppSession(userLike) {
  const s = getOrCreateSession(userLike);
  if (s.status === 'ready' && s.sock) return snapshot(s);
  if (s.sock && LIVE_STATUSES.has(s.status)) return snapshot(s);

  if (!s.startPromise) {
    s.closing = false;
    s.reconnectAttempts = 0;
    s.relinkAttempts = 0;
    s.status = 'initializing';
    s.lastError = null;
    s.progressMessage = 'Connecting to WhatsApp...';
    s.startPromise = createSocket(s)
      .catch((err) => {
        s.status = 'disconnected';
        s.lastError = err.message;
        s.sock = null;
        console.error(`WhatsApp start failed (${s.userKey}):`, err.message);
      })
      .finally(() => {
        s.startPromise = null;
      });
  }

  await Promise.race([s.startPromise, new Promise((r) => setTimeout(r, 2500))]);
  if (s.status === 'initializing') {
    await new Promise((r) => setTimeout(r, 1500));
  }
  return snapshot(s);
}

async function teardown(s, reason) {
  s.closing = true;
  if (s.pendingSave) {
    try {
      await s.pendingSave;
    } catch {
      /* already logged in creds.update handler */
    }
    s.pendingSave = null;
  }
  const sock = s.sock;
  s.sock = null;
  try {
    sock?.end?.(undefined);
  } catch {
    /* socket already gone */
  }
  console.log(`WhatsApp session closed (${s.userKey}): ${reason}`);
}

export async function logoutWhatsAppSession(userLike) {
  const s = getOrCreateSession(userLike);
  try {
    if (s.sock) await s.sock.logout();
  } catch (err) {
    console.warn(`WhatsApp logout (${s.userKey}):`, err.message);
  }
  await teardown(s, 'user logout');
  try {
    const clear = s.auth?.clearState || (await useMongoAuthState(s.userKey)).clearState;
    await clear();
    s.auth = null;
  } catch (err) {
    console.warn(`WhatsApp clear state (${s.userKey}):`, err.message);
  }
  sessions.set(s.userKey, emptySession(s.userKey, s.label));
  return snapshot(sessions.get(s.userKey));
}

/** Idle reaper — only stuck QR/initializing sockets, never a live `ready` session. */
const IDLE_RAW = String(process.env.WHATSAPP_IDLE_MS ?? '').trim().toLowerCase();
const IDLE_DISABLED = IDLE_RAW === '0' || IDLE_RAW === 'off' || IDLE_RAW === 'false';
const IDLE_MS = IDLE_DISABLED ? 0 : Math.max(Number(process.env.WHATSAPP_IDLE_MS) || 6 * 60 * 60 * 1000, 5 * 60 * 1000);
const REAP_INTERVAL_MS = 5 * 60 * 1000;

const reaperTimer = setInterval(() => {
  if (IDLE_DISABLED) return;
  const now = Date.now();
  for (const s of [...sessions.values()]) {
    if (!s.sock) continue;
    if (s.status === 'ready') continue;
    if (now - (s.lastActivityAt || 0) < IDLE_MS) continue;
    const reason = `idle stuck ${s.status} ${Math.round((now - (s.lastActivityAt || 0)) / 60000)}m`;
    void teardown(s, reason).then(() => {
      sessions.set(s.userKey, emptySession(s.userKey, s.label));
    });
  }
}, REAP_INTERVAL_MS);
if (typeof reaperTimer.unref === 'function') reaperTimer.unref();

export async function shutdownAllWhatsAppSessions() {
  clearInterval(reaperTimer);
  await Promise.all([...sessions.values()].map((s) => teardown(s, 'server shutdown')));
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

async function ensureConnected(userLike) {
  const s = getOrCreateSession(userLike);
  if (s.status === 'ready' && s.sock) return s;

  if (!s.sock && !s.startPromise) await startWhatsAppSession(userLike);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (s.status === 'ready' && s.sock) return s;
    if (s.status === 'qr' || s.status === 'disconnected') break;
    await new Promise((r) => setTimeout(r, 300));
  }

  const err = new Error(
    s.status === 'qr'
      ? 'WhatsApp is not linked yet. Scan the QR, then send again.'
      : s.lastError || 'WhatsApp is not connected. Open the Daily WhatsApp Report and link it.'
  );
  err.code = 'WHATSAPP_NOT_CONNECTED';
  throw err;
}

/** proto.WebMessageInfo.Status: ERROR 0, PENDING 1, SERVER_ACK 2, DELIVERY_ACK 3, READ 4. */
const SERVER_ACK = 2;
const ACK_TIMEOUT_MS = Math.max(Number(process.env.WHATSAPP_ACK_TIMEOUT_MS) || 20000, 5000);
const MEDIA_ACK_TIMEOUT_MS = Math.max(Number(process.env.WHATSAPP_MEDIA_ACK_TIMEOUT_MS) || 40000, ACK_TIMEOUT_MS);

/** Wait until WhatsApp's servers acknowledge a message (sendMessage() resolving is not proof it was sent). */
async function waitForAck(s, id, timeoutMs = ACK_TIMEOUT_MS) {
  if (!id) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (s.ackErrors.has(id)) return false;
    const status = s.acks.get(id) || 0;
    if (status >= SERVER_ACK) return true;
    if (!s.sock) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function sendConfirmed(s, jid, content, label, timeoutMs = ACK_TIMEOUT_MS) {
  const sent = await s.sock.sendMessage(jid, content);
  const id = sent?.key?.id || null;
  if (id && sent?.message) {
    s.sentMessages.set(id, sent);
    if (s.sentMessages.size > 200) s.sentMessages.delete(s.sentMessages.keys().next().value);
  }
  const acked = await waitForAck(s, id, timeoutMs);
  if (!acked) console.warn(`WhatsApp: no server ack for ${label} (${s.userKey})`);
  return { id, acked, label };
}

async function resolveJid(s, number) {
  if (String(number).endsWith('@g.us')) return number; // group: no number lookup
  let results;
  try {
    results = await s.sock.onWhatsApp(number);
  } catch (err) {
    console.warn(`onWhatsApp lookup failed (${s.userKey}) for ${number}:`, err.message);
    return `${number}@s.whatsapp.net`;
  }
  const hit = results?.find?.((r) => r?.exists);
  if (hit?.jid) return hit.jid;
  const err = new Error(`${number} is not on WhatsApp`);
  err.code = 'NOT_ON_WHATSAPP';
  throw err;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Groups this WhatsApp is a member of: [{ id: '...@g.us', name, size }], sorted by name. */
export async function listWhatsAppGroups(userLike) {
  const s = await ensureConnected(userLike);
  const groups = await s.sock.groupFetchAllParticipating();
  return Object.values(groups || {})
    .map((g) => ({ id: g.id, name: g.subject || g.id, size: g.participants?.length || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function summarize(s, results) {
  const delivered = results.filter((r) => r.status === 'sent' || r.status === 'unconfirmed');
  if (!delivered.length) {
    const err = new Error(results[0]?.error || 'WhatsApp did not accept the message');
    err.code = 'WHATSAPP_SEND_FAILED';
    err.results = results;
    throw err;
  }
  return {
    results,
    to: results.map((r) => r.to).join(', '),
    sentTo: results.filter((r) => r.status === 'sent').map((r) => r.to),
    failedTo: results.filter((r) => r.status !== 'sent').map((r) => ({ to: r.to, error: r.error || 'not confirmed' })),
    allDelivered: results.every((r) => r.status === 'sent'),
    from: s.connectedNumber,
    fromName: s.connectedName
  };
}

export async function sendWhatsAppText(phone, message, userLike) {
  const body = String(message || '').trim();
  if (!body) {
    const err = new Error('Message body is required');
    err.code = 'INVALID_MESSAGE';
    throw err;
  }
  const numbers = parseRecipients(phone);
  if (!numbers.length) {
    const err = new Error('Enter a valid recipient phone number');
    err.code = 'INVALID_PHONE';
    throw err;
  }

  const s = await ensureConnected(userLike);
  const results = [];
  for (const number of numbers) {
    try {
      const jid = await resolveJid(s, number);
      const ack = await sendConfirmed(s, jid, { text: body }, `the message to ${number}`);
      results.push({
        to: number,
        status: ack.acked ? 'sent' : 'unconfirmed',
        id: ack.id,
        error: ack.acked ? undefined : 'WhatsApp did not confirm this message'
      });
    } catch (err) {
      results.push({ to: number, status: 'failed', error: err.message });
    }
    if (numbers.length > 1) await pause(1200);
  }

  return summarize(s, results);
}

export async function sendWhatsAppImage(phone, buffer, caption, userLike) {
  const numbers = parseRecipients(phone);
  if (!numbers.length) {
    const err = new Error('Enter a valid recipient phone number');
    err.code = 'INVALID_PHONE';
    throw err;
  }
  const s = await ensureConnected(userLike);
  const text = String(caption || '').trim();

  const results = [];
  for (const number of numbers) {
    try {
      const jid = await resolveJid(s, number);
      const ack = await sendConfirmed(
        s,
        jid,
        { image: buffer, caption: text || undefined },
        `the image to ${number}`,
        MEDIA_ACK_TIMEOUT_MS
      );
      results.push({
        to: number,
        status: ack.acked ? 'sent' : 'unconfirmed',
        id: ack.id,
        error: ack.acked ? undefined : 'WhatsApp did not confirm this image'
      });
    } catch (err) {
      results.push({ to: number, status: 'failed', error: err.message });
    }
    if (numbers.length > 1) await pause(1200);
  }

  return summarize(s, results);
}
