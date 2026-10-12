# Database Documentation

LMS has no schema of its own. **Google Sheets is the system of record**; MongoDB is a read-optimized mirror, not an independent database. There are no foreign keys, no migrations, and no ORM — every "table" is a sheet tab, and every Mongo collection shares that tab's name and shape.

## Why a mirror exists

Reading Google Sheets live on every page load hit the Sheets API's shared quota (shared with other apps in the organization) and was a frequent source of rate-limit errors. The fix: a MongoDB mirror that the app reads from, kept in sync by a background reconciliation job, with writes still going to Sheets first (Sheets remains authoritative) and then patching the mirror immediately so a just-made change doesn't wait for the next sync cycle.

## Read/write pattern

```
WRITE:  app → Google Sheets (authoritative)  → patch the Mongo mirror (instant)
READ:   app → MongoDB mirror (fast, quota-free)
SYNC:   jobs/sheetsReconcile.job.js, every few minutes — catches edits made
        directly in the spreadsheet, or a mirror-patch that failed
```

If a Sheets write succeeds but the mirror patch fails, the next reconciliation cycle (minutes later) catches up — the mirror is never the thing actually holding data that matters, only a cache of it.

## Collection ↔ sheet mapping

Every entry below is a tab in the main spreadsheet (`env.GOOGLE_SHEET_ID`) unless noted. Collection name = sheet tab name, verbatim (see `backend/src/config/sheets.config.js` for the exact strings — some contain spaces/mixed case).

| Sheet tab (= Mongo collection) | Sync strategy | Notes |
|---|---|---|
| New Lease | full refresh, position-keyed | Container No is **not** reliably unique (confirmed live: one container can recur across orders/cycles) |
| Deployed sheet | full refresh | the fleet's current-lease master list; backs Lease Expiry, Off-Lease lookups, Renew & Document |
| Operation sheet | full refresh | |
| Billing Sales | full refresh | |
| Receivables | full refresh | |
| Off-Lease Tracking | full refresh | the Off-Lease 8-stage pipeline's own row-per-container sheet; uniqueness unverified, treated conservatively |
| New lease reff | full refresh | agreement/PO lookup enrichment for Verify Lease |
| USER | keyed by Email (col D), case-insensitive | verified unique |
| Team Accounts | keyed by Email (col A), case-insensitive | verified unique — this is the entire Roles & Access permission table |
| Sidebar Access | keyed by Email (col A), case-insensitive | verified unique |
| Off-Lease Remarks | append-only, full refresh, empty allowed | dashboard comment thread |
| Renew Remarks | append-only, full refresh, empty allowed | Renew Approval Pending's comment thread |
| Off-Lease Move History | append-only, full refresh, empty allowed | Stage 2 move/send-back audit trail |
| Stage 9 Movement | append-only, full refresh, empty allowed | container movement journal (outside the 1-8 stage pipeline) |
| Renewal Log | append-only, full refresh, empty allowed | every renewal action, audit trail |
| (auth session log) | append-only, full refresh, empty allowed | login activity |
| Invoice PO | full refresh | Accounts' transportation-invoice vetting log, read-only mirror |
| Off-Lease Bills (Refunds) | append-only, full refresh, empty allowed | SD-refund submissions + HOD/CEO/Accounts decisions |
| Stage 1 order-intake form | full refresh | external Google Form, read-only (this app never writes to it) |

### External workbook (separate spreadsheet — FMS)

| Sheet tab | Notes |
|---|---|
| STAGE-8, STAGE-9, STAGE-10 | a different Google Sheet entirely (`EXTERNAL_SPREADSHEETS.CONSOLIDATE`). Mirrored because `stage8.service.js` reading it live was the single largest source of Sheets quota errors app-wide. DO numbers are not reliably unique or even present (blanks are written as the literal text `"NA"`), so these are full-refresh with no natural key. |

### System collections (not sheet-backed)

| Collection | Purpose |
|---|---|
| sessions | login session tokens, TTL-indexed (auto-expire) |
| `_sync_outbox` | pending Sheets writes queued by Mongo-first flows, replayed by `outboxWorker.js` |
| `_api_keys` | public API key hashes (SHA-256) for `/api/public/v1/*` |
| `_runtime_config` | optional secrets fallback when `.env` can't be edited on the server |

## "fullRefresh" vs. natural-key upsert — why almost everything is full refresh

Most sheets here use `fullRefresh: true` (replace the whole collection every cycle, keyed by row position) rather than upserting by a natural key like Container No. This was a deliberate, hard-learned decision: Container No was verified unique on 2026-08-07, then silently stopped being so (a re-leased container keeps its old row instead of it being deleted). Upserting by that column was confirmed to cause **real, live data loss** — a Verify Lease "Approved" action was silently wiped because a second, unrelated row for the same container sorted after it on a later sync. Every sheet without a verified, enforced-unique key now uses full refresh instead.

The three sheets keyed by Email (USER, Team Accounts, Sidebar Access) are the exception — email uniqueness is actually enforced there.

## Known data-quality facts worth knowing before changing anything here

- Container numbers are **not unique** across the New Lease, Deployed, and Off-Lease Tracking sheets. A container can legitimately have multiple active rows (re-leased, or off-leased under more than one client historically).
- The external FMS workbook's "blank" cells are sometimes the literal text `"NA"`, not an empty cell — code reading those sheets accounts for this; new code touching them should too.
- `ROLE_PERMISSIONS_LEGACY` ("Role Permissions" tab) is read once during a migration script and otherwise unused — the entire authorization model now lives in Team Accounts + Sidebar Access (see `backend/src/config/permissions.config.js`'s header comment: a hardcoded permission baseline was removed 2026-09-16 in favor of this grid being the sole source).

## Where to look for more detail

Every entry in `backend/src/config/mongoSheetMapping.js` has its own doc comment explaining exactly why it's configured the way it is, usually citing the specific incident that led to that choice. That file is the authoritative source for this mapping — this document summarizes it, but the code comments are more detailed and will stay current if the mapping changes; update both together.
