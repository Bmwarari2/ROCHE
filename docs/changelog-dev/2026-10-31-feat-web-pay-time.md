# Web screens for time, working time, absence and pay

Branch `feat/web-pay-time` (Phase 2 slice 60; SCHED-003 to 007, SCHED-010), on the slice 30, 36
and 40 APIs.

## What changed

- **My time** (`/my-time`): shifts from yesterday (for a night shift) to tomorrow with clock in, start and end a break and
  clock out, and the last 14 days of one's own timesheet; a corrected entry is struck through and
  also says "Corrected".
- **Timesheets** (`/timesheets`): a home's entries for the last 14 days, drafts first, each with
  the worker's name, worked time, pairing problems in words and an approve button for rota
  approvers (the API refuses one's own). Approving runs the working time check as advice.
- **Working time** (`/timesheets/working-time/{member}`): the member's stored results with each finding's rule,
  citation, "Breach" or "Depends on a condition" and the minutes against the limit, under a card
  saying the results are advice, never a block.
- **Absences** (`/absences`): ask for leave; approvers approve, or decline with a reason; an
  absence that leaves rota shifts open says "N shifts need cover" with an icon (HZ-123).
- **Pay** (`/pay`, `/pay/{id}`, `/pay/rule-sets`): pay runs with their state, start a run,
  calculate, override exceptions with a reason, lock and start a correction; draft and approve
  rule sets (the tenant's own rates only); **my pay** (`/my-pay`) shows one's lines from locked runs
  with the working. Step-up and multi-factor refusals send the person to confirm it is them.
- API: `workerName` on timesheet entries, `memberName` on working time results and on pay run lines and exceptions, so the
  screens show names, not ids.
- Navigation entries, `payTime.*` strings (Welsh marked untranslated), unit tests for the gates,
  chips and form readers, and Playwright journeys with axe in both themes.

## Reviews

- Security review: no high findings. Names on pay runs are read under the caller's own rights
  (no system-rights elevation), the override response carries the name too, server actions build
  each API body from checked, named fields, pay permissions held for some homes only are refused
  in words, a missing second sign-in step links to setting one up, and redirects check the id.
  The name fields are in records-of-processing and data-standards.
- Accessibility review: a form the refresh removes announces its result and moves focus to the
  page heading; locking a pay run and starting a correction ask first; the working time page and
  its links name the member; durations read in whole words, money differences say "more" or
  "less", working lines read "step: amount"; date hints; button names say what they act on;
  one's own timesheet entry says someone else approves it. Open points are in H-1188.

## Human actions

H-1180 to H-1189 in `docs/plans/human-actions.md`.
