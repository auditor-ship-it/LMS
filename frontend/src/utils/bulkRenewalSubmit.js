/**
 * Shared by RenewDocumentPage.jsx's own Bulk Save/Submit and
 * LeaseExpiryPage.jsx's "Renew (N)" button (explicit report 2026-11-04,
 * "mujhe hai na aesa chhaiye... sab ek saath hona chhaiue" — one form
 * filled once should update every selected container, not one at a time) —
 * extracted here rather than left duplicated per page: a duplicate of
 * buildDocPayload/buildRenewPayload on these same two pages is exactly what
 * caused that same day's "data save nahi ho raha hai" bug (one copy updated
 * with new fields, the other silently left behind).
 */

export const RESULT_CODE_TEXT = {
  INVALID_STATE: 'not in the document-upload stage',
  MISSING_PO: 'PO number/file required',
  MISSING_AGR: 'signed agreement copy required'
};

/**
 * Runs `fn` for each item ONE AT A TIME, in the same { status, value|reason }
 * shape Promise.allSettled returns — a drop-in replacement for it, not a new
 * contract describeBulkFailures has to learn.
 *
 * Bulk Save/Submit used to fire every container's request at once
 * (Promise.allSettled(items.map(...))). Each one does its own LIVE Sheets
 * read-then-write (completeDocStage/saveRenewalDraft's "re-read before a
 * write" guard — see expiry.service.js), and firing a dozen-plus of those in
 * the same instant is exactly the burst this project's shared Sheets quota
 * keeps failing under (same root cause documented in
 * mongoSheetData.service.js's own header note — "any burst of traffic...
 * tripped the... rate limit... repeatedly"). Confirmed live 2026-10-06: a
 * 7-of-14 Sales OS bulk Submit failed with no INVALID_STATE/MISSING_PO/
 * MISSING_AGR reason on any of the 7 — a quota/transient-error signature, not
 * a data problem (all 7 were still plain 'Documents Pending' rows). Running
 * these one at a time costs a little wall-clock time on a big batch, but
 * never exceeds the per-minute quota the way firing them all at once does.
 */
export async function settleSequentially(items, fn) {
  const results = [];
  for (const item of items) {
    try {
      results.push({ status: 'fulfilled', value: await fn(item) });
    } catch (e) {
      results.push({ status: 'rejected', reason: e });
    }
  }
  return results;
}

/* Bulk Save/Submit failure summary — groups containers by the actual
   reason (server message or result code) instead of listing bare numbers. */
export function describeBulkFailures(results, items, doneVerb, apiErrorMessage) {
  const byReason = new Map();
  results.forEach((r, i) => {
    if (r.status !== 'rejected') return;
    const e = r.reason;
    const reason = RESULT_CODE_TEXT[e?.message] || apiErrorMessage(e) || 'Unknown error';
    if (!byReason.has(reason)) byReason.set(reason, []);
    byReason.get(reason).push(items[i].row?.[0]);
  });
  const failedCount = [...byReason.values()].reduce((n, list) => n + list.length, 0);
  if (!failedCount) return '';
  const detail = [...byReason.entries()].map(([reason, list]) => `${list.join(', ')} — ${reason}`).join(' | ');
  const tail = failedCount === items.length ? `None were ${doneVerb}.` : `The other ${items.length - failedCount} were ${doneVerb}.`;
  return `Failed for ${failedCount} of ${items.length}: ${detail}. ${tail}`;
}
