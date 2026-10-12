# Lease Management System (LMS)

A standalone full-stack app for Crystal Group's container-leasing operations: lease verification and approval, lease-expiry/renewal tracking, the 8-stage Off-Lease return workflow, SD refunds, and role-based access — all built on top of the company's existing Google Sheets as the system of record, mirrored into MongoDB for fast reads.

This app has its own frontend, its own backend, and its own MongoDB/Google Sheets connection. It does not share a backend with any other app in this organization.

**Companion documents** (all compiled 2026-10-12 from a full read-only codebase pass): [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) (folder-by-folder map), [CODE_DOCUMENTATION.md](CODE_DOCUMENTATION.md) (per-function documentation), [WORKFLOWS.md](WORKFLOWS.md) (end-to-end business processes), [API_DOCUMENTATION.md](API_DOCUMENTATION.md) (every endpoint), [DATABASE_DOCUMENTATION.md](DATABASE_DOCUMENTATION.md) (the Sheets/Mongo data model), [CLEANUP_REPORT.md](CLEANUP_REPORT.md) and [TESTING_REPORT.md](TESTING_REPORT.md) (the codebase audit — unused code, test coverage). This README is the entry point; those files hold the depth.

---

## System overview

LMS digitizes the lifecycle of a leased shipping container, from the lease being verified and approved, through its active term, to its eventual return ("off-lease") and the resulting SD-refund/payment close-out. The system of record is a set of Google Sheets the company already used; this app did not replace them — it wraps them with a proper UI, permission model, and a MongoDB read cache so the app isn't bottlenecked by the Sheets API's shared quota.

Three groups of people use it directly:

- **Internal ops/finance staff**, through the main React app — verifying and approving leases, tracking expiries, running containers through the 8-stage Off-Lease pipeline, approving SD refunds.
- **Admins**, through Roles & Access and API Access — who can see what, and which other systems can call in.
- **External systems**, through two separate integration surfaces: a key-gated public REST API (`/api/public/v1/*`), and SSO deep-links from the company's separate Sales CRM ("Sales OS") that let a salesperson act on their own leases without a password.

## Architecture

```
┌─────────────┐        HTTPS (axios, bearer token)        ┌──────────────────┐
│  React app  │ ─────────────────────────────────────────▶│  Express backend  │
│  (Vite)     │◀───────────────────────────────────────────│  (Node, ESM)      │
└─────────────┘                                             └─────────┬────────┘
                                                                       │
                      ┌────────────────────────────────────────────────┼────────────────────────────┐
                      │                                                │                            │
                      ▼                                                ▼                            ▼
            ┌───────────────────┐                         ┌──────────────────────┐      ┌─────────────────────┐
            │  Google Sheets     │  write (authoritative)  │  MongoDB (this app's  │      │  External services   │
            │  (system of record)│ ◀──────────────────────▶│  own cluster)         │      │  Sales CRM (read-only│
            │                     │  read-mirror, 5-min     │  — sessions, outbox,  │      │  cluster), FMS       │
            │                     │  reconcile + instant    │  Sheets mirror,       │      │  workbook, Accounts  │
            │                     │  patch-on-write         │  API keys             │      │  & Collection API    │
            └───────────────────┘                         └──────────────────────┘      └─────────────────────┘
```

