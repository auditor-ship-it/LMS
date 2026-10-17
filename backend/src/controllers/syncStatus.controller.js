import * as outboxService from '../services/outbox.service.js';
import { assertRolesAdmin } from '../services/roles.service.js';

/**
 * Admin-only read-only view of _sync_outbox (explicit request 2026-10-17) —
 * what's still waiting to replay against live Google Sheets after a
 * Mongo-first write. Same admin gate as Roles & Access (rolesAdmin), since
 * this exposes raw write-arguments for every background-synced action.
 */
export async function status(req, res) {
  await assertRolesAdmin(req.user.email);
  res.json(await outboxService.getOutboxStatus());
}
