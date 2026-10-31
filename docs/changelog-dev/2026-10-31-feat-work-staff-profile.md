# Staff profile and pre-employment file (Phase 2 slice 11)

Branch `feat/work-staff-profile`, stacked on `feat/work-domain-rules` (#131). Register rows
WORK-002 and WORK-011 (schema and API; screens come with slice 56).

## What changed

- Spec: [workforce.md](../specs/workforce.md) section 2a (the two tables and what each Schedule 3
  item keeps), section 3 (four new permissions so HR data has its own), section 5 (nine routes,
  audit actions and the expiry reminders), section 8 (the Article 9 and 10 conditions with DPA 2018
  Schedule 1) and section 9 (the tests).
- Domain: `staffFileState` and `complianceItemView` (`packages/domain/src/workforce/staff-file.ts`)
  work out each item on the UK date asked about from its details, who verified it and when, using
  the slice 4 rules; an item verified by the worker themselves or on a later date is never
  satisfied. Expiry reminders count down to an expiry or a DBS Update Service re-check, once each.
- Permissions: `workforce.staff_file.read`, `workforce.staff_file.manage`,
  `workforce.hr_document.read` (owner and HR only by default) and
  `workforce.dbs_risk_assessment.sign` (owner and Registered Manager); the generated matrix
  updated.
- Database: migration 0073 (`staff_profile`, `compliance_item`) with forced row-level security.
  `app.holds_staff_permission` counts a role of any scope, since staff files are employment
  records, not care records (HR's role has none). Read by holders of read or manage and by the
  worker for their own file; written by holders of manage, never on their own file; each
  verification and signature in the caller's own name (guard trigger); nothing deleted; earlier
  versions kept. The `document_hr_only` policy hides HR-only documents (`staff_hr_document`) from
  everyone without `workforce.hr_document.read`, whatever their document permissions. Main stops at
  0070 until #123 merges, so the lead may renumber at merge.
- API: `/v1/workforce/staff-files` (list, create, read, change), recording each check
  (`PUT .../items/{kind}` with `expectedVersion`), signing the DBS risk assessment, adding and
  opening HR-only documents (every open audited as `workforce.hr_document.viewed`; no DBS
  certificate copies; right to work copies kept as `right_to_work_copy`), and
  `/v1/me/staff-file`. The general document routes refuse and never serve HR-only documents, and
  search never finds them. OpenAPI and the client regenerated.
- Expiry tasks: the `staff-file-expiry-reminders` job (hourly) raises a generic task for HR through
  the task engine at each document-expiry reminder day, once each; recording the check again with a
  new date cancels its open reminder.
- Data protection: records of processing (a new staff file row and B3's conditions), data
  standards (the code lists), retention (the DBS certificate gap settled as a spec decision for the
  DPO to confirm; HR-only documents and reminder tasks), the export catalogue.

## What is next

- Slice 56: the staff file screens. Slice 17: training, competence and the rostering port that
  reads this file.
- The reminder task is assigned to the `hr` role; an organisation without an HR role holder sees
  it through tenant-wide roles only (see the open question to the lead).

## Human actions logged

- H-575 (what of a DBS check is kept), H-576 (appropriate policy document), H-577 (default holders
  of the new permissions), H-578 (staff privacy notice), H-579 (right to work record against the
  Home Office guide).

## Tests

- `packages/domain/src/workforce/staff-file.test.ts`: 41 table-driven tests.
- `packages/db/test/staff-file.test.ts`: 17 tests (isolation, policies, guards, HR-only documents).
- `apps/api/test/staff-files.test.ts`: 12 tests through the API, including the reminder job.
