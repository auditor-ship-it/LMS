# Review instructions

## What Important means here
This is a live system: merging to `main` deploys to production. Reserve
Important for anything that would break behaviour, lose or corrupt data,
leak data, or block a rollback:
- wrong business logic, especially approvals, limits, amounts, dates and TATs
- writes to Google Sheets or MongoDB that could overwrite or duplicate rows
- missing permission / role checks on a route
- secrets, PINs, PAN/GST/bank numbers or customer contacts in code, logs or responses
- changes to deploy scripts or workflows that remove a safety step
Style, naming and refactors are Nit at most. Report at most five Nits.

## Always check
- Class 3 paths (see CLAUDE.md) changed without a linked, approved SCR → Important
- New or changed routes go through the auth and permission middleware
- Sheet writes keep the existing mutex / write-through pattern
- No test, lint or smoke-check was deleted or weakened

## Do not report
- Anything lint already enforces
- Files under `dist/`, lockfiles, generated `*.generated.js`
