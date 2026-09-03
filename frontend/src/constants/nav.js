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
export const NAV_TREE = {
  label: 'Lease Management System',
  items: [
    { key: 'myTask', label: 'My Task', path: ROUTES.MY_TASK, icon: 'check-circle', sidebarKey: 'myTask', section: 'Overview' },
    { key: 'verify', label: 'Verify Lease', path: ROUTES.VERIFY_LEASE, icon: 'search', sidebarKey: 'verify', section: 'Agreements', taskKey: 'pendingVerify' },
    { key: 'approve', label: 'Approve Lease', path: ROUTES.APPROVE_LEASE, icon: 'check', sidebarKey: 'approve', section: 'Agreements', taskKey: 'pendingApprovals' },
    { key: 'renewDocument', label: 'Renew & Document', path: ROUTES.RENEW_DOCUMENT, icon: 'edit', sidebarKey: 'renewDocument', section: 'Agreements', taskKey: 'renewPending' },
    { key: 'leaseExpiry', label: 'Lease Expiry', path: ROUTES.LEASE_EXPIRY, icon: 'clock', sidebarKey: 'expiry', section: 'Lease', taskKey: 'expired' },
    { key: 'deployedSummary', label: 'Deployed Summary', path: ROUTES.DEPLOYED_SUMMARY, icon: 'grid', sidebarKey: 'deployedSummary', section: 'Lease' },
    { key: 'offLease', label: 'Off-Lease', path: ROUTES.OFF_LEASE, icon: 'package', sidebarKey: 'offLease', section: 'Returns', taskKey: 'offleaseApproval' },
    /* No sidebarKey — same reasoning as 'reports' just below: the Sidebar
       Access sheet is read POSITIONALLY against SIDEBAR_KEYS, so a new key
       needs a matching column added there before it grants anything. Left
       unkeyed (always visible) rather than shipping a nav item nobody can see. */
    { key: 'offLeaseEfficiency', label: 'Off-Lease Efficiency', path: ROUTES.OFF_LEASE_EFFICIENCY, icon: 'grid', section: 'Returns' },
    /* No sidebarKey: the Sidebar Access sheet is read POSITIONALLY against
       SIDEBAR_KEYS, so a new key needs a matching column added there before it
       grants anything. Left unkeyed (always visible) until that column exists,
       rather than shipping a nav item nobody can see. */
    { key: 'reports', label: 'Reports', path: ROUTES.REPORTS, icon: 'list', section: 'Reports' },
    // No sidebarKey/permKey — always shown, same as the main app's own nav
    // (navConfig.js's `adminOnly: true` is decorative there too); real access
    // control is the server-side 403 (roles.service.js's assertRolesAdmin),
    // which the page itself turns into an "Access Restricted" state.
    { key: 'rolesAccess', label: 'Roles & Access', path: ROUTES.ROLES_ACCESS, icon: 'lock', section: 'Admin' },
    // Same convention as Roles & Access directly above — no sidebarKey,
    // gated server-side by API_SUPER_ADMIN_EMAILS (apiKeys.controller.js's
    // assertApiSuperAdmin), page itself renders "Access Restricted" on 403.
    { key: 'apiAccess', label: 'API Access', path: ROUTES.API_ACCESS, icon: 'external', section: 'Admin' }
  ]
};
