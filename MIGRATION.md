# LMS → central PostgreSQL (branch `migration/central-db`)

Status: built and sandbox-tested, **not deployed**. Production keeps running `main` unchanged
(Google Sheets + Mongo mirrors) until a cutover is approved.

## What this branch does

`DATA_SOURCE=central` switches the backend to the company PostgreSQL database. Without that
setting the app behaves exactly as before (that is the rollback).

In central mode the app **never calls Google**:

| Before (main) | Central mode |
|---|---|
| Reads tabs live from Sheets or from the Mongo mirrors (`Deployed sheet`, `Off-Lease Tracking`, …) | Reads schema `lease`: one typed table per tab |
| Writes cells to Sheets, then patches the Mongo mirror | Writes the same cells to the `lease` tables; the Sheets are never written |
| Mongo-first "Fast" writes + `_sync_outbox` replayed to Sheets every 7 s | The authoritative write runs directly against `lease`; outbox worker not started |
| `sheetsReconcile` cron (Sheets → Mongo every 5 min) | Not scheduled |
| `insertSheetIfMissing` / `deleteSheetIfExists` / `ensureColumnCount` create, drop or widen tabs | Never create or drop anything (a registered empty tab gets its header row) |
| Roles read `Team Accounts` / `Sidebar Access` live | Read from `lease.team_accounts` / `lease.sidebar_access` |
| Gate-In form `Stage 3 ` read live | `lease.stage_3` |
| FMS workbook STAGE-8/9/10 (Mongo mirror of an external workbook) | `lease.fms_stage_8/9/10` when the central copy has workbook `fms_dispatch`, else empty + one log line |
| Drive uploads/downloads, admin sheet-repair tools | Return HTTP 503 "not available with DATA_SOURCE=central" (files move to R2 separately) |

Code: `backend/src/services/centralSheets.service.js` (the one new module; identical copy in
Accounts-Collection), plus small `if (isCentral())` branches in `googleSheets.service.js`,
`mongoSheetData.service.js`, `mongo.service.js` (old mirror collection names → central tables, both
mirror shapes), `offlease/expiry.service.js` (the 12 `*Fast` writers call their authoritative
function), `server.js`, `jobs/index.js`, `config/env.js`. New dependency: `pg`.

### Schema `lease` (shared with Accounts-Collection — one shape, one writer)

- `db/central/0001_lease_schema.sql` — roles `lease_owner/_rw/_ro`, schema, registry
  `lease.sheet_tab` (which table holds which workbook tab) and `lease.sheet_column`
  (header row + type of every column).
- `backend/scripts/central/load-lease.mjs` — the loader/rebuild job. Reads `landing_sheets.rows`
  (uses `raw` = unformatted values; falls back to un-formatting the display text only where `raw`
  is NULL), creates/extends one table per tab, fills it, and **verifies every row cell-by-cell**
  against the source (fails the tab otherwise).
- `db/central/0002_lease_tables.generated.sql` — the DDL the loader produced from the
  23 Oct copy, for review (the loader re-creates it idempotently; new sheet columns are added).

