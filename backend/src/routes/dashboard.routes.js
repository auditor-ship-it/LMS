import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import * as dashboardController from '../controllers/dashboard.controller.js';

// Only the Deployed Summary/Detail slice — this backend doesn't have the
// wider dashboard/report-suite (those depend on Accounts & Collection
// domain services). See dashboard.service.js's header note.
const router = Router();
router.use(requireAuth);

router.get('/deployed-summary', asyncHandler(dashboardController.getDeployedSummary));
router.get('/deployed-detail', asyncHandler(dashboardController.getDeployedDetail));

export default router;
