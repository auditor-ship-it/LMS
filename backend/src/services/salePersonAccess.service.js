/**
 * User-wise data visibility for the "Sale Person" ownership axis.
 *
 * Deployed sheet column 9, header "Sale Person", records who owns each
 * lease. Lease Expiry and Renew & Document (frontend/src/pages/renewDocument
 * — same GET /api/expiry?filter=... endpoint, different `filter` value) both
 * read that sheet, so filtering happens once here and both pages inherit it.
 *
 * NOTE: the value fed to matchesSalePersonScope() is no longer that sheet
 * cell verbatim — expiry.service.js first resolves the row's owner from the
 * Sales CRM (salesCrmLeads.service.js), falling back to the sheet cell only
 * for companies the CRM does not carry. That is deliberate: the name a
 * scoped user is filtered BY must be the name the row DISPLAYS, or they
 * would be shown rows labelled with somebody else's name.
 *
 * This is a DIFFERENT ownership axis from the off-lease workflow-role
 * filtering already in tasks.service.js (MY_TASK_BY_EMAIL_BACKEND — who
 * verifies/approves/bills, a fixed set of desks). That one stays untouched;
 * this one is about who a LEASE belongs to, not who acts on a workflow step.
 *
 * Scoped deliberately to a small, explicit map rather than "any logged-in
 * user whose session name happens to match a Sale Person cell" — Deployed's
 * Sale Person column also carries "Pushpa" and "Pushpalata" as two DISTINCT
 * values, and pushpa.shetty@crystalgroup.in's session name ("PUSHPA") would
 * exact-match "Pushpa" by accident under automatic matching, silently
 * restricting someone nobody asked to restrict. An explicit map only ever
 * grows when a person is deliberately added to it.
 */
import { isRolesAdmin } from './roles.service.js';
import { safeStr } from '../utils/format.js';

/** Login email -> the exact "Sale Person" value that login is restricted to.
 *  Add a login here to bring it under this filter. These names all exist
 *  verbatim in the Sales CRM's `assignedTo` field as well as in the sheet, so
 *  the switch to CRM-resolved owners did not change who any of them sees.
 *  Gargi and Laveena added 2026-08-20 for the same restriction, now also
 *  applied to the Off-Lease module (see offlease.service.js's
 *  _offLeaseAccessGate) — same six-login screenshot, same USER-sheet
 *  credentials, this map just adds the two names that were missing.
 *
 * key.accounts@crystalgroup.in: 'Sagar' (reverted 2026-09-30, explicit
 * request — supersedes the 2026-09-16 request that flipped this to
 * 'Sagar-A'). "-A" now means "temporary assignment, same person" for ANY
 * name (see stripTemporaryAssignmentSuffix below), so there is no longer a
 * per-name choice of which spelling "wins" — the base name without "-A" is
 * always canonical. */
const SALE_PERSON_BY_EMAIL = {
  'gauri.gupta@crystalgroup.in': 'Gauri',
  'enquiry@crystalgroup.in': 'Kedar',
  'key.accounts@crystalgroup.in': 'Sagar',
  'sales1@crystalgroup.in': 'Sapna',
  'sales@crystalgroup.in': 'Gargi',
  'contactsales@crystalgroup.in': 'Laveena'
};

const norm = (v) => safeStr(v).trim().toLowerCase();

/**
 * A trailing "-A" marks a TEMPORARY assignment, not a different person —
 * explicit request 2026-09-30: "Sagar-A" is the same person as "Sagar", just
 * temporarily reassigned, and this is expected to keep happening for other
 * names too as reassignments occur ("many users will in future have their
 * name with a[n] -A"). So this is a general rule, not a per-name lookup like
 * SALE_PERSON_ALIASES below — any current or future "<Name>-A" collapses to
 * "<Name>" with no map entry needed. Only a literal trailing "-A" (optional
 * surrounding whitespace, case-insensitive) qualifies — this must NOT strip
 * names that merely end in the letter "a" (e.g. "Priya"), so a hyphen
 * separating a standalone "A" token is required.
 */
function stripTemporaryAssignmentSuffix(name) {
  const s = String(name == null ? '' : name).trim();
  const m = s.match(/^(.+?)\s*-\s*a$/i);
  return m ? m[1].trim() : s;
}

