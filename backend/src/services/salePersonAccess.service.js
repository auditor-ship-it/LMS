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
 * key.accounts@crystalgroup.in: 'Sagar-A' (restored 2026-09-30 evening —
 * supersedes the SAME-DAY earlier change that had set this to plain 'Sagar').
 * Reasoning flipped once this was seen live in a real dropdown: "-A" must
 * show as its OWN distinct entry everywhere names are listed/grouped for
 * display (a dropdown merging "Sagar" and "Sagar-A" hides a real, useful
 * distinction — who currently holds the temporary vs. the permanent
 * assignment). It still means the SAME PERSON for ACCESS purposes only — see
 * matchIdentity()'s own doc comment for why display and matching now use two
 * different notions of "same name" instead of one. */
const SALE_PERSON_BY_EMAIL = {
  'gauri.gupta@crystalgroup.in': 'Gauri',
  'enquiry@crystalgroup.in': 'Kedar',
  'key.accounts@crystalgroup.in': 'Sagar-A',
  'sales1@crystalgroup.in': 'Sapna',
  'sales@crystalgroup.in': 'Gargi',
  'contactsales@crystalgroup.in': 'Laveena'
};

const norm = (v) => safeStr(v).trim().toLowerCase();

/**
 * A trailing "-A" marks a TEMPORARY assignment, not a different person, for
 * ACCESS purposes — key.accounts@crystalgroup.in (scoped to "Sagar-A") must
 * still see "Sagar"'s own leads too, and this is expected to keep recurring
 * under other names as reassignments happen ("many users will in future have
 * their name with a[n] -A"), so it is a general rule here, not a per-name
 * map entry. Deliberately NOT used by canonicalSalePersonName (see its own
 * doc comment, explicit request 2026-09-30 evening) — a row whose real name
 * is "Sagar-A" must still DISPLAY as "Sagar-A", this only widens who counts
 * as the same person when deciding VISIBILITY. Only a literal trailing "-A"
 * (optional surrounding whitespace, case-insensitive) qualifies — this must
 * NOT strip names that merely end in the letter "a" (e.g. "Priya"), so a
 * hyphen separating a standalone "A" token is required.
 */
function stripTemporaryAssignmentSuffix(name) {
  const s = String(name == null ? '' : name).trim();
  const m = s.match(/^(.+?)\s*-\s*a$/i);
  return m ? m[1].trim() : s;
}

/* Alternate spellings the SAME person genuinely appears under — used for
 * BOTH display grouping (canonicalSalePersonName) and access matching
 * (matchIdentity). Two confirmed cases:
 *   - "Laveena" / "Lavina" (2026-09-07): the CRM has both as distinct
 *     assignedTo values (6 real Lease Expiry rows resolved to "Lavina"),
 *     which zeroed out Laveena's own login (contactsales@crystalgroup.in) —
 *     her exact-match scope never matched the misspelled variant.
 *   - "Pushpa Shetty" / "Pushpalata" / "Pushpalata Shetty" (2026-09-30,
 *     explicit request): confirmed live, the Deployed sheet's OWN stale
 *     fallback cell carries both "Pushpalata" (5 rows) and "Pushpalata
 *     Shetty" (5 rows) for companies the CRM doesn't currently recognise —
 *     both the same person, per the request. Deliberately does NOT include
 *     bare "Pushpa" — that is the Sales CRM's own live `assignedTo` spelling
 *     (203 leads, the dominant, authoritative value; confirmed it is the
 *     ONLY spelling the CRM itself ever uses), not a second stale variant of
 *     the same kind, and this file's very first header comment already flags
 *     "Pushpa" as historically treated as potentially ambiguous — folding it
 *     in was not asked for and would be a much bigger, unverified merge.
 * The CRM is read-only (this app never writes assignments back), so a
 * spelling can't be fixed at the source; treat known aliases as the same
 * identity here instead. Add an entry only when a real person is confirmed
 * affected by a genuinely different spelling — NOT for a plain "-A" suffix,
 * which stripTemporaryAssignmentSuffix already covers for access without
 * needing an entry here.
 *
 * Keyed by the CANONICAL (displayed) spelling exactly as it should appear,
 * with every OTHER spelling that means the same person listed as an alias
 * (compared case-insensitively). */
