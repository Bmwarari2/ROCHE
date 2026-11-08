# Retention sweep rules (retention sweeps plan, slice 1)

Branch `feat/platform-retention-rules`, from `main` at `ea6fc04d`.

## What changed

- **Domain rules** in `packages/domain/src/platform/retention-sweep.ts`, exported from the package
  index: `resolveRule`, `triggerDate`, `dueDate`, `longestWins`, `holdCovers` and `sweepDecision`.
  Pure functions with no database, no I/O and no clock reads; `now` is passed in. They build on
  `retentionDecision`, `addPeriod`, `validateTenantOverride`, `isUnderLegalHold` and
  `staffFileRetainUntil`, which are unchanged; existing types gain nothing that alters behaviour.
- **Semantics** follow section 5.2 of the retention sweeps plan on #193 (`docs/retention-sweeps-spec`)
  and its provisional answers, pending DPO review at the testing phase: the organisation's
  `staff_file_option` picks the staff file row (H-1583); trigger dates with no column are inputs
  (H-1584); a `tenant_policy` class, an unknown class and an unreadable row are never destroyed
  (H-1585); an open DSAR case, complaint, safeguarding enquiry or employee relations case about the
  subject holds the record (H-1586). Holds may name a member of staff, an applicant, a record
  class, a location and a date range, ahead of the `legal_hold` columns in slice 12.
- **Tests**: `retention-sweep.test.ts`, table-driven, one case per class row of the revised
  retention.md (48 rows: period, unit and trigger, with the day before and the day of the due date),
  leap-day and month-end cases, overrides, open records, people in care, staff still employed, the
  75th birthday before and after leaving, every hold scope, released holds, each open case kind,
  longest wins (a controlled drug administration as `controlled_drugs_register` and `mar_chart`)
  and each `sweepDecision` outcome. The new file is at 100% coverage.
- **No record changes.** Nothing calls these functions yet: no migration, route, job or data change.

## Choices where the plan was open

- `staff_file` with no option chosen resolves to `staff_file.to_75th_birthday`, the schedule's
  default option.
- An organisation's row shorter than the schedule's is ignored (overrides only lengthen).
- `triggerDate` gives the leaving date for a staff file; `dueDate` turns it into the keep-until
  date through `staffFileRetainUntil`, and a staff file kept to the birthday with no date of birth
  has no due date (H-874).
- A class counted from a period end with no period end known has no trigger yet, and counts from
  the later of the period end and the creation date.
- A hold names who (person, member of staff, applicant or record: any matches) and may narrow by
  class, location and date range (all named must match). A record with no location or date stays
  under a hold that names one. A hold on `staff_file` covers its two rows.

## What is next

- Slice 2: the retention registry, part 1 (`feat/platform-retention-registry`).
