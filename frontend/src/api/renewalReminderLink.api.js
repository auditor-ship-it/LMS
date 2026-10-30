import { apiClient } from '../shared/auth/index.js';

/** GET /api/renewal-reminder-link — no-login read for the signed action link. */
export const getRenewalReminderLinkTarget = ({ token }) =>
  apiClient.get('/renewal-reminder-link', { params: { token } }).then((r) => r.data);

/** POST /api/renewal-reminder-link/confirm — no-login action via the signed
 *  link. `action` ('renew' | 'offlease') is which button was clicked on the
 *  detail page — the token only ever authorizes WHICH container. */
export const confirmRenewalReminderLinkAction = ({ token, action }) =>
  apiClient.post('/renewal-reminder-link/confirm', { token, action }).then((r) => r.data);
