import { getPoAgreementTracker, addPoAgreementHistory } from '../api/dashboard.api.js';

export async function fetchPoAgreementTracker() {
  return getPoAgreementTracker();
}

export async function saveBackfillPeriod(payload) {
  return addPoAgreementHistory(payload);
}
