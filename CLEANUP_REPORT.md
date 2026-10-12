# Cleanup Report

Phase 1–3 of the codebase audit requested 2026-10-10/12: inventory, flag, and classify by risk. **Nothing in this report has been removed, refactored, or otherwise changed.** This is the plan for review — per the audit's own final rule, no destructive change happens until this is approved, and even then in small, reviewable steps.

Produced by two read-only inventory passes (backend/src, 91 files; frontend/src, 147 files) plus direct verification of the items below — every "unused" claim was grep-checked across the whole relevant tree, not inferred from a single file.

## Summary

| | Count |
|---|---|
| Unused dependencies | **0** — all 14 declared production deps are genuinely used |
| Unused backend files | **0** |
| Unused frontend functions/exports (dead end-to-end) | 6 |
| Dead routes (frontend, no in-app path to reach them) | 10 |
| Self-documented duplicate logic | 2 confirmed drift, 1 deliberate |
| Unreachable code (dead `if` branch) | 1 |
| Stray unused CSS classes | 2 (spot-checked, not exhaustive) |
| Loose one-off debug scripts | 5 |
| Stale tracked log files | 33 |
| Files flagged for maintainability (size, not correctness) | 3 |

## Safe to remove (confirmed dead, zero behavioral risk)

Each of these was verified with a repo-wide grep for its export/class name — not just "not imported in the one file I was reading."

1. **`frontend/src/services/offLease.service.js`'s `sendRejectedBackToStage1()`** + the `sendRejectedToStage1` call it wraps in `api/offlease.api.js`, + the backend route `POST /api/offlease/:containerNo/reject/send-back` it would have hit. Nothing calls this anywhere in the frontend. `sendBackToStage1FromApproval` (a sibling, actually used in 2 files) appears to have superseded it.
2. **`frontend/src/services/renewDocument.service.js`'s `fetchRenewRemarkThread`/`postRenewRemark`/`editRenewRemark`/`removeRenewRemark`** + their 4 `api/renewDocument.api.js` counterparts + the 4 backend routes under `/api/expiry/renewal/:containerNo/remarks`. Fully dead end-to-end on the frontend — no page ever calls these. (`RenewRemarksModal.jsx`, despite the similar name, is an unrelated approval-decision feature, not this remark thread.) **Backend routes:** keep the backend routes for one more review cycle in case the public API or another consumer uses them directly — I did not check `/api/public/v1` for a reference, and removing a route is a slightly bigger decision than removing dead frontend code.
3. **`frontend/src/services/stage.service.js`'s `fetchMoveHistory()`** + `api/stage.api.js`'s `getMoveHistory`. Unused — but note the *backend* route `GET /api/offlease/:containerNo/move-history` may still be used by something outside this frontend; same caveat as #2.
4. **`frontend/src/services/verify.service.js`'s `submitAgreementEdit()` / `uploadAgreementDocument()`** + their api-layer counterparts. Unused.
5. **`frontend/src/pages/offLease/lookupModel.js`'s `BILLING_HEAD` / `buildBilling()`** — a complete, well-commented billing-section builder that neither `LookupResult.jsx` nor `lookupExport.js` imports, despite importing all of its siblings. Looks like a feature that was built and then not wired in, or superseded.
6. **`frontend/src/constants/routes.js`'s `ROUTES.STAGES`** ('/stages') constant — nothing references it; only `ROUTES.stage(n)` is used.

**Unreachable code, not just unused:**

7. **`frontend/src/components/ui/StatCard.jsx`'s second `compactParts` branch (lines ~100-107)** — an earlier `if (compactParts) { return … }` at line 81 already returns before this is ever reached. The `.compactHead`/`.kname`/`.kicker` CSS classes it would have used are correspondingly dead.

**Stray CSS (low-value, trivial to remove, verify when next touching the file):**

8. `frontend/src/components/layout/Sidebar.module.css`'s `.sectionLabel` — superseded by `.sectionToggle`/`.sectionToggleLabel`, looks like a rename left the old rule behind.

## Moderate risk (needs a small coordinated change, not a pure delete)

