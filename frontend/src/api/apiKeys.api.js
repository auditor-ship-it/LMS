import { apiClient } from '../shared/auth/index.js';

/**
 * API Access admin screen — backend/src/routes/apiKeys.routes.js, admin-gated
 * server-side (apiKeys.controller.js's assertApiSuperAdmin, HTTP 403
 * otherwise). Manages the keys that unlock backend/src/routes/public.routes.js
 * (/api/public/v1/*) — a completely separate, session-free auth surface;
 * this screen itself is still a normal session-authenticated LMS page.
 *
 * GET /api/api-keys response shape:
 *   { domains: string[], writeCapableDomains: string[],
 *     keys: [{ id, label, keyPreview, scopes, actsAsEmail, createdBy,
 *     createdAt, revoked, revokedAt, revokedBy, lastUsedAt }] }
 *
 * POST /api/api-keys response includes `rawKey` — the only time the full
 * secret is ever sent to a browser; it is never retrievable again after this.
 * `actsAsEmail` is required whenever `scopes` includes any `:write`/`all:write`
 * token — see apiKeys.service.js's header comment for why writes run as a
 * real LMS user rather than the key itself.
 */
export const listApiKeys = () => apiClient.get('/api-keys').then((r) => r.data);

export const createApiKey = (label, scopes, actsAsEmail) =>
  apiClient.post('/api-keys', { label, scopes, actsAsEmail }).then((r) => r.data);

export const revokeApiKey = (id) =>
  apiClient.delete(`/api-keys/${id}`).then((r) => r.data);
