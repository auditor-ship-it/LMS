import { ROUTES } from './routes.js';

/**
 * Sidebar hierarchy — exact structure requested:
 *   Lease Management
 *   ├── My Task
 *   ├── Verify Lease
 *   ├── Approve Lease (also the read-only lease register — same GET /approve
 *   │   data, no separate "Lease" page: the standalone Lease page was dropped
 *   │   as a duplicate of this one)
 *   ├── Lease Expiry
 *   ├── Renew & Document
 *   └── Off-Lease (also hosts the Stage 1..8 pipeline as tabs on that page —
 *       the separate "Stages" sidebar branch was removed in favor of this)
 *
 * `sidebarKey` matches the real app's Roles & Access "Sidebar" grid (the
 * per-email menu-visibility toggles) — this is the SOLE source of truth for
 * menu visibility, for every item below, no exceptions. The separate
 * Permissions grid controls what a user can actually DO on a page (each
 * page gates its own action buttons on that independently) — it has no say
 * in whether the menu item itself appears. Settled 2026-08-05 after going
 * back and forth on Renew & Document / Off-Lease specifically — do not
 * reintroduce a `requireBoth`/permKey-gated-visibility variant without the
 * user explicitly asking again.
 */
// `section` groups items under an uppercase label in the sidebar (purely
// visual — has no bearing on visibility, which is still sidebarKey/canView
// only). taskKey (where present) maps to a field on GET /tasks (My Task's
// existing pending-count aggregate) the sidebar reuses to show a badge —
// no separate endpoint per nav item.
/* `hidden: true` keeps the page, its route, permissions and breadcrumb exactly
   as they are and only leaves the item out of the sidebar menu (explicit
   request 2026-10-05: SD Refunds and Refunds Approval). Remove the flag to
   show it again. */
export const NAV_TREE = {
  label: 'Lease Management System',
  items: [
    { key: 'myTask', label: 'My Task', path: ROUTES.MY_TASK, icon: 'check-circle', sidebarKey: 'myTask', section: 'Overview' },
    { key: 'verify', label: 'Verify Lease', path: ROUTES.VERIFY_LEASE, icon: 'search', sidebarKey: 'verify', section: 'Agreements', taskKey: 'pendingVerify' },
    // Removed from the sidebar app-wide 2026-09-11 (explicit request) — the
    // page/route/backend are untouched, so it's still reachable directly
    // (ROUTES.APPROVE_LEASE) and My Task's "Pending Approvals" card still
    // links there; only the menu entry itself is gone. Re-add this line to
    // restore it for everyone.
    // { key: 'approve', label: 'Approve Lease', path: ROUTES.APPROVE_LEASE, icon: 'check', sidebarKey: 'approve', section: 'Agreements', taskKey: 'pendingApprovals' },
    { key: 'renewDocument', label: 'Renew & Document', path: ROUTES.RENEW_DOCUMENT, icon: 'edit', sidebarKey: 'renewDocument', section: 'Agreements', taskKey: 'renewPending' },
    // Menu entry removed 2026-10-05, then RESTORED the same day (explicit
    // request) — see ApprovalPendingPage.jsx / the Sales OS SSO embed
    // (SsoApprovalPendingPage.jsx, used by Pushpa Shetty for real renewal
    // approvals) for why the page and route never went anywhere in between.
    // taskKey added same day (explicit request: "show count for renew
    // approval pending") — same getMyTasks source the page's own "Approval
    // Pending" tile reads, see tasks.service.js.
    { key: 'approvalPending', label: 'Renew Approval Pending', path: ROUTES.APPROVAL_PENDING, icon: 'clock', section: 'Agreements', sidebarKey: 'approvalPending', taskKey: 'renewApprovalPending' },
    { key: 'leaseExpiry', label: 'Lease Expiry', path: ROUTES.LEASE_EXPIRY, icon: 'clock', sidebarKey: 'expiry', section: 'Lease', taskKey: 'expired' },
    { key: 'deployedSummary', label: 'Deployed Summary', path: ROUTES.DEPLOYED_SUMMARY, icon: 'grid', sidebarKey: 'deployedSummary', section: 'Lease' },
    { key: 'offLease', label: 'Off-Lease', path: ROUTES.OFF_LEASE, icon: 'package', sidebarKey: 'offLease', section: 'Returns', taskKey: 'offleaseApproval' },
    // sidebarKey added 2026-09-10 — the matching SIDEBAR_KEYS column now
    // exists (permissions.config.js) and roles.service.js backfills every
    // existing user's row to TRUE for it, so this doesn't silently vanish
    // for anyone the moment this ships (see _ensureSidebarHeaderWidth).
    { key: 'offLeaseEfficiency', label: 'Off-Lease Efficiency', path: ROUTES.OFF_LEASE_EFFICIENCY, icon: 'grid', sidebarKey: 'offLeaseEfficiency', section: 'Returns' },
    // sidebarKey added 2026-10-01 (explicit request) — the matching
    // SIDEBAR_KEYS column already existed (added 2026-09-16) but was never
    // wired here or added to RELEVANT_SIDEBAR_KEYS, so it controlled nothing.
    { key: 'reports', label: 'Reports', path: ROUTES.REPORTS, icon: 'list', section: 'Reports', sidebarKey: 'reports' },
    // sidebarKey added 2026-10-01 (explicit request). Real access is still
    // separately gated by the 'refunds' PERMISSION key (page renders
    // view-only without it) — this just controls menu visibility.
    { key: 'refunds', label: 'SD Refunds', path: ROUTES.REFUNDS, icon: 'inbox', section: 'Reports', sidebarKey: 'refunds', hidden: true },
    // Own sidebar page, not inline actions on the Refunds page — explicit
    // request 2026-09-30, same "separate approval page" pattern as Renew
    // Approval Pending above. sidebarKey added 2026-10-01; real access to
    // the Approve/Reject buttons is gated by the refundsApprovalHod/Ceo/
    // Accounts PERMISSION keys (page shows only what this caller can act on).
    { key: 'refundsApproval', label: 'Refunds Approval', path: ROUTES.REFUNDS_APPROVAL, icon: 'clock', section: 'Reports', sidebarKey: 'refundsApproval', hidden: true },
    // permKey added 2026-09-30 (explicit request: "this two access only
    // employee id 1111") — the menu entry itself now disappears for anyone
    // without the 'rolesAdmin' permission, not just the page content after
    // the click. See Sidebar.jsx's own doc comment for why this is a
    // deliberate, narrow exception rather than the general visibility rule.
    // sidebarKey ALSO added 2026-09-30 (explicit follow-up request) — an
    // independent, admin-editable toggle on top of the permission check;
    // both must allow it for this item to show.
    { key: 'rolesAccess', label: 'Roles & Access', path: ROUTES.ROLES_ACCESS, icon: 'lock', section: 'Admin', sidebarKey: 'rolesAccess', permKey: 'rolesAdmin' },
    // Same reasoning/exception as Roles & Access directly above, gated on
    // 'apiAdmin' + 'apiAccess' instead.
    { key: 'apiAccess', label: 'API Access', path: ROUTES.API_ACCESS, icon: 'external', section: 'Admin', sidebarKey: 'apiAccess', permKey: 'apiAdmin' }
  ]
};
