# The weekly break-glass report screen (PLAT-006)

Branch `feat/web-break-glass-report`.

## What changed

- Web: `/break-glass/weekly-report` and "Break-glass report" in the side bar for
  `platform.audit.read` (anyone else is told they do not have access). One UK week at a time
  (Monday to Sunday, the last complete week by default, previous and next week), each location's
  report in the reader's access with its totals in words, "Reviewed" or "To review" and
  "n things flagged" as icons and words, and a plain-English empty state.
  `/break-glass/weekly-report/{reportId}?week=` shows one report: totals, the flags as sentences
  naming who and whom, records opened by member of staff, by person and by reason chosen, the
  break-glass searches, and the review. People are named from the reader's own list, with their
  communication needs (AIS), others numbered; the typed reasons stay in the audit log and the page says so. The review form
  ("Actions taken", 3 to 2,000 characters) is offered once and never to someone the report flags;
  refusals are said in the page's words. A partly unreadable summary warns (HZ-011). The alert's
  link (`/break-glass/weekly-report`) now opens the page. Strings in en-GB; Welsh copied and listed
  as untranslated.
- API (additive): each weekly report carries `staff`, the `StaffName` of every member it counts and
  of its reviewer, because the quality lead and group executive cannot list members
  (`/v1/members` needs `platform.user.manage`, and a location role lists only its own staff).
  OpenAPI and the typed client regenerated.
- API script: `pnpm --filter @harbour/api break-glass-report:run [--this-week]` runs the report job
  once for local journeys (`--this-week` reports the week in progress).
- Docs: platform.md (the screen), data-standards.md (`staff` on the report), the hazard log
  (HZ-011 control and tests), the local development runbook.

## Register evidence (PLAT-006, for the lead to merge)

- Code: `apps/web/src/app/(shell)/break-glass/weekly-report/page.tsx`,
  `apps/web/src/app/(shell)/break-glass/weekly-report/[reportId]/page.tsx`,
  `apps/web/src/lib/break-glass-report.ts`, `apps/web/src/app/actions/break-glass-report.ts`,
  `apps/web/src/components/platform/BreakGlassReview.tsx`,
  `apps/web/src/components/platform/CountTable.tsx`, `apps/api/scripts/run-break-glass-report.ts`.
- Tests: `apps/web/src/lib/break-glass-report.test.ts`, `apps/web/e2e/break-glass-report.spec.ts`.
- Status: the screen is built; the row stays partial for the open items below.

## What is next

- Each opening's time and typed reason are not on the screen: the report stores counts and ids,
  `break_glass_event` is readable only at tenant scope or by its opener (row-level security), and
  `GET /v1/audit` withholds reasons from readers holding `platform.audit.read` at some locations
  only (S-M3). Showing them to a location's Registered Manager needs a decision (a report-scoped
  read in the system's view, or audit events that carry their location) and a security review.
- Nothing reviews a single opening (`break_glass_event.reviewed_at` is never set), so the
  per-opening "not yet reviewed" count is not shown; the report-level review is.
- The review needs no step-up (the API asks none); a decision for the DPO with H-80 if it should.
- `--this-week` stores the week in progress early in the local database, so the worker leaves that
  week as first built (local only).

## Human actions logged

- None.

## Tests

- `apps/web/src/lib/break-glass-report.test.ts` (25); `apps/api/test/people-lifecycle.test.ts`
  `PLAT-006` (6, staff named); `apps/web/e2e/break-glass-report.spec.ts` (2, axe in light and dark
  on every state; run twice to cover the review form and the reviewed report). The journey opens a
  Sam Twin record, not Una Example's, so `break-glass.spec.ts` (which runs after it) still finds
  Una's record closed to the manager; both pass run one after the other.
