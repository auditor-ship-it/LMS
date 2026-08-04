import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import * as rolesController from '../controllers/roles.controller.js';

const router = Router();
router.use(requireAuth);

router.get('/', asyncHandler(rolesController.getData));
router.post('/permission', asyncHandler(rolesController.savePermission));
router.post('/sidebar', asyncHandler(rolesController.saveSidebar));
router.post('/accounts', asyncHandler(rolesController.addAccount));
router.delete('/accounts', asyncHandler(rolesController.removeAccount));

export default router;
