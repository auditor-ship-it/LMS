import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import * as newLeaseController from '../controllers/newLease.controller.js';

/** "New Lease" queue — see newLeaseQueue.service.js's own header comment.
 *  Any logged-in user can view/complete these, same posture as Off-Lease
 *  tracking creation itself (addToOffLeaseTrackingFast has no permission
 *  gate either). */
const router = Router();
router.use(requireAuth);

router.get('/', asyncHandler(newLeaseController.list));
router.post('/:id/complete', asyncHandler(newLeaseController.complete));

export default router;
