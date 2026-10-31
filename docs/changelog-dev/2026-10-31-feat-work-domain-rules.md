# Workforce compliance, training and competence rules (Phase 2 slice 4)

Branch `feat/work-domain-rules`. Register rows WORK-002, WORK-003, WORK-005, WORK-008, WORK-009,
WORK-012 (domain rules only).

## What changed

- Spec: [workforce.md](../specs/workforce.md) sections 2 (the domain types and the tables they
  will be stored in), 3 (the permission matrix the API slices use; no new permission), 4 (ten
  rules) and 9 (the test list).
- Domain: `packages/domain/src/workforce/` (exported from the package): the Schedule 3 file per
  role with expiry reminders once each; right to work with follow-up checks and late first
  checks; DBS clearance, supervised-only starts before the certificate and Update Service re-check
  dates; employment history gaps by calendar month; the training matrix with refresh years and the
  Oliver McGowan tiers (tier 2 covers tier 1, never the reverse; England only); observed
  competence that gates an action (never self-signed, observer must hold
  `workforce.competence.observe`); supervision and appraisal schedules; registration and NMC
  revalidation planning; sponsor change reports in working days and both salary floors; and the
  rostering rule, whose override needs a justification and never covers a missing right to work.
  All dates are UK calendar dates; every figure comes from the rate table through
  `resolveWorkforceRates`.
- Rate table: `nmc.revalidation.cycle_years`, `.participatory_cpd_hours`, `.feedback_count`,
  `.reflective_accounts`, `dbs.update_service.check_interval_months` (tenant default) and
  `sponsor.counted_weekly_hours_max`, all marked to verify.
- Human actions H-570 to H-574 (lane B); the register rows' spec, code and test paths.

## Clinical safety and data protection

- No hazard is assigned to slice 4 in the plan. The rules feed HZ-119 (expired competence) and
  HZ-124 (rostered without a required check), which the schema slices add with their tests.
- No personal data is stored or processed by this slice (pure functions); records of processing
  and data standards change with slice 11.

## What is next

- Slice 11 stores the file, training and competence records; slice 17 publishes competence for
  medicines and scheduling (ADR-0085); slice 35 the sponsor records.

## Human actions logged

- H-570 to H-574.

## Tests

- `packages/domain/src/workforce/*.test.ts` (13 files, 135 tests, table-driven; 100% lines and
  96.9% branches of the folder), including UK dates either side of both clock changes and working
  days across a bank holiday.
