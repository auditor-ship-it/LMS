import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import * as syncStatusController from '../controllers/syncStatus.controller.js';

/**
 * Admin screen showing what's still pending in the Mongo-first write outbox
 * (frontend: pages/syncStatus) — explicit request 2026-10-17. Admin gate
 * (rolesAdmin) enforced inside the controller, same convention as
 * apiKeys.routes.js/roles.routes.js.
 */
const router = Router();
router.use(requireAuth);

router.get('/', asyncHandler(syncStatusController.status));

export default router;
