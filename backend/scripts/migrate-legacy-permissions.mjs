/**
 * ONE-TIME MIGRATION — ALREADY RUN 2026-09-16, kept as a historical record
 * and a re-runnable safety net, not part of the app's runtime.
 *
 * Reconciled the hardcoded permission baseline that used to live in
 * config/permissions.config.js (ACTION_PERMISSIONS / ALL_ACCESS_EMAILS /
 * ROLES_ADMIN_EMAILS / API_SUPER_ADMIN_EMAILS) into the live Roles & Access
 * sheets, so that removing those hardcoded lists from the runtime
 * permission check (permissions.service.js's userHasAction,
 * roles.service.js's isRolesAdmin, apiKeys.controller.js's
 * assertApiSuperAdmin) did not silently revoke anyone's current access.
 * The four constants below are copied verbatim from that file as it stood
 * immediately before this migration ran — permissions.config.js itself no
 * longer defines them (removed the same day, once this had been confirmed
 * against the live sheet via --dry-run), so they're embedded here rather
 * than imported.
 *
 * Purely ADDITIVE and IDEMPOTENT: only ever sets a cell to `true`, never
 * `false`, and only touches a cell that isn't already `true`. Safe to run
 * again at any time — confirmed 2026-09-16 it now reports 0 changes.
 *
 * Run manually: node scripts/migrate-legacy-permissions.mjs
 * Dry run first (no writes, just prints what it WOULD do):
 *   node scripts/migrate-legacy-permissions.mjs --dry-run
 * (from the backend/ directory.)
 */
import 'dotenv/config';
import { connectMongo } from '../src/config/db.js';
import { loadTeamPermTable, addTeamAccount, saveEmailPermission } from '../src/services/roles.service.js';

