import 'dotenv/config';

const REQUIRED = [
  'GOOGLE_PROJECT_ID',
  'GOOGLE_CLIENT_EMAIL',
  'GOOGLE_PRIVATE_KEY',
  'GOOGLE_SHEET_ID',
  'MONGODB_URI',
  'MONGO_DB_NAME'
];

const missing = REQUIRED.filter((key) => !process.env[key] || String(process.env[key]).trim() === '');
if (missing.length) {
  console.error(`[env] Missing required environment variables: ${missing.join(', ')}`);
  console.error('[env] Check backend/.env — see README.md for setup.');
  process.exit(1);
}

// Apps Script / dotenv often stores the private key with literal \n escapes.
const normalizedPrivateKey = process.env.GOOGLE_PRIVATE_KEY.includes('\\n')
  ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
  : process.env.GOOGLE_PRIVATE_KEY;

export const env = {
  port: Number(process.env.PORT) || 4000,
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',

  googleProjectId: process.env.GOOGLE_PROJECT_ID,
  googleClientEmail: process.env.GOOGLE_CLIENT_EMAIL,
  googlePrivateKeyId: process.env.GOOGLE_PRIVATE_KEY_ID,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientX509CertUrl: process.env.GOOGLE_CLIENT_X509_CERT_URL,
  googlePrivateKey: normalizedPrivateKey,
  googleSheetId: process.env.GOOGLE_SHEET_ID,
  appsScriptId: process.env.APPS_SCRIPT_ID,

  // New — not in the original Apps Script env. Optional: features that need
  // them fail gracefully with a clear error rather than crashing at boot.
  googleDriveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID || '',
  enableCron: String(process.env.ENABLE_CRON || '').toLowerCase() === 'true',

  /* Accounts & Collection app — Tally outstanding shown on Off-Lease Stage 1.
     Server-side only: these credentials must never reach the browser. */
  accountsApiUrl: process.env.ACCOUNTS_API_URL || 'https://accounts-collection.vercel.app',
  accountsApiEmpId: process.env.ACCOUNTS_API_EMP_ID || '',
  accountsApiPassword: process.env.ACCOUNTS_API_PASSWORD || '',

  /* SMTP. MAIL_PASS must be a Gmail APP PASSWORD (2-Step Verification on, then
     Security > App passwords) — an account password is rejected by Google. */
  mailHost: process.env.MAIL_HOST || '',
  mailPort: process.env.MAIL_PORT || '587',
  mailUser: process.env.MAIL_USER || '',
  mailPass: process.env.MAIL_PASS || '',
  mailFrom: process.env.MAIL_FROM || '',

  /* -- Sales CRM (READ-ONLY) ---------------------------------------------
     A SEPARATE Atlas cluster owned by the Sales CRM app. Its
     `existing_leads` collection is the source of truth for which
     salesperson a company is assigned to (admins reassign leads there, and
     only there). Lease Expiry mirrors that onto its "Sale Person" column --
     see services/salesCrmLeads.service.js. This app never writes to it.

     Optional on purpose: leave SALES_CRM_MONGODB_URI unset and Lease Expiry
     keeps showing the Deployed sheet's own "Sale Person" cell, exactly as it
     did before this integration existed. */
  salesCrmUri: process.env.SALES_CRM_MONGODB_URI || '',
  salesCrmDbName: process.env.SALES_CRM_DB_NAME || 'sales_crm',
  salesCrmLeadsCollection: process.env.SALES_CRM_LEADS_COLLECTION || 'existing_leads',
  /* How long the company -> salesperson map is held in memory: a background
     re-read every 30 minutes, in effect. A reassignment made in the CRM
     appears on Lease Expiry within this window on its own; the "Sync Sale
     Person" button on that page (POST /api/expiry/sale-person/refresh) drops
     the cache and re-reads immediately for anyone who cannot wait. */
  salesCrmCacheSecs: Number(process.env.SALES_CRM_CACHE_SECONDS) || 1800,

  /* -- Sales CRM renewal handoff ------------------------------------------
     "Renew via Sales CRM" (Lease Expiry) mints a signed link to the Sales
     CRM's own renewal-entry form (the "Success" form with Grade/Rev
     Share/LM/Client/Product/Addendum fields) so a salesperson doesn't have
     to log in twice or retype the company/container. See
     services/renewalHandoff.service.js.

     BOTH sides of this are optional-until-configured, same convention as
     salesCrmUri above:
       - salesCrmRenewalFormUrl: the target form's URL. Unknown as of writing
         this — the button is wired and will mint a real token the moment
         this is set, no code change needed.
       - salesCrmHandoffSecret: HS256 signing key for the token (a standard
         JWT — see utils/jwtLite.js). Signing it here is only half the
         contract: the Sales CRM side needs matching verification code added
         by whoever owns that app, sharing this same secret out of band
         (never commit it to either repo). Until that exists, the link still
         opens the form (once the URL above is set) but doesn't actually log
         the salesperson in — the token rides along unused.
     Minting refuses (503) with a clear message while either is unset,
     rather than silently handing out an unsigned or unusable link. */
  salesCrmRenewalFormUrl: process.env.SALES_CRM_RENEWAL_FORM_URL || '',
  salesCrmHandoffSecret: process.env.SALES_CRM_HANDOFF_SECRET || '',
  salesCrmHandoffTtlSecs: Number(process.env.SALES_CRM_HANDOFF_TTL_SECONDS) || 600,

  mongoUri: process.env.MONGODB_URI,
  mongoDbName: process.env.MONGO_DB_NAME,
  enableSheetsSync: String(process.env.ENABLE_SHEETS_SYNC || '').toLowerCase() === 'true',

  // Kill switch for the public read-only API (/api/public/v1) — flip to
  // 'false' in the env file to take it offline instantly (no code change,
  // no redeploy) if a key leaks or the endpoint needs to come down in a
  // hurry. Defaults to enabled since the feature is meant to be live.
  enablePublicApi: String(process.env.ENABLE_PUBLIC_API ?? 'true').toLowerCase() !== 'false',
  outboxPollMs: Number(process.env.OUTBOX_POLL_MS) || 7000
};

if (!env.salesCrmUri) {
  console.warn('[env] SALES_CRM_MONGODB_URI not set — Lease Expiry will show the Deployed sheet\'s own "Sale Person" values instead of the live Sales CRM assignment. See README.md.');
}

if (!env.salesCrmRenewalFormUrl || !env.salesCrmHandoffSecret) {
  console.warn('[env] SALES_CRM_RENEWAL_FORM_URL and/or SALES_CRM_HANDOFF_SECRET not set — "Renew via Sales CRM" will show an error until both are configured. See README.md.');
}

if (!env.googleDriveFolderId) {
  console.warn('[env] GOOGLE_DRIVE_FOLDER_ID not set — file uploads (verify docs, payment proofs, agreements) will fail until you share a Drive folder with the service account and set this var. See README.md.');
}
