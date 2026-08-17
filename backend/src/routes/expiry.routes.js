import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { requirePermission } from '../middlewares/permission.middleware.js';
import * as expiryController from '../controllers/expiry.controller.js';

const router = Router();
router.use(requireAuth);

// Read-only — no dedicated permission gate in the original (getExpiryDataByFilter).
router.get('/', asyncHandler(expiryController.list));

/* Renewal Log as report rows, for the month-wise Renewal report. Read-only,
   so it follows the same open-read convention as the list above. */
router.get('/renewal-log', asyncHandler(expiryController.renewalLog));
router.get('/new-lease-report', asyncHandler(expiryController.newLeaseReport));

router.post('/documents/upload', requirePermission('document'), asyncHandler(expiryController.uploadDocument));
router.post('/documents/complete', requirePermission('document'), asyncHandler(expiryController.completeDocumentStage));

router.post('/action', requirePermission('expiry'), asyncHandler(expiryController.saveAction));

router.post('/renewal/complete-document-stage', requirePermission('renew'), asyncHandler(expiryController.completeRenewalDocStage));

export default router;
