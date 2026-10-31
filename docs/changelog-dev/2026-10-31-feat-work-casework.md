# Employee relations casework (WORK-010, plan slice 39)

Branch `feat/work-casework`, stacked on `feat/work-applicant-tracking` (slice 23).

## What changed

- Spec: [workforce.md](../specs/workforce.md) section 2c (four tables), section 3 (the casework
  silo and who does what on a case), rules 14 to 18, the routes in section 5, data protection in
  section 8, the tests in section 9 and the known gaps in section 11. ADR-0089 (restricted silos)
  is brought across unchanged from `feat/safety-speak-up`.
- Domain (`packages/domain/src/workforce/casework.ts`): grievance, disciplinary, capability,
  sickness absence and probation cases following the Acas Code: how a case moves (investigation,
  hearing, outcome, appeal, closed; no decision without a hearing unless the employee repeatedly
  did not attend; warnings carry the date they stop counting; the right of appeal), who may take
  which part (never the subject, investigator, hearing chair and appeal chair different people
  unless the exception is recorded, the last case manager stays), the hearing invitation steps
  (the issue in writing, the evidence, the right to be accompanied), suspension as a reviewed
  precaution, the DBS barring and regulator referral decisions due before closing, and the
  timeline with days at each stage and no target.
- `workforce.casework.manage` is now a silo permission (`SILO_PERMISSIONS`, MFA): the owner,
  Registered Manager, deputy manager and HR roles no longer carry it; the new built-in role
  `employee_relations_lead` carries it alone.
- Schema and migration 0101 (one self-contained file): `employee_case`, `employee_case_member`,
  `employee_case_hearing` and `employee_case_event` (append-only), with forced row-level security
  that opens a case only to the members named on it (`app.casework_member`, a definer function).
  Guards keep the case's rules in the database, and keep the silo permission in a role of its own,
  never in a grant, never self-appointed, never held with user or role management. The migration
  removes the permission from existing roles that carry anything else. No `capture_version` on
  the silo tables.
- API (`apps/api/src/routes/casework.ts`): list, open, read, members, moves, hearings, suspension,
  referral decisions, the safeguarding link and notes. MFA on every route; a case the caller is
  not named on is not found; refusals audited; audit events carry the case id and codes only.
- Export catalogue (the four tables left out of the organisation-wide export, H-805), retention
  rows, records of processing (the casework categories row and purpose B3), data standards,
  feature register (WORK-010 partial), the permission matrix.

## What is next

- Screens (slice 58); a declared-conflict check when naming members; refusing portal-only
  accounts as members; an audit view that hides casework events from those not named.
- Folding the casework guards and the speak-up guards (migration 0086) into one
  `app.silo_permissions()` once both are merged.

## Human actions logged

- H-800 to H-809 (lawful bases and the appropriate policy document, the Acas Code mapping, the
  referral triggers, telling organisations about the role change, the support route for an
  orphaned case, export and DSAR, retention, the privacy notice, warning and notice guidance, the
  Registered Manager's duties).

## Tests

- `packages/domain/src/workforce/casework.test.ts` (table-driven), `packages/db/test/casework.test.ts`
  (22), `apps/api/test/casework.test.ts` (14); RLS coverage (silo tables unversioned, the
  timeline append-only), definer ACLs, seed (22 built-in roles), export catalogue re-run.
