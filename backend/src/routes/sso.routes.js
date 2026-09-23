import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import * as ssoController from '../controllers/sso.controller.js';

const router = Router();

/* Unauthenticated on purpose — this IS the login step for a Sales OS deep
   link. Identity is proven by employeeCode (+ an optional signed token, see
   salesOsRenewal.service.js#verifyInboundParams) instead of a password —
   there is no other entry point into this router, so a normal session token
   is never required to reach it. */
router.post('/sales-os/session', asyncHandler(ssoController.startSession));

/* Same idea, but for the plain "embed the whole Lease Expiry page" case
   (Sales OS's "Lease" section) — no KAM lead/company context needed. */
router.post('/lease-expiry/session', asyncHandler(ssoController.startEmployeeSession));

/* Everything past the initial session hop runs as the SSO'd salesperson. */
router.post('/sales-os/confirm-company', requireAuth, asyncHandler(ssoController.confirmCompany));
router.post('/sales-os/renewal', requireAuth, asyncHandler(ssoController.saveRenewal));

export default router;
