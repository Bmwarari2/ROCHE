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

## Review round 1 (#130)

- H1 (ADR-0071): each listed permission is judged in its own scope (without break-glass). A record
  gets only the permissions whose scope sees it, and managing an incident needs it seen whole. Each
  item returns those permissions, and the page offers steps from them alone. Tests cover a deputy at
  one home with a submission grant at another, and a team leader at one home who is a clinical lead
  at another.
- H2 (HZ-013): statutory notification and candour deadlines now reach the list. The safety module
  writes them onto the workflow (`deadlineOnRecord`, `setWorkflowDeadline`,
  `candourStateDeadline`), the engine keeps them across moves, and one not yet written reads "Deadline
  kept on the record: open it to check" and comes first. HZ-013 is updated.
- M1: the list filters in SQL, then pages until 300 visible records. `truncated` counts visible ones,
  and the empty states say when the list was cut.
- L1: removed records and instances are left out. L3: the page makes one `view=all` call.
- L6, A3: "Incident closed: <incident>" and "Sent back to open: <incident>" show only while the
  incident's status still matches.
- A1: each item is headed "Incident, raised 31/10/2026 12:16" (no names), with its forms at level 4.
  A2: waiting states show a clock and "due", in-progress states a magnifying glass.
- The 320 px title fix no longer hyphenates, so names are not split.
- Logged in `platform.md`, not done: L2 (module-owned visibility resolvers), L4 (reading an incident
  that waits for you is audited as a view) and L5 (step-up asked of holders of notification
  submission alone).

## Review round 2 (#130)

- M1: an incident shows to its raiser anywhere, so visibility alone let a permission act at a
  home where it is not held. Reach is now decided by the record's home (`scopeReachesLocation`).
  This applies on the list, in `managesIncident`, in the incident review and close routes and in
  the notification submit and not-required routes, and each refusal is audited. Tests: a submitter
  at one home who raised a police incident at another under an ended grant, and a manager moving an
  incident they raised elsewhere.
- M2 (HZ-013): a workflow names the states whose deadline is kept on the record. Only those read
  "Deadline kept on the record" when it is missing; candour enquiries open read "No deadline" and
  are not listed first.
- L3: keyset paging with no scan cap, so `truncated` means only that more visible records exist.
  The list carries the incident facts the page needs, so the page no longer reads (and audits as
  viewed) each incident.
- L4: instances are read in the union of the held scopes, so a record behind a stale step-up does
  not drop out.
- L5: `syncCandourDeadline` moved to the safety service, with a test on the candour record and step.
  An idempotent backfill (`pnpm --filter @harbour/api workflow-deadlines:backfill`) is tested and was
  run locally (it filled 10 instances). It needs running once per environment after release; that is
  for whoever releases, not a human action.
- Merged `main` (#114, #127); the feature register keeps both sides of PLAT-011.

## What is next

- Steps for the other workflows are still taken on each record's own page. Approving them in place
  needs each module's form on this page, as was done for incidents.
- The tasks screens (#114) have merged: this page could become a tab beside them.
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
