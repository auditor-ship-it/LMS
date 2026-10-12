# API Documentation

Every endpoint below was read directly from `backend/src/routes/*.js` on 2026-10-12 — this is the actual route table, not a description reconstructed from memory. For exact request/response bodies, see each route's controller in `backend/src/controllers/`.

## Auth model

- **Session routes** (everything under `/api/auth`, `/api/roles`, `/api/uploads`, `/api/verify`, `/api/approve`, `/api/expiry`, `/api/offlease`, `/api/tasks`, `/api/dashboard`, `/api/api-keys`, `/api/refunds`): a Bearer session token, obtained from `POST /api/auth/login`. Each of those routers applies `router.use(requireAuth)` — no route in them is reachable without a valid session, except the handful of `/api/auth/*` routes listed as public below.
- Individual write actions are additionally gated by `requirePermission('<key>')` — the permission keys come from the live Roles & Access sheet (`backend/src/config/permissions.config.js`), not hardcoded.
- **Public API** (`/api/public/v1/*`): no session — gated by an `X-Api-Key` header instead (`requirePublicApiKey`), issued/revoked via the API Access admin screen. Used by other internal apps (Sales OS, Accounts & Collection) to read/write this app's data without a login.
- **SSO** (`/api/sso/*`): session-less deep-link entry points for Sales OS — a session is created by employee code alone (no password), then the normal session model applies to the follow-up calls.
- **No-login, token-authorized**: `/api/refund-review/*` — a single signed link (JWT, `utils/jwtLite.js`) authorizes exactly one row + stage for an HOD/CEO/Accounts refund decision, no session at all.

## `/api/auth`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/login` | public | employee login |
| POST | `/otp/request` | public | request a password-reset OTP |
| POST | `/otp/reset` | public | reset password via OTP |
| POST | `/logout` | session | end session |
| POST | `/heartbeat` | session | keep-alive |
| GET | `/me` | session | current user |
| GET | `/access-bundle` | session | permissions + sidebar visibility in one call |
| GET | `/permissions` | session | action permissions only |
| GET | `/sidebar-visibility` | session | sidebar visibility only |
| GET | `/login-activity` | session | login history |
| POST | `/admin/add-user` | session | create a user |

## `/api/verify` — Verify Lease

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/` | session | pending verifications |
| POST | `/:containerNo/action` | `verify` | approve/reject a row |
| POST | `/:containerNo/follow-up` | `verify` | log a follow-up |
| POST | `/document` | `verify` | save document fields |
| POST | `/document/upload` | `verify` | upload a document |
| PUT | `/:containerNo/edit` | `verify` | edit lease fields |
| PUT | `/lease-period` | `expiry` | update the lease period |
| POST | `/renew-with-agreement` | `expiry` | renew with a new agreement |

## `/api/approve` — Approve Lease

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/` | session | the lease register |
| GET | `/history` | session | approval history |
| POST | `/auto-run` | session | run the auto-approval cron logic on demand |
| POST | `/auto-revert` | session | revert an auto-approval run |
| POST | `/action` | `approve` | approve/reject, latest row |
| POST | `/:containerNo/action` | `approve` | approve/reject, specific row |

