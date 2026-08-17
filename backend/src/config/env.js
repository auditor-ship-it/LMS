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

  mongoUri: process.env.MONGODB_URI,
  mongoDbName: process.env.MONGO_DB_NAME,
  enableSheetsSync: String(process.env.ENABLE_SHEETS_SYNC || '').toLowerCase() === 'true',
  outboxPollMs: Number(process.env.OUTBOX_POLL_MS) || 7000
};

if (!env.googleDriveFolderId) {
  console.warn('[env] GOOGLE_DRIVE_FOLDER_ID not set — file uploads (verify docs, payment proofs, agreements) will fail until you share a Drive folder with the service account and set this var. See README.md.');
}
