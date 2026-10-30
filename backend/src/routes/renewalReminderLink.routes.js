import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import * as renewalReminderLinkController from '../controllers/renewalReminderLink.controller.js';

/**
 * No-login renewal reminder deep link (explicit request 2026-10-30) —
 * reached only via the signed `?token=` link minted by
 * renewalReminderLink.service.js's mintRenewalReminderLink and sent in the
 * renewal reminder digest email. Same no-session convention as
 * sso.routes.js: deliberately NOT behind requireAuth — the token itself is
 * the authorization (see ssoIntoLeaseExpiry's own doc comment).
 */
const router = Router();

router.post('/sso', asyncHandler(renewalReminderLinkController.startSso));

export default router;
