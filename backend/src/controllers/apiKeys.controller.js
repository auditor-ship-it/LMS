import * as apiKeysService from '../services/apiKeys.service.js';
import { dynamicHasPermission } from '../services/roles.service.js';
import { accessDenied } from '../utils/AppError.js';

/**
 * REWORKED 2026-09-16: used to check a hardcoded API_SUPER_ADMIN_EMAILS
 * array, deliberately kept separate from Roles & Access admin since a
 * public API key is a standing credential to read data with no LMS login
 * at all — a materially bigger blast radius than anything else Roles &
 * Access gates. Still its own dedicated permission (`apiAdmin`,
 * PERMISSION_KEYS), just editable in the same grid now, with no hardcoded
 * fallback (same deliberate choice as roles.service.js's assertRolesAdmin —
 * see the migration script that seeded every prior API_SUPER_ADMIN_EMAILS
 * member's apiAdmin column true before this shipped).
 */
async function assertApiSuperAdmin(email) {
  if (!(await dynamicHasPermission(email, 'apiAdmin'))) {
    throw accessDenied('ACCESS_DENIED: API Access is restricted to admins.');
  }
}

export async function list(req, res) {
  await assertApiSuperAdmin(req.user.email);
  res.json({
    domains: apiKeysService.API_DOMAINS,
    writeCapableDomains: apiKeysService.WRITE_CAPABLE_DOMAINS,
    keys: await apiKeysService.listApiKeys()
  });
}

export async function create(req, res) {
  await assertApiSuperAdmin(req.user.email);
  const { label, scopes, actsAsEmail } = req.body;
  const created = await apiKeysService.createApiKey({ label, scopes, actsAsEmail, createdBy: req.user.email });
  res.json(created);
}

export async function revoke(req, res) {
  await assertApiSuperAdmin(req.user.email);
  const revoked = await apiKeysService.revokeApiKey(req.params.id, req.user.email);
  res.json(revoked);
}
