import { startRenewalReminderSso } from '../api/renewalReminderLink.api.js';

/** Kicks off the renewal reminder's no-login SSO — `searchParams` is the
 *  email link's own URLSearchParams (token=, plus the display-only
 *  container=/row= — see mintRenewalReminderLink's own doc comment). Same
 *  "forward as a plain object" shape sso.service.js's own start functions
 *  use. */
export async function startRenewalReminderLinkSso(searchParams) {
  return startRenewalReminderSso(Object.fromEntries(searchParams.entries()));
}
