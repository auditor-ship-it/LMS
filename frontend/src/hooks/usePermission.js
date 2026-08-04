import { useAuth } from '../shared/auth/index.js';

/**
 * Reads the same perms/sidebar bundle the shared AuthContext already loads
 * from the real backend (Roles & Access) — this app just applies its own
 * gating logic on top of that shared data, it doesn't fetch/own it.
 *
 * canAct: an action-permission key with no entry means "cannot act" (fails
 * closed, matching checkActionPermission's server-side deny-by-default).
 * canView: a sidebar-visibility key the admin has no explicit opinion on
 * defaults to visible (matches the main app's "no regression" default —
 * see frontend/src/hooks/usePermission.js).
 */
export function usePermission() {
  const { perms, sidebar } = useAuth();
  const canAct = (permKey) => (permKey ? !!perms[permKey] : true);
  const canView = (sidebarKey) => (sidebarKey in sidebar ? !!sidebar[sidebarKey] : true);
  return { canAct, canView, perms, sidebar };
}
