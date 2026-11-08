# Retention registry (retention sweeps plan, slices 2 and 3)

Branch `feat/platform-retention-registry`: #193 (the plan and slice 0) merged with slice 1
(`feat/platform-retention-rules`).

## What changed

- **The registry** in `packages/domain/src/platform/retention-registry/`, one file per bounded
  context (plan section 5.3), exported from the package index. One entry per table that holds
  personal data: its record class or classes (fixed, the row's own `retention_class`, by a column's
  value, as its parent, as the record it links, not retained, kept while current, or permanent);
  how each trigger date is found (a column, the first of several, the parent's, a looked-up
  column, the latest child, the person's care end, the member's leaving date, the end of the pay
  reference period, or a stated rule where no column holds it); the subject (person, staff,
  applicant or none) and its column; the parent it is destroyed with; and the destruction method
  (`delete`, `clear_columns` with the columns, or `never`). It holds no period: classes resolve
  through `resolveRule` (slice 1).
- **Coverage**: 238 entries, every table with personal data in `packages/db/src/schema`: the 135
  Phase 2 tables of the plan's inventory, 96 Phase 0 and 1 tables and 6 sign-in (`auth`) tables.
  76 tables are listed in `no-personal-data.ts` as holding none, each with a reason (plan 3.1 and
  the Phase 0 and 1 configuration and reference data). No allow-list was needed.
- **Methods**: 226 deleted, 5 cleared (`rota`, `shift` and `pay_run` under H-1560; `applicant`
  redacted; `lone_worker_location` as today's sweep does), 6 never destroyed (`legal_hold`,
  `destruction_certificate` and four configuration tables).
- **`packages/db/src/retention-registry.test.ts`** reads the Drizzle schema (no database needed). A
  table holds personal data unless `NO_PERSONAL_DATA` lists it, so every other table needs an
  entry. It fails when a table has neither, when an entry or listing names a table that does not
  exist, a column that does not exist (on its own table or a looked-up one), a cleared column that
  is NOT NULL, a key whose foreign key points elsewhere, a rate key not in rates.md, or a class
  that is not a row of `docs/specs/retention.md` (parsed with `parseRetention`), and it resolves
  every class through `resolveRule`. Table-driven cases prove each failure is caught.
- **`packages/domain/src/platform/retention-registry.test.ts`** (table-driven): every class of
  every entry resolves through `resolveRule` to a schedule row and is not retired; every entry
  supplies the trigger fact its classes need (directly, through its parent or its children);
  the registry has no structural problem (duplicates, missing parents, loops, a parent date with no
  parent, a method that does not fit); and the export catalogue agrees with every entry.
- **Export catalogue alignment** (`export-catalogue.ts`): the `retention` field is checked against
  the registry by `catalogueRetentionFor` (one class: that class; a class that depends on the row or
  several classes: `by_category`; a child: its parent's; a link: `as_subject`; staged data:
  `operational`). 45 values changed, retention.md winning:
  - medicines logs: `mar_chart` to `medicines_stock_log` (`medicine_stock_item`,
    `medicine_stock_movement`, `medicine_order`, `medicine_order_line`), `medicines_disposal_log`
    (`medicine_disposal`) and `temperature_log` (`medicine_temperature_reading`);
  - audits: `organisation_document` to `quality_audit` (`audit_record`, `audit_action`);
  - payroll exports: `rota_and_timesheet` to `payroll_export` (`payroll_export`,
    `payroll_export_result`);
  - `pulse_survey_participation`, `pulse_survey_response`: `staff_wellbeing` to
    `staff_survey_response` (H-1557); `feed_view`: `audit_event` to `audit_event.care_record`;
    `death_record`, `death_step`: `serious_incident` to `care_record`; `missing_episode`,
    `missing_event`: `as_subject` to `care_record` (H-1558); `lms_import`: `training_record` to
    `audit_event`; `evidence_link`: `tenant_configuration` to `as_subject`;
  - class by row or longest wins, now `by_category`: `person`, `contact` and the three
    pre-admission tables (H-39), `incident` and its four children, `statutory_notification`,
    `medication_error`, `letter`, `controlled_drug_entry`, `employee_case` and its three children,
    `document_signature`, `signature_request`, `hr_pay_rate` and `hr_pay_unit`;
  - not retained, now `operational`: `lone_worker_location` (was `lone_worker_location`, not a
    schedule row), `lms_import_row`, `integration_inbound`; `operator_user` is
    `tenant_configuration`.
  `ExportRetention` gains the seven classes now used and loses `lone_worker_location`. The DSAR
  erasure check reads this field: a `by_category` record is reported as kept under the
  organisation's policy instead of by one class's period, which only ever keeps more until the
  sweep reads the registry (slice 4).
- **No migration, no data change, no route.**

## Found, and listed in plan section 3.2

- `processor_breach_notice.breach_id` refers to the organisation's `dp_breach`: the notice closes
  with the breach (the plan said there was no link).
- Classes only in the export catalogue (no retention.md row; DPO to confirm): `access_grant`,
  `role_assignment`, `support_access_request`, `person_assignment`, `form_submission`,
  `notification`.
- No class anywhere (kept, never offered; DPO decision): `tenant_user`, `tenant`,
  `notification_preference`, `operator_user`, the six `auth` tables (no sweep deletes expired
  sessions or verifications), `request_quota`, `integration_inbound`, and the trigger of a
  statutory notification with no incident.
- Organisation material the catalogue marks personal (`dependency_scale_version`,
  `policy_version`, `statement_of_purpose_version`, `letter_template_version`) has entries under
  `organisation_document`; `homely_remedy_protocol` (mapped to `mar_chart`) holds no person.
- H-1560 clearing blocked by NOT NULL columns or a check (`audit_record`, `audit_action`,
  `rota_publication`, `shift_assignment`, `pay_run_line`, `pay_run_exception`, `outbreak_case`):
  deleted until an expand migration (slice 8).
- Per-row distinctions the registry leaves to the sweep: a person closed without admission (both
  H-39 classes, longer wins), the talent pool, `audit_event.care_record`, downtime packs in force
  during an outage, and non-sickness absences under `sickness_absence`.
- A stock item, its movements and disposals, and controlled drug pages and administrations have
  different periods: the purge must never delete a parent while a child is kept.

## Size

2,147 lines of registry code (602 of types, builders and checks in `registry.ts` and `index.ts`;
1,545 of per-context data), 737 lines of tests and a 106-line catalogue diff: far over the 400-line
guide. Split for review as: (1) the types and checks, the domain and db tests, platform, people and
care (slice 2); (2) workforce and scheduling; (3) medicines, safety, quality, comms, integrations,
operations and the catalogue fix, leaving no allow-list (slice 3). Built as one branch, as asked.

## What is next

- Slice 4: the report-only sweep (`feat/platform-retention-report`), which reads the registry.
- The DPO decisions above go into `human-actions.md` with the plan's other questions at merge.
