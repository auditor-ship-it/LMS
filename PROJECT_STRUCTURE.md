# Project Structure

Compiled 2026-10-12 from a read-only inventory pass over both `backend/src` (91 files) and `frontend/src` (147 files). One line per file/group; see each file's own header doc comment for detail — this codebase documents itself heavily, and this file is a map to that, not a replacement for it.

```
LMS/
├── backend/          Express API — see below
├── frontend/          React app (Vite) — see below
├── .github/
│   ├── DEPLOYMENT.md   how the push-to-main auto-deploy works
│   ├── workflows/ci.yml  lint + build + backend smoke-import, every PR
│   └── scripts/        smoke-import.mjs, vps-auto-deploy.sh, restart-backend.sh
├── package.json       root: `npm run dev` / `install:all` / `build` orchestration
└── containers-on-lease-reconciled.csv   data dump — see CLEANUP_REPORT.md
```

## backend/src

### config/
| File | Purpose |
|---|---|
| `db.js` | MongoDB connection (forces public DNS, pins a TLS workaround for this network) |
| `env.js` | loads/validates required env vars; exits on startup if any are missing |
| `mongoSheetMapping.js` | per-sheet reconciliation identity (natural key / append-only / full-refresh) |
| `permissions.config.js` | `PERMISSION_KEYS`/`SIDEBAR_KEYS` label schema for Roles & Access |
| `runtimeSecrets.js` | optional secrets from Mongo, fallback when `.env` can't be edited |
| `salesCrmDb.js` | read-only connection to the separate Sales CRM cluster (write is impossible by construction — only `findLeads()` is exposed) |
| `sheets.config.js` | sheet-tab name constants + external spreadsheet IDs |

### controllers/ (14) + routes/ (13)
One pair per domain (`verify`, `approve`, `expiry`, `offlease`, `refunds`, `roles`, `tasks`, `dashboard`, `apiKeys`, `upload`, `auth`, `sso`, `salesOsRenewal`), plus `public.routes.js` (the key-gated external API) and `refundReview.routes.js` (no-login, signed-link refund approval). Full endpoint list: [API_DOCUMENTATION.md](API_DOCUMENTATION.md).

### middlewares/ (7)
`asyncHandler`, `auth.middleware` (Bearer token → `req.user`), `errorHandler` (404 + Google-quota detection), `permission.middleware` (`requirePermission`), `publicApiAuth.middleware` (`X-Api-Key` gate), `requestLogger`, `responseCache`.

### jobs/ (4)
`index.js` (cron registrations behind `ENABLE_CRON`), `outboxRegistry.js` + `outboxWorker.js` (Mongo-first write queue replayed to Sheets), `sheetsReconcile.job.js` (periodic Sheets→Mongo catch-up).

### services/ (37) — grouped
- **Core data layer:** `googleSheets.service.js`, `googleDrive.service.js`, `mongo.service.js`, `mongoSheetData.service.js`, `outbox.service.js`.
- **Workflow domains:** `verify.service.js`, `approve.service.js`, `expiry.service.js` (1,612 lines), `offlease.service.js` (6,712 lines — by far the largest file in the repo), `refunds.service.js`, `roles.service.js`, `permissions.service.js`.
- **Off-Lease sub-modules:** `offleaseEfficiency.service.js` (+ its `.test.js`), `offleaseMoveHistory.service.js`, `offleaseRemarks.service.js`, `offleaseSla.service.js`, `olHeaders.generated.js`, `stage3Form.service.js`, `stage8.service.js`, `stage9.service.js`.
- **Cross-app / external:** `accountsApi.service.js`, `salesCrmDb.js`-backed `salesCrmLeads.service.js`, `salePersonAccess.service.js`, `salesOsRenewal.service.js`, `renewalHandoff.service.js`.
- **Comms/reporting:** `email.service.js`, `leaseExpiryDigest.service.js`, `monthlyReport.service.js`.
- **Misc:** `apiKeys.service.js`, `auth.service.js`, `dashboard.service.js`, `renewRemarks.service.js`, `tasks.service.js`.

### utils/ (11)
`AppError`, `format`, `isRateOrAmountHeader`, `jwtLite` (dependency-free HS256, used only for the Sales CRM handoff), `logger`, `memoryCache`, `normalize`, `quotaLock`, `requestContext`, `sheetMutex`.