## `/api/expiry` — Lease Expiry + Renew & Document

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/` | session | lease-expiry list |
| GET | `/renewal-log` | session | Renewal Log export data |
| GET | `/new-lease-report` | session | New Lease report data |
| POST | `/sale-person/refresh` | session | refresh the live Sales CRM salesperson mapping |
| POST | `/documents/upload` | `document` | upload an agreement/PO document |
| POST | `/documents/complete` | `document` | complete the document stage |
| POST | `/action` | `expiry` | Renew / Off-Lease action (async, backend-queued) |
| POST | `/action-sync` | `expiry` | same, synchronous (waits for the Sheets write) |
| POST | `/renewal/send-back-to-pending` | `expiry` | return a container to Lease Expiry's pending list |
| POST | `/remark` | `expiry` | save a remark |
| POST | `/renewal/complete-document-stage` | `renew` | **Submit** on Update Agreement |
| POST | `/renewal/save-document-draft` | `renew` | **Save** (draft) on Update Agreement |
| POST | `/renewal/decide-approval` | session (permission checked inside) | Pushpa's Approve/Send Back decision |
| GET | `/renewal-companies/containers` | session | containers for a company, for the Sales CRM handoff picker |
| POST | `/renewal-link` | `renew` | mint a "Renew via Sales CRM" handoff link |
| GET | `/renewal/:containerNo/remarks` | session | renewal remark thread — **unused by the frontend**, see CLEANUP_REPORT.md |
| POST | `/renewal/:containerNo/remarks` | session | add a renewal remark — **unused** |
| PUT | `/renewal/remarks/:remarkId` | session | edit — **unused** |
| DELETE | `/renewal/remarks/:remarkId` | session | delete — **unused** |

## `/api/offlease` — the 8-stage pipeline (largest surface, ~45 routes)

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | stage data, `?stage=1..8,11` |
| GET | `/next-lease-id` | next lease ID suggestion |
| GET | `/stage-counts` | pending count per stage (sidebar/tab badges) |
| GET | `/stage2/containers`, `/stage2/container/:containerNo` | Stage 9's container-picker data source |
| GET / POST | `/stage9/movements` | movement log read/write |
| GET / POST / PUT / DELETE | `/:containerNo/remarks` (+`/:remarkId`) | the dashboard comment thread |
| GET / POST | `/:containerNo/stage/:stage` | read/save one stage's form |
| GET | `/:containerNo/enrichment` | card enrichment (fast lookups) |
| GET | `/:containerNo/agreement-po-pdf` | Agreement/PO PDF links |
| GET | `/:containerNo/sd-refunds` | this container's refund entries |
| POST | `/:containerNo/move-to-stage` (+`/client-to-client-pending`) | manual stage jump |
| POST | `/:containerNo/send-back` | Stage 2 send-back |
| GET | `/:containerNo/move-history` | move/send-back audit trail |
| POST | `/:containerNo/hold` (+`/send-back`) | Stage 1 hold |
| POST | `/:containerNo/voucher-raised` | Stage 7 (Payment Status) action |
| POST | `/:containerNo/reject/send-back` | **unused by the frontend**, see CLEANUP_REPORT.md |
| GET / POST | `/approval`, `/:containerNo/approval` (+`/send-back`, `/client-to-client`) | Stage 1A intimation approval |
| POST | `/:containerNo/billing/send-back` | Stage 5 send-back |
| GET | `/dashboard`, `/efficiency` | the pipeline dashboard + SLA/efficiency view |
| GET | `/:containerNo/detail`, `/:containerNo/outstanding` | full record lookup, Tally outstanding |
| POST | `/tracking` | add a container to the pipeline |
| POST/GET `/admin/*` (9 routes) | header-row repair, FMS auto-create, column/header fixes, order-number tracing/debugging — maintenance tools, not day-to-day UI |

## `/api/roles` — Roles & Access

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | the full grid |
| POST | `/permission` | toggle one permission cell |
| POST | `/sidebar` | toggle one sidebar-visibility cell |
| POST | `/accounts` | add an account |
| DELETE | `/accounts` | remove an account |

## `/api/refunds` + `/api/refund-review`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/refunds` | session | list |
| POST | `/refunds` | `refunds` permission | submit a refund |
| POST | `/refunds/decide-approval` | session (permission checked inside) | HOD/CEO/Accounts decision |
| GET | `/refund-review` | signed link token | one row+stage, no login |
| POST | `/refund-review/decide` | signed link token | decide via that link |

## `/api/api-keys`, `/api/tasks`, `/api/dashboard`, `/api/uploads`

| Method | Path | Purpose |
|---|---|---|
| GET/POST/DELETE | `/api-keys` (+`/:id`) | API key admin CRUD |
| GET | `/tasks/mine`, `/tasks/employee/:employeeCode` | My Task counts |
| GET | `/dashboard/deployed-summary`, `/deployed-detail` | Deployed Summary data |
| POST | `/uploads` | generic base64 → Google Drive upload |

## `/api/sso` — Sales OS deep links

| Method | Path | Purpose |
|---|---|---|
| POST | `/sales-os/session` | start a Sales OS lead-context session |
| POST | `/lease-expiry/session`, `/renew-document/session`, `/approval-pending/session` | start a plain employee-code session for each embed |
| POST | `/sales-os/confirm-company` | confirm which company a renewal is for |
| POST | `/sales-os/renewal`, `/sales-os/renewal-draft` | Submit / Save from the Sales OS embed |

## `/api/public/v1` — external key-gated API

Each scope below maps to a separate API key (`requirePublicApiKey('<scope>')`), issued independently via API Access.

| Scope | Routes |
|---|---|
| `leases` | GET verify/approve/approve-history/expiry; POST verify-action/approve-action/expiry-action (write) |
| `offlease` | GET dashboard/stage/approval/detail/efficiency; POST stage/approval (write) |
| `accounts` | GET `/accounts/:containerNo/outstanding` |
| `offleaseefficiency` | GET `/offlease/efficiency` |
| `salesos` | GET renewals/company-match/renewal-stats/renewal-log/renewal-pipeline |
| `refunds` | GET `/refunds` |
| `renewdocument` | GET renew-document, renew-document/approval-pending |
| `deployedsummary` | GET deployed-summary, deployed-summary/detail |
| `reports` | GET reports/renewal-log, reports/new-lease |
