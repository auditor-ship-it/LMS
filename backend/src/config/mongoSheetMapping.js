import { SHEETS, EXTERNAL_SPREADSHEETS } from './sheets.config.js';

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
  // Container No was verified unique (47/47) on 2026-08-07 — no longer true.
  // BUG FOUND 2026-08-29: 14 of 73 containers now have 2-3 rows each (a
  // container re-leased after an earlier cycle keeps its old row instead of
  // it being deleted — same pattern as Deployed/Off-Lease Tracking below).
  // Upserting by that column silently collapsed them onto ONE Mongo doc,
  // so whichever row the reconcile job's next pass processed LAST won —
  // discarding the other row's data outright. Confirmed as real, live data
  // loss: TRIU6632949's Verify Lease "Approved" action, saved seconds
  // earlier, was silently wiped by the next reconcile cycle because a
  // second, unrelated row for the same container number happened to sort
  // after it in the sheet. Switched to fullRefresh (position-keyed
  // `row_N`), same fix and same reasoning as those other sheets.
  [SHEETS.NEW_LEASE]: { naturalKeyColumn: null, appendOnly: false, fullRefresh: true },
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
  [SHEETS.NEW_LEASE_REFF]: { naturalKeyColumn: null, appendOnly: false, fullRefresh: true },

  /* EXTERNAL FMS WORKBOOK (2026-08-28) — a completely different Google
   * Sheet (EXTERNAL_SPREADSHEETS.CONSOLIDATE), not the main lease-management
   * spreadsheet every other entry above reads from. `ssId` on an entry
   * overrides the reconcile job's default (env.googleSheetId) for that one
   * sheet — see sheetsReconcile.job.js's reconcileSheet.
   *
   * Explicit, deliberate request: this workbook was the single largest
   * remaining source of "Google Sheets API rate limit" errors reaching the
   * app, because stage8.service.js read it live (with its own 30-min
   * in-memory cache + disk-persisted last-good fallback) instead of through
   * this Mongo-mirror system every other sheet already uses. Mirrored here
   * the same way, stage8.service.js now reads Mongo exclusively — see its
   * own 2026-08-28 rewrite.
   *
   * fullRefresh (position-keyed), same reasoning as Operation/Deployed/
   * Off-Lease Tracking above: DO numbers on these tabs are NOT reliably
   * unique or even reliably present (confirmed 2026-08-27 — blank cells are
   * written as literal "NA" text, not left empty), so there is no safe
   * natural key to upsert by. */
  [SHEETS.FMS_STAGE8]: { naturalKeyColumn: null, appendOnly: false, fullRefresh: true, ssId: EXTERNAL_SPREADSHEETS.CONSOLIDATE.ssId },
  [SHEETS.FMS_STAGE9]: { naturalKeyColumn: null, appendOnly: false, fullRefresh: true, ssId: EXTERNAL_SPREADSHEETS.CONSOLIDATE.ssId },
  [SHEETS.FMS_STAGE10]: { naturalKeyColumn: null, appendOnly: false, fullRefresh: true, ssId: EXTERNAL_SPREADSHEETS.CONSOLIDATE.ssId }
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
