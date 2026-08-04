/**
 * Port of checkActionPermission/getUserPermissions/getUserSidebarVisibility/
 * getUserAccessBundle (LMS.js lines 38-46, 159-193). Combines the static
 * ACTION_PERMISSIONS map with the dynamic Roles & Access sheets (additive OR).
 */
import { ACTION_PERMISSIONS, ALL_ACCESS_EMAILS } from '../config/permissions.config.js';
import { dynamicHasPermission, dynamicSidebarVisible } from './roles.service.js';
import { accessDenied } from '../utils/AppError.js';
import { SIDEBAR_KEYS } from '../config/permissions.config.js';

export async function userHasAction(email, type) {
  if (ALL_ACCESS_EMAILS.includes(email)) return true; // all-access bypass
  if (await dynamicHasPermission(email, type)) return true; // Roles & Access grant
  const allowed = ACTION_PERMISSIONS[type] || ACTION_PERMISSIONS.default;
  return allowed.includes(email);
}

export async function checkActionPermission(type, email) {
  if (!(await userHasAction(email, type))) {
    throw accessDenied();
  }
}

/** For frontend gating — which actions the current user can perform (true/false). */
export async function getUserPermissions(email) {
  const out = { user: email };
  for (const type of Object.keys(ACTION_PERMISSIONS)) {
    out[type] = await userHasAction(email, type);
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
