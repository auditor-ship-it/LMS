import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import * as refundsController from '../controllers/refunds.controller.js';

/**
 * No-login Refund review (explicit request 2026-10-01) — reached only via a
 * signed link (?rowNum=&stage=&token=) minted by refunds.service.js's
 * _mintRefundReviewLink and written straight into the Offlease Bills sheet's
 * HOD/CEO/Accounts "Review Link" columns, same no-session convention as
 * sso.routes.js's /sales-os/session: deliberately NOT behind requireAuth —
 * the token itself is the authorization (see getRefundEntryForReview /
 * decideRefundApprovalViaLink's own doc comments in refunds.service.js).
 */
const router = Router();

router.get('/', asyncHandler(refundsController.getForReview));
router.post('/decide', asyncHandler(refundsController.decideViaLink));

export default router;
