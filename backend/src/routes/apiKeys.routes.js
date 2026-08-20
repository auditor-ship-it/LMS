import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import * as apiKeysController from '../controllers/apiKeys.controller.js';

/**
 * Admin screen for managing public API keys (frontend: pages/apiAccess).
 * Session-authenticated like every other admin route in this app —
 * distinct from routes/public.routes.js, which the keys created here grant
 * access to and which needs no LMS login at all. Admin gate itself
 * (API_SUPER_ADMIN_EMAILS) is enforced inside each controller function,
 * same convention as roles.routes.js's assertRolesAdmin.
 */
const router = Router();
router.use(requireAuth);

router.get('/', asyncHandler(apiKeysController.list));
router.post('/', asyncHandler(apiKeysController.create));
router.delete('/:id', asyncHandler(apiKeysController.revoke));

export default router;
