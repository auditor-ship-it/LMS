import { apiClient } from '../shared/auth/index.js';

/** Outbox status (admin-only) — what's still pending replay to live Google Sheets after a Mongo-first write. */
export const getSyncStatus = () => apiClient.get('/sync-status').then((r) => r.data);
