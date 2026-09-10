/**
 * Static permission baseline — ported verbatim from LMS.js (ACTION_PERMISSIONS,
 * ALL_ACCESS_EMAILS, ROLES_ADMIN_EMAILS, PERMISSION_KEYS, SIDEBAR_KEYS).
 * The dynamic Roles & Access sheets (Team Accounts / Sidebar Access) sit
 * ADDITIVELY on top of this — see services/roles.service.js. Do not remove
 * emails from here as part of a "cleanup"; that changes production access.
 */

export const ACTION_PERMISSIONS = {
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
  /* Stage 9 (movement entry) draws its containers from Stage 2, so it starts
     with exactly the offlease6 (Transportation) list — the people already
     working that queue, Kshirod Khatua included. Roles & Access can widen it. */
  offlease9: ['pushpa.shetty@crystalgroup.in', 'sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'ar@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'kshirod.khatua@crystalgroup.in', 'pc@crystalgroup.in'],
  /* 2026-08-18: Dashboard and Container Lookup, the two tabs inside the
     Off-Lease page that aren't tied to any one stage, had NO permission gate
     at all before this — anyone with any Off-Lease access saw both. This is
     the union of every email across offleaseapproval + offlease1..9 above:
     everyone who can already act on some part of Off-Lease keeps both tabs
     exactly as before; Roles & Access can now narrow either individually. */
  offleasedashboard: ['pushpa.shetty@crystalgroup.in', 'sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'ar@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'kshirod.khatua@crystalgroup.in', 'pc@crystalgroup.in', 'service@crystalgroup.in'],
  offleaselookup: ['pushpa.shetty@crystalgroup.in', 'sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'ar@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'kshirod.khatua@crystalgroup.in', 'pc@crystalgroup.in', 'service@crystalgroup.in'],
  billing: ['shivani.dhall@crystalgroup.in', 'intern@crystalgroup.in', 'pushpa.shetty@crystalgroup.in', 'swati.barot@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'pc@crystalgroup.in'],
  receivables: ['ar@crystalgroup.in', 'intern@crystalgroup.in', 'pushpa.shetty@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'support@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'pc@crystalgroup.in'],
  'default': ['intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'ar@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'pc@crystalgroup.in']
};

// All-access users: allowed to perform EVERY action above (all workflow points).
// Does NOT grant API Key / API Kit admin — that stays gated to API_SUPER_ADMIN only.
export const ALL_ACCESS_EMAILS = ['aa@crystalgroup.in'];

export const ROLES_ADMIN_EMAILS = ['dmo@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'aa@crystalgroup.in'];

/* Who can create/revoke public API keys (services/apiKeys.service.js,
   routes/apiKeys.routes.js) — deliberately its own list, not reused from
   ROLES_ADMIN_EMAILS or ALL_ACCESS_EMAILS, since a public API key is a
   standing credential to read data with no LMS login at all, a materially
   bigger blast radius than anything else this file gates. Defaulted to the
   same trusted circle as Roles & Access; edit this array directly to
   narrow or widen it, same as every other list here. */
export const API_SUPER_ADMIN_EMAILS = ['dmo@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'aa@crystalgroup.in'];

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
  { key: 'offleaseapproval', label: 'Off-Lease Stage 1.2: Approval' },
  // Also governs the Stage 1.1 (Invoice) tab — same permission, no separate
  // key, since that tab is a filtered view of Stage 1's own data/form.
  { key: 'offlease1', label: 'Off-Lease Stage 1 / 1.1: Intimation & Invoice (Christopher)' },
  // Retired 2026-08-10 — no live tab corresponds to this. Deliberately NOT
  // labelled "Stage 2", which now means Transportation (offlease6, below).
  { key: 'offlease2', label: 'Off-Lease (Retired) Lifting / Arrival' },
  { key: 'offlease3', label: 'Off-Lease Stage 4: Inspection Checklist (Sitaram)' },
  // Retired 2026-08-10 — no live tab corresponds to this. Deliberately NOT
  // labelled "Stage 4", which now means Inspection Checklist (offlease3, above).
  { key: 'offlease4', label: 'Off-Lease (Retired) Quotation / Order' },
  { key: 'offlease5', label: 'Off-Lease Stage 5: Billing Reconciliation (Shivani Maam)' },
  { key: 'offlease6', label: 'Off-Lease Stage 2: Transportation (Kshirod Khatua)' },
  { key: 'offlease7', label: 'Off-Lease Stage 3: Gate In (Pritam)' },
  { key: 'offlease8', label: 'Off-Lease Stage 6: FMS Closure' },
  { key: 'billing', label: 'Billing' },
  { key: 'receivables', label: 'Receivables' },
  /* APPENDED, never inserted — exactly like SIDEBAR_KEYS below. This array is
     read POSITIONALLY against the live "Team Accounts" sheet
     (roles.service.js: perms[p.key] = row[3 + k]), so putting offlease9 next
     to offlease8 would shift Billing and Receivables one column right and
     hand every user the wrong permission. A new key must land at the END, and
     its sheet column does not exist yet — so it reads false until Roles &
     Access adds it, which is why ACTION_PERMISSIONS above carries the working
     baseline. */
  { key: 'offlease9', label: 'Off-Lease Stage 9: Movement Entry' },
  // Appended (not inserted) — same positional rule as offlease9 above. Until
  // Roles & Access explicitly sets these for someone, ACTION_PERMISSIONS'
  // offleasedashboard/offleaselookup baseline is what's actually in effect
  // (see dynamicHasPermission's additive-OR in roles.service.js).
  { key: 'offleasedashboard', label: 'Off-Lease Dashboard' },
  { key: 'offleaselookup', label: 'Off-Lease Container Lookup' }
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
  { key: 'offLeaseEfficiency', label: 'Off-Lease Efficiency' }
];
