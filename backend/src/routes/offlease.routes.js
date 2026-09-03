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
/* Pending count per stage, for the tab badges. */
router.get('/stage-counts', asyncHandler(offLeaseController.getStageCounts));

/* Stage 9 — container movement log (append-only, its own sheet, outside the
   1..8 pipeline). Declared BEFORE the '/:containerNo/...' routes so a literal
   'stage2'/'stage9' first segment can never be read as a container number. */
router.get('/stage2/containers', asyncHandler(offLeaseController.getMovementSources));
router.get('/stage2/container/:containerNo', asyncHandler(offLeaseController.getMovementSource));
router.get('/stage9/movements', asyncHandler(offLeaseController.getMovements));
router.post('/stage9/movements', asyncHandler(offLeaseController.saveMovement));

/* Dashboard live remarks — a comment thread per record, not stage data. */
router.get('/:containerNo/remarks', asyncHandler(offLeaseController.getRemarkThread));
router.post('/:containerNo/remarks', asyncHandler(offLeaseController.addRemark));
router.put('/:containerNo/remarks/:remarkId', asyncHandler(offLeaseController.updateRemark));
router.delete('/:containerNo/remarks/:remarkId', asyncHandler(offLeaseController.deleteRemark));

router.get('/:containerNo/stage/:stage', asyncHandler(offLeaseController.getStageDetail));
router.post('/:containerNo/stage/:stage', asyncHandler(offLeaseController.saveStage));

/* Stage 2 (Transportation) "Move To Stage" / Send Back — manual alternate-
   disposition move. Declared here, not under /:containerNo/stage/:stage,
   since neither is a normal stage-column save (see saveOffLeaseMoveToStage's
   doc comment in offlease.service.js). */
router.post('/:containerNo/move-to-stage', asyncHandler(offLeaseController.saveMoveToStage));
router.post('/:containerNo/send-back', asyncHandler(offLeaseController.saveSendBack));
router.get('/:containerNo/move-history', asyncHandler(offLeaseController.getMoveHistoryForContainer));

/* Stage 1 (Intimation) Hold / Send Back To Stage 1 — same "same row, no
   duplicate" shape as Move To Stage above, declared alongside it for the
   same reason (see saveOffLeaseHold's doc comment in offlease.service.js). */
router.post('/:containerNo/hold', asyncHandler(offLeaseController.saveHold));
router.post('/:containerNo/hold/send-back', asyncHandler(offLeaseController.saveSendBackToStage1));

/* Stage 1 (Intimation) Reject tab's own Send Back — reverses a Rejected
   approval decision AND reopens Stage 1 itself (see
   saveOffLeaseSendRejectedToStage1's doc comment). The Reject action itself
   has no separate route: it's the existing /:containerNo/approval endpoint
   with status = 'Rejected', now also accepting an optional `remarks` body
   field (RejectModal, frontend). */
router.post('/:containerNo/reject/send-back', asyncHandler(offLeaseController.sendRejectedToStage1));

/* Pending Approval queue (between Stage 1 and Stage 2) */
router.get('/approval', asyncHandler(offLeaseController.getApprovalData));
router.post('/:containerNo/approval', asyncHandler(offLeaseController.saveApprovalAction));

/* Dashboard: pipeline overview (all containers) + single-container lookup */
router.get('/dashboard', asyncHandler(offLeaseController.getDashboardData));
router.get('/efficiency', asyncHandler(offLeaseController.getEfficiencyData));
router.get('/:containerNo/detail', asyncHandler(offLeaseController.getContainerDetail));
router.get('/:containerNo/outstanding', asyncHandler(offLeaseController.getOutstanding));

/* Tracking-sheet bootstrap — moves a container off "Deployed" onto Off-Lease Tracking */
router.post('/tracking', asyncHandler(offLeaseController.addToTracking));

/* Admin-only: one-time maintenance / repair tools + diagnostics
   (ROLES_ADMIN_EMAILS gate enforced inside each controller via assertRolesAdmin) */
router.post('/admin/copy-approved-data', asyncHandler(offLeaseController.runCopyApprovedData));
router.get('/admin/fms-auto-create/preview', asyncHandler(offLeaseController.previewAutoCreateFromFms));
router.post('/admin/fms-auto-create/run', asyncHandler(offLeaseController.runAutoCreateFromFms));
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
