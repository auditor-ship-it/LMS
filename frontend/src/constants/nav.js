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
 * per-email menu-visibility toggles, e.g. "Dashboard/My Task/Verify Lease/…"
 * in the admin's Sidebar tab) — an admin's explicit on/off there wins.
 * `permKey` matches the action-permission grid (the same checkActionPermission
 * types every page's own action buttons already gate on). Renew & Document,
 * Off-Lease and the Stages have no dedicated sidebar toggle in that system —
 * for those, the action permission is the only signal, so it doubles as the
 * menu-visibility gate. See Sidebar.jsx for how the two combine.
 */
export const NAV_TREE = {
  label: 'Lease Management System',
  items: [
    { key: 'myTask', label: 'My Task', path: ROUTES.MY_TASK, icon: 'check-circle', sidebarKey: 'myTask' },
    { key: 'verify', label: 'Verify Lease', path: ROUTES.VERIFY_LEASE, icon: 'search', sidebarKey: 'verify', permKey: 'verify' },
    { key: 'approve', label: 'Approve Lease', path: ROUTES.APPROVE_LEASE, icon: 'check', sidebarKey: 'approve', permKey: 'approve' },
    { key: 'leaseExpiry', label: 'Lease Expiry', path: ROUTES.LEASE_EXPIRY, icon: 'clock', sidebarKey: 'expiry', permKey: 'expiry' },
    { key: 'renewDocument', label: 'Renew & Document', path: ROUTES.RENEW_DOCUMENT, icon: 'edit', permKey: 'renew' },
    { key: 'offLease', label: 'Off-Lease', path: ROUTES.OFF_LEASE, icon: 'package', permKey: 'offleaseapproval' },
    // Read-only summary, no write action to gate — always shown, same as
    // Roles & Access below.
    { key: 'deployedSummary', label: 'Deployed Summary', path: ROUTES.DEPLOYED_SUMMARY, icon: 'grid' },
    // No sidebarKey/permKey — always shown, same as the main app's own nav
    // (navConfig.js's `adminOnly: true` is decorative there too); real access
    // control is the server-side 403 (roles.service.js's assertRolesAdmin),
    // which the page itself turns into an "Access Restricted" state.
    { key: 'rolesAccess', label: 'Roles & Access', path: ROUTES.ROLES_ACCESS, icon: 'lock' }
  ]
};
