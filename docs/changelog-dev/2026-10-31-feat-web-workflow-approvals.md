# Approvals across modules (PLAT-011)

Branch `feat/web-workflow-approvals`.

## What changed

- Domain:
  - `workflowSlaState` reads a deadline as overdue, due today (the same UK calendar day), on track
    or none.
  - `workflowActorView` lists the steps open to the reader and marks the approval step, the one the
    record's creator may not take. It also says when the reader raised the record, so someone else
    must approve it.
  - `workflowPermissions` gives every permission a workflow's steps need.
  - `LISTED_WORKFLOWS` is the list the screen shows: incident, candour, statutory notification,
    DoLS legal-change review, outage, discharge, transfer and death. The person lifecycle is not
    listed, because it is a record's status rather than work waiting for someone.
- API: `GET /v1/workflows` (`view=approvals` by default, or `all`) lists open workflow records in
  scope, soonest deadline first.
  - Each item gives its state, deadline state, who started it and the reader's steps.
  - An instance about nobody is listed only when its record is visible under row-level security,
    and an unknown subject type never is.
  - It needs any listed step's permission, with MFA as for care records. It is audited by view and
    count only, holds at most 300 records, and is additive (no migration).
- Web: `/approvals`, with "Approvals" in the side bar for the same readers.
  - Records are grouped as waiting for your approval, raised by you and waiting for someone else
    (said in words), and other open work.
  - Each shows its state and deadline as an icon and words, who raised it and since when, and links
    to its own page.
  - An incident waiting for you can be closed or sent back to open here, using the incident page's
    own forms, rules and server actions. Anything still to do first links to the incident.
  - Strings are in en-GB; Welsh is copied and listed as untranslated.
- Fix: a long word in a page title ("Environmental incident") now wraps at 320 px instead of
  scrolling sideways (WCAG 1.4.10). `incidents.spec.ts` showed it once the newest incident was an
  environmental one.
- Docs: `platform.md` (task and workflow engine), a HZ-091 control and verification row, and the
  feature register row.

## What is next

- Steps for the other workflows are still taken on each record's own page. Approving them in place
  needs each module's form on this page, as was done for incidents.
- When the tasks screens (#114) merge, this page could become a tab beside them.
- The user guide for the approvals page is still to write (section 19, definition of done).

## Human actions logged

- None.

## Tests

- `packages/domain/src/platform/workflow.test.ts` (new tables: deadline states including the UK day
  in summer time, the reader's steps, permissions) and `workflow-registry.test.ts` (3).
- `apps/api/test/workflows.test.ts` (10): approval and raised-by-you, the deadline state, `view=all`,
  finished records dropped, a care worker refused, MFA asked first, another home and another
  organisation never listed, and the audit entry. `route-gates` still passes.
- `apps/web/src/lib/approvals.test.ts` (31). Web unit tests: 1014 of 1014.
- `apps/web/e2e/approvals.spec.ts` (3, axe in the light and dark themes). `incident-review`,
  `incidents`, `smoke` and `statutory-notifications` pass (18).