const ACTION_PERMISSIONS = {
  verify: ['sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'pushpa.shetty@crystalgroup.in', 'swati.barot@crystalgroup.in', 'support@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'pc@crystalgroup.in'],
  approve: ['pushpa.shetty@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'sc@crystalgroup.in', 'swati.barot@crystalgroup.in', 'support@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'pc@crystalgroup.in'],
  expiry: ['pushpa.shetty@crystalgroup.in', 'sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'dmo@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'pc@crystalgroup.in'],
  renew: ['pushpa.shetty@crystalgroup.in', 'sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'ar@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'pc@crystalgroup.in'],
  document: ['pushpa.shetty@crystalgroup.in', 'sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'ar@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'pc@crystalgroup.in'],
  offleaseapproval: ['pushpa.shetty@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'ar@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'pc@crystalgroup.in'],
  offlease1: ['pushpa.shetty@crystalgroup.in', 'sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'ar@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'kshirod.khatua@crystalgroup.in', 'pc@crystalgroup.in'],
  offlease2: ['pushpa.shetty@crystalgroup.in', 'sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'ar@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'kshirod.khatua@crystalgroup.in', 'pc@crystalgroup.in'],
  offlease3: ['pushpa.shetty@crystalgroup.in', 'sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'ar@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'kshirod.khatua@crystalgroup.in', 'pc@crystalgroup.in', 'service@crystalgroup.in'],
  offlease4: ['pushpa.shetty@crystalgroup.in', 'sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'ar@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'kshirod.khatua@crystalgroup.in', 'pc@crystalgroup.in'],
  offlease5: ['pushpa.shetty@crystalgroup.in', 'sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'ar@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'kshirod.khatua@crystalgroup.in', 'pc@crystalgroup.in'],
  offlease6: ['pushpa.shetty@crystalgroup.in', 'sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'ar@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'kshirod.khatua@crystalgroup.in', 'pc@crystalgroup.in'],
  offlease7: ['pushpa.shetty@crystalgroup.in', 'sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'ar@crystalgroup.in', 'kshirod.khatua@crystalgroup.in', 'pc@crystalgroup.in'],
  offlease8: ['pushpa.shetty@crystalgroup.in', 'sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'ar@crystalgroup.in', 'kshirod.khatua@crystalgroup.in', 'pc@crystalgroup.in'],
  offlease9: ['pushpa.shetty@crystalgroup.in', 'sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'ar@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'kshirod.khatua@crystalgroup.in', 'pc@crystalgroup.in'],
  offleasedashboard: ['pushpa.shetty@crystalgroup.in', 'sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'ar@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'kshirod.khatua@crystalgroup.in', 'pc@crystalgroup.in', 'service@crystalgroup.in'],
  offleaselookup: ['pushpa.shetty@crystalgroup.in', 'sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'ar@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'kshirod.khatua@crystalgroup.in', 'pc@crystalgroup.in', 'service@crystalgroup.in'],
  billing: ['shivani.dhall@crystalgroup.in', 'intern@crystalgroup.in', 'pushpa.shetty@crystalgroup.in', 'swati.barot@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'pc@crystalgroup.in'],
  receivables: ['ar@crystalgroup.in', 'intern@crystalgroup.in', 'pushpa.shetty@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'support@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'pc@crystalgroup.in']
  // 'default' fallback intentionally dropped — never a real, checkable
  // permission key (computeGrants below already skipped it).
};
const ALL_ACCESS_EMAILS = ['aa@crystalgroup.in'];
const ROLES_ADMIN_EMAILS = ['dmo@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'aa@crystalgroup.in'];
const API_SUPER_ADMIN_EMAILS = ['dmo@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'aa@crystalgroup.in'];

const DRY_RUN = process.argv.includes('--dry-run');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Each grant is its own live Sheets write (saveEmailPermission); firing them
// back-to-back tripped Google's "Write requests per minute per user" quota
// partway through the first real run (confirmed live, 2026-09-16 — 74 of 110
// succeeded before a 429). The script is idempotent either way (see the
// header comment), so a paced re-run just picks up wherever the last one
// stopped rather than needing any resume bookkeeping.
const WRITE_DELAY_MS = 1200;

// Any current Roles & Access admin works here — assertRolesAdmin (still the
// hardcoded, sync check at the time this script must be run) just needs a
// valid caller identity to authorize this script's own writes. Not stored
// anywhere; purely an authorization formality for this one run.
const CALLER = ROLES_ADMIN_EMAILS[0];

function computeGrants() {
  const grants = new Map(); // lowercased email -> Set(permission key)
  const ensure = (email) => {
    const e = String(email).trim().toLowerCase();
    if (!grants.has(e)) grants.set(e, new Set());
    return grants.get(e);
  };

  for (const [key, emails] of Object.entries(ACTION_PERMISSIONS)) {
    if (key === 'default') continue; // never a real, checkable permission key
    for (const email of emails) ensure(email).add(key);
  }
  for (const email of ALL_ACCESS_EMAILS) ensure(email).add('__allAccess');
  for (const email of ROLES_ADMIN_EMAILS) ensure(email).add('rolesAdmin');
  for (const email of API_SUPER_ADMIN_EMAILS) ensure(email).add('apiAdmin');

  return grants;
}

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN — no writes will be made ===' : '=== LIVE RUN ===');
  await connectMongo();

  const grants = computeGrants();
  let team = await loadTeamPermTable();

  // Pass 1: create any missing account row first (addTeamAccount also seeds
  // every current sidebar key TRUE for a new row — the same "visible until
  // explicitly restricted" default every other new account gets).
  for (const email of grants.keys()) {
    if (team[email]) continue;
    console.log(`  [create account] ${email}`);
    if (!DRY_RUN) { await addTeamAccount(CALLER, email, ''); await sleep(WRITE_DELAY_MS); }
  }
  if (!DRY_RUN) team = await loadTeamPermTable(); // refresh after inserts

  // Pass 2: grant whatever's missing. allAccess is its own sheet column
  // (not a PERMISSION_KEYS entry), handled via the '__allAccess' sentinel.
  let changes = 0;
  for (const [email, keys] of grants) {
    const acct = team[email] || { allAccess: false, perms: {} };
    for (const key of keys) {
      if (key === '__allAccess') {
        if (acct.allAccess) continue;
        console.log(`  [grant] ${email} -> All Access`);
        changes++;
        if (!DRY_RUN) { await saveEmailPermission(CALLER, email, 'allAccess', true); await sleep(WRITE_DELAY_MS); }
        continue;
      }
      if (acct.perms[key]) continue;
      console.log(`  [grant] ${email} -> ${key}`);
      changes++;
      if (!DRY_RUN) { await saveEmailPermission(CALLER, email, key, true); await sleep(WRITE_DELAY_MS); }
    }
  }

  console.log(`\n${DRY_RUN ? 'Would change' : 'Changed'} ${changes} cell(s) across ${grants.size} email(s).`);
  if (DRY_RUN) console.log('Re-run without --dry-run to apply.');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