1. **`_expiryOrderNoMap` duplicated in `approve.service.js` and `expiry.service.js`** (byte-identical logic). `approve.service.js`'s own header comment already flags this as unresolved: *"pick one canonical home and re-export/import."* Consolidating means picking the home, updating both files' imports, and re-verifying every caller (`dashboard.service.js`, `renewalHandoff.service.js`, and whichever path `tasks.service.js` actually takes today — the existing comment's claim about `tasks.service.js` may itself be stale and should be re-confirmed before relying on it).
2. **Dead routes** (frontend has no sidebar entry or `navigate()` call reaching these — URL-only):
   - `/stages/stage-1` through `/stages/stage-9` (9 routes) — `nav.js`'s own comment confirms the Stages sidebar branch was deliberately removed in favor of Off-Lease's embedded tabs (`OffLeasePage.jsx` renders `StagePageBase` directly via `embedded`, never navigates to these). Removing the routes is low-risk (nothing links to them), but the components (`Stage1Page`…`Stage9Page`, and `StagePageBase` itself) are still the *same* components Off-Lease embeds — don't delete the components, only the now-pointless standalone routes.
   - `/approve-lease` (`ApproveLeasePage`) — removed from the sidebar 2026-09-11; the comment claiming "My Task still links here" is itself stale (that My Task tile was removed 2026-09-29). No remaining in-app path. Moderate, not safe, because this is a route change visible to anyone who had it bookmarked.
3. **Loose/one-off debug scripts, not wired into npm or CI** (5 files — kept for now, flagged for a relocate-or-remove decision): `backend/check_match.mjs`, `backend/verify_digest.mjs`, `backend/verify_headers.mjs`, `backend/verify_reject_dryrun.mjs`, `backend/scripts/_tmp_check_stage8_detail2.mjs`. All are temp-named or hardcoded to specific containers/companies — read as throwaway investigation tools. Moderate only because someone should confirm none are still being run manually before moving them.
4. **33 tracked `backend_restart*.log.err` files** in the backend root. Almost certainly accidental commits of local restart-log output. Moderate (not safe) only in the sense that `git rm` affects history visibility — functionally these are pure noise with zero code risk to remove.

## Deliberately NOT flagged as problems (checked, found to be intentional)

- **Quota-error detection duplicated 3 times** (`errorHandler.js`, `googleSheets.service.js`, a comment in `memoryCache.js`) — each site's own comment explicitly justifies this as "a 2-line check isn't worth a cross-layer dependency." Leave it.
- **Four near-identical "confirm + capture remarks" modals** (`HoldModal` → `RejectModal` → `ClientToClientModal` → `OffLeaseModal`, each explicitly citing the previous as its pattern) and **`RefundApprovalModal`/`ApprovalDecisionModal`** sharing a "decision fixed by which button opened this" shape. Real, callable-out duplication, but the codebase's own comments show this was a conscious choice each time, not drift. Worth a shared base component if this app is actively growing, not urgent.
- **`DataGrid.jsx`** is explicitly documented as a deliberate reimplementation of the main app's own table component, built independently per that project's "duplication over cross-app sharing" decision. Not a same-repo duplicate — out of scope.
- **`backend/scripts/migrate-legacy-permissions.mjs`, `reconcileOffLeaseEfficiency.mjs`, `test-mail.mjs`** — not wired into CI, but each is a documented, intentional, reusable manual tool (migration record, data-quality validator, SMTP credential check). Keep.

## Flagged for maintainability, not correctness (no action proposed here)

These are large, but each is a legitimate single-domain port, not evidence of drift or duplication:

- `backend/src/services/offlease.service.js` — 6,712 lines (largest file in the repo).
- `frontend/src/pages/stages/StageDetailModal.jsx` — 2,690 lines (largest frontend file).
- `backend/src/services/expiry.service.js` — 1,612 lines.

Splitting any of these is a real Phase 4 candidate, but per [TESTING_REPORT.md](TESTING_REPORT.md) there is no automated test coverage for the logic inside them — a split should wait for at least targeted tests around the function(s) being moved, not be attempted cold.

## What was explicitly checked and found clean

- **Every one of the 14 declared production dependencies** (7 backend, 7 frontend) is genuinely imported somewhere — verified by grep, including two that needed a second look (`dotenv` via a side-effect import, `react-dom` via a `/client` subpath import). No `package.json` cleanup needed.
- **No backend file is unreferenced.** All 91 files in `backend/src` are either imported/routed/cron-registered, or are a legitimate non-imported entry point (`server.js`, `app.js`).

## Suggested order, if this plan is approved

1. The 8 "safe to remove" frontend items (§1) — genuinely zero behavioral risk, each independently verifiable.
2. The 33 stray `.log.err` files — pure noise, `git rm` + a `.gitignore` entry so they stop reappearing.
3. The 5 loose debug scripts — relocate to a clearly-marked `backend/scripts/debug/` (or remove, your call) rather than leaving them at the repo root looking like part of the app.
4. Consolidate `_expiryOrderNoMap` — small, contained, already-scoped by the existing comment.
5. Remove the 10 dead routes — after confirming nobody has these bookmarked/linked externally.
6. File-splitting (the 3 large files) — only after some test coverage exists around the function(s) being extracted.
