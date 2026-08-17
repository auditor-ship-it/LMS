/**
 * Verifies SMTP credentials and optionally sends one test message.
 *
 *   node scripts/test-mail.mjs                  # verify only
 *   node scripts/test-mail.mjs you@example.com  # verify, then send
 *
 * Reads backend/.env — the password is never passed on the command line, where
 * it would land in shell history.
 */
import 'dotenv/config';
import { verifyMailTransport, sendMail, mailStatus } from '../src/services/email.service.js';

const to = process.argv[2];

console.log('config:', JSON.stringify(mailStatus()));

const ok = await verifyMailTransport();
if (!ok) {
  console.log('\nSMTP did NOT authenticate. Most common causes:');
  console.log('  - MAIL_PASS is the account password, not a 16-char App Password');
  console.log('  - App Password copied with spaces (remove them)');
  console.log('  - 2-Step Verification not enabled, so App Passwords are unavailable');
  console.log('  - MAIL_USER is not the same account the App Password was created for');
  process.exit(1);
}

if (!to) {
  console.log('\nCredentials OK. Pass an address to send a test:  node scripts/test-mail.mjs you@example.com');
  process.exit(0);
}

const r = await sendMail({
  to,
  subject: 'Crystal LMS — SMTP test',
  body: 'Plain-text body. If you can read this, SMTP is working.',
  html: '<p>If you can read this, <b>SMTP is working</b>.</p>'
});
console.log('send result:', JSON.stringify(r));
process.exit(r.ok ? 0 : 1);