const SALE_PERSON_ALIASES = {
  'Laveena': ['Lavina'],
  'Pushpa Shetty': ['Pushpalata Shetty', 'Pushpalata']
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

/**
 * Reduces a name to the identity it counts as for ACCESS/matching purposes
 * only — resolves a genuine alias (SALE_PERSON_ALIASES) THEN strips a "-A"
 * temporary-assignment suffix, so "Sagar" and "Sagar-A" (or "Pushpalata" and
 * a hypothetical "Pushpalata-A") are the same identity for deciding who may
 * SEE a row. Deliberately separate from canonicalSalePersonName, which
 * decides what a row DISPLAYS as — explicit request 2026-09-30: a dropdown
 * or column must show "Sagar" and "Sagar-A" as distinct entries even though
 * the same login sees both.
 */
function matchIdentity(name) {
  return norm(stripTemporaryAssignmentSuffix(canonicalSalePersonName(name)));
}

/** True when a Deployed-sheet "Sale Person" cell belongs to `scope` — same
 *  identity once both sides go through matchIdentity (see its own doc
 *  comment for exactly what that folds together). */
export function matchesSalePersonScope(salePersonCell, scope) {
  return matchIdentity(salePersonCell) === matchIdentity(scope);
}

/** The canonical name a raw Sale Person cell should be DISPLAYED/grouped
 *  under: resolves a genuine alternate spelling (SALE_PERSON_ALIASES —
 *  "Lavina" -> "Laveena", "Pushpalata" -> "Pushpa Shetty"), untouched
 *  otherwise. Deliberately does NOT strip a "-A" temporary-assignment
 *  suffix (explicit request 2026-09-30) — "Sagar-A" must display, and appear
 *  as its own entry in any dropdown/grouping built from this, distinctly
 *  from "Sagar"; only genuinely different spellings of the same person merge
 *  here. See matchIdentity() for the separate, wider notion of "same person"
 *  used for access control. Used by the Lease Expiry digest email and the
 *  Lease Expiry/Reports pages' own Sale Person column/dropdown. */
export function canonicalSalePersonName(name) {
  const raw = String(name == null ? '' : name).trim();
  const n = norm(raw);
  for (const [canonical, aliases] of Object.entries(SALE_PERSON_ALIASES)) {
    if (n === norm(canonical) || aliases.some((a) => norm(a) === n)) return canonical;
  }
  return raw;
}

/** Stable, small cache-key suffix for a scope (one of 6 values today) — used
 *  so a 60s counts cache cannot serve one person's scoped numbers to
 *  another, or to an unscoped/admin caller. */
export function scopeCacheKey(scope) {
  return scope ? norm(scope) : 'all';
}

/* Inverted view of SALE_PERSON_BY_EMAIL (name -> email instead of email ->
 * name) — built once, not per call. Keyed by matchIdentity, not a plain
 * norm() of the map's own value, so "Sagar" resolves to key.accounts'
 * address exactly like "Sagar-A" does even though the map's own value is
 * literally "Sagar-A" — this is an ACCESS question ("who should be
 * notified"), not a display one, so it uses the wider matchIdentity notion
 * of "same person", not canonicalSalePersonName's display-only one. Two of
 * the six logins could in theory share a Sale Person name; last-one-wins
 * here is harmless since that has never happened in this map (each name
 * appears exactly once today). */
const EMAIL_BY_SALE_PERSON = Object.fromEntries(
  Object.entries(SALE_PERSON_BY_EMAIL).map(([email, name]) => [matchIdentity(name), email])
);

/** The login email a Sale Person NAME resolves to, or null if this name
 *  isn't one of the 6 explicitly mapped logins (e.g. a CRM-only name with no
 *  LMS login yet). Used by the Lease Expiry digest email to address the
 *  right salesperson — same map salePersonScopeFor uses, just inverted.
 *  Resolves through matchIdentity (genuine aliases AND a "-A" temporary
 *  suffix), so "Lavina", "Sagar" and "Sagar-A" all correctly resolve to the
 *  same address their base identity maps to. */
export function emailForSalePerson(name) {
  return EMAIL_BY_SALE_PERSON[matchIdentity(name)] || null;
}
