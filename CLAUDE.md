# Lease Management System (LMS)

Crystal Group's lease app: lease expiry, Renew & Document, and the 11-step
Off-Lease track (Intimation → Transportation → Gate-In → Inspection → Final
Billing → SD Refund with HOD / Accounts / CEO approvals → Payment Status).
Live at lease.crystalgrp.xyz.

## Stack
- `backend/` — Node 20, Express, MongoDB (primary record) + Google Sheets
  mirror via `googleapis`, `node-cron` jobs, outbox worker, nodemailer.
- `frontend/` — React 19 + Vite, linted with oxlint.

## Run & check
- `npm run install:all` then `npm run dev` (backend + frontend together)
- Before every PR, run what CI runs (`.github/workflows/ci.yml`):
  `npm run lint --prefix frontend` · `npm run build --prefix frontend` ·
  `cd backend && node ../.github/scripts/smoke-import.mjs` (dummy env vars as in CI)
- There is no backend test suite yet. Bug fixes must add a test or a
  reproducible script under `backend/scripts/` before the fix.

## LIVE SYSTEM — hard rules
- **Merging to `main` deploys to production within ~2 minutes** (the VPS pulls;
  see `.github/DEPLOYMENT.md`). Never push to `main`; always open a PR.
- Never connect to production MongoDB, Sheets, Drive or mail. Never run
  scripts in `backend/scripts/` against production.
- Never commit `.env*`, service-account JSON, PINs, or customer data exports.
- No releases in the month-end freeze (last working day → 5th of the month).

## Class 3 paths — human-led, process-owner sign-off required
Agents may analyse and write tests here, but must not change behaviour
without an approved SCR (issue labelled `type:scr`, not `needs-owner-approval`):
- Approvals & refunds: `backend/src/controllers/approve.controller.js`,
  `refunds.controller.js`, `backend/src/services/refunds.service.js`,
  `backend/src/routes/approve.routes.js`, `refunds.routes.js`, `refundReview.routes.js`
  (SD refund chain HOD → Accounts → CEO; CEO only above ₹1,00,000)
- Auth & permissions: `auth.*`, `sso.*`, `apiKeys.*`, `roles.*`,
  `backend/src/middlewares/auth.middleware.js`, `permission.middleware.js`,
  `publicApiAuth.middleware.js`, `backend/src/config/permissions.config.js`,
  `runtimeSecrets.js`
- Sheet / cross-system writers: `backend/src/config/mongoSheetMapping.js`,
  `backend/src/jobs/` (outbox, sheetsReconcile), `accountsApi.service.js`,
  `salesOsRenewal.*`, `salesCrmLeads.service.js`
- Deploy & CI: `.github/scripts/`, `.github/workflows/`

## Conventions
- Small PRs, one ticket each. Title starts with the ticket key, e.g. `LSE-42: …`.
- Keep the Mongo-primary / Sheet-mirror pattern; never write to Sheets directly
  from a controller.
- Business terms: OL = off-lease, SD = security deposit, FMS Stage 8/9/10 =
  transport movement, HOD = Pushpalata Shetty's approval stage.
