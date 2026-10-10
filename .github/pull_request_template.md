## What & why
<!-- One or two lines. Link the ticket: Closes #___ · Jira: ___-___ -->

## Risk class
- [ ] C0 — docs / help text only
- [ ] C1 — cosmetic UI (labels, filters, read-only columns)
- [ ] C2 — logic in a non-money module
- [ ] C3 — money, approvals, limits, Tally, refunds, permissions, sheet writers (**human-led, process-owner sign-off**)
- [ ] C4 — production data or schema (**script + dry run only; a named person runs it after backup**)

## Checks
- [ ] A failing test / reproduction existed before the fix (bugs)
- [ ] CI is green
- [ ] Tested against staging or masked data — never production
- [ ] Not inside a freeze window (month-end close: last working day → 5th)
- [ ] Rollback: revert this PR (merge to `main` auto-deploys)

## Business owner sign-off (C3 only)
<!-- Name of the process owner who approved the SCR -->
