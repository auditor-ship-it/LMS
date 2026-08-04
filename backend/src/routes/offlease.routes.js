import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import * as offLeaseController from '../controllers/offlease.controller.js';

const router = Router();
router.use(requireAuth);

/* Core 8-stage pipeline. Per-stage permission (offlease1..offlease8) is
   dynamic on the :stage param, so it's enforced inside the service rather
   than via a static requirePermission(...) at the route level. */
router.get('/', asyncHandler(offLeaseController.getData)); // ?stage=1..8
router.get('/next-lease-id', asyncHandler(offLeaseController.nextLeaseId));
router.get('/:containerNo/stage/:stage', asyncHandler(offLeaseController.getStageDetail));
router.post('/:containerNo/stage/:stage', asyncHandler(offLeaseController.saveStage));

/* Pending Approval queue (between Stage 1 and Stage 2) */
router.get('/approval', asyncHandler(offLeaseController.getApprovalData));
router.post('/:containerNo/approval', asyncHandler(offLeaseController.saveApprovalAction));

/* Dashboard: pipeline overview (all containers) + single-container lookup */
router.get('/dashboard', asyncHandler(offLeaseController.getDashboardData));
router.get('/:containerNo/detail', asyncHandler(offLeaseController.getContainerDetail));

/* Tracking-sheet bootstrap — moves a container off "Deployed" onto Off-Lease Tracking */
router.post('/tracking', asyncHandler(offLeaseController.addToTracking));

/* Admin-only: one-time maintenance / repair tools + diagnostics
   (ROLES_ADMIN_EMAILS gate enforced inside each controller via assertRolesAdmin) */
router.post('/admin/copy-approved-data', asyncHandler(offLeaseController.runCopyApprovedData));
router.get('/admin/dump-headers', asyncHandler(offLeaseController.dumpHeaders));
router.post('/admin/restore-header-row', asyncHandler(offLeaseController.restoreHeaderRow));
router.post('/admin/fix-email-collision', asyncHandler(offLeaseController.fixEmailCollision));
router.post('/admin/reorder-columns', asyncHandler(offLeaseController.reorderColumns));
router.post('/admin/fix-stage-headers', asyncHandler(offLeaseController.fixStageHeaders));
router.get('/admin/debug-order-nos/:containerNo', asyncHandler(offLeaseController.debugOrderNos));
router.get('/admin/trace-order-no/:containerNo', asyncHandler(offLeaseController.traceOrder));
router.get('/admin/feeds-new-lease-reff', asyncHandler(offLeaseController.feedsNewLeaseReff));
router.get('/admin/feeds-all-sheets', asyncHandler(offLeaseController.feedsAllSheets));

export default router;
