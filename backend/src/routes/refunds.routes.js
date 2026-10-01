import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { requirePermission } from '../middlewares/permission.middleware.js';
import * as refundsController from '../controllers/refunds.controller.js';

const router = Router();
router.use(requireAuth);

/* No requirePermission('refunds') here — read access is broader than submit
   access (an HOD/CEO/Accounts approver may hold only their own stage
   permission, not the base 'refunds' one), enforced inside
   getRefundEntries' own _assertCanViewRefunds. */
router.get('/', asyncHandler(refundsController.list));
router.post('/', requirePermission('refunds'), asyncHandler(refundsController.create));
/* Approval gate itself is enforced inside decideRefundApproval
   (checkActionPermission('refundsApproval<Stage>', ...)) — no requirePermission(...)
   here, same pattern expiry.routes.js uses for its own decide-approval route. */
router.post('/decide-approval', asyncHandler(refundsController.decideApproval));

export default router;
