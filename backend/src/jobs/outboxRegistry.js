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
  saveOffLeaseHold, saveOffLeaseSendBackToStage1, saveOffLeaseSendRejectedToStage1, saveOffLeaseVoucherRaised,
  saveOffLeaseSendBackFromApproval, addToOffLeaseTrackingSheetWrite, saveOffLeasePaymentDone
} from '../services/offlease.service.js';
import { saveExpiryAction, completeDocumentStage, saveExpiryRemark, sendExpiryToPending, saveRenewalDraft, completeDocStage, decideRenewalApproval } from '../services/expiry.service.js';
import { writeHistoryRowToSheet } from '../services/poAgreementHistory.service.js';
import { addOffLeaseRemarkSheetWrite, updateOffLeaseRemarkSheetWrite, deleteOffLeaseRemarkSheetWrite } from '../services/offleaseRemarks.service.js';
import { decideRefundApproval, decideRefundSendBack } from '../services/refunds.service.js';
import { saveVerifyAction } from '../services/verify.service.js';

export const OUTBOX_REGISTRY = {
  'offlease.saveOffLeaseStage': saveOffLeaseStage,
  'offlease.saveOffLeaseApprovalAction': saveOffLeaseApprovalAction,
  'offlease.saveOffLeaseMoveToStage': saveOffLeaseMoveToStage,
  'offlease.saveOffLeaseSendBack': saveOffLeaseSendBack,
  'offlease.saveOffLeaseHold': saveOffLeaseHold,
  'offlease.saveOffLeaseSendBackToStage1': saveOffLeaseSendBackToStage1,
  'offlease.saveOffLeaseSendRejectedToStage1': saveOffLeaseSendRejectedToStage1,
  'offlease.saveOffLeaseVoucherRaised': saveOffLeaseVoucherRaised,
  'offlease.saveOffLeaseSendBackFromApproval': saveOffLeaseSendBackFromApproval,
  'offlease.addToOffLeaseTrackingSheetWrite': addToOffLeaseTrackingSheetWrite,
  'offlease.saveOffLeasePaymentDone': saveOffLeasePaymentDone,
  'expiry.saveExpiryAction': saveExpiryAction,
  'expiry.completeDocumentStage': completeDocumentStage,
  'expiry.saveExpiryRemark': saveExpiryRemark,
  'expiry.sendExpiryToPending': sendExpiryToPending,
  'expiry.saveRenewalDraft': saveRenewalDraft,
  'expiry.completeDocStage': completeDocStage,
  'expiry.decideRenewalApproval': decideRenewalApproval,
  'poAgreementHistory.writeRowToSheet': writeHistoryRowToSheet,
  'offleaseRemarks.addOffLeaseRemarkSheetWrite': addOffLeaseRemarkSheetWrite,
  'offleaseRemarks.updateOffLeaseRemarkSheetWrite': updateOffLeaseRemarkSheetWrite,
  'offleaseRemarks.deleteOffLeaseRemarkSheetWrite': deleteOffLeaseRemarkSheetWrite,
  'refunds.decideRefundApproval': decideRefundApproval,
  'refunds.decideRefundSendBack': decideRefundSendBack,
  'verify.saveVerifyAction': saveVerifyAction
};

export function resolveReplay(kind) {
  const fn = OUTBOX_REGISTRY[kind];
  if (!fn) throw new Error(`No outbox replay registered for '${kind}'`);
  return fn;
}
