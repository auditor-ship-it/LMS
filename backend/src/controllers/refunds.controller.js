import * as refundsService from '../services/refunds.service.js';

/** GET /api/refunds — every bill ever submitted, newest first. Also reused
 *  by the public API's reads (routes/public.routes.js), which shim
 *  `req.user` to `null` — `?.email` keeps that safe (getRefundEntries treats
 *  a literal `null` email as the public-API case, see its own doc comment). */
export async function list(req, res) {
  res.json({ headers: refundsService.REFUNDS_HEADERS, data: await refundsService.getRefundEntries(req.user?.email ?? null) });
}

/** POST /api/refunds — submit a new bill. Timestamp and the caller's email
 *  are stamped server-side (req.user.email), never taken from the body. */
export async function create(req, res) {
  res.json(await refundsService.addRefundEntry(req.body, req.user.email));
}

/** POST /api/refunds/decide-approval — HOD/CEO/Accounts decision. `stage` is
 *  'hod' | 'ceo' | 'accounts', `decision` is 'approved' | 'rejected'. The
 *  actual permission check (which stage this caller may decide) happens
 *  inside decideRefundApproval, same "per-action, not per-route" pattern
 *  expiry.routes.js's own decide-approval route uses. */
export async function decideApproval(req, res) {
  const { rowNum, stage, decision, remarks } = req.body;
  res.json({ result: await refundsService.decideRefundApproval(rowNum, stage, decision, remarks, req.user.email) });
}

/** GET /api/refund-review — no-login read for the signed review link (the
 *  "HOD/CEO/Accounts Review Link" sheet columns). Token carries its own
 *  rowNum/stage; verified inside the service — see getRefundEntryForReview's
 *  doc comment. Not behind requireAuth (routes/refundReview.routes.js). */
export async function getForReview(req, res) {
  const { rowNum, stage, token } = req.query;
  res.json({ headers: refundsService.REFUNDS_HEADERS, entry: await refundsService.getRefundEntryForReview(Number(rowNum), stage, token) });
}

/** POST /api/refund-review/decide — no-login decision for the signed review
 *  link. The token IS the authorization (decideRefundApprovalViaLink skips
 *  checkActionPermission) — same hierarchy/guards as decideApproval above. */
export async function decideViaLink(req, res) {
  const { rowNum, stage, token, decision, remarks } = req.body;
  res.json({ result: await refundsService.decideRefundApprovalViaLink(Number(rowNum), stage, decision, remarks, token) });
}
