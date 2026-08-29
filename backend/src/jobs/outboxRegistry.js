/**
 * kind (string, stored on each outbox entry) -> the REAL, unchanged
 * live-Sheets function to replay it against. See outbox.service.js's header
 * comment for why this points at the original functions instead of
 * hand-written duplicates.
 *
 * Filled in domain by domain as each write action gets a Mongo-first fast
 * path (offlease first, then verify/approve/expiry/roles).
 */
import {
  saveOffLeaseStage, saveOffLeaseApprovalAction, saveOffLeaseMoveToStage, saveOffLeaseSendBack,
  saveOffLeaseHold, saveOffLeaseSendBackToStage1, saveOffLeaseSendRejectedToStage1
} from '../services/offlease.service.js';
import { saveExpiryAction, completeDocumentStage } from '../services/expiry.service.js';

export const OUTBOX_REGISTRY = {
  'offlease.saveOffLeaseStage': saveOffLeaseStage,
  'offlease.saveOffLeaseApprovalAction': saveOffLeaseApprovalAction,
  'offlease.saveOffLeaseMoveToStage': saveOffLeaseMoveToStage,
  'offlease.saveOffLeaseSendBack': saveOffLeaseSendBack,
  'offlease.saveOffLeaseHold': saveOffLeaseHold,
  'offlease.saveOffLeaseSendBackToStage1': saveOffLeaseSendBackToStage1,
  'offlease.saveOffLeaseSendRejectedToStage1': saveOffLeaseSendRejectedToStage1,
  'expiry.saveExpiryAction': saveExpiryAction,
  'expiry.completeDocumentStage': completeDocumentStage
};

export function resolveReplay(kind) {
  const fn = OUTBOX_REGISTRY[kind];
  if (!fn) throw new Error(`No outbox replay registered for '${kind}'`);
  return fn;
}
