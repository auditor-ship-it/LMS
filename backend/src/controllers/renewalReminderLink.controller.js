import * as renewalReminderLinkService from '../services/renewalReminderLink.service.js';

/** POST /api/renewal-reminder-link/sso — no-login entry point for the
 *  signed reminder link. Verifies the token, SSOs the resolved KAM in
 *  (same posture as /api/sso/*), and returns a real session token — see
 *  ssoIntoLeaseExpiry's own doc comment. Not behind requireAuth
 *  (routes/renewalReminderLink.routes.js). */
export async function startSso(req, res) {
  const { token } = req.body;
  res.json(await renewalReminderLinkService.ssoIntoLeaseExpiry(token));
}