/* Alternate spellings the SAME person genuinely appears under in the Sales
 * CRM's `assignedTo` field — confirmed live 2026-09-07: the CRM has BOTH
 * "Laveena" and "Lavina" as distinct assignedTo values (6 real Lease Expiry
 * rows resolved to "Lavina"), which zeroed out Laveena's own login
 * (contactsales@crystalgroup.in) on the Lease Expiry page — her exact-match
 * scope never matched the misspelled variant. The CRM is read-only (this
 * app never writes assignments back), so the spelling can't be fixed at the
 * source; treat known aliases as the same identity here instead. Add an
 * entry only when a real person is confirmed affected with a genuinely
 * different (non "-A") misspelling — the "-A" case is handled generically by
 * stripTemporaryAssignmentSuffix above and no longer needs an entry here
 * (the former 'sagar-a': ['sagar'] entry was removed 2026-09-30 for exactly
 * that reason).
 *
 * Keyed by the CANONICAL (displayed) spelling, with every OTHER spelling
 * that must still match and normalize to it listed as an alias. */
const SALE_PERSON_ALIASES = {
  laveena: ['lavina']
};

/**
 * The Sale Person name `user` must be restricted to, or null if they see
 * every record — an admin (dynamic `rolesAdmin` permission; "Admin sees
 * all" per spec), or a login with no mapped Sale Person identity, which
 * keeps today's unfiltered behaviour rather than hiding data with no clear
 * owner.
 *
 * `user` is always the AUTHENTICATED session object (req.user), sourced from
 * the bearer token — never from a request body/query field a caller could
 * substitute another person's name/email/id into.
 *
 * Async since 2026-09-16 (isRolesAdmin became a live permission lookup,
 * not a hardcoded array check) — every call site needs `await`.
 */
export async function salePersonScopeFor(user) {
  const email = norm(user?.email);
  if (!email) return null;
  if (await isRolesAdmin(email)) return null;
  return SALE_PERSON_BY_EMAIL[email] || null;
}

/** True when a Deployed-sheet "Sale Person" cell belongs to `scope` — same
 *  person once both sides are reduced to their canonical form (strips a
 *  "-A" temporary-assignment suffix, then resolves any known alternate
 *  spelling — see canonicalSalePersonName). Comparing canonical forms
 *  directly (rather than expanding one side into a fixed alias list) is what
 *  lets a brand-new "<Name>-A" match its base name with no map entry. */
export function matchesSalePersonScope(salePersonCell, scope) {
  return norm(canonicalSalePersonName(salePersonCell)) === norm(canonicalSalePersonName(scope));
}

/** The canonical name a raw Sale Person cell should be grouped/displayed
 *  under: strip a "-A" temporary-assignment suffix first (any name, not just
 *  ones hardcoded below), then resolve a known genuine alternate spelling
 *  (e.g. "Lavina" -> "Laveena", SALE_PERSON_ALIASES), untouched otherwise.
 *  Used by the Lease Expiry digest email and the Lease Expiry page's own
 *  Sale Person column/dropdown so the same person's leases don't split into
 *  separately-addressed/filtered groups under two spellings. */
export function canonicalSalePersonName(name) {
  const stripped = stripTemporaryAssignmentSuffix(name);
  const n = norm(stripped);
  for (const [canonical, aliases] of Object.entries(SALE_PERSON_ALIASES)) {
    if (n === canonical || aliases.includes(n)) {
      // Title-case the canonical key back to the display form used elsewhere
      // in this file's own map values (e.g. 'laveena' -> 'Laveena').
      const displayName = Object.values(SALE_PERSON_BY_EMAIL).find((v) => norm(v) === canonical);
      return displayName || stripped;
    }
  }
  return stripped;
}

/** Stable, small cache-key suffix for a scope (one of 6 values today) — used
 *  so a 60s counts cache cannot serve one person's scoped numbers to
 *  another, or to an unscoped/admin caller. */
export function scopeCacheKey(scope) {
  return scope ? norm(scope) : 'all';
}

/* Inverted view of SALE_PERSON_BY_EMAIL (name -> email instead of email ->
 * name) — built once, not per call. Two of the six logins could in theory
 * share a Sale Person name; last-one-wins here is harmless since that has
 * never happened in this map (each name appears exactly once today). */
const EMAIL_BY_SALE_PERSON = Object.fromEntries(
  Object.entries(SALE_PERSON_BY_EMAIL).map(([email, name]) => [norm(name), email])
);

/** The login email a Sale Person NAME resolves to, or null if this name
 *  isn't one of the 6 explicitly mapped logins (e.g. a CRM-only name with no
 *  LMS login yet). Used by the Lease Expiry digest email to address the
 *  right salesperson — same map salePersonScopeFor uses, just inverted.
 *  Resolves known alternate spellings first (see SALE_PERSON_ALIASES), so
 *  e.g. "Lavina" correctly resolves to Laveena's own address. */
export function emailForSalePerson(name) {
  return EMAIL_BY_SALE_PERSON[norm(canonicalSalePersonName(name))] || null;
}
