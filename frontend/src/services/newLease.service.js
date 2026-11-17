import { getNewLeaseQueue, completeNewLeaseEntry } from '../api/newLease.api.js';
import { invalidate } from '../shared/dataBus.js';

export async function fetchNewLeaseQueue() {
  return getNewLeaseQueue();
}

export async function submitNewLeaseEntry(id, payload) {
  const result = await completeNewLeaseEntry(id, payload);
  invalidate('deployed-sheet');
  return result;
}
