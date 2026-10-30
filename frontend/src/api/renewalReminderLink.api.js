import { apiClient } from '../shared/auth/index.js';

/** POST /api/renewal-reminder-link/sso — no-login entry point for the
 *  signed reminder link. Returns a real session token (same shape as the
 *  Sales OS SSO endpoints) plus which container to land on. */
export const startRenewalReminderSso = ({ token }) =>
  apiClient.post('/renewal-reminder-link/sso', { token }).then((r) => r.data);
