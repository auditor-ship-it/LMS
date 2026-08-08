import { SHEETS } from './sheets.config.js';

/**
 * Per-sheet identity config for the Sheets<->Mongo reconciliation job
 * (jobs/sheetsReconcile.job.js) and the outbox worker's row-resolution.
 *
 * naturalKeyColumn: 0-based column index reconciliation can use to link a
 *   legacy (pre-migration) sheet row to a Mongo doc before a `_mongoId`
 *   cell exists for it. null means the sheet has no reliable natural key —
 *   every unlinked row is treated as new and self-links via `_mongoId` from
 *   then on (append-only logs).
 * appendOnly: true for pure operational logs that are never updated in
 *   place, only ever appended to.
 * fullRefresh: true means Container No (or whatever column looked like a
 *   natural key) is NOT actually unique in this sheet — confirmed by
 *   directly checking the live data: Operation sheet/Billing Sales had 1030+
 *   rows collapsing to ~372 unique values, Deployed sheet/Receivables the
 *   same pattern (a container legitimately recurs across multiple orders/
 *   billing cycles). Upserting by that column silently collapses distinct
 *   rows into one doc — real data loss, not a cosmetic issue, since these
 *   feed the dashboard's KPIs directly. These sheets have no write-through
 *   path yet (read-only mirrors in this pass), so there is nothing to lose
 *   by fully replacing their collection every cycle instead of upserting —
 *   simpler and strictly more correct than inventing a synthetic key.
 *
 * Filled in domain-by-domain as each is migrated — see the rollout order in
 * the approved plan. Not every SHEETS.* constant needs an entry here yet.
 */
export const MONGO_SHEET_MAPPING = {
  [SHEETS.NEW_LEASE]: { naturalKeyColumn: 0, appendOnly: false }, // Container No — verified unique (47/47)
  [SHEETS.OPERATION]: { naturalKeyColumn: null, appendOnly: false, fullRefresh: true },
  [SHEETS.DEPLOYED]: { naturalKeyColumn: null, appendOnly: false, fullRefresh: true },
  // Off-Lease Tracking's container-no uniqueness hasn't been verified against
  // live data the way NEW_LEASE was (see the header note above) — fullRefresh
  // errs conservative rather than risk an upsert silently collapsing distinct
  // rows, matching the treatment OPERATION/DEPLOYED got for the same reason.
  [SHEETS.OFF_LEASE_TRACKING]: { naturalKeyColumn: null, appendOnly: false, fullRefresh: true },
  [SHEETS.BILLING_SALES]: { naturalKeyColumn: null, appendOnly: false, fullRefresh: true },
  [SHEETS.RECEIVABLES]: { naturalKeyColumn: null, appendOnly: false, fullRefresh: true },
  [SHEETS.USER]: { naturalKeyColumn: 3, appendOnly: false, keyCaseInsensitive: true }, // Email — verified unique
  [SHEETS.TEAM_ACCOUNTS]: { naturalKeyColumn: 0, appendOnly: false, keyCaseInsensitive: true }, // Email — verified unique
  [SHEETS.SIDEBAR_ACCESS]: { naturalKeyColumn: 0, appendOnly: false, keyCaseInsensitive: true }, // Email — verified unique
  // Order No (col D) uniqueness not verified against live data — fullRefresh
  // errs conservative, same reasoning as OPERATION/DEPLOYED above. Added so
  // getVerifyData's agreement-lookup enrichment (Client Code/Agreement Date/
  // Agreement PDF by Order No) can read this from Mongo instead of hitting
  // the live sheet on every Verify Lease page load — confirmed 2026-08-07 as
  // a live quota contributor (project-wide quota shared with 3 other apps).
  [SHEETS.NEW_LEASE_REFF]: { naturalKeyColumn: null, appendOnly: false, fullRefresh: true }
};

/** Normalizes a raw natural-key cell value the same way reconciliation and
 *  writeThrough call sites must agree on, so a write's filter always
 *  matches the doc reconciliation created for the same row. */
export function normalizeKey(sheetName, rawValue) {
  const s = String(rawValue == null ? '' : rawValue).trim();
  const mapping = getMongoSheetMapping(sheetName);
  return mapping?.keyCaseInsensitive ? s.toLowerCase() : s;
}

export function getMongoSheetMapping(sheetName) {
  return MONGO_SHEET_MAPPING[sheetName] || null;
}
