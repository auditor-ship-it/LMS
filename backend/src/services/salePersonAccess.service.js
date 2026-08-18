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
 *  Add a login here to bring it under this filter. These four names all exist
 *  verbatim in the Sales CRM's `assignedTo` field as well as in the sheet, so
 *  the switch to CRM-resolved owners did not change who any of them sees. */
const SALE_PERSON_BY_EMAIL = {
  'gauri.gupta@crystalgroup.in': 'Gauri',
  'enquiry@crystalgroup.in': 'Kedar',
  'key.accounts@crystalgroup.in': 'Sagar',
  'sales1@crystalgroup.in': 'Sapna'
};

const norm = (v) => safeStr(v).trim().toLowerCase();

/**
 * The Sale Person name `user` must be restricted to, or null if they see
 * every record — an admin (ROLES_ADMIN_EMAILS; "Admin sees all" per spec),
 * or a login with no mapped Sale Person identity, which keeps today's
 * unfiltered behaviour rather than hiding data with no clear owner.
 *
 * `user` is always the AUTHENTICATED session object (req.user), sourced from
 * the bearer token — never from a request body/query field a caller could
 * substitute another person's name/email/id into.
 */
export function salePersonScopeFor(user) {
  const email = norm(user?.email);
  if (!email) return null;
  if (isRolesAdmin(email)) return null;
  return SALE_PERSON_BY_EMAIL[email] || null;
}

/** True when a Deployed-sheet "Sale Person" cell belongs to `scope`. */
export function matchesSalePersonScope(salePersonCell, scope) {
  return norm(salePersonCell) === norm(scope);
}

/** Stable, small cache-key suffix for a scope (one of 5 values today) — used
 *  so a 60s counts cache cannot serve one person's scoped numbers to
 *  another, or to an unscoped/admin caller. */
export function scopeCacheKey(scope) {
  return scope ? norm(scope) : 'all';
}
