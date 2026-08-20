import * as apiKeysService from '../services/apiKeys.service.js';
import { API_SUPER_ADMIN_EMAILS } from '../config/permissions.config.js';
import { accessDenied } from '../utils/AppError.js';

function assertApiSuperAdmin(email) {
  if (!API_SUPER_ADMIN_EMAILS.includes(email)) {
    throw accessDenied('ACCESS_DENIED: API Access is restricted to admins.');
  }
}

export async function list(req, res) {
  assertApiSuperAdmin(req.user.email);
  res.json({
    domains: apiKeysService.API_DOMAINS,
    writeCapableDomains: apiKeysService.WRITE_CAPABLE_DOMAINS,
    keys: await apiKeysService.listApiKeys()
  });
}

export async function create(req, res) {
  assertApiSuperAdmin(req.user.email);
  const { label, scopes, actsAsEmail } = req.body;
  const created = await apiKeysService.createApiKey({ label, scopes, actsAsEmail, createdBy: req.user.email });
  res.json(created);
}

export async function revoke(req, res) {
  assertApiSuperAdmin(req.user.email);
  const revoked = await apiKeysService.revokeApiKey(req.params.id, req.user.email);
  res.json(revoked);
}
