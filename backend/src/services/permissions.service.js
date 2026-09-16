/**
 * Port of checkActionPermission/getUserPermissions/getUserSidebarVisibility/
 * getUserAccessBundle (LMS.js lines 38-46, 159-193).
 *
 * REWORKED 2026-09-16: this used to OR the dynamic Roles & Access grant
 * against a hardcoded static baseline (ACTION_PERMISSIONS) and a separate
 * hardcoded ALL_ACCESS_EMAILS bypass — the grid could only ever ADD access
 * on top of code nobody could see or edit, never fully govern it. Both were
 * migrated into the live sheet (scripts/migrate-legacy-permissions.mjs,
 * run 2026-09-16 — every email either list ever granted now has the
 * equivalent dynamic grant) and removed from here. The Roles & Access grid
 * is now the ONLY source `userHasAction` consults — see PERMISSION_KEYS in
 * config/permissions.config.js for the full set of checkable keys, and
 * PermissionGrid.jsx's "All Access" row for the one dynamic bypass that
 * still exists (an admin-editable column, not code).
 */
import { dynamicHasPermission, dynamicSidebarVisible } from './roles.service.js';
import { accessDenied } from '../utils/AppError.js';
import { PERMISSION_KEYS, SIDEBAR_KEYS } from '../config/permissions.config.js';

export async function userHasAction(email, type) {
  return dynamicHasPermission(email, type);
}

export async function checkActionPermission(type, email) {
  if (!(await userHasAction(email, type))) {
    throw accessDenied();
  }
}

/** For frontend gating — which actions the current user can perform (true/false). */
export async function getUserPermissions(email) {
  const out = { user: email };
  for (const { key } of PERMISSION_KEYS) {
    out[key] = await userHasAction(email, key);
  }
  return out;
}

/** For the sidebar — only keys the admin has an explicit opinion on are included. */
export async function getUserSidebarVisibility(email) {
  const out = {};
  for (const item of SIDEBAR_KEYS) {
    const v = await dynamicSidebarVisible(email, item.key);
    if (v !== null) out[item.key] = v;
  }
  return out;
}

export async function getUserAccessBundle(email) {
  const [perms, sidebar] = await Promise.all([getUserPermissions(email), getUserSidebarVisibility(email)]);
  return { perms, sidebar };
}
