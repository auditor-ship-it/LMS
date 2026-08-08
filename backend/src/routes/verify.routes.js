import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { requirePermission } from '../middlewares/permission.middleware.js';
import * as verifyController from '../controllers/verify.controller.js';

const router = Router();
router.use(requireAuth);

// Read-only, no permission gate in the original (getVerifyData had none)
router.get('/', asyncHandler(verifyController.getData));
// Read-only dashboard view — same no-gate convention as the list above;
// visibility is controlled by the Sidebar Access toggle, not this route.
router.get('/return-dashboard', asyncHandler(verifyController.getReturnDashboard));

router.post('/:containerNo/action', requirePermission('verify'), asyncHandler(verifyController.saveAction));
router.post('/:containerNo/follow-up', requirePermission('verify'), asyncHandler(verifyController.saveFollowUp));
router.post('/document', requirePermission('verify'), asyncHandler(verifyController.saveDocument));
router.post('/document/upload', requirePermission('verify'), asyncHandler(verifyController.uploadDocument));
router.put('/:containerNo/edit', requirePermission('verify'), asyncHandler(verifyController.editLease));

// Gated 'expiry' in the original (checkActionPermission('expiry', ...))
router.put('/lease-period', requirePermission('expiry'), asyncHandler(verifyController.updateLeasePeriod));
router.post('/renew-with-agreement', requirePermission('expiry'), asyncHandler(verifyController.renewWithAgreement));

export default router;
