import { apiClient } from '../shared/auth/index.js';

/**
 * Roles & Access admin screen — same real backend endpoints the main app's
 * Roles & Access page uses (backend/src/routes/roles.routes.js), admin-gated
 * server-side (roles.service.js's assertRolesAdmin, HTTP 403 otherwise).
 *
 * GET /api/roles response shape:
 *   { emails: string[],
 *     permKeys: [{key,label}], sidebarKeys: [{key,label}],
 *     emailPerms: { [email]: { name, allAccess, perms: {[key]:bool} } },
 *     emailSidebar: { [email]: {[key]:bool} },
 *     team: [{email,name}] }
 */
export const getRolesAndAccessData = () => apiClient.get('/roles').then((r) => r.data);

export const saveEmailPermission = (email, key, value) =>
  apiClient.post('/roles/permission', { email, key, value }).then((r) => r.data);

export const saveEmailSidebar = (email, key, value) =>
  apiClient.post('/roles/sidebar', { email, key, value }).then((r) => r.data);

export const addTeamAccount = (email, name) =>
  apiClient.post('/roles/accounts', { email, name }).then((r) => r.data);

export const removeTeamAccount = (email) =>
  apiClient.delete('/roles/accounts', { data: { email } }).then((r) => r.data);

/** POST /api/auth/admin/add-user — creates a real login-capable account
 *  (Employee ID + Password, USER sheet) rather than just a permissions row.
 *  Same admin gate as everything else here (isRolesAdmin), enforced by
 *  auth.controller.js's addUser. Explicit request 2026-09-30: "login
 *  employee id wise and employee id role and access" — a new team member
 *  should get both login credentials AND their Team Accounts/Sidebar Access
 *  permission row from one form, not two separate admin steps. */
export const createUserLogin = ({ name, empId, password, email }) =>
  apiClient.post('/auth/admin/add-user', { name, empId, password, email }).then((r) => r.data);
