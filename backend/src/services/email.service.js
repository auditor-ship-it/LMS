/**
 * Stub email service — real sending (SMTP/Nodemailer or Gmail API) is not
 * wired up yet (no credentials provided). Every call is logged in a
 * structured way so OTPs etc. can still be read/tested from the server console.
 * Swap the body of sendMail() for a real transport later; call sites elsewhere
 * never need to change.
 */
export async function sendMail({ to, subject, body }) {
  console.log('----- [email.service] MAIL NOT SENT (stub) -----');
  console.log(`To:      ${to}`);
  console.log(`Subject: ${subject}`);
  console.log(`Body:\n${body}`);
  console.log('-------------------------------------------------');
  return { ok: true, stub: true };
}