Table shape: `lease.<tab_slug>(row_number int PK = sheet row, c000_<header> …, _extra jsonb)`.
Columns are `text`, `double precision` or `boolean` (type of ≥90 % of a column's values); a cell
that does not fit its column's type (e.g. `"NA"` in a number column), or sits past the typed
columns, is kept in `_extra` so nothing is lost. Reads rebuild exactly the arrays the Sheets API
returned, so the existing index-based business logic is unchanged.

Safety: every app write stamps `sheet_tab.app_written_at`; the loader refuses to overwrite a tab
the apps have written since its last load unless `--force`.

Tabs loaded (31): New Lease, Deployed sheet, Operation sheet, Billing Sales, Receivables, Renewal
Log, Off-Lease Tracking, Dispute Approval, New Lease Other Order type, Approve billing for invoice,
Receivables other order Type, Transportion, Control, Client Db, New lease reff, Team Accounts,
Sidebar Access, Role Permissions (empty), USER, Stage 9 Movement, Off-Lease Remarks, Off-Lease Move
History, Renew Remarks, `__login_log`, Login Time Log, ` Invoice PO`, Offlease Bills, Stage 1,
`Stage 3 ` + container_master `Master Sheet`, `container_master_logs`.
Left out on purpose: `__api_keys/__api_usage/__api_admin_audit/__api_idempotency` (no code reads
them; 182k rows of old usage log), `Copy of …`, `SheetNN`, backups.

### Missing workbooks (served empty, one `[CENTRAL] … not in the central copy` log line each)

| Workbook | Tabs used | Status |
|---|---|---|
| `fms_dispatch` (1_9Lsg4A…, FMS / "Consoldate Data") | STAGE-8, STAGE-9, STAGE-10 (LMS); STAGE1/2/3/4/7, STAGE5.1, Consoldate Data (Accounts-Collection) | Configured in the VPS sync (`sheets_oms`) but absent from the sandbox copy. The loader picks it up automatically when present. Note: STAGE-8 column G hyperlinks (reconcile read them with `FORMULA`) are not in the copy — only the link text. |
| `invoice_template` (1SZQzdi8…) | invoiceTemplate<Month> | Not in the central sync — add it to `sources.vps.json`. |
| `invoice_archive_2526` (1ko_BTCi…) | Merge_invoices | Not in the central sync (static archive; Accounts-Collection keeps its already-imported Mongo copy). |
| `sales_exec_company_assigned` (1E7mHI6j…) | — | Dead constant, never read. |

### Still on Mongo (for now)

App-only collections stay on the Lease Mongo database: `_auth_sessions`, `_api_keys`,
`_runtime_config`, `_sync_outbox` (unused in central mode), SLA alerts/feature flags, monthly-report
state, `_sales_os_*`. They are many and document-shaped; they move with the MongoDB-compatible
layer being tested separately. The Sales CRM leads lookup (`SALES_CRM_MONGODB_URI`) is another
app's database and is read-only here.

## Run in central mode

```sh
# once, as DB admin
psql "$ADMIN_URL" -f db/central/0001_lease_schema.sql
# (Accounts-Collection: its db/central/0001_collection_lease_access.sql)
cd backend && npm ci
node scripts/central/load-lease.mjs --db "$ADMIN_URL"          # landing_sheets is in the same DB on the VPS

# backend env
DATA_SOURCE=central
CENTRAL_DATABASE_URL=postgres://lease_app:…@127.0.0.1:6432/crystal   # login role, member of lease_rw
MONGODB_URI=… MONGO_DB_NAME=Lease                                     # app-only collections, unchanged
# GOOGLE_* no longer required in this mode
```

## Sandbox test (23 Oct 2026)

Containers on `sim-internal` (no internet): `mig-lease-pg` (postgres 16, `lease` schema loaded),
`mig-lease-mongo` (app-only collections replayed from `landing_lease`), `mig-lms`, `mig-ac`,
both apps connecting as non-owner login roles (`lease_app`, `collection_app`).

Loader: 31 tabs `loaded + verified` (every row re-read and compared cell-by-cell with the source).
`fms_dispatch`, `invoice_template`, `invoice_archive_2526` are not in the sandbox copy → skipped and
served empty with one log line each.

**A. Same data as the earlier sandbox run (22 Oct copy, `raw` NULL → display-text fallback)** vs the
earlier Mongo-mirror sandbox outputs (`sim/lease/out/lms-unformat`), 27 public endpoints:
14 identical; the rest differ only by the day that passed (daysLeft, TAT elapsed, efficiency
minutes). Two improvements: `/offlease/approval` returned 500 in the old sandbox (it tried to create
a tab in Google) and now returns 200; consequently 3 off-lease items correctly show
"Pending Approval". `/leases/verify` and `/leases/approve` also work without Google now.

**B. Fresh copy with real `raw` values (lease workbook, 23 Oct 05:36 UTC — captured into the
sandbox only, with the central sync's own code and the `spreadsheets.readonly` scope, 3 API calls)** vs the
**live** production API (read-only GETs, 31 endpoints incl. detail calls): **0 formatting/rounding
differences** (the old sandbox had 1,271 on `/deployed-summary` alone — now MATCH; `/leases/approve`
137 = 137, was 119 vs 137). 13 endpoints identical. Remaining differences, all explained:
- `/leases/expiry`: production returns 11 fields that are not in GitHub `main` (agreementDate,
  poDate, poNo, approvalStatus, …) and 34 different Order Nos — production runs unpublished code.
- `/reports/renewal-log`: production shows 4 more header columns (same cause).
- Off-lease stage 3/6/7, dashboard stage counts, efficiency: depend on the FMS workbook
  (STAGE-8/9/10, not in the sandbox copy) — same differences as the earlier sandbox; on the VPS the
  loader includes `fms_dispatch`.
- `/accounts/:c/outstanding`: Accounts API credentials not set in the sandbox (prod: login broken).
- TAT `elapsedMs` by milliseconds (request time).

**Writes (sandbox, LMS logged in as an all-access user)**: login (appends Login Time Log +
`__login_log`), add off-lease remark (append), put on hold (Fast path → authoritative write on
Off-Lease Tracking), expiry remark (Deployed sheet cell), delete remark (row delete + shift up) —
all 200, read back correctly by the next GET; GETs alone write nothing (`app_written_at` stays
NULL). No Google call possible (no credentials, no internet) and none attempted.

## Known data/behaviour notes (not changed here)

- Production LMS runs code that is not in GitHub `main`: `/leases/expiry` in prod returns 11 extra
  fields (agreementDate, poDate, poNo, approvalStatus, …). This branch is built on `main`; the prod
  code must be committed and merged into this branch before cutover.
- LMS → Accounts-Collection login (Tally Outstanding panel) is broken in prod; Sales CRM has
  duplicate leads; "Rate" shows as a date on the off-lease grids — reported, untouched.
- Values typed in by the app are stored like USER_ENTERED would (numeric text → number,
  TRUE/FALSE → boolean); date strings stay as written. Formulas are not stored (values only).

## Cutover (needs approval)

1. Merge the production-only LMS code into this branch; re-test in the sandbox.
2. Apply `0001_lease_schema.sql` (+ Accounts-Collection's `0001`) on the VPS; create login roles
   `lease_app` (in `lease_rw`) and `collection_app` (in `collection_rw`).
3. Make sure the central sync has fresh `raw` for `lease_workbook`, `container_master`, `fms_dispatch`
   (and add `invoice_template` if wanted).
4. Freeze writes: stop LMS (`pm2`/systemd) and put Accounts-Collection in maintenance; let the
   central sync take one last pass; ask users not to edit the lease workbook.
5. `node scripts/central/load-lease.mjs --db "$ADMIN_URL"` — all tabs must say `loaded + verified`.
6. Deploy this branch with `DATA_SOURCE=central` + `CENTRAL_DATABASE_URL`; start; smoke-test
   (`/api/public/v1/leases/expiry`, off-lease dashboard, one remark write).
7. Switch Accounts-Collection to central at the same time (both apps must use the same source).
8. From now on the Google workbook is a frozen snapshot; nobody edits it.

## Rollback

Unset `DATA_SOURCE` (or set it to anything else) and restart: the app is back on Sheets + Mongo
exactly as before. Writes made in central mode exist only in the `lease` tables; if rolling back
after real use, export them first (`lease.*` tables where `sheet_tab.app_written_at` is set) and
re-enter them in the sheet — this branch never writes to Google.
