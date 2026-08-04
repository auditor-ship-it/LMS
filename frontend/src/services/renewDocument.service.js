import { getRenewDocumentData, renewWithAgreement, completeRenewalDocStage } from '../api/renewDocument.api.js';

export async function fetchRenewList() {
  return getRenewDocumentData('renewed');
}
export async function fetchDocumentList() {
  return getRenewDocumentData('documents');
}
export async function submitRenewal(payload) {
  return renewWithAgreement(payload);
}
export async function submitDocumentCompletion(payload) {
  return completeRenewalDocStage(payload);
}
