# Code Documentation

Per-module and per-function documentation, compiled 2026-10-12 from a full read-only pass over the codebase. For the folder-level map, see [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md); for end-to-end processes, see [WORKFLOWS.md](WORKFLOWS.md); for every HTTP endpoint, see [API_DOCUMENTATION.md](API_DOCUMENTATION.md).

A note on method: this codebase documents itself unusually thoroughly — nearly every file and most non-trivial functions already carry a doc comment explaining *why*, often citing the specific bug or explicit request that shaped the current code. The entries below draw on those comments rather than re-deriving behavior from scratch, and skip trivial one-line getters/pass-throughs in favor of functions with real logic.

## Contents

- [Backend](#backend)
  - [Lease lifecycle services](#lease-lifecycle-services-verify-approve-expiry-roles-permissions-auth-tasks-dashboard)
  - [Off-Lease pipeline](#off-lease-pipeline-offleaseservicejs--sub-modules)
  - [Refunds, integrations & infra](#refunds-integrations--infra)
  - [Jobs, middlewares, utils, config](#jobs-middlewares-utils-config)
  - [Controllers](#controllers-thin-pass-throughs)
- [Frontend](#frontend)
  - [Hooks](#hooks)
  - [UI components](#ui-components)
  - [Layout components](#layout-components)
  - [Auth & data bus](#auth--data-bus-sharedauth-shareddatabusjs)
  - [Constants & utils](#constants--utils)
  - [Services & API layer](#services--api-layer)
  - [Pages](#pages)

---

# Backend

## Lease lifecycle services (verify, approve, expiry, roles, permissions, auth, tasks, dashboard)

### `services/verify.service.js`

Backs Verify Lease — lists New Lease rows awaiting a verify decision, records approve/reject actions, follow-up log entries, and field edits/document uploads. Also owns the Deployed-sheet renewal actions shared with Lease Expiry (`updateLeasePeriod`, `renewLeaseWithAgreement`). Sheets-first (live Sheets is authoritative for reads and writes); Mongo is a best-effort mirror.

- **`uploadAndSaveVerifyDocument(base64Data, mimeType, fileName, containerNo, docType, userEmail, knownRow)`** — uploads to Drive, saves the URL via `saveVerifyDocument`; best-effort deletes the orphaned Drive file if the save fails after upload succeeded.
- **`updateLeasePeriod(containerNo, newDateString, userEmail, knownRow)`** — sets a new Valid Upto (Deployed cols H/O/X), stamps who/when, flips status to "Documents Pending". `knownRow` disambiguates when a container has more than one Deployed row — omitting it when needed throws rather than silently picking one.
- **`renewLeaseWithAgreement(containerNo, newDateString, agreementUrl, userEmail, knownRow)`** — appends renewal history, writes the new valid date, either clears status (fully renewed) or sets "Documents Pending" (agreement still pending). Always appends to the Renewal Log and emails a notification (never throws, never blocks the renewal).
- **`getVerifyData()`** — the Verify Lease list (cached 20s), excluding already-actioned rows, joined with Agreement Date/PDF/Client Code from "New lease reff". Returns `{ headers, data }`, each item carrying `_rowNum`.
- **`saveVerifyAction(containerNo, timestamp, status, billingType, invoiceType, linkContainer, userEmail, knownRow)`** — records Approve/Reject with billing/invoice type and an optional linked container. Container No is **not unique** on this sheet — omitting `knownRow` when more than one row matches throws rather than risking a write to the wrong client's row.
- **`saveVerifyFollowUp(containerNo, timestamp, remarks, userEmail, issue, knownRow)`** — appends one `date | issue | remarks | user` entry to the row's follow-up log.
- **`updateVerifyLeaseFields(containerNo, fieldUpdates, userEmail, knownRow)`** — edits New Lease fields restricted to columns 1–25; internal bookkeeping columns (Z:AJ) are always protected regardless of what's sent. Throws if nothing in the update was actually editable.
- **`saveVerifyDocument(containerNo, docType, url, userEmail, knownRow)`** — writes a PO or Agreement URL (col AF or AG).

### `services/approve.service.js`

Backs Approve Lease — decides which Operation-sheet rows need a human decision vs. which recurring container+client pairs auto-approve (seeded only by *prior manual* approvals within the current lease cycle), runs/reverts the auto-approval batch, records decisions, and serves an audit history view.

- **`_offLeaseCycleIndex()`** — cached (5 min, single-flight) container→off-lease-events index, built from Off-Lease Tracking + the Deployed Status column. Bounds "recurring approval" history to the *current* lease cycle only — an approval made before the container last went off-lease must not justify auto-approving its next (re-leased) cycle.
- **`_cycleClosedAt(cycleIndex, container, clientCode, clientName)`** — when this exact container+client pair last went off-lease (`0` if never); matches by client code first, then normalized name, deliberately not fuzzy (a near-miss risks auto-approving one client against another's history).
- **`getApproveData(doWrite)`** — the pending list. A pair with no prior manual approval stays Pending; one with such history auto-approves. `doWrite=true` (the hourly cron, or an explicit rerun) performs the write; otherwise a cached (30s, degrade-on-error) read-only preview.
- **`getApprovalHistory()`** — every decided row with derived audit fields, distinguishing system auto-approvals (user cell starts `"auto-approved"`) from manual ones.
- **`runAutoApproval()`** — invokes `getApproveData(true)` for real; returns a summary string.
- **`revertAutoApproved()`** — clears AC:AE on every auto-approved row, returning it to manual Pending.
- **`saveActionData(containerNo, actionType, timestamp, status, userEmail)`** — writes an approve decision, scanning past already-approved rows for this container to find the real pending one. **Confirmed no live frontend caller as of the file's own note** — a candidate for removal, see [CLEANUP_REPORT.md](CLEANUP_REPORT.md).
- **`saveApproveLeaseByContainer(containerNo, timestamp, status, userEmail)`** — the live Approve/Reject action: locates the row by container, scanning past duplicate already-approved rows to the first still-pending one. Returns `'ALREADY_PROCESSED'` if none remain pending.
- **`_expiryOrderNoMap()`** — container→Order No map (Operation sheet, then New Lease). **Duplicated** in `expiry.service.js`; see [CLEANUP_REPORT.md](CLEANUP_REPORT.md) — the two intentionally share one cache/in-flight guard pending a dedup pass.

### `services/expiry.service.js` (1,612 lines)

The largest lease-lifecycle file — backs Lease Expiry, Renew & Document, and the full renewal-approval workflow.

- **`_expiryOrderNoMap()`** — the canonical copy of the duplicated function above. Checks the external FMS Stage-9 "Lease" movement rows **first** (more authoritative than this app's own Operation sheet), scoped separately per container-only and per-client keys so a spelling mismatch between the two systems can't let the lower-priority source win.
- **`_resolveOrderNo(ordMap, containerNo, clientName)`** — resolves one container's Order No via a 4-step fallback (STAGE-9 client → STAGE-9 container → Operation-sheet client → plain container map) — a container can be re-leased to a different client with a different Order No over time.
- **`_deployedRawValues()`** — shared, cached (30s, degrade-on-error) raw Deployed-sheet read, used by every Lease Expiry / Deployed Summary / Deployed Detail / My Task caller in one load. Every write path still re-reads live and resolves its own row fresh.
- **`getExpiryDataByFilter(filterType, user)`** — the core list for `'pending' | 'renewed' | 'documents' | 'approval'`. Computes the `safe/critical/warning/overdue` band — see the band rule called out in [WORKFLOWS.md §1](WORKFLOWS.md#1-lease-lifecycle). Sale-Person-scoped, fails **closed** if the scoping column can't be located for a scoped user; resolves each row's live Sale Person via the CRM, not the sheet's stale cell.
- **`uploadAndSaveDeployedDocument(...)`** — permission-gated (`'document'`); uploads to Drive, saves to Deployed col Y/Z; best-effort cleans up on a failed save.
- **`completeDocumentStage(containerNo, callerEmail, knownRow)`** / **`...Fast(...)`** — permission-gated (`'document'`); clears status once a "Documents Pending" container has at least a PO **or** an Agreement URL (either is enough). Returns `'INVALID_STATE'` / `'MISSING_PO_OR_AGR'` on guard failure.
- **`saveExpiryAction(rowId, timestamp, status, callerEmail, knownRow)`** / **`...Fast(...)`** — permission-gated (`'expiry'`); the main Renew/Off-Lease decision. `Fast` is the Mongo-first/outbox-replay variant the normal UI uses; the plain version backs `action-sync`, used where an immediate caller needs a synchronous, already-visible write (avoids a race with a follow-up read).
- **`sendExpiryToPending(containerNo, callerEmail, knownRow)`** / **`...Fast(...)`** — permission-gated (`'expiry'`); "Send Back" from Renew & Document to Lease Expiry. Returns `'INVALID_STATE'` if not currently "documents pending", `'AWAITING_APPROVAL'` if already pending Pushpa's decision. Leaves staged draft fields untouched so a later re-Renew still pre-fills them.
- **`saveExpiryRemark(containerNo, remark, callerEmail, knownRow)`** / **`...Fast(...)`** — permission-gated (`'expiry'`); writes the free-text remark, auto-labelling the header on first use but refusing if it's already labelled something unrelated.
- **`getRenewalLogReport(user)`** — Renewal Log rows, newest first, Sale-Person-scoped unconditionally via the live CRM (this sheet has no Sale-Person column, so unlike `getExpiryDataByFilter` there's no sheet-value fallback — fails closed).
- **`getNewLeaseReport(user)`** — New Lease rows grouped by **Deployed Date** (not approval timestamp), CRM-first scoping with a sheet-cell fallback.
- **`_resolveRenewalColumns(hdrs0)`** — header-based resolution of the real Agreement/PO/PO-PDF/Billing-Cycle/PO-Validity/PO-Value columns, shared by the draft-staging functions and the approval's promotion step.
- **`saveRenewalDraft(...)`** — permission-gated (`'renew'`); **"Save"**: stages supplied fields into the draft columns only, never the real columns, never Approval Status. Deliberately permissive/partial. Returns `'INVALID_STATE'` unless currently "documents pending".
- **`completeDocStage(...)`** — permission-gated (`'renew'`); **"Submit"**: same staging shape (Renewed Date now required) **and** sets Approval Status = `'Pending'`, records the submitter, emails Pushpa. Does not touch the real columns.
- **`decideRenewalApproval(containerNo, decision, remarks, callerEmail, knownRow)`** — permission-gated (`'renewApproval'`); Pushpa's decision, guarded on Approval Status currently `'Pending'`. **Reject**: only approval metadata changes, emails the Sale Person + Shivani Dhall. **Approve**: promotes the draft into the real columns, clears status, appends a Renewal Log row crediting the original submitter, sends the completion notice.
- **`_logRenewal(info)`** — appends one Renewal Log row + sends the notification. Never throws — a logging failure must never block or be mistaken for the renewal itself.

### `services/roles.service.js`

The dynamic, admin-editable Roles & Access system — two Google Sheets ("Team Accounts", "Sidebar Access") are now the *entire* authorization source; the old hardcoded baseline was migrated into these sheets and removed 2026-09-16.

- **`isRolesAdmin(email)`** — checks `rolesAdmin` **directly** (`hasDirectPermission`), never via "All Access" — a real incident fix: a routine All-Access grant must never silently also confer Roles-admin rights.
- **`assertRolesAdmin(email)`** — throws `accessDenied` unless `isRolesAdmin`.
- **`ensureRolesSeeded()`** — lazily creates/seeds both sheets on first use (lock-protected against a startup-race duplicate-row bug), self-heals header width as `PERMISSION_KEYS`/`SIDEBAR_KEYS` grow (backfilling new columns `false` for permissions, `true` for sidebar — "visible until explicitly hidden").
- **`clearRolesCache()`** — evicts the in-process permission caches; called by every write below.
- **`loadTeamPermTable()`** — live-read (cached 7.5 min) → `email → {name, allAccess, perms}`.
- **`dynamicHasPermission(email, type)`** — the check every ordinary feature permission consults: `true` on "All Access", else the specific column.
- **`hasDirectPermission(email, type)`** — same lookup but bypasses "All Access" — required for `rolesAdmin`/`apiAdmin`.
- **`dynamicSidebarVisible(email, tabId)`** — `true`/`false`, or `null` ("no opinion") if unset.
- **`getRolesAndAccessData(callerEmail)`** / **`saveEmailPermission(...)`** / **`saveEmailSidebar(...)`** / **`addTeamAccount(...)`** / **`removeTeamAccount(...)`** — admin-only grid read/write operations, all gated by `assertRolesAdmin`.

### `services/permissions.service.js`

Thin façade over `roles.service.js` — the single choke point every permission-gated route goes through.

- **`userHasAction(email, type)`** — delegates to `dynamicHasPermission`.
- **`checkActionPermission(type, email)`** — throws `accessDenied()` unless `userHasAction` — the guard at the top of most gated service functions.
- **`getUserPermissions(email)`** / **`getUserSidebarVisibility(email)`** / **`getUserAccessBundle(email)`** — frontend-facing permission/sidebar bundles.

### `services/auth.service.js`

Login/session/OTP, backed by a durable Mongo session collection (TTL-indexed, 6h sliding expiry) so sessions survive a restart; Mongo-first reads for login/heartbeat to keep this hot path off the Sheets quota.

- **`empLogin(empId, password)`** — validates against the USER sheet (Mongo-first), creates a session + session-log row. Returns `{ok:false, error}` without revealing which part was wrong.
- **`empSsoLogin(empCode)`** — same session shape, but by an already-verified Sales OS employee code — no password; used only by `/api/sso/*`.
- **`findEmployeeByCode(empCode)`** — pure lookup with **no session/log side effects**, used by a server-to-server stats poll that must not spam the login-activity log.
- **`empSession(token)`** — resolves a token, sliding expiry forward.
- **`empLogout(token)`** — finalizes the heartbeat, logs the event, deletes the session.
- **`empHeartbeat(token, force)`** — keeps the session alive cheaply, throttled to syncing the sheet log once per 5 min (this throttle was added after heartbeats — every open tab, every 60s — were found to be the single largest Sheets-quota contributor).
- **`empRequestOtp(idOrEmail)`** / **`empResetPassword(empId, otp, newPassword)`** — 6-digit OTP, 10 min TTL, max 5 tries; generic "if the account exists" response (anti-enumeration); reset writes live, then immediately patches the mirror.
- **`addUserToLogin(name, empId, password, email)`** — admin utility, rejects duplicates, upserts the mirror immediately so the new account can log in right away.

### `services/tasks.service.js`

Aggregates every pending-work count the sidebar/dashboard badges show, in one call.

- **`getMyTasks(user, force)`** — cached 90s, keyed by the caller's Sale-Person scope. `expiring7`/`expired` are computed by re-banding the *same* `getExpiryDataByFilter('pending', user)` list Lease Expiry itself bands — never a second approximation. A scoped caller also gets `visibleKeys`.
- **`getEmployeeTasks(employeeCode, force)`** — resolves an employee code → counts for that specific person. Returns `null` for unknown; `assigned: false` for a whole-desk role with no per-person tasks.

### `services/dashboard.service.js`

Backs Deployed Summary/Detail — month-by-month opening/addition/deletion/net/closing counts, built from the Deployed sheet (shares `expiry.service.js`'s cached raw read).

- **`normalizeContainerType(rawType)`** — collapses free-text type strings so grouping isn't fragmented by spelling variants.
- **`getDeployedSummaryData()`** — the full month×type×size table from every row with a parseable Deployed Date. A container counts "off-lease" only once its Action Status/Timestamp both say so.
- **`getDeployedDetailData(monthLabel, category, typeFilter, sizeFilter)`** — drill-down list behind one Summary cell, Order No resolved via the same client-disambiguated lookup Lease Expiry uses.

---

## Off-Lease pipeline (`offlease.service.js` + sub-modules)

### `services/offlease.service.js` (6,712 lines — the largest file in the repo)

Port of the legacy 8-stage workflow, plus the tracking-sheet bootstrap/repair tools and the Dashboard's container-detail lookup. Internal stage *numbers* are fixed forever (they select column ranges); display order/labels are tracked separately and have been renumbered repeatedly by explicit request. A recurring theme throughout: **container numbers are not unique**, so nearly every function takes an explicit `knownRow` or falls back to a fuzzy client-name match, and several functions carry "BUG FOUND AND FIXED" comments documenting a real incident where a wrong row was written to. A second theme: most "Fast" variants are Mongo-first (instant for the UI), enqueuing a background replay of the authoritative "slow" function.

**Stage/column constants** — `OL_STAGE_INFO` (internal stage → column range), `OL_ACTIVE_STAGE_NUMS = [1, 6, 7, 3, 5, 11, 8]` (the real workflow order), `OL_INSPECTION_POINTS`/`OL_MACHINE_POINTS`/`OL_CABIN_ITEMS` (Stage 3 checklist definitions, explicit non-contiguous column numbers).

**Admin / diagnostic / one-time maintenance tools** (not day-to-day UI — header-repair, backup/restore, column migration, order-no tracing):
`_ensureOffLeaseSheet`, `restoreOffLeaseHeaderRowFromLatestBackup`, `dumpOffLeaseTrackingHeaders`, `fixQuotationEmailMarkedCollision`, `fixOffLeaseStageHeaders`, `reorderOffLeaseTrackingColumns` (makes a full backup before writing, aborts loudly on a header mismatch), `debugOrderNosForContainer`/`traceOrderNo`, `whatFeedsNewLeaseReff`/`whatFeedsAllSheets`.

**Order No / client lookup helpers:**
- `_findOlColumn` / `_findOlColumnMulti` — header-text column finders.
- `_lookupStage9OrderNos(containerNo, clientName)` — the preferred Order No source (STAGE-9 carries the real dispatch order, more authoritative than this app's own data).
- `getOffLeaseAgreementPoPdf(containerNo)` — fast, standalone PDF+email-ID lookup, split out so the approval screen doesn't wait on slower Order-No lookups.
- `getOffLeaseCardEnrichment(containerNo, user, knownRow)` — full card enrichment (PDFs, deployed email ID, Order No, Transportation One/Return Way).
- `getNextLeaseId()` — auto-incrementing `OF00xx` Lease ID, counting across both the old `LEASE00xx` and new prefix so the sequence never restarts or collides.

**Add to tracking / FMS auto-create:**
- `addToOffLeaseTracking(containerNo, deployedRow, remarks, personName, userEmail)` — creates the Tracking row. Duplicate detection requires a match on BOTH container **and** client (a container number alone can be legitimately reused by a later, unrelated lease). Marks the Deployed sheet so it exits Lease Expiry's pending list; mirrors both writes instantly.
- `autoCreateOffLeaseFromFms({dryRun=true})` — scans every Stage 8 "Offlease" movement row, reports `WOULD_CREATE/CREATED/ALREADY_LINKED/SKIPPED_.../ERROR` per row. **Defaults to a dry run that makes zero writes**; real creation requires `dryRun:false` and is deliberately not wired into the automatic cron.
- `getOffLeaseEntryStamp(containerNo)` — when the container was actually marked off-lease (Stage 1's SLA clock start) — not the original Deployed date, which could be years earlier.

**Access scoping:**
`_offLeaseAccessGate(user)`, `getOffLeaseClientNamesForContainer`, `isOffLeaseContainerVisibleToUser` — a client the Sales CRM doesn't recognize is **excluded** (fail-closed) for a scoped caller.

**Stage list / detail (read):**
- `getOffLeaseData(stage, opts, user)` — the pending-queue for one stage, implementing every bypass rule (STAGE-10/Move-To-Stage closing Transportation, Gate-In form closing Gate In, the Intimation-Approval gate applying even to a bypassed row). Also serves Stage 1's Hold/Reject sub-tabs and Stage 7's Pending/Completed split.
- `getOffLeaseStageCounts(user)` — runs `getOffLeaseData` per stage so badge counts can never drift from the real queues (replaced an older, bypass-unaware counter).
- `attachStageTat(result, stage)` — per-row SLA-vs-budget object; Transportation and Gate In are special-cased with their own clock-start rules.
- `getOffLeaseStageDetail(containerNo, stage, user, knownRow)` — the fillable-form data for one row (Mongo mirror). Requires `knownRow`; rethrows rather than silently returning blank.
- `_classifyOffLeaseStages(headers, row, gatedIn, repairSkip, delivered)` — per-row done/skipped/current classification for the Dashboard, with a backward `impliedDone` pass.
- `getOffLeaseContainerDetail(containerNo, leaseId, user)` — the full Container Lookup report. Returns a `multiple: true` candidate list (scoped to caller visibility) when disambiguation is needed.

**Dashboard & lookup:**
- `getOffLeaseDashboardData(user)` — KPI cards + pipeline table, cached 20s (display-only, unlike action queues). `currentStage`/`byStage` derive from the *same* `getOffLeaseData`/`getOffLeaseApprovalData` every stage tab uses — not a second hand-written approximation (one was found to drift repeatedly).
- `getInvoiceAttachments(invoiceNos)` — matched purely on invoice number (not container+client) — the Accounts API and Billing Sales sheet spell client names differently for a meaningful share of records.

**Save a stage:**
- `saveOffLeaseStage(containerNo, stage, data, userEmail, knownRow)` — the authoritative save. Assigns the real Lease ID on Stage 1's first save (ignores any client-sent value); derives technician cost on Stage 3; **hard-blocks Stage 7** unless Stage 6 is CEO-approved **and** Voucher Raised is done; fires completion emails only on genuine first completion, never a resubmit.
- `saveOffLeaseStageFast(...)` — the controller's real entry point: Mongo-patch instantly, enqueue a live replay. Stage 1 is the one exception and runs fully live/synchronous (must hand back a real, non-duplicate Lease ID).
- `markOffLeaseSdRefundSubmitted(containerNo)` / `markOffLeaseSdRefundApproved(containerNo, note)` — stamp Stage 6 "Submitted"/"Completed", called from `refunds.service.js`, not from any UI action on this sheet.

**Move-to-stage / hold / send-back** (each with a `...Fast` Mongo-first variant unless noted):
- `saveOffLeaseMoveToStage` — manual alternate-disposition jump, **gated on a real STAGE-8 movement already being found** (a deliberate reversal from the feature's original framing), fails closed on an FMS read error.
- `saveOffLeaseMoveToStageClientToClientPending` — DO-first draft; finalized later by the `checkPendingClientToClientMoves` cron.
- `saveOffLeaseSendBack` — reverses an active jump; for "Client to Client" specifically, also re-fetches Transportation data under the new client (ordinary FMS lookups never surface this — they only check `Movement Type = Offlease`, not `Lease`).
- `saveOffLeaseHold` / `saveOffLeaseSendBackToStage1` — Stage 1 hold and its reversal.
- `saveOffLeaseVoucherRaised` — Stage 7's "VR" step, gated on Stage 6 already CEO-approved.

**Approval (Stage 1A):**
- `getOffLeaseApprovalData(user, preFetchedSheetData, filter)` — the Pending-Approval queue, plus a `filter='clientToClient'` view for already-decided rows (which never release into Stage 2 and would otherwise vanish entirely once decided).
- `saveOffLeaseApprovalAction` / `saveOffLeaseApprovalClientToClient` / `saveOffLeaseSendRejectedToStage1` / `saveOffLeaseRejectAndCancel` / `saveOffLeaseSendBackFromApproval` / `saveOffLeaseSendBackFromBilling` — the four approval outcomes plus the two reopening paths; see [WORKFLOWS.md §2](WORKFLOWS.md#2-off-lease-8-stage-pipeline) for the full decision tree.
- `_syncOffLeaseRowToMaster(rn, status)` — pushes the decision to the external Master workbook; a rejection is deliberately a no-op there.

**New Lease → Deployed copy:**
`copyApprovedData()` — hourly job: runs auto-approval, then copies Approved-and-not-yet-moved rows into Deployed, deduping on container+Deployed-Date+Valid-Upto (not container alone — the same container can be re-leased with different dates).

### `services/offleaseEfficiency.service.js` (515 lines)

Computes `Efficiency % = (Target Time / Actual Time) × 100`, capped at 100%, replacing an older "Overdue %" metric. Single authoritative source for both the internal page and the public API-key route. Explicitly refuses to paper over three real data-model limitations: Hold duration is **not computable** (no release-from-hold timestamp exists), rework history is only partially reconstructable, and server timezone isn't pinned (affects only a still-running stage's live reading).

- **`calculateStageEfficiency(events, config)`** — pure function; one stage's result with `status`/`calculationStatus`/a human-readable `formula` string shared verbatim by the API, frontend, and test suite.
- **`calculateCumulativeEfficiency(stageResults)`** — overall efficiency as Σtarget/Σactual × 100 over valid+completed stages, **never an average of already-rounded percentages** (explicitly rejected — it would weight a fast 1h stage the same as a slow 48h one).
- **`getOffLeaseEfficiencyReport(user)`** — the full report: KPIs, per-stage breakdown with client-level bottleneck ranking, per-container detail, and a `dataQuality` block. Access-scoped (the old Overdue-% version was unscoped — a gap this closes).

### `services/offleaseMoveHistory.service.js`

Append-only Move-To-Stage/Send-Back audit trail, in its own sheet — survives a Send Back even though the live row's move-state columns get cleared on one. Keyed on container + Lease ID.

- **`getMoveHistory(containerNo, leaseId)`** — full history, newest first, 60s cache.
- **`addMoveHistoryEntry({...})`** — appends one event; best-effort, never allowed to fail the move itself.

### `services/offleaseRemarks.service.js`

Live, append-only comment thread per off-lease record (distinct from a stage's own frozen Remark field), doubling as a per-stage thread when `stage` is supplied.

- **`sanitizeRemarkHtml(html)`** — strips to a tight allow-list, drops every attribute (remarks are rendered back as HTML to every viewer).
- **`getRemarkIndex()`** — dashboard-wide latest/count per record — **dashboard-only** remarks (blank stage); a stage-scoped remark must never silently become "the latest" shown on the dashboard.
- **`addOffLeaseRemark`** / **`updateOffLeaseRemark`** / **`deleteOffLeaseRemark`** — requires an `offlease1..9` permission to add; edit/delete restricted to the author or a roles-admin, re-resolved **inside** the sheet lock since a concurrent delete can shift row positions.

### `services/offleaseSla.service.js`

Per-stage time budgets, computed at read time only (never written — a positional write would be unsafe given the sheet's column drift, and SLA is fully derivable from existing timestamps).

- **`SLA_MS`** — 1 hour per desk-work step, 2 days for Transportation (the one physical-movement step).
- **`parseStamp(v)`** — parses by explicit component, never via `new Date(string)` (which reads `dd/MM` as `MM/dd` and silently shifts dates ≤12).
- **`applySla(stages, ctx)`** — each stage's clock starts the moment the *previous* step finished.

### `services/stage3Form.service.js`

Reads the external Google Form gate-movement log — now the **sole** completion signal for Stage 3/Gate In, which has had its manual form removed entirely.

- **`pickGateFormForClient(rows, clientName)`** — the row relevant to one client (the same box is reused across unrelated clients over time); prefers the latest fuzzy-client-matched row, falls back to the latest row overall.
- **`isGatedIn(row)`** — true only for exactly `"Inward (Gate-In)"`; a later `"Outward"` row is deliberately **not** treated as un-gating.
- **`isRepairNotRequired(row)`** — still read/reported, but no longer used as an Inspection-skip bypass (removed 2026-09-04).

### `services/stage8.service.js` (797 lines)

Read-only integration with the external FMS workbook's STAGE-8/9/10 tabs, Mongo-mirrored since 2026-08-28 (never hits live Sheets). Only `Movement Type = Offlease` rows normally count (~90 of 1,100+ STAGE-8 rows).

- **`clientMatches(a, b)`** — the shared fuzzy client-name matcher used everywhere a human-typed name needs cross-referencing across systems that spell it differently.
- **`getFmsForContainer(containerNo, clientName, cycleStartMs)`** — the STAGE-8→9→10 chain, bounded to the current off-lease cycle so a container's *previous* cycle's movement is never attached to the current one.
- **`getDeliveredKeys()`** — container → every delivery-qualifying timestamp it's ever had (an array per container, not a flat set, so a reused container's old delivery doesn't wrongly read as "delivered" for a new cycle). Requires a match in **both** STAGE-8 and STAGE-9 **and** a STAGE-10 match.
- **`getClientToClientLeaseMovement(containerNo, newClientName)`** — the one case where a `Movement Type = Lease` row (not Offlease) is what this app actually wants.

### `services/stage9.service.js`

Append-only container-movement journal, deliberately outside the 1–8 pipeline — one row per physical movement, nothing ever overwritten.

- **`saveStage9Movement(payload, userEmail)`** — for `Movement Type = 'Offlease'`, every identity field is **re-derived server-side from Stage 2**, discarding whatever the client sent — the same anti-tampering rule Stage 1 applies to Lease ID.

### `services/olHeaders.generated.js`

Not logic — a generated snapshot of the live Tracking sheet's header row (289+ columns), captured after a manual column deletion. Every column index throughout `offlease.service.js` is positional against this array; it must be regenerated any time a column moves on the live sheet.

---

## Refunds, integrations & infra

### `services/refunds.service.js`

Backs the "Refunds (Off-Lease Bills)" submission form and its HOD → Accounts → CEO approval chain (CEO conditional on amount — skipped automatically at or below ₹1,00,000). No-login, signed-token "review links" (60-day TTL) let each approver act without logging in.

- **`getRefundEntries(userEmail)`** — every bill, newest first, from the Mongo mirror. Gated by a view check allowing the submit permission OR any of the three approval permissions.
- **`addRefundEntry(payload, userEmail)`** — requires `refunds` permission; Vendor Name/Invoice Amount/Amount to Pay/Department/Container No required (Container No mandatory so Off-Lease Stage 6 can find it). Mints the HOD review link, mirrors to Mongo, best-effort emails HOD and marks the Off-Lease container's Stage 6 "submitted".
- **`decideRefundApproval(rowNum, stage, decision, remarks, callerEmail, opts)`** — the sequential decision function. On Accounts' approval, dynamically decides whether CEO is required from the live row's amount; if not, auto-writes `'Skipped'` with a system remark. Once the final required stage clears, best-effort unblocks the container's SD Refund stage.
- **`decideRefundApprovalViaLink(...)`** — no-login path: the signed token itself is the authorization, delegating to `decideRefundApproval` with `skipPermissionCheck: true`.

### `services/apiKeys.service.js`

Manages public API bearer keys for `/api/public/v1/*`. Only a SHA-256 hash is ever stored; the raw key is returned exactly once, at creation. **Write is "acts as", not ambient** — a write-scoped key must name a real LMS user and runs with exactly that person's existing permissions, never more.

- **`createApiKey({label, scopes, actsAsEmail, createdBy})`** — validates/normalizes scopes, requires `actsAsEmail` for any write scope.
- **`checkPublicApiRateLimit(keyId)`** — best-effort sliding-window limiter (120 req/min/key).

### `services/salesOsRenewal.service.js` (732 lines)

The **inbound** half of the Sales OS integration — a salesperson deep-links in (no password), renews one or more containers, and the result writes via the **same** functions a human uses manually (`saveExpiryAction`, `completeDocStage`/`saveRenewalDraft`) — no parallel write path.

- **`resolveLeaseCompany(companyNameRaw)`** — exact match first, then an UNAMBIGUOUS fuzzy pass — deliberately not distance-scored, since a wrong guess would hand a salesperson the wrong company's containers.
- **`saveRenewal(user, body)`** — "Submit": re-validates every requested container against a *fresh* read before replaying the real write path, writes an audit receipt.
- **`getRenewalPipeline(employeeCode)`** — sourced from the SAME live Lease pages' own data, not the audit-receipt collection — deliberately has no blind spot for a renewal started directly in-app.

### `services/renewalHandoff.service.js`

The **outbound** mirror image — "Renew via Sales CRM" hands off FROM Lease Expiry TO the CRM's own renewal form via a signed JWT. Container selection is scoped by an EXACT (not fuzzy) Customer Name match — stricter than the inbound side, because a wrong guess here hands a salesperson the wrong company's picker, feeding straight into a renewal PO.

### `services/salesCrmLeads.service.js`

Read-only live resolution of "which salesperson owns this company", from the Sales CRM's `existing_leads` collection — **never writes** to it. Two-pass matching (exact, then unambiguous fuzzy), distinguishing a company the CRM explicitly has **no assignee** for ("Unassigned") from one it doesn't know at all (`null` — keep the stale sheet value).

- **`getSalePersonResolver()`** — builds/caches (30 min TTL) an index preferring an explicit reassignment timestamp over a merely-touched one (a passive resync could otherwise outrank a genuine reassignment). Degrades to `() => null` if the CRM is unconfigured/unreachable.

### `services/salePersonAccess.service.js`

User-wise data-visibility scoping for the "Sale Person" axis. Deliberately a small, explicit email→name map rather than automatic matching (the sheet has near-duplicate names like "Pushpa"/"Pushpalata" that automatic matching would confuse).

- **`salePersonScopeFor(user)`** — the Sale Person name this user is restricted to, or `null` for an admin or any unmapped login.

### `services/accountsApi.service.js`

Client for the external Accounts & Collection app, backing Off-Lease Stage 1's Tally outstanding display. Logs in with a service account, caches the token 20 min.

- **`getOutstandingForContainer(containerNo, clientName)`** — combines three endpoints; party selection prefers an exact/fuzzy match against the container's *own* invoice client name over the stored record's field, tie-broken by which party's bills actually reference this container's invoices. Never throws on a sub-call failure — degrades to whatever succeeded.

### `services/email.service.js`

SMTP via nodemailer, falling back to console-logging when unconfigured so OTPs/notifications stay usable on a dev box.

- **`sendMail(...)`** — **never throws** — a failed notification must not roll back the business action that triggered it.

### `services/leaseExpiryDigest.service.js` / `services/monthlyReport.service.js`

Daily per-salesperson digest and monthly activity report, both purely read-only (reuse existing read functions, never touch the underlying workflow). `monthlyReport` is idempotent via a Mongo state doc, but a test send is never checked against or recorded into that state.

### Core data layer

- **`services/mongo.service.js`** — `getCollection(name)` (shared accessor), `withTransaction(fn)` (multi-document atomicity, works on Atlas shared tiers too).
- **`services/mongoSheetData.service.js`** — the read half of Mongo-first: `getSheetDataFromMongo` (cached 8s), `patchMongoMirrorRow`/`appendMongoMirrorRow` (parse the mirror patch directly out of the exact `{range,values}` already sent to Sheets, so it can never drift).
- **`services/googleSheets.service.js`** — every live-Sheets call funnels through `withQuotaRetry`, tripping a **global** quota lock (`utils/quotaLock.js`) so one request's quota hit short-circuits every other in-flight request.
- **`services/googleDrive.service.js`** — `uploadToDrive` (requires `supportsAllDrives: true` — a service account has no personal storage quota), `downloadFromDrive` (returns `null` rather than throwing — a photo that can't be fetched should degrade to a link, not break the whole email).
- **`services/outbox.service.js`** — `enqueueSheetReplay(kind, args)`: enqueues a replay of the original, unchanged live-Sheets function rather than a second hand-written implementation.
- **`services/renewRemarks.service.js`** — Renew Approval Pending's own comment thread, same shape as `offleaseRemarks.service.js` but kept separate so Off-Lease and Renew & Document permissions stay independent.

---

## Jobs, middlewares, utils, config

See [WORKFLOWS.md §3–4](WORKFLOWS.md#3-sheets--mongo-sync) for the full Sheets↔Mongo sync and cron-schedule narrative. File-level summary:

**jobs/** — `index.js` (cron registration), `outboxRegistry.js` (`kind` → real live-Sheets function map), `outboxWorker.js` (polls `_sync_outbox`, replays, backs off on quota errors), `sheetsReconcile.job.js` (`fullRefresh` vs. by-key reconciliation, guarded against overlapping cycles racing the same transactional refresh).

**middlewares/** — `asyncHandler` (promise-rejection → `next(err)`), `auth.middleware` (`requireAuth` hard-401s, `optionalAuth` leaves `req.user = null`), `errorHandler` (404 + quota/not-found/access-denied classification by message pattern), `permission.middleware` (`requirePermission`), `publicApiAuth.middleware` (`X-Api-Key` gate, rate limit, `req.actsAsEmail` for writes), `requestLogger.middleware` (AsyncLocalStorage request context for truthful "Source: Mongo/Sheets" logging), `responseCache.middleware` (now just a defense-in-depth quota-lock trip — its old pre-emptive blocking behavior was removed once reads went Mongo-first).

**utils/** — `AppError` (`accessDenied()`/`notFound()`), `format` (ported date/string helpers, `dmyTime`/`parseDmyTime`), `isRateOrAmountHeader` (the system-wide pricing-hiding convention), `jwtLite` (dependency-free HS256, scoped to cross-app handoffs only — this app's own sessions are opaque Mongo tokens, not JWTs), `logger`, `memoryCache` (`cacheGetOrLoad` adds stampede protection + stale-on-error degrade), `normalize` (`normKey`/`splitContainers`/`normClientName`), `quotaLock` (the global circuit breaker), `requestContext`, `sheetMutex` (`withSheetLock` — single-process read-modify-write serialization, Node's analog of Apps Script's `LockService`).

**config/** — `db.js` (Mongo connection, with network-specific DNS/TLS workarounds), `env.js` (validates required vars, hard-exits on startup if missing), `mongoSheetMapping.js` (per-sheet reconciliation identity — see [DATABASE_DOCUMENTATION.md](DATABASE_DOCUMENTATION.md)), `permissions.config.js` (`PERMISSION_KEYS`/`SIDEBAR_KEYS` — **append-only, positionally read**: reordering would silently corrupt every existing user's grant), `runtimeSecrets.js` (optional Mongo-backed secret fallback), `salesCrmDb.js` (read-only, exposes only `findLeads()` — write is impossible by construction), `sheets.config.js` (tab-name constants, must match live tab names exactly).

---

## Controllers (thin pass-throughs)

Every controller resolves request params, injects `req.user`/`rowNum`, and calls the matching service function — no business logic lives at this layer. Full route tables: [API_DOCUMENTATION.md](API_DOCUMENTATION.md). Two worth flagging: `auth.controller.js`'s `loginActivity`/`addUser` explicitly admin-gate via `isRolesAdmin` *at the controller*, since the underlying service functions carry no permission check of their own; `offlease.controller.js` additionally resolves which optional enrichment data (delivered keys, gate-form index) a given stage needs before calling its service function.

---

# Frontend

## Hooks

- **`useAsync(fetcher, deps=[])`** — the fetch-on-mount hook used by essentially every page. Returns `{data, loading, error, reload, setData}`. Guards against React StrictMode's double-invoke, and against **out-of-order resolution** of overlapping calls (only the most-recently-*started* call's result is ever committed). `reload({silent:true})` skips touching `loading`/`error`, so a background poll failure doesn't blank the screen.
- **`useAutoRefresh(domains, reload)`** — subscribes to `dataBus.js` invalidation for one or more domains, refetching immediately regardless of page visibility. This is what lets a write on one page update another already-mounted (but hidden) page under `KeepAlivePages`.
- **`usePagination(rows)`** — not real pagination; every page lists all rows at once. A shim always reporting "one page" so call sites don't need to change if real paging is reintroduced.
- **`usePermission()`** — `canAct(permKey)` fails **closed** (no entry = cannot act); `canView(sidebarKey)` defaults to **visible** when the admin has no explicit opinion.
- **`usePolling(reload, intervalMs=180000, enabled=true)`** — fixed-interval refetch for data that can change *outside* the app. Deliberately scoped to Off-Lease only (a chip-flicker incident on other pages). Default 3 minutes, not 1 — a 60s interval across every open tab previously caused app-wide Sheets rate-limit lockouts.
- **`useSidebarState()`** / **`useSwipeSidebar(open, setOpen)`** / **`useTheme()`** — small, focused persistence/gesture utilities.

## UI components

Mostly dumb/presentational; a few carry real logic:

- **`DataGrid`** — this app's independently-built equivalent of the main app's own table (deliberate duplication, see [CLEANUP_REPORT.md](CLEANUP_REPORT.md)). Notable options: `colWidths` (CSS lengths per column — only meaningful with `table-layout: fixed`, since `<col>` doesn't accept `fr` units); `bodyMaxHeight` (sticky `thead`, needs an actual vertical scrollport); `selectable`/`onRowClick` (action/select cells `stopPropagation` so a button press never also fires the row click).
- **`CellValue` (`renderCellValue`)** — detects an absolute URL or this app's document-proxy path and renders a small 📎 icon instead of the raw URL; empty cells render as an em dash.
- **`FileUpload`** — reads a chosen file into `{base64Data, mimeType, fileName}`, the exact shape the upload endpoint expects.
- **`RichTextEditor`** — `contentEditable` + `execCommand`, deliberately no third-party dependency. Writes `value` into the DOM only when it actually differs (avoids resetting caret position every keystroke). Explicitly **not a security boundary** — re-sanitized server-side.
- **`Select`** — a custom dropdown (not a native `<select>`) specifically so the open menu can be restyled.
- **`StatCard`** — `tint`/`onClick`/`footnoteSegments`/`size`/`split` modes. **Has a confirmed dead branch**: the `compactParts` branch near the end of `return` is unreachable (an earlier `if` already returns first) — see [CLEANUP_REPORT.md](CLEANUP_REPORT.md).
- **`StatusBadge`** — maps a status string to one of 4 semantic color tokens via a lookup table; `dot` prop swaps the filled pill for a leading dot.
- **`Pagination`** — dumb display, but real page-window logic (first/last/±1 with ellipsis gaps); renders nothing if `totalPages <= 1`.
- Pure presentational, no real logic: `Button`, `Card`, `ConfirmDialog`, `EmptyState`/`ErrorState`/`LoadingState`, `FilterBar`, `Icon`/`IconSprite`, `LogModal`, `Modal`, `PageHeader`, `SearchBar` (except the `/`-key shortcut on `variant="large"`), `Skeleton*`, `ActionMenu`.

## Layout components

- **`KeepAlivePages`** — renders every page visited this session simultaneously, toggling `hidden` instead of unmount/remount. Each page's `useAsync()` fetch runs once per session. This is *why* `dataBus.js`/`useAutoRefresh` exist — without them, a write on one page would never be seen by another already-mounted-but-hidden page.
- **`Sidebar`** — gates every item via `usePermission().canView` against the Roles & Access "Sidebar" grid (sole source of truth), with a narrow explicit exception (Roles & Access / API Access additionally gate on `canAct`). Computes badge counts from `fetchMyTasks`. Self-subscribes via `useAutoRefresh` (a confirmed bug fix — mounted once per session, it never refetched after initial mount before this). Section headers always start collapsed regardless of prior session state.
- **`RequireAuth`** — redirects unauthenticated users to `/login`, preserving `pathname + search` (not just pathname) so a query-param-carrying link, like a Refunds-approval email link, survives the round-trip.
- **`AppShell`** / **`TopBar`** / **`Breadcrumbs`** / **`ErrorBoundary`** — standard shell/chrome, no business logic.

## Auth & data bus (`shared/auth/`, `shared/dataBus.js`)

A **standalone, independent reimplementation** of auth — same login API shape as the sibling main app by original design, now maintained independently.

- **`client.js`** — the shared axios instance; request interceptor injects the bearer token, response interceptor clears the session and calls a registered "unauthorized" handler on any 401. Also `apiErrorMessage(err)` and `apiQuotaRetrySeconds(err)` (non-null only on a 429 from the backend's quota guard).
- **`AuthContext.jsx`** — loads `me` + `accessBundle` in parallel on mount if a token exists; runs a heartbeat every 60s while logged in.
- **`dataBus.js`** — a tiny `invalidate(domain)`/`subscribe(domain, fn)` pub/sub, existing specifically to counteract `KeepAlivePages`' fetch-once model.

## Constants & utils

- **`constants/nav.js`** — `NAV_TREE`: `sidebarKey` is the sole source of truth for visibility; `permKey` is a narrow additional gate (only Roles & Access / API Access); `hidden: true` keeps a route/permissions intact while removing just the sidebar entry.
- **`constants/stages.js`** — `ALL_STAGES` (includes retired stages, kept for historical labeling) vs. `STAGES` (the live, in-order workflow with a synthetic gap-free display number).
- **`utils/formatDateTime.js`** — `toDate()` checks the backend's own `dd/MM/yyyy` convention *before* falling back to native `Date` parsing, to avoid ambiguous `d/M` vs `M/d` misreads.
- **`utils/isRateOrAmountHeader.js`** — mirrors the backend util; the system-wide pricing-hiding convention.
- **`utils/tableFilters.js`** — `pickCategoricalFilterColumn` heuristically picks a FilterBar column (prefers a header literally containing "status", else a 2–8-distinct-value column).

## Services & API layer

Thin, mostly 1:1 pass-throughs (`services/` over `api/`), one file per backend domain. Two carry real logic worth noting:

- **`offLease.service.js`** — calls `invalidate('off-lease')` on every real write, deliberately excluding remarks/Stage 9 movements (neither affects any stage/TAT stat).
- **`stage.service.js`** — calls `invalidate('off-lease')` on *every* stage mutation — the single choke point so the Efficiency page and anything else subscribed refetches immediately rather than waiting on its poll interval.

Several exports here are confirmed dead end-to-end — see [CLEANUP_REPORT.md](CLEANUP_REPORT.md) for the full list (`offLease.service.js#sendRejectedBackToStage1`, `renewDocument.service.js`'s whole remark-thread set, `stage.service.js#fetchMoveHistory`, `verify.service.js#submitAgreementEdit`/`uploadAgreementDocument`).

## Pages

### apiAccess/

**`ApiAccessPage`** — admin-only key management against the backend's public API. A 403 renders an "Access Restricted" card rather than hiding the nav item. The raw key is shown exactly once (`NewKeyReveal`), mirroring a GitHub PAT. **`CreateKeyForm`** — per-domain Read/Write grid with an "All domains" override; Write force-checks Read and requires an email (writes run under that real user's permissions).

### approveLease/

**`ApproveLeasePage`** — every row shown here is, by construction, a "First Entry": any container+client pair with a prior manual approval auto-approves server-side and never reaches this queue — hence the permanent "First Entry · Pending Manual Approval" badge on the detail view. Reject goes through a confirm dialog; Approve does not.

### auth/

**`LoginPage`** — three-mode form (login / request-OTP / reset-with-OTP). The login error uses `role="alert"` — explicitly "the one message on this page a user must not miss".

### deployedSummary/

**`DeployedSummaryPage`** — month-wise Opening/Addition/Deletion/Net/Closing with click-through drill-down; builds Excel/PDF exports client-side (xlsx + jsPDF). Deliberately reads only the Deployed sheet, avoiding the Accounts & Collection report-suite dependencies the original app's equivalent page carried.

### leaseExpiry/

**`LeaseExpiryPage`** (987 lines) — the largest list page outside Off-Lease/Stages. Non-obvious logic the code itself explains:
- "Renew" writes `'Documents Pending'` directly (an old intermediate "Renewed" state was skipped 2026-09-03).
- Renew uses the **synchronous** action variant specifically because a bug was found where the immediate follow-up read raced the outbox-queued real write.
- "Off-Lease" from this page must call the *same* function the Off-Lease page itself uses (`trackContainer`) — an earlier version only flipped a flag without creating the actual tracking row (a confirmed-live bug).
- Renew only reappears once `daysLeft <= 15`, to avoid re-offering it on a freshly-renewed container.

**`RenewalHandoffModal`** — pre-checks only the container the user opened it from (a renewal PO often covers more than one container) and opens the CRM form in a new tab, re-validated server-side.

### myTask/

**`MyTaskPage`** — pure rendering layer; "does not own/compute any of the counting logic" per its own header. `data.visibleKeys` narrows the tile set for Sale-Person-scoped logins.

### offLease/ (18 files)

**`OffLeasePage`** (parent, 775 lines) — tab-strip shell: Dashboard, Container Lookup, the Pending-Approval queue, and (hidden from the strip since 2026-10-05 but still routable) each numbered Stage tab + the 6A/6B/6C SD-refund sub-tabs, always mounted (CSS-hidden) so their badge counts stay live.

**`ApprovalQueue`** (inside `OffLeasePage.jsx`) — the gate between Stage 1 and Stage 2. Four outcomes: Approve, Reject, Send Back (reopens Stage 1 without cancelling), Client to Client (own modal, single-item only, deliberately never reaches Stage 2 — hence its own dedicated sub-tab so decided rows stay visible).

**`PipelineDashboard`** — clicking a KPI card filters the table below rather than navigating away ("sending the reader somewhere else to see what they just counted loses the context"). Month filter groups by Off-Lease *Intimation* Date, deliberately not the target date (a bug was found where a September record appeared under "October").

**`ContainerDetailPage`** — the full-page record view. Clicking any stage card/rail-dot opens that stage's form *inline in place of the tabs*, including the 1A/6A/6B/6C approval gates (reusing the exact same backend decision calls the queue tabs use). Computes its own "current stage" label independently of the API's string, since that string can lag behind the card data already on screen.

**`StageSelector`** — a PDF-only stage-exclusion checkbox row; the on-screen cards and Excel export are unaffected.

**`LookupResult`** — all field selection lives in `lookupModel.js`, shared with the Excel/PDF exporters, so the screen and the download can never disagree about which fields exist.

**`ContainerDetailModal`** — wraps the *same* `LookupResult` component used elsewhere, deliberately ("a parallel implementation would be one more place for a newly captured field to go missing").

**`SdRefundApprovalTab`** — surfaced as 6A/6B/6C tabs alongside, not replacing, the standalone `RefundsApprovalPage` — "same approvals, two doors to the same room."

**`OffLeaseEfficiencyPage`** — backed by the *same* `GET /offlease/efficiency` the public-API route serves, so the PDF export can never show a number this screen doesn't.

### refundReview/

**`RefundReviewPage`** — no-login, mounted outside `RequireAuth`, the `?token=` itself is the credential. Redesigned from an earlier separate-modal flow because "this page IS the single focused screen an approver lands on from an email link."

### refunds/

**`RefundSubmitForm`** — explicitly front-validates required fields before any network call, after an earlier version relied on native HTML5 validation that silently failed to scroll an off-screen invalid field into view (looked exactly like "Submit did nothing").

**`RefundsApprovalPage`** — mirrors, deliberately not sharing a module with, Off-Lease's own `SdRefundApprovalTab` ("small per-page duplication over a premature shared module").

### renewDocument/

**`RenewDocumentPage`** (566 lines) — bulk Save/Submit runs requests **sequentially**, not concurrently (`settleSequentially`) — a confirmed-live incident showed firing a dozen-plus concurrent Sheets calls tripped the shared rate limit with no per-item error reason.

**`ApprovalPendingPage`** — its own sidebar page, not a Renew & Document tab, after being reverted the same day it was first tried as one.

**`CompleteDocumentModal`** / **`RenewRemarksModal`** — "Send Back" (stored server-side as `'rejected'`, only the UI label changed) requires a remark and returns the record to Pending, explicitly not a terminal rejection.

### reports/

**`ReportsPage`** — one Year/Month/Sale-Person filter drives three independent reports specifically so the page can never show mismatched periods across sections ("the page could show August off-lease next to June renewals and read as a single coherent view when it was not").

### rolesAccess/

**`RolesAccessPage`** — every checkbox toggle applies optimistically then persists; a failed call reverts by reloading from the server ("revert to server truth"). **`PermissionGrid`** — the synthetic "All Access" row visually disables every other checkbox in that column when checked.

### sso/

**`SsoEmbedShell`** — the shared "sign in by employee code, store the token, render the real page as children" dance factored out of three different embeds. **`SsoSalesOsPage`** — deliberately not a custom form: uses the *exact same* `CompleteDocumentModal` Renew & Document uses in bulk mode, "so a renewal entered via Sales OS looks identical to one entered by an ops user in-app."

### stages/

**`StagePageBase`** (484 lines) — one shared, parametrized component backing every numbered Stage list page. Stage 2's size classification checks "Cabin" first (substring match against messy free text — "20FT Cabin" would otherwise misclassify). `Stage9Page` is architecturally separate (append-only, not a pipeline stage).

**`StageDetailModal`** (2,690 lines — the largest frontend file) — the single shared view/edit form for one record at one stage. Fields are always exactly `STAGE_FIELDS[stageNumber]` — never hand-written per call site. Fetches enrichment via *separately, independently timed* calls specifically so a slow multi-sheet fallback never makes fast fields wait up to a minute. Stage 6's form renders a `<div>`, not `<form>` — a documented fix for the embedded `RefundSubmitForm`'s own nested form bubbling its submit event and double-firing two saves.

### verifyLease/

**`VerifyLeasePage`** — there is **no reject path** on this page, only Approve (with a Follow Up alternative that sends the row back to the Sale Executive).
