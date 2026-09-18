/**
 * Roles & Access schema — PERMISSION_KEYS/SIDEBAR_KEYS, the append-only
 * positional column definitions for the live "Team Accounts"/"Sidebar
 * Access" Google Sheets (services/roles.service.js). This is now the ONLY
 * content in this file.
 *
 * REMOVED 2026-09-16: ACTION_PERMISSIONS, ALL_ACCESS_EMAILS,
 * ROLES_ADMIN_EMAILS, API_SUPER_ADMIN_EMAILS — the hardcoded baseline every
 * dynamic permission check used to OR against, so the grid could only ever
 * ADD access on top of code nobody could see or edit, never fully govern
 * it. Every email any of those four ever granted was migrated into the live
 * sheet first (scripts/migrate-legacy-permissions.mjs, run 2026-09-16 —
 * see that script if you need the exact historical grants it read) so
 * removing them here changed no one's actual access. Roles & Access is now
 * the single, sole source every permission check consults
 * (services/permissions.service.js's userHasAction,
 * services/roles.service.js's isRolesAdmin, and
 * controllers/apiKeys.controller.js's assertApiSuperAdmin — the latter two
 * via the new `rolesAdmin`/`apiAdmin` keys below, also grid-editable now,
 * also migrated, also with no hardcoded fallback).
 */

export const PERMISSION_KEYS = [
  { key: 'verify', label: 'Verify Lease' },
  { key: 'approve', label: 'Approve Lease' },
  { key: 'expiry', label: 'Lease Expiry' },
  { key: 'renew', label: 'Renew (Renewed action)' },
  { key: 'document', label: 'Renew > Documents' },
  /* LABELS ONLY, updated 2026-08-18 to match the live workflow order in
   * frontend/src/constants/stages.js (WORKFLOW = [1,6,7,3,5,8]) and the
   * actual OffLeasePage tab strip — this grid's labels had drifted to the
   * pre-reorder numbering (still calling internal 6 "Stage 6" when the tabs
   * have called it "Stage 2" since 2026-08-12), so an admin ticking "Stage 6:
   * Transport" here had no way to know it actually governs the tab labelled
   * "Stage 2 (Kshirod Khatua)".
   *
   * The KEY and the array POSITION are untouched — both are read positionally
   * against the live "Team Accounts" sheet column-for-column (see the
   * append-only note below), so reordering this array or renaming a key would
   * silently corrupt every existing grant. Only the label string changes;
   * `offlease6` is still the third-from-last entry, still governs the same
   * sheet column, and now simply SAYS "Stage 2" because that is what Stage 2
   * has meant since the reorder. */
  { key: 'offleaseapproval', label: 'Off-Lease Stage 1A: Approval' },
  { key: 'offlease1', label: 'Off-Lease Stage 1: Intimation (Christopher)' },
  // Retired 2026-08-10 — no live tab corresponds to this. Deliberately NOT
  // labelled "Stage 2", which now means Transportation (offlease6, below).
  { key: 'offlease2', label: 'Off-Lease (Retired) Lifting / Arrival' },
  { key: 'offlease3', label: 'Off-Lease Stage 5: Inspection Checklist (Sitaram)' },
  // Retired 2026-08-10 — no live tab corresponds to this. Deliberately NOT
  // labelled "Stage 5", which now means Inspection Checklist (offlease3, above).
  { key: 'offlease4', label: 'Off-Lease (Retired) Quotation / Order' },
  { key: 'offlease5', label: 'Off-Lease Stage 6: Final Billing (Shivani)' },
  { key: 'offlease6', label: 'Off-Lease Stage 2: Transportation (Kshirod Khatua)' },
  { key: 'offlease7', label: 'Off-Lease Stage 4: Gate In (Pritam)' },
  { key: 'offlease8', label: 'Off-Lease Stage 7: KAM (Sales)' },
  { key: 'billing', label: 'Billing' },
  { key: 'receivables', label: 'Receivables' },
  /* APPENDED, never inserted — exactly like SIDEBAR_KEYS below. This array is
     read POSITIONALLY against the live "Team Accounts" sheet
     (roles.service.js: perms[p.key] = row[3 + k]), so putting offlease9 next
     to offlease8 would shift Billing and Receivables one column right and
     hand every user the wrong permission. A new key must land at the END,
     reading false for everyone until Roles & Access explicitly grants it —
     no hardcoded baseline exists to fall back on any more (removed
     2026-09-16; see this file's header comment). */
  { key: 'offlease9', label: 'Off-Lease Stage 9: Movement Entry' },
  // Appended (not inserted) — same positional rule as offlease9 above.
  { key: 'offleasedashboard', label: 'Off-Lease Dashboard' },
  { key: 'offleaselookup', label: 'Off-Lease Container Lookup' },
  /* Appended (not inserted) — same positional rule as offlease9 above.
   * Replace the old hardcoded ROLES_ADMIN_EMAILS/API_SUPER_ADMIN_EMAILS
   * arrays: "who can administer Roles & Access" / "who can manage API keys"
   * is now itself a Roles & Access permission, editable in this same grid,
   * not a separate list living in code. See roles.service.js's
   * isRolesAdmin/assertRolesAdmin and apiKeys.controller.js's
   * assertApiSuperAdmin — both now just check this key dynamically, with NO
   * hardcoded fallback (explicit choice, 2026-09-16: a lockout is recovered
   * by editing the live sheet directly, same as any other permission
   * mistake, not by a code-level escape hatch). */
  { key: 'rolesAdmin', label: 'Roles & Access Admin' },
  { key: 'apiAdmin', label: 'API Access Admin' },
  // Appended (not inserted) — same positional rule as offlease9 above. New
  // internal Stage 10 ("LR & Return Transportation"), added 2026-09-18,
  // displays as "Stage 3".
  { key: 'offlease10', label: 'Off-Lease Stage 3: LR & Return Transportation (Shivani)' }
];