**Read/write pattern:** a write goes to Google Sheets first (the authoritative store), then immediately patches the MongoDB mirror; every page read is served from that fast Mongo mirror, never live Sheets. A background job re-reconciles every few minutes to catch anything written outside the app (a direct spreadsheet edit) or any instant-patch that failed. Full detail: [DATABASE_DOCUMENTATION.md](DATABASE_DOCUMENTATION.md) and [WORKFLOWS.md §3](WORKFLOWS.md#3-sheets--mongo-sync).

**Authorization** is entirely data-driven: two Google Sheets ("Team Accounts", "Sidebar Access") are the sole source of who can do what and see what in the sidebar — there is no hardcoded permission list anywhere in the code.

**Three separate auth models** coexist, each scoped to its own surface: a session token for the main app (`/api/auth/login`), an `X-Api-Key` header for the external public API, and a session created by employee code alone (no password) for Sales OS's SSO deep-links.

## Frontend

React 19 + Vite 8, `frontend/src/`. Entry point `app/App.jsx`; routes in `routes/routes.jsx`, one lazy-loaded page per sidebar leaf.

| Area | What's there |
|---|---|
| `pages/` | One folder per feature — Verify Lease, Approve Lease, Lease Expiry, Renew & Document (+ its own Approval Pending), Off-Lease (18 files: dashboard, pipeline, lookup, 8 stage forms, SD-refund approval, efficiency view), Refunds, Roles & Access, API Access, Reports, Deployed Summary, the 4 SSO embeds, and a no-login Refund Review page. |
| `components/ui/` | The design-system primitive set (23 files) — `DataGrid`, `Modal`, `Button`, `StatCard`, `StatusBadge`, a dependency-free `RichTextEditor`, etc. — barrel-exported from `index.js`. |
| `components/layout/` | `AppShell`, `Sidebar`, `TopBar`, `Breadcrumbs`, and `KeepAlivePages` — the component that keeps every visited page mounted (`hidden`, not unmounted) so each page's data fetch runs only once per session. |
| `hooks/` | `useAsync` (fetch-on-mount, used everywhere), `useAutoRefresh` (cross-page refetch via `dataBus.js`, the deliberate counterpart to `KeepAlivePages`' fetch-once model), `usePermission`, `usePolling`, etc. |
| `api/` + `services/` | One thin axios wrapper + one pass-through service per backend domain (13 each). |
| `shared/auth/` | A standalone, independently-maintained auth context/client — not shared with any other app. |

Full per-component/per-page detail: [CODE_DOCUMENTATION.md § Frontend](CODE_DOCUMENTATION.md#frontend). Three user journeys traced click-by-click: [WORKFLOWS.md §5](WORKFLOWS.md#5-frontend-user-journeys).

## Backend

Node ≥18 (ESM), Express 4, `backend/src/`. Entry points `server.js` / `app.js` (route mounting, middleware chain).

| Area | What's there |
|---|---|
| `routes/` + `controllers/` (13 + 14 files) | One pair per domain, thin pass-throughs with no business logic — session-gated via `requireAuth`, action-gated via `requirePermission`. Plus `public.routes.js` (the key-gated external API) and `refundReview.routes.js` (no-login, signed-link refund approval). |
| `services/` (37 files) | Where the actual logic lives. The two largest: `offlease.service.js` (6,712 lines — the entire 8-stage pipeline) and `expiry.service.js` (1,612 lines — Lease Expiry/Renewal). Grouped by domain in [CODE_DOCUMENTATION.md](CODE_DOCUMENTATION.md#backend). |
| `jobs/` | Cron registrations (`ENABLE_CRON`/`ENABLE_SHEETS_SYNC`) — auto-approval, the Sheets↔Mongo reconciliation, the outbox replay worker, daily/monthly report emails. |
| `middlewares/` | Auth, permission gates, a global Sheets-quota circuit breaker, request-source logging. |
| `utils/` + `config/` | Shared helpers (date/string formatting, a dependency-free JWT implementation used only for cross-app handoffs, an in-memory TTL cache) and the sheet-tab/permission-schema/env configuration. |

Full per-function detail: [CODE_DOCUMENTATION.md § Backend](CODE_DOCUMENTATION.md#backend). Every route: [API_DOCUMENTATION.md](API_DOCUMENTATION.md).

## Key modules / workflows

- **Verify Lease → Approve Lease → Lease Expiry → Renew & Document → Renewal Approval** — the full lease lifecycle, including the auto-approval rule for recurring container+client pairs and the band logic (`safe/warning/critical/overdue`) Lease Expiry uses. Traced step-by-step, naming every function involved: [WORKFLOWS.md §1](WORKFLOWS.md#1-lease-lifecycle).
- **Off-Lease — the 8-stage return pipeline** — Intimation → (approval gate) → Transportation → Gate In → Inspection → Final Billing → SD Refunds (its own HOD→Accounts→CEO approval chain) → Payment Status. Every stage's completion rule, bypass condition, and gate: [WORKFLOWS.md §2](WORKFLOWS.md#2-off-lease-8-stage-pipeline).
- **Roles & Access** — the admin-editable permission/sidebar grid that is the sole authorization source app-wide.
- **API Access** — issues scoped, revocable keys for the public API surface; a write-scoped key always "acts as" a real LMS user and can never exceed that person's own permissions.
- **Background sync** — the Sheets↔Mongo write-then-mirror-then-reconcile pattern every page's data freshness depends on: [WORKFLOWS.md §3](WORKFLOWS.md#3-sheets--mongo-sync).

## Dependencies

All verified by direct import-grep against the source tree — nothing here is declared-but-unused (see [CLEANUP_REPORT.md](CLEANUP_REPORT.md)).

**Backend** (`backend/package.json`): `express` 4, `mongodb` driver 6, `googleapis` 144 (Sheets + Drive), `node-cron` 3, `nodemailer` 9, `cors` 2, `dotenv` 16.

**Frontend** (`frontend/package.json`): `react`/`react-dom` 19, `react-router-dom` 6, `axios` 1, `xlsx` 0.18, `jspdf` + `jspdf-autotable` (Excel/PDF export, built client-side). Dev tooling: `vite` 8, `@vitejs/plugin-react`, `oxlint` (linting — no ESLint/Prettier in this project).

No ORM, no database migrations, no test framework is installed beyond Node's built-in `node:test` (used by exactly one file — see [TESTING_REPORT.md](TESTING_REPORT.md)).

## Prerequisites

- Node.js 18 or later (CI and production both run Node 20).
- A MongoDB connection string.
- A Google Cloud service account with Sheets + Drive API access, sharing on the target spreadsheet(s).

## Setup

```bash
npm run install:all   # installs backend/ and frontend/ dependencies
```

Create `backend/.env` with (all required unless noted):

```
GOOGLE_PROJECT_ID=...
GOOGLE_CLIENT_EMAIL=...
GOOGLE_PRIVATE_KEY=...
GOOGLE_SHEET_ID=...
MONGODB_URI=...
MONGO_DB_NAME=...

# Optional
PORT=4000
ENABLE_CRON=true
GOOGLE_DRIVE_FOLDER_ID=...
ACCOUNTS_API_...=...
MAIL_...=...
SALES_CRM_...=...
```

The backend (`backend/src/config/env.js`) exits on startup if any required variable is missing. An optional fallback exists for secrets that can't be edited via `.env` directly: see `backend/src/config/runtimeSecrets.js` (loads from a Mongo `_runtime_config` collection; a real `.env` value always wins).

The frontend reads `VITE_API_URL` (see `frontend/.env.production.example`); it defaults to `http://localhost:4001/api` in local dev.

## Running it

```bash
npm run dev          # backend (node --watch) + frontend (Vite) together, from the repo root
```

Or individually:

```bash
npm run dev --prefix backend
npm run dev --prefix frontend
```

## Building and linting

```bash
npm run build                    # builds the frontend (frontend/dist)
npm run lint --prefix frontend   # oxlint
```

There is no backend test suite today — see [TESTING_REPORT.md](TESTING_REPORT.md). CI's "smoke test" imports every backend module to catch syntax/import errors; it does not execute test cases.

## Deployment

Fully automated — merge to `main` and a VPS cron job picks it up, builds, verifies, and restarts within ~2 minutes. No manual steps, no deploy credentials in CI. Full detail, including rollback: [.github/DEPLOYMENT.md](.github/DEPLOYMENT.md).

## Notable integrations

- **Sales CRM** (a separate MongoDB cluster) — read-only; this app never writes to it. Supplies the live company→salesperson mapping (`salesCrmLeads.service.js`).
- **Sales OS** — the same CRM's front end. SSO deep-links (no password) into Lease Expiry / Renew & Document / Approval Pending, plus a two-way renewal handoff: outbound ("Renew via Sales CRM", a signed link into the CRM's own form) and inbound (a salesperson renews directly from Sales OS, writing through the exact same backend functions a human uses in-app).
- **External FMS Google Workbook** (STAGE-8/9/10 tabs — a different spreadsheet entirely) — mirrored into Mongo and re-synced every few minutes; drives Transportation's auto-completion and the Off-Lease efficiency/SLA metrics.
- **Accounts & Collection API** — a separate internal app; Tally outstanding-balance lookups shown on Off-Lease Stage 1 and in invoices.

## Codebase health (2026-10-12 audit)

- **0 unused dependencies**, **0 unreferenced backend files** out of 91.
- A handful of confirmed-dead frontend functions and two dead routes, all listed with risk classification in [CLEANUP_REPORT.md](CLEANUP_REPORT.md) — nothing has been removed; that file is a reviewable plan, not a change log.
- No automated test suite exists yet — see [TESTING_REPORT.md](TESTING_REPORT.md) for exactly what CI does and doesn't catch, and suggested next steps.
