# Workflows

End-to-end business processes, traced through the actual code (not the UI alone) — which function handles each step, and the non-obvious rules governing the handoffs between them. For per-function detail, see [CODE_DOCUMENTATION.md](CODE_DOCUMENTATION.md); for the full endpoint list, see [API_DOCUMENTATION.md](API_DOCUMENTATION.md).

## Contents

1. [Lease lifecycle — Verify → Approve → Expiry → Renew & Document → Renewal Approval](#1-lease-lifecycle)
2. [Off-Lease — the 8-stage container-return pipeline](#2-off-lease-8-stage-pipeline)
3. [Sheets ↔ Mongo sync — the write-then-mirror pattern](#3-sheets--mongo-sync)
4. [Background jobs & cron](#4-background-jobs--cron)
5. [Frontend user journeys](#5-frontend-user-journeys)

---

## 1. Lease lifecycle

The path a single lease record travels from creation through its next renewal, spanning `verify.service.js`, `approve.service.js`, `expiry.service.js`, and the permission/task layers.

1. **New lease created** (upstream of this app) and surfaces on **Verify Lease** via `verify.service.js#getVerifyData`.
2. **Verify decision** — a reviewer approves or rejects, optionally logging follow-ups or editing fields first: `#saveVerifyAction` (decision), `#saveVerifyFollowUp` (follow-up log), `#updateVerifyLeaseFields` / `#saveVerifyDocument` / `#uploadAndSaveVerifyDocument` (edits/documents).
3. **Approve Lease** — the matching Operation-sheet row surfaces via `approve.service.js#getApproveData`. A brand-new container+client pair needs a human decision (`#saveApproveLeaseByContainer`); a pair with prior manual-approval history **within the current lease cycle** auto-approves instead — applied for real by `#runAutoApproval` (hourly cron), reversible via `#revertAutoApproved`. Decided rows are visible afterward via `#getApprovalHistory`.
4. **Deployed / lease goes live** — the container lands on the Deployed sheet and now shows up on **Lease Expiry** via `expiry.service.js#getExpiryDataByFilter('pending', user)`, banded `safe / warning / critical / overdue` by whichever of Agreement-Valid-Upto or PO-Validity is still valid. **Both valid is always `safe`**, regardless of how soon either expires; **neither valid** is `overdue`, using the *less*-negative (more-recently-lapsed) day count — not whichever is more negative, which was a confirmed bug (a healthy PO could read "156 days overdue" because of an unrelated, already-expired agreement).
5. **Renew is initiated** — either a quick date update with no agreement-history tracking (`verify.service.js#updateLeasePeriod`), a full renewal with history (`#renewLeaseWithAgreement`, also logs to the Renewal Log), or — the common path, from Lease Expiry itself — the Renew/Off-Lease action (`expiry.service.js#saveExpiryAction` / `#saveExpiryActionFast`) stamps the row "Documents Pending" and hands it to **Renew & Document**.
6. **Renew & Document — Documents stage.** The submitter saves a draft as they go (`#saveRenewalDraft`, partial/optional — nothing is required) and, when ready, **Submits** (`#completeDocStage`): stages the full draft (renewed date, valid till, signed copy, PO, billing cycle, PO value) and sets Approval Status = `'Pending'`, emailing Pushpa Shetty. *Neither* function touches the real Agreement/PO/Valid-Upto columns — only step 7's approval does. A row can instead be sent back to Lease Expiry's plain pending list (`#sendExpiryToPending` / `#sendExpiryToPendingFast`) or just annotated (`#saveExpiryRemark`), without reaching Submit.
7. **Renewal Approval** — Pushpa reviews the submitted draft via `#decideRenewalApproval`:
   - **Rejected** (labelled "Send Back" in the UI, same stored value) → only approval metadata changes; the row falls back into Renew & Document's ordinary Pending tab for the submitter to fix and resubmit — not a terminal outcome, back to step 6.
   - **Approved** → the staged draft is promoted into the real Agreement/PO/PO-PDF/Billing-Cycle/PO-Validity/Valid-Upto columns (via `_resolveRenewalColumns`, which locates those columns by header text since they've shifted by hand over time), the row's status is cleared (exits the renewal workflow entirely), a Renewal Log row is appended crediting the *original submitter* (not the approver) as "Updated By", and the renewal-completed notification goes out. The lease is live again under its new terms — the cycle returns to step 4 for its next expiry window.

**Reporting, throughout:** `tasks.service.js#getMyTasks` / `#getEmployeeTasks` aggregate pending counts from every step above for the sidebar/My Task badges; `dashboard.service.js#getDeployedSummaryData` / `#getDeployedDetailData` report on the Deployed-sheet population independently of where any one container sits in this cycle.

**Also reachable without a password**, via Sales OS (a separate CRM) deep-linking a salesperson in: `services/salesOsRenewal.service.js` replays the *exact same* `saveExpiryAction` / `completeDocStage` / `saveRenewalDraft` functions a human uses manually — no parallel write path exists for the SSO entry point.

---

## 2. Off-Lease 8-stage pipeline

A container moves through this sequence in true **workflow order** — `OL_ACTIVE_STAGE_NUMS = [1, 6, 7, 3, 5, 11, 8]` — not numeric internal-stage-ID order. Internal stage numbers never change once assigned (even retired ones); what the user sees ("Stage 1".."Stage 7") is a separately computed display number.

1. **Entry point.** `offlease.service.js#addToOffLeaseTracking` (or the FMS auto-create path, `#autoCreateOffLeaseFromFms` → its internal row-creator) creates the Off-Lease Tracking row from the Deployed sheet and stamps the Deployed row's own Update/Status columns. This moment (read back by `#getOffLeaseEntryStamp`) starts Stage 1's SLA clock.
2. **Stage 1 — Off-Lease Intimation.** `#saveOffLeaseStage` / `#saveOffLeaseStageFast` (stage `1`) assigns the real Lease ID on first save and fires the off-lease notification email. Can be put **On Hold** (`#saveOffLeaseHold`, reversed by `#saveOffLeaseSendBackToStage1`) without touching any real Stage 1 field.
3. **Stage 1A — Intimation Approval gate.** Once Stage 1 is complete, the record enters the approval desk (`#getOffLeaseApprovalData`). Four possible outcomes, each syncing the external Master workbook instantly (`#_syncOffLeaseRowToMaster`):
   - **Approve** (`#saveOffLeaseApprovalAction`, status `"Approved"`) → releases into Stage 2's queue.
   - **Client to Client** (`#saveOffLeaseApprovalClientToClient`) → the container goes to a different client instead of physically returning; writes `"Client to Client"` (not `"Approved"`) so it deliberately never enters Stage 2+, staying visible on its own approval sub-view instead.
   - **Reject** → either reopened for revision later (`#saveOffLeaseSendRejectedToStage1`, reopens Stage 1 too) or finally cancelled (`#saveOffLeaseRejectAndCancel` — reverts the Deployed sheet's off-lease stamp entirely; the container returns to Lease Expiry as an ordinary active lease).
   - **Send Back** (`#saveOffLeaseSendBackFromApproval`) → a softer correction: reopens Stage 1 with a remark, cancels nothing.
4. **Stage 2 — Transportation** (internal 6). Read-only, FMS-enriched. Completes automatically once STAGE-8 (booked) + STAGE-9 (transported) + STAGE-10 (delivered) all have a matching external-FMS record (`stage8.service.js#getDeliveredKeys`) — its status column is essentially never hand-filled. Alternatively, a manual **Move To Stage** (`#saveOffLeaseMoveToStage`, gated on a real STAGE-8 record already existing) or a **Client-to-Client pending-DO draft** (`#saveOffLeaseMoveToStageClientToClientPending`, finalized later by the `checkPendingClientToClientMoves` cron) jumps the container straight to Gate In, Inspection, or Final Billing — reversible via `#saveOffLeaseSendBack`, audited by `offleaseMoveHistory.service.js`.
5. **Stage 3 — Gate In** (internal 7). Has **no form of its own** — completion is purely the external Stage 3 Google Form log (`stage3Form.service.js#isGatedIn`) showing `"Inward (Gate-In)"` for this container+client.
6. **Stage 4 — Inspection Checklist** (internal 3). The inspector fills the checklist + technician labour hours via `#saveOffLeaseStage` (stage `3`), which auto-derives technician cost and emails Pushpa/Shivani on completion. Every container passes through a real inspection now — an earlier "repair not required" bypass was removed.
7. **Stage 5 — Final Billing** (internal 5). The reconciler fills outstanding/repair/transport charges via `#saveOffLeaseStage` (stage `5`), shown alongside a read-only Cost-Reference card built from the checklist's own fault-point estimates. Can be sent back to reopen both Stage 1 and Stage 5 (`#saveOffLeaseSendBackFromBilling`) if reconciliation reveals an upstream data problem.
8. **Stage 6 — SD Refunds** (internal 11) — **the HOD/CEO approval gate.** Nothing is submitted directly here; its status is set automatically once this container's own SD Refund entry (`refunds.service.js`) clears its own approval chain:
   - **HOD → Accounts → CEO** (CEO conditional: only required when Amount to Pay exceeds ₹1,00,000, auto-skipped with a system remark otherwise).
   - `offlease.service.js#markOffLeaseSdRefundSubmitted(containerNo)` flags Stage 6 `"Submitted"` the moment a refund is raised; `#markOffLeaseSdRefundApproved` flags it `"Completed"` once the chain reaches its CEO-approved (or CEO-skipped) end.
9. **Stage 7 — Payment Status** (internal 8) — hard-gated: Stage 6 must read `"Completed"` **and** Voucher Raised must be done first.
   - **VR (Voucher Raised)** — `#saveOffLeaseVoucherRaised`, no form field of its own.
   - **UTR Number** — a real form field; submitting it via the normal `#saveOffLeaseStage` (stage `8`) path **is** the stage's completion record, with no separate status column.

Throughout, `offlease.service.js#attachStageTat` (pending-queue TAT) and `offleaseEfficiency.service.js` (cumulative Target/Actual efficiency score) both independently re-derive every stage's real start/end timestamps from the *same* underlying signals (Stage 1 entry stamp, approval timestamp, FMS STAGE-8/9/10, the Gate-In form) — deliberately, so the SLA badges, the Efficiency Dashboard, and the Container Lookup detail view can never disagree about when something actually happened.

---

## 3. Sheets ↔ Mongo sync

Three cooperating pieces keep a Google Sheet (the real source of truth, editable by humans and other apps too) and its Mongo mirror (fast, quota-free reads) in step:

1. **The write path.** Some actions are "Mongo-first": the user sees success the instant the Mongo write lands, and `outbox.service.js#enqueueSheetReplay(kind, args)` drops a `{kind, args, status:'pending'}` document into `_sync_outbox`. `jobs/outboxWorker.js` polls that collection (~7s) and replays the entry by calling `jobs/outboxRegistry.js`'s mapped function — the **exact original, unchanged live-Sheets function** (e.g. `offlease.saveOffLeaseStage`), never a second hand-maintained copy that could drift. That replayed function still does its own fresh read and guard checks, so it's authoritative, not a blind replay. On a Sheets quota error, the worker pauses its own claiming for 5 minutes (scoped to itself — it never blocks the rest of the app) and retries with exponential backoff, up to a max-attempts cap before marking the entry `dead`.

   More commonly in this codebase, a write goes **directly and synchronously to Sheets**, then immediately calls `mongoSheetData.service.js#patchMongoMirrorRow` (in-place) or `#appendMongoMirrorRow` (new append-only rows) to update the mirror right away — parsing the exact same `{range, values}` payload that was just sent to Sheets, so the mirror can never show something different from what was actually written. Both are best-effort: a mirror-patch failure never undoes or fails the Sheets write that already succeeded.

2. **The read path.** Every display/list read goes through `mongoSheetData.service.js#getSheetDataFromMongo` (or `#getMongoRowsWithKeys` when a write needs the row's Mongo key), never live Sheets — this removed almost all read traffic from the shared, cross-app Sheets quota. Because the write path above patches the mirror immediately, a user's own action is visible on their very next read with no lag. Only edits made **directly in the raw spreadsheet**, by someone or something outside this app, are invisible until the next scheduled reconcile.

3. **The catch-up path.** Every 5 minutes, `jobs/sheetsReconcile.job.js#runSheetsReconciliation` live-reads every sheet in `config/mongoSheetMapping.js` and reconciles it one of two ways: `fullRefresh` sheets (no safe, *verified*-unique natural key — several sheets were found, via real data, to have a column that looked unique and later silently stopped being so) are wiped and rebuilt wholesale inside one Mongo transaction; `naturalKeyColumn` sheets are upserted by that key, with any doc whose key no longer appears in the live sheet soft-deleted. This job is the only mechanism that notices a change made outside the app entirely, and it's also what makes the write-then-mirror pattern self-healing: if a patch/append/replay call ever silently fails, the next cycle (≤5 min later) re-derives the correct mirror state from the live sheet regardless.

**In short:** writes go to Sheets first, the mirror is patched instantly as a side effect of that same write, reads are always served from the fast mirror, and a background job periodically re-derives the mirror from Sheets to catch anything the instant-patch step missed.

---

## 4. Background jobs & cron

Registered in `backend/src/jobs/index.js`, in two independently-gated groups. Every job runs wrapped in `safeRun`, which catches and logs any error — node-cron has no per-task isolation, so an unguarded failure in one job could otherwise crash the process or block the others.

**`registerCronJobs()` — gated by `ENABLE_CRON`:**

| Job | Schedule | What it does |
|---|---|---|
| `runAutoApproval` | hourly | Auto-approves recurring container+client pairs (`approve.service.js`). |
| `copyApprovedData` | hourly | Copies Approved New Lease rows into the Deployed sheet (`offlease.service.js#copyApprovedData`). |
| `sendLeaseExpiryDigest` | daily, 9:00 AM | One email per sales executive listing their overdue/soon-expiring leases. |
| `sendMonthlyReport` | 1st of month, 6:00 AM | Previous month's full Renew + Off-Lease activity, to Pushpa Shetty & Shivani Dhall. Idempotency is handled inside the service (a state doc), not by the schedule. |

**`registerSheetsSync()` — gated by `ENABLE_SHEETS_SYNC`, independent of `ENABLE_CRON`, every 5 minutes, deliberately staggered:**

| Job | Offset | What it does |
|---|---|---|
| `runSheetsReconciliation` | :01 | Sheets→Mongo mirror sync — see §3 above. |
| `refreshStage3FormCache` | :03 | Refreshes the external Stage 3 Gate-In form cache. |
| `warmFmsCache` | :04 | Re-warms the FMS STAGE-8/9/10 cache, 1 minute after reconcile has pulled fresh data in. |
| `checkPendingClientToClientMoves` | :05 | Finalizes pending Client-to-Client DO matches, run last so it sees the freshest possible STAGE-8 mirror. |

All four sync schedules use explicit comma-separated minute lists rather than cron range/step syntax (`'1-59/5'`) — a confirmed real bug where that syntax silently collapsed two *intended-to-be-offset* schedules onto the identical instant, repeatedly causing quota lockouts before this fix.

---

## 5. Frontend user journeys

### Journey A — Completing a stage form (Stage 6, SD Refunds, as the most complex example)

1. **Entry points** — all render the same `StageDetailModal`, reached from: a Stage N list page (`StagePageBase.jsx`), a stage chip on a dashboard "order book" row (`OrderBookView.jsx`), or a stage card/rail-dot on the full record page (`ContainerDetailPage.jsx`, where the form replaces the tab content inline rather than opening a popup).
2. The modal fires `stage.service.js#fetchStageDetail` for the stage's own fields, plus (in parallel, deliberately decoupled so a slow lookup never blocks fast fields) `fetchCardEnrichment` and `fetchAgreementPoPdf`.
3. For Stage 6 specifically: if no SD Refund has been submitted yet (`fetchSdRefundsForContainer` returns empty), the modal embeds the shared `RefundSubmitForm`, with Container No/Client Name/Off-Lease ID pre-filled and locked from context.
4. The user fills Vendor Name, SD Amount, SD Amount to be Refunded (required), optionally uploads supporting files, and submits — the form front-validates required fields in JS first (a documented fix for a bug where native HTML5 validation silently failed to scroll an off-screen invalid field into view).
5. Files upload via `upload.service.js#uploadStageFile` (returning Drive URLs); `refunds.service.js#submitRefund` writes the bill row; the panel re-renders showing the HOD/Accounts/CEO pipeline status in place of the form.
6. An approver reaches the decision via the Off-Lease page's 6A/6B/6C tabs, the standalone Refunds Approval sidebar page, the inline panel on the record page, or a no-login emailed link — all four call the same `refunds.service.js#submitRefundApprovalDecision`.
7. Once the bill clears its final required approval, the container's Stage 7 (Payment Status) form unlocks "Mark Voucher Raised", then a UTR Number field, completing the record.

### Journey B — Off-Lease record lookup / detail page

1. **From Container Lookup**: the user types a container number; `offLease.service.js#lookupContainer(containerNo, leaseId?)` runs.
2. If the container has more than one off-lease record, a disambiguation picker (`ContainerMatchPicker`) appears; picking a client re-runs the lookup scoped to that `leaseId`.
3. `LookupResult` then renders: identity fields, the Stage 1–9 history table, Invoices, Movements, the 8-stage + 1A-gate progress board, and per-completed-stage "Filled Stage Data" cards.
4. The user can scope a PDF download to specific completed stages (`StageSelector`), then download Excel/PDF — both built from the exact same field-shaping functions (`lookupModel.js`) the on-screen card uses, so a download can never show different fields than the screen.
5. **From the dashboard instead**: clicking a record row (`OrderBookView.jsx`) navigates to `/off-lease/record?container=&leaseId=&row=`, rendering `ContainerDetailPage.jsx` — tabs (Overview/History/Stage data/Invoices/Movements), a step rail, and the ability to open any stage's live form or the 1A/6A/6B/6C approval gates inline without leaving the page.
6. From either entry point, if the viewer has permission and it's the record's *current* stage, they can act on it directly (see Journey A) and return to the lookup/detail view once saved.

### Journey C — Renew & Document → Renewal Approval (with the Sales OS variant)

1. A container becomes due and shows on `LeaseExpiryPage.jsx`. The user clicks **Renew**, which opens `CompleteDocumentModal` directly (an explicit change ensuring Renew opens the real form immediately rather than silently flipping a status). Behind the scenes, the container is first marked `'Documents Pending'` via a *synchronous* write (`actionExpiryRowSync`, chosen specifically to avoid a race with the async-write outbox) before Save/Submit runs.
2. The user fills Renewed Date, optional Agreement Valid Till, and *either* a Signed Copy upload *or* a PO No + PO File — at least one required, neither individually mandatory. **Save** persists a draft (reopenable later, pre-filled); **Submit** requires the proof and stages the renewal for approval.
3. If reached later instead (not via the one-click Renew), the same form is opened from `RenewDocumentPage.jsx` ("Renew & Document") — single-row or bulk (multi-select, one form applied to every selected container).
4. On Submit, the record moves into `ApprovalPendingPage.jsx` ("Renew Approval Pending" — a dedicated sidebar page, not a tab, after being reverted the same day it was first tried as one).
5. Pushpa opens a row (`RenewRemarksModal`, showing the existing record plus the proposed update) and decides inline: **Approve** (applies the renewal) or **Send Back** (requires a remark; returns to Renew & Document's Pending list — not a terminal rejection, even though the stored value is still `'rejected'`).
6. If sent back, the submitter reopens the form (now showing Pushpa's remark), fixes the issue, and resubmits from step 2.
7. **Without an LMS login**, the same flow is reachable from Sales OS: `SsoRenewDocumentPage.jsx` / `SsoApprovalPendingPage.jsx` embed the *exact same* page components (authenticated by employee code alone via `SsoEmbedShell`), and `SsoSalesOsPage.jsx` provides a from-scratch landing flow (authenticate → company match → container checklist → the same bulk `CompleteDocumentModal`) for a salesperson entering a renewal directly from a CRM deal — staging it for the identical approval step above.
