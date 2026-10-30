import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import * as renewalReminderLinkController from '../controllers/renewalReminderLink.controller.js';

/**
 * No-login renewal reminder action links (explicit request 2026-10-30) —
 * reached only via a signed `?token=` link minted by
 * renewalReminderLink.service.js's mintRenewalReminderLink and sent in the
 * renewal reminder digest email. Same no-session convention as
 * refundReview.routes.js: deliberately NOT behind requireAuth — the token
 * itself is the authorization (see getLinkTarget/confirmRenewalReminderAction's
 * own doc comments in renewalReminderLink.service.js).
 */
const router = Router();

router.get('/', asyncHandler(renewalReminderLinkController.getTarget));
router.post('/confirm', asyncHandler(renewalReminderLinkController.confirm));

export default router;
