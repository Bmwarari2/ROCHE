# Absence and leave (SCHED-010, slice 40)

Branch `feat/sched-absence-leave`, cut from `feat/sched-rota-builder`.

## What changed

- Spec: [scheduling.md](../specs/scheduling.md) section 15 (schema, rules 1 to 8, permissions,
  API, test list). Rates `ssp.piw_min_days`, `ssp.piw_link_weeks`, `ssp.self_certification_days`
  (to verify, H-972); retention class `sickness_absence` (H-973).
- Domain `packages/domain/src/scheduling/absence.ts`: kinds and states, who may decide (never the
  member), the days of an absence, a fit note needed after the self-certification days, periods of
  incapacity linked within the link weeks, qualifying days, which assignments need cover, whether a
  member is away on a shift, the Bradford factor's days. Table-driven tests.
- Migration 0107: `absence`, `fit_note`, `return_to_work`, `shift_cover_need` with forced RLS. A
  member reads and asks for their own; rota managers and approvers read those at their home; a
  decision only by an approver there, never the member (check and guard); fit notes and return to
  work only for holders of `workforce.hr_document.read` (and the member reads their own records);
  cover needs raised for the absent member's own assignment only, resolved once. The HR-only
  document policy now also takes a fit note on someone else's sickness.
- API `/v1/absences`: ask, record, decide, cancel, end, Bradford exclusion; fit note upload (an
  HR-only document, retention `sickness_absence`, never the condition) and audited open; return to
  work once; `/v1/members/{id}/bradford` with its working and a notice; `/v1/absences/{id}/ssp`
  with the period of incapacity and the slice 6 rule, nothing stored and the earnings never
  audited. Approving or recording raises cover needs (outbox `scheduling.cover_needed`).
- Rota: an assignment whose member is away reads `coverNeeded`; the check counts it as open with
  a warning and lists `coverNeededAssignmentIds`; assigning onto an absence is refused
  (`member_absent`); taking someone off resolves the cover need.
- Records of processing (absence and leave, special category), data standards, retention, hazard
  log HZ-123 and HZ-124, feature register.

## Found, not fixed here

- The rota screens (slice 59, another branch) do not yet show cover needs (H-978); statutory
  family pay on absences (H-979); the absence screens.

## Human actions logged

- H-970 to H-979.

## Review

- Clinical safety: cover needs are raised at any home through `app.raise_cover_need` (definer,
  checked), a published shift that loses its worker is marked changed since publication, every UK
  date a long shift touches counts, a sickness ended early resolves needs from UK midnight after its
  last day, tests carry the hazard ids and cover another home and a published rota. A consumer of
  `scheduling.cover_needed` raises a task for the home's rota managers, due the rate table's lead
  time before the shift, tells them at once and closes when cover is resolved. Not built: the daily
  re-check (H-839).
- Security: fit note uploads are capped like other uploads; HR-only fields are decided per home;
  the Bradford exclusion needs HR rights at the home and never one's own (API and database); a
  decision's reason is fixed; absence versions only with HR rights; a fit note's document is never
  readable by its member through HR rights (`app.absence_member`); the Bradford factor needs the
  member to work now at a home the holder reaches; the SSP working takes the earnings in the body.

## Tests

- Domain 5458 (absence.ts 98.7% lines), database 784, API 1471, contracts 34, web 1437; lint and
  typecheck clean.
