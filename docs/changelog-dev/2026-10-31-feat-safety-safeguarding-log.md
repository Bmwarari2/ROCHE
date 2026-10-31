# Safeguarding log: schema and API (SAFE-006, HZ-126)

Branch `feat/safety-safeguarding-log`, stacked on `feat/safety-domain-phase-2` (#137). Phase 2
slice 13, lane D. Migration file 0075 (one self-contained SQL file and journal entry; the lead
renumbers at merge).

## What changed

- **Spec**: [safety.md](../specs/safety.md) "Safeguarding log": the table, scope, clocks, the link
  to the Phase 1 s.42 drafts, the routes and the tests.
- **Schema** (`packages/db/src/schema/safeguarding.ts`, migration 0075): `safeguarding_concern`, a
  mutable, versioned aggregate with forced RLS, the tenant policy and a restrictive scope policy
  that reuses `app.incident_in_scope(location_id, raised_by, ARRAY[person_id])`, so scope works as
  incidents do (ADR-0033). No DELETE grant; not published to devices. CHECKs repeat the step rules:
  a reason and who decided for not referring, the local authority and time for a referral, the
  enquiry's kind, a finding at outcome, Making Safeguarding Personal before closing, and the DBS
  decision before a concern ends where a member of staff was removed for harm. Links to the
  incident, the Phase 1 `safeguarding_s42` draft (one concern per draft) and the pressure-ulcer
  decision guide task. Export catalogue entry added; retention class `serious_incident`. The
  sample data removal list (`app.sample_removal_tables`, migration 0069) is redefined with
  `safeguarding_concern`, so a concern about an invented sample person goes with it (HZ-072).
- **Domain** (`packages/domain/src/safety/safeguarding.ts`, slice 7's file): `safeguardingClock`
  (due, overdue, referred, not referred; overdue never clears by itself) and
  `protectiveMeasuresFor` (open concerns' measures, newest first, and a count of open concerns
  with none). The domain index exports were re-sorted by Biome (they were out of order on the base
  branch).
- **API** (`apps/api/src/routes/safeguarding.ts`): raise a concern (`safety.incident.report`
  reaching the person, MFA, optional client id), list and read the log, record the referral,
  enquiry, finding, Making Safeguarding Personal, DBS decision and protective measures (expected
  version), and move the workflow (`safety.safeguarding.manage`, reaching the person); the
  protective measures for staff caring for the person (`care.plan.read`, never the allegation).
  Audited by opaque ids only. OpenAPI and the typed client regenerated.
- **Clocks in the notification centre** (`apps/api/src/services/safeguarding.ts`): the worker's
  statutory notification queue also runs `escalateSafeguardingReferrals`, which tells the holders
  of `safety.safeguarding.manage` at the location once, urgently, through the escalation chain
  `safety.safeguarding.overdue` (default: the owner role after
  `statutory_notification.escalation_minutes`); referring or deciding not to refer acknowledges
  the alerts; an overdue concern nobody active can manage is audited daily and counted in the
  operator's unrouted signal. `submitHolders` now calls a general `permissionHolders`.
- **Clinical safety**: HZ-126 added to the hazard log (initial Major / Medium / 3; target Major / Low
  / 3 until H-599 is settled, then Very low / 2; an engineering proposal for the CSO, H-595); it joins the Phase 2 safety case
  report. **Medical-device boundary** re-checked: no. The log stores and transmits records,
  applies a tenant-set target clock and checks record-keeping rules; it produces no diagnosis,
  prognosis, risk score or recommendation, and it decides nothing about whether abuse happened.
- **Data protection**: [records-of-processing.md](../compliance/records-of-processing.md) (a
  safeguarding log row under B4, and a note on who reads it, disclosures and alleged
  perpetrators' rights), [data-standards.md](../specs/data-standards.md) (the code lists),
  [retention.md](../specs/retention.md) (`safeguarding_concern` as `serious_incident`).
- **Register**: SAFE-006 `todo` to `partial` with its spec, code and tests; the SAFE and total
  summary counts. The PLAT summary row was already out of step with its rows on the base branch
  (6 and 17 against 3 and 20) and is left for its owner.

## What is next

- Slice 62: the web screens (the log, the concern page, the protective measures on the person's
  record) and the user guide.
- When #137 merges, this branch is retargeted; migration 0075 is renumbered at merge if needed.

## Human actions logged

- H-595: the CSO rates HZ-126 and reviews its controls.
- H-596: the DPO confirms the retention class and how subject access requests from people named in
  a concern are handled.
- H-597: cross-check the finding codes and Making Safeguarding Personal fields against the
  Safeguarding Adults Collection.
- H-598: agree who is told when a referral is overdue.
- H-599: the CSO decides whether a decision not to refer needs a second person, whether "DBS
  referral not required" may be recorded when the s.35 conditions are met (with legal advice), and
  whether protective measures must be on the phone at the point of care.

## Tests

- `packages/db/test/safeguarding-log.test.ts` (20; the whole db suite, 698, passes),
  `packages/domain/src/safety/safeguarding.test.ts` (50), `apps/api/test/safeguarding.test.ts` (25), all passing; also passing:
  `packages/db/test/rls-coverage.test.ts`, `migration-journal.test.ts`,
  `src/export-catalogue.test.ts`, `sample-data.test.ts` (the sample removal list now includes `safeguarding_concern`), and the API's `route-gates`, `incidents`, `jobs`, `exports` and
  `export-worker` suites. `pnpm check:links` passes.

## Review rounds

- Round 1 (clinical-safety and security reviewer agents, before the pull request):
  - Overdue alerts repeat each day while a concern waits, so acknowledging one in the notification
    centre never silences it; they go to the managers of the home where the person lives now.
  - `staff_removed_for_harm` (a boolean defaulting to no) became `staff_harm` with no default
    (`removed`, `would_have_removed`, `not_removed`, `no_staff_involved`), answered before the
    outcome and before the concern ends; the DBS decision follows `removed` and
    `would_have_removed`.
  - Making Safeguarding Personal is recorded before the referral decision, not only at closing.
  - Protective measures never vanish: before a concern ends a manager records whether they were
    carried into the care plan or risk assessment (`measures_outcome`); blank measures count as
    none.
  - Whoever raised a concern cannot decide alone that it is not referred, or close it; the other
    managers at the person's home are told of a decision not to refer.
  - Only an ended concern may be soft-deleted. The description is not changed after raising.
  - Row-level security split by command: reading keeps the incident scope (the raiser reads their
    own concern); writing needs the person in scope, so raising in one's own name never reaches a
    person the caller cannot see. The log's list leaves out a concern the caller raised about
    someone the manage permission does not reach (ADR-0071). A replayed client id is answered only
    after the reach check, and a used id gets one message. Rows are locked only after the reach
    check.
  - Clock-change rows for the referral target (elapsed hours across both changes).
  - Left open: protective measures on the phone, a second person for not referring, and "DBS not
    required" when the s.35 conditions are met (H-599); the unrouted audit has no fixture yet; a
    separate escalation rate key for safeguarding (it reuses
    `statutory_notification.escalation_minutes`).
