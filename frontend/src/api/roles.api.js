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
