import * as renewalReminderLinkService from '../services/renewalReminderLink.service.js';

/** GET /api/renewal-reminder-link — no-login read for the signed action
 *  link minted into the renewal reminder digest email. The token carries
 *  its own container/row/action; verified inside the service — see
 *  getLinkTarget's own doc comment. Not behind requireAuth
 *  (routes/renewalReminderLink.routes.js). */
export async function getTarget(req, res) {
  const { token } = req.query;
  res.json(await renewalReminderLinkService.getLinkTarget(token));
}

/** POST /api/renewal-reminder-link/confirm — no-login action for the
 *  signed link. The token authorizes WHICH CONTAINER; `action` (which of
 *  the two buttons on the detail page was clicked) travels in the body —
 *  see confirmRenewalReminderAction's own doc comment. */
export async function confirm(req, res) {
  const { token, action } = req.body;
  res.json(await renewalReminderLinkService.confirmRenewalReminderAction(token, action));
}
