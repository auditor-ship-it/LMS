import { getRenewDocumentData, completeRenewalDocStage } from '../api/renewDocument.api.js';

export async function fetchDocumentList() {
  return getRenewDocumentData('documents');
}
export async function submitDocumentCompletion(payload) {
  return completeRenewalDocStage(payload);
}
