# Testing Report

Compiled 2026-10-12 as part of the codebase audit. **No tests were run as part of this audit** — everything below is a report of what testing infrastructure exists, not a pass/fail result, because I did not execute a test suite against this app (there is only one test file, and it is not wired into any runnable script — see below). I am not claiming anything "passed."

## What exists today

- **One test file:** `backend/src/services/offleaseEfficiencyEngine.test.js`, using Node's built-in `node:test` runner. It covers the pure calculation functions in the Off-Lease efficiency engine.
- **It is not run by anything automated.** `backend/package.json` defines only `start` and `dev` — no `test` script exists at all, at the root, in `backend/`, or in `frontend/`. CI (`.github/workflows/ci.yml`) does not invoke `node --test` anywhere.
- **It is parse-checked, not executed, by CI.** CI's "smoke test" (`.github/scripts/smoke-import.mjs`) dynamically imports every `.js` file under `backend/src`, including this one — which would catch a syntax error or bad import in the test file itself, but never runs its actual `test()`/`assert` calls.
- **Two efficiency-engine functions are explicitly undocumented by this test**, per the test file's own header comment — they're instead checked by `backend/scripts/reconcileOffLeaseEfficiency.mjs`, a manual script run against live data, not an automated test.
- **No frontend tests exist at all** — no test runner is installed in `frontend/package.json`, no `*.test.jsx`/`*.spec.jsx` files were found.

## CI's actual safety net (what it does catch)

From `.github/workflows/ci.yml`, run on every push and PR:

1. `npm run lint --prefix frontend` (oxlint).
2. `npm run build --prefix frontend` — a real Vite production build, with the same `VITE_API_URL` production uses.
3. `node .github/scripts/smoke-import.mjs` from `backend/` — imports every backend module with dummy env vars, so a bad import path, a missing export, or a top-level syntax error fails CI. This also carries a case-sensitivity check (the comment ties it to a specific past incident, commit `c88461a`).

This is real and useful — it would catch "the app doesn't start" and "the frontend doesn't build" — but it is not behavioral testing. Nothing verifies that, say, Approve actually marks a lease approved, or that a permission check actually denies the right people.

## To run what does exist

```bash
# The one test file (manual — no npm script wraps this):
node --test backend/src/services/offleaseEfficiencyEngine.test.js

# CI's own checks, locally:
npm run lint --prefix frontend
npm run build --prefix frontend
# smoke-import.mjs needs the dummy env vars CI sets — see ci.yml for the exact list
```

I did not run these as part of this audit pass; this section describes how to, for whoever picks up Phase 5 (per the user's own phased process) of actually exercising them.

## Risk this leaves

Every behavioral guarantee in this app — permission checks, the Sheets↔Mongo reconciliation's full-refresh-vs-upsert logic, the Off-Lease stage-advancement rules, the renewal approval state machine — is currently verified only by manual testing before each deploy and by the auto-deploy pipeline's own health check (`/api/health` after restart) confirming the process comes back up, not that it behaves correctly. A regression in business logic that doesn't throw a syntax error or fail to import will reach production undetected by anything automated.

## Recommended next steps (not acted on in this pass)

1. Add a `test` script to `backend/package.json` that runs `node --test`, and wire it into `ci.yml` as a required check — this alone would start actually executing the one test file that exists today.
2. Pick 2-3 of the highest-risk, most self-contained functions (permission resolution, the Off-Lease stage-advancement logic, the Sheets↔Mongo full-refresh decision) and write unit tests for them first — these are also the functions whose own doc comments cite past live-data-loss incidents, which makes them the best return on a first testing investment.
3. Decide whether frontend testing is worth the setup cost here before adding it — this is a sheet-backed internal ops tool, not a public product; the team should weigh that explicitly rather than default to "add Jest/Vitest" without a specific regression it would have caught.
