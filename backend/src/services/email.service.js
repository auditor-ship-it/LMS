/**
 * Email transport.
 *
 * Sends through SMTP when credentials are configured, and falls back to the
 * previous console-logging stub when they are not — so a machine without
 * credentials (a dev box, CI) keeps working and OTPs stay readable in the
 * server log rather than the app failing at the point of send.
 *
 * GMAIL NOTE: a normal account password will NOT authenticate here. Google
 * removed password-based SMTP in 2022; the account needs 2-Step Verification
 * enabled and a 16-character App Password, which is what MAIL_PASS expects.
 *
 * Configure in backend/.env (never commit it — .env is gitignored):
 *
 *   MAIL_HOST=smtp.gmail.com
 *   MAIL_PORT=587
 *   MAIL_USER=auditor@crystalgroup.in
 *   MAIL_PASS=<16-char app password, no spaces>
 *   MAIL_FROM=Crystal LMS <auditor@crystalgroup.in>
 */
import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

let transporter = null;
let verified = null;   // null = not yet checked, true/false = result

function getTransport() {
  if (transporter) return transporter;
  if (!env.mailHost || !env.mailUser || !env.mailPass) return null;

  transporter = nodemailer.createTransport({
    host: env.mailHost,
    port: Number(env.mailPort) || 587,
    /* 465 is implicit TLS; 587 starts plaintext and upgrades via STARTTLS.
       Setting secure:true on 587 makes the connection hang rather than fail
       clearly, which is a confusing way to spend an afternoon. */
    secure: Number(env.mailPort) === 465,
    auth: { user: env.mailUser, pass: env.mailPass },
    pool: true,              // reuse one connection; Gmail rate-limits new ones
    maxConnections: 3
  });
  return transporter;
}

/**
 * Checks the credentials once at startup so a bad password is reported then,
 * not on the first real send hours later. Never throws.
 */
export async function verifyMailTransport() {
  const t = getTransport();
  if (!t) {
    logger.warn('[MAIL] no credentials configured — mail will be logged, not sent');
    verified = false;
    return false;
  }
  try {
    await t.verify();
    verified = true;
    logger.info(`[MAIL] SMTP ready as ${env.mailUser}`);
    return true;
  } catch (e) {
    verified = false;
    /* The message is quoted verbatim: Gmail's own wording ("Username and
       Password not accepted") is the fastest route to the actual cause. */
    logger.error(`[MAIL] SMTP verify failed — ${e?.message || e}`);
    return false;
  }
}

/**
 * @returns {{ ok: boolean, stub?: boolean, messageId?: string, error?: string }}
 *   Never throws: a failed notification must not roll back the business action
 *   that triggered it. Callers that care can inspect `ok`.
 */
export async function sendMail({ to, subject, body, html, cc, bcc, attachments }) {
  const t = getTransport();

  if (!t) {
    console.log('----- [email.service] MAIL NOT SENT (no credentials) -----');
    console.log(`To:      ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`Body:\n${body}`);
    console.log('----------------------------------------------------------');
    return { ok: true, stub: true };
  }

  try {
    const info = await t.sendMail({
      from: env.mailFrom || env.mailUser,
      to, cc, bcc, subject,
      text: body,
      /* Gmail treats a text-only bulk message as more spam-like; sending both
         parts costs nothing and improves delivery. */
      html: html || undefined,
      attachments
    });
    logger.info(`[MAIL] sent to ${to} — ${info.messageId}`);
    return { ok: true, messageId: info.messageId };
  } catch (e) {
    logger.error(`[MAIL] send failed to ${to} — ${e?.message || e}`);
    return { ok: false, error: e?.message || String(e) };
  }
}

export function mailStatus() {
  return { configured: !!getTransport(), verified, user: env.mailUser || null };
}