export const SIDEBAR_KEYS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'myTask', label: 'My Task' },
  { key: 'verify', label: 'Verify Lease' },
  { key: 'approve', label: 'Approve Lease' },
  { key: 'expiry', label: 'Lease Expiry' },
  { key: 'billing', label: 'Billing Sales' },
  { key: 'pendingBilling', label: 'Pending Billing' },
  { key: 'receivables', label: 'Receivables' },
  { key: 'statement', label: 'Monthly Statement' },
  { key: 'outstanding', label: 'Outstanding View' },
  { key: 'deployedSummary', label: 'Deployed Summary' },
  { key: 'report', label: 'Report' },
  { key: 'billingApproval', label: 'Billing Approval' },
  { key: 'disputeApproval', label: 'Dispute Approval' },
  { key: 'approvalSummary', label: 'Approval Summary' },
  // Appended (not inserted) — new columns land at the END of the live
  // "Sidebar Access" sheet so no existing column shifts position. Added for
  // Lease Management's own Renew & Document / Off-Lease pages, which had no
  // dedicated sidebar toggle before (see nav.js's requireBoth wiring).
  { key: 'renewDocument', label: 'Renew & Document' },
  { key: 'offLease', label: 'Off-Lease' },
  /* BUG FOUND AND FIXED 2026-09-10: 'returnDashboard'/'agreementForm' were
     dropped from THIS array on 2026-08-18 when their pages were deleted, but
     the live "Sidebar Access" sheet was never trimmed to match — it still
     physically has both columns (confirmed live: 20 header columns wide,
     this array only accounted for 17). Since this array is read POSITIONALLY
     (row[1 + index]), removing them shifted every later entry's position
     off by 2 relative to the live sheet — appending offLeaseEfficiency
     straight after 'offLease' silently landed it on the leftover
     'returnDashboard' column instead of a new one, and read every existing
     user's old (mostly false) Return Dashboard value as their
     offLeaseEfficiency visibility, hiding the new nav item for everyone.
     Restored as inert placeholders to keep this array's positions aligned
     with the live sheet — neither key appears in RELEVANT_SIDEBAR_KEYS
     (roles.service.js) or as a sidebarKey in nav.js, so they hold their
     slot open without being editable or read anywhere. Do not remove a
     slot from this array again without also shrinking the live sheet. */
  { key: '_retiredReturnDashboard', label: 'Return Dashboard' },
  { key: '_retiredAgreementForm', label: 'Agreement Form' },
  // Genuinely the next free column — appended 2026-09-10. Off-Lease
  // Efficiency had no dedicated sidebar toggle before (nav.js left it
  // unkeyed/always-visible for exactly this reason: no matching column
  // existed here yet). See roles.service.js's _ensureSidebarHeaderWidth for
  // how the live sheet picks up this new column without hiding it from
  // existing users.
  { key: 'offLeaseEfficiency', label: 'Off-Lease Efficiency' },
  // Appended 2026-09-16, same reasoning/mechanism as offLeaseEfficiency
  // directly above — Reports had no sidebar column at all (nav.js left it
  // unkeyed/always-visible), backfilled true for every existing row by
  // _ensureSidebarHeaderWidth so nobody loses it the moment this ships.
  { key: 'reports', label: 'Reports' }
];
