import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { requirePermission } from '../middlewares/permission.middleware.js';
import * as approveController from '../controllers/approve.controller.js';

const router = Router();
router.use(requireAuth);

// Read-only, no permission gate in the original (getApproveData had none)
router.get('/', asyncHandler(approveController.getData));

// runAutoApproval / revertAutoApproved had NO checkActionPermission in the
// original either (editor/trigger-only) — preserved as-is: session required,
// no specific permission. Worth a second look in a security-focused pass now
// that they're reachable over REST instead of only from the Apps Script editor.
router.post('/auto-run', asyncHandler(approveController.runAuto));
router.post('/auto-revert', asyncHandler(approveController.revertAuto));

router.post('/action', requirePermission('approve'), asyncHandler(approveController.saveAction));
router.post('/:containerNo/action', requirePermission('approve'), asyncHandler(approveController.saveByRow));

export default router;
