import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { requirePublicApiKey } from '../middlewares/publicApiAuth.middleware.js';
import * as verifyController from '../controllers/verify.controller.js';
import * as approveController from '../controllers/approve.controller.js';
import * as expiryController from '../controllers/expiry.controller.js';
import * as offLeaseController from '../controllers/offlease.controller.js';

/**
 * Public, key-gated API (see publicApiAuth.middleware.js — the X-Api-Key
 * header, issued/scoped from the API Access admin screen, is the only auth
 * here; no LMS session/login is involved). Read endpoints (GET) need only a
 * matching read scope; write endpoints (POST) additionally need that
 * domain's `:write` scope AND run "acts as" a real LMS user named on the key
 * (apiKeys.service.js's `actsAsEmail`) — see `reuse()` below and
 * apiKeys.service.js's header comment for why. `accounts` has no write
 * routes at all (WRITE_CAPABLE_DOMAINS) — LMS never writes ledger data.
 *
 * Every handler below reuses the SAME controller function the internal,
 * session-authenticated route calls (see `reuse()`), so this can never
 * quietly drift into a second, out-of-sync copy of the read/write logic — a
 * change to what /api/offlease/dashboard returns, or what saving a stage
 * validates, automatically applies here too.
 */
const router = Router();

/**
 * Runs `controllerFn(shimReq, shimRes)` and forwards whatever it res.json()'d.
 *
 * Reads: `user: null` mirrors an unauthenticated caller; every read path
 * reused here already treats a null user as "unscoped" (see
 * salePersonScopeFor in salePersonAccess.service.js), so a public caller
 * sees the same unfiltered data an unscoped admin session would —
 * consistent with every domain here being fully exposed by design.
 *
 * Writes (`write: true`): `user: { email: req.actsAsEmail }`, set by
 * requirePublicApiKey's write check — the controller (and anything it calls,
 * including offlease.service.js's internal checkActionPermission) runs
 * exactly as if that real LMS user made the call themselves, body included.
 */
function reuse(controllerFn, { write = false } = {}) {
  return (req, res, next) => {
    const user = write ? { email: req.actsAsEmail } : null;
    const shimReq = { user, query: req.query, params: req.params, body: req.body };
    const shimRes = { json: (data) => res.json(data), status() { return this; } };
    Promise.resolve(controllerFn(shimReq, shimRes)).catch(next);
  };
}

/* ---------------- leases (Verify / Approve / Expiry) ---------------- */
router.get('/leases/verify', requirePublicApiKey('leases'), asyncHandler(reuse(verifyController.getData)));
router.get('/leases/approve', requirePublicApiKey('leases'), asyncHandler(reuse(approveController.getData)));
router.get('/leases/approve/history', requirePublicApiKey('leases'), asyncHandler(reuse(approveController.getHistory)));
// ?filter=pending|expired|... — same query param as the internal endpoint.
router.get('/leases/expiry', requirePublicApiKey('leases'), asyncHandler(reuse(expiryController.list)));

/* ---- leases: write (requires leases:write or all:write — see reuse() above) ---- */
// Body: { timestamp, status, billingType, invoiceType, linkContainer }
router.post('/leases/verify/:containerNo/action', requirePublicApiKey('leases', { write: true }), asyncHandler(reuse(verifyController.saveAction, { write: true })));
// Body: { timestamp, status } — status: 'Approved' | 'Rejected'
router.post('/leases/approve/:containerNo/action', requirePublicApiKey('leases', { write: true }), asyncHandler(reuse(approveController.saveByRow, { write: true })));
// Body: { rowId, timestamp, status }
router.post('/leases/expiry/action', requirePublicApiKey('leases', { write: true }), asyncHandler(reuse(expiryController.saveAction, { write: true })));

/* ---------------- off-lease pipeline ---------------- */
router.get('/offlease/dashboard', requirePublicApiKey('offlease'), asyncHandler(reuse(offLeaseController.getDashboardData)));
// ?stage=1..8 — same query param as the internal endpoint.
router.get('/offlease/stage', requirePublicApiKey('offlease'), asyncHandler(reuse(offLeaseController.getData)));
router.get('/offlease/approval', requirePublicApiKey('offlease'), asyncHandler(reuse(offLeaseController.getApprovalData)));
// ?leaseId= optional, same as the internal endpoint.
router.get('/offlease/:containerNo/detail', requirePublicApiKey('offlease'), asyncHandler(reuse(offLeaseController.getContainerDetail)));

/* ---- off-lease: write (requires offlease:write or all:write) ----
   Both of these check permission a SECOND time internally against
   actsAsEmail (offlease.service.js's checkActionPermission for the specific
   stage / the approval gate) — a key acting as someone without that
   specific stage's permission gets ACCESS_DENIED here even with a
   write-scoped key, same as if that person tried it in the app. */
// Body: whatever that stage's form fields are (same shape as the internal form).
router.post('/offlease/:containerNo/stage/:stage', requirePublicApiKey('offlease', { write: true }), asyncHandler(reuse(offLeaseController.saveStage, { write: true })));
// Body: { status } — status: 'Approved' | 'Rejected'
router.post('/offlease/:containerNo/approval', requirePublicApiKey('offlease', { write: true }), asyncHandler(reuse(offLeaseController.saveApprovalAction, { write: true })));

/* ---------------- accounts / invoice ledger (read-only — see WRITE_CAPABLE_DOMAINS) ---------------- */
// ?clientName= optional, same as the internal endpoint.
router.get('/accounts/:containerNo/outstanding', requirePublicApiKey('accounts'), asyncHandler(reuse(offLeaseController.getOutstanding)));

export default router;
