import { apiClient } from '../shared/auth/index.js';

/**
 * "New Lease" queue — see backend/src/services/newLeaseQueue.service.js's
 * own header comment. Populated by the Lease Expiry "Off-Lease Container"
 * modal's Location Change checkbox.
 */
export const getNewLeaseQueue = () => apiClient.get('/new-lease').then((r) => r.data.data);

export const completeNewLeaseEntry = (id, payload) =>
  apiClient.post(`/new-lease/${id}/complete`, payload).then((r) => r.data.result);

export const cancelNewLeaseEntry = (id) =>
  apiClient.post(`/new-lease/${id}/cancel`).then((r) => r.data.result);