### backend/scripts/ + loose `backend/*.mjs`
8 manual/debug tools, none wired into npm or CI — see [CLEANUP_REPORT.md](CLEANUP_REPORT.md) §Scripts for which are kept-on-purpose vs. candidates for cleanup.

## frontend/src

### api/ (13) + services/ (13)
One thin axios wrapper + one pass-through service per backend domain (`verify`, `approve`, `expiry`, `offlease` (118 lines, largest), `refunds`, `renewDocument`, `roles`, `sso`, `stage` (115 lines), `tasks`, `upload`, `apiKeys`, `dashboard`). `offLease`/`stage` services additionally call `dataBus.invalidate()` on writes.

### app/ + routes/
`App.jsx` — top-level router (`/login`, 3 SSO embeds, no-login `/refund-review`, everything else behind `RequireAuth` + `AppShell`). `routes/routes.jsx` — `APP_ROUTES`, one lazy-loaded element per sidebar leaf plus `Stage1Page`…`Stage9Page` (now dead — see CLEANUP_REPORT.md).

### components/layout/ (7)
`AppShell`, `Sidebar` (permission/sidebar-key gated, collapsible), `TopBar`, `Breadcrumbs`, `KeepAlivePages` (keeps every visited page mounted so data fetches once per session), `RequireAuth`, `ErrorBoundary`.

### components/ui/ (23)
The design-system primitive set: `Button`, `Card`, `DataGrid` (generic table — this app's own, independent of the main app's equivalent), `Modal`, `StatusBadge`, `StatCard`, `SearchBar`, `FilterBar`, `Pagination`, `Icon`/`IconSprite`, `RichTextEditor` (no 3rd-party dep), `FileUpload`, `ConfirmDialog`, `LogModal`, `Select`, loading/empty/error states, skeletons, `CellValue` (link-aware cell renderer). Barrel-exported via `index.js`.

### constants/
`nav.js` (sidebar tree + visibility rules), `routes.js` (path constants), `stages.js` (Off-Lease stage metadata).

### hooks/ (9)
`useAsync`, `useAutoRefresh`, `useDebouncedValue`, `usePagination`, `usePermission`, `usePolling`, `useSidebarState`, `useSwipeSidebar`, `useTheme`.

### pages/ — by domain
| Folder | Contents |
|---|---|
| `apiAccess/` | key management admin UI |
| `approveLease/` | read-only lease register + approve/reject (route now orphaned — see CLEANUP_REPORT.md) |
| `auth/` | `LoginPage` |
| `deployedSummary/` | monthly fleet summary + export (416 lines) |
| `leaseExpiry/` | `LeaseExpiryPage` (987 lines) + 2 modals |
| `myTask/` | scorecard aggregating every stage's pending count |
| `offLease/` | 18 files — dashboard, pipeline, lookup, approval/refund sub-tabs, efficiency view, PDF/Excel export |
| `refundReview/` | no-login, signed-link refund decision page |
| `refunds/` | refund submission + HOD/CEO approval |
| `renewDocument/` | post-renewal document upload + its own approval step (566 lines) |
| `reports/` | Renewal Log / New Lease Excel export |
| `rolesAccess/` | permission + sidebar grid admin UI |
| `sso/` | the 4 SSO embed shells |
| `stages/` | `StagePageBase` (484 lines) + `StageDetailModal` (2,690 lines — largest file in the app) + `Stage1Page`…`Stage9Page` wrappers (now reached only by direct URL — see CLEANUP_REPORT.md) |
| `verifyLease/` | `VerifyLeasePage` + 2 modals |

### shared/
`auth/` — a standalone auth context/client, independent of the main app. `dataBus.js` — cross-page "data changed" pub/sub (the deliberate exception to `KeepAlivePages`' fetch-once model).

### utils/
`breadcrumbs.js`, `formatDateTime.js`, `isRateOrAmountHeader.js` (mirrors the backend util — system-wide "hide pricing columns" convention), `tableFilters.js`.

## Data flow, in one line

Google Sheets (system of record) → reconciled into MongoDB every few minutes, patched instantly on writes → the app reads Mongo, writes go to Sheets first then patch the mirror. Full detail: [DATABASE_DOCUMENTATION.md](DATABASE_DOCUMENTATION.md).
