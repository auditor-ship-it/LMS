import {
  pushSaveEmailPermission,
  pushSaveEmailSidebar,
  pushAddTeamAccount,
  pushRemoveTeamAccount
} from '../services/sheetPushers/roles.pusher.js';
import { pushSaveVerifyAction, pushSaveVerifyFollowUp } from '../services/sheetPushers/verify.pusher.js';

/** handler registry key (stored on each outbox entry) -> pusher function(payload) */
export const OUTBOX_HANDLERS = {
  'roles.saveEmailPermission': pushSaveEmailPermission,
  'roles.saveEmailSidebar': pushSaveEmailSidebar,
  'roles.addTeamAccount': pushAddTeamAccount,
  'roles.removeTeamAccount': pushRemoveTeamAccount,
  'verify.saveVerifyAction': pushSaveVerifyAction,
  'verify.saveVerifyFollowUp': pushSaveVerifyFollowUp
};

export function resolveOutboxHandler(name) {
  const fn = OUTBOX_HANDLERS[name];
  if (!fn) throw new Error(`No outbox handler registered for '${name}'`);
  return fn;
}
