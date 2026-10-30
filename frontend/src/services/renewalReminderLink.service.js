import { getRenewalReminderLinkTarget, confirmRenewalReminderLinkAction } from '../api/renewalReminderLink.api.js';

export async function fetchRenewalReminderLinkTarget(token) {
  return getRenewalReminderLinkTarget({ token });
}
export async function submitRenewalReminderLinkConfirm(token, action) {
  return confirmRenewalReminderLinkAction({ token, action });
}
