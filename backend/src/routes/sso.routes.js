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

/* Same idea, but for the plain "embed the whole page" cases — no KAM
   lead/company context needed, just employeeCode -> session. All three route
   to the exact same handler (startEmployeeSession does nothing page-specific)
   — kept as separate paths only so each embed's URL is self-descriptive for
   whoever wires it up on the Sales OS side:
     - lease-expiry: LeaseExpiryPage (Renew, Off-Lease, Remarks)
     - renew-document: RenewDocumentPage (Update Agreement, Save, Send Back)
     - approval-pending: ApprovalPendingPage (Approve/Reject a submitted renewal) */
router.post('/lease-expiry/session', asyncHandler(ssoController.startEmployeeSession));
router.post('/renew-document/session', asyncHandler(ssoController.startEmployeeSession));
router.post('/approval-pending/session', asyncHandler(ssoController.startEmployeeSession));

/* Everything past the initial session hop runs as the SSO'd salesperson. */
router.post('/sales-os/confirm-company', requireAuth, asyncHandler(ssoController.confirmCompany));
router.post('/sales-os/renewal', requireAuth, asyncHandler(ssoController.saveRenewal));
router.post('/sales-os/renewal-draft', requireAuth, asyncHandler(ssoController.saveRenewalDraft));

export default router;
