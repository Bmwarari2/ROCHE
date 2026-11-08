# Retention sweeps for Phase 2 records: inventory and plan

**Draft plan, 07/11/2026.** Branch `feat/platform-retention-sweeps`, from `main` at `daa038a7`. No code or
migration has been written for this plan. It says what exists, what is missing and how to build sweeps
that destroy Phase 2 records when their retention class ends: soft delete, then hard delete (or
crypto-shred for stored files) with a signed certificate, never while a legal hold applies.

Sources read: [retention.md](../specs/retention.md) (the schedule and the table-to-class mapping),
[retention-and-deletion.md](../compliance/retention-and-deletion.md) (the mechanism),
[platform.md, retention and legal hold](../specs/platform.md#retention-and-legal-hold-plat-012),
[ADR-0031](../decisions/0031-document-storage-scanning-and-destruction.md) (documents and destruction),
[ADR-0109](../decisions/0109-per-organisation-crypto-shredding.md) (crypto-shredding),
[ADR-0133](../decisions/0133-definer-functions-owned-by-nologin-roles.md) (definer owners),
[ADR-0002](../decisions/0002-tenancy-and-row-level-security.md) (tenancy and row-level security), the
[add-migration skill](../../.claude/skills/add-migration/SKILL.md), the worker
([worker.ts](../../apps/api/src/jobs/worker.ts), [tasks.ts](../../apps/api/src/jobs/tasks.ts)), the
retention routes and services ([documents.ts route](../../apps/api/src/routes/documents.ts),
[shred.ts route](../../apps/api/src/routes/shred.ts), [shred.ts service](../../apps/api/src/services/shred.ts),
[documents.ts service](../../apps/api/src/services/documents.ts)), the domain rules
([retention.ts](../../packages/domain/src/platform/retention.ts)), the export catalogue
([export-catalogue.ts](../../packages/domain/src/platform/export-catalogue.ts)) and every migration from
0073 to 0152.

## 1. Summary

- **Nothing destroys database rows when a retention class ends.** The retention engine built in Phase 1
  (PLAT-012) reaches **documents only**, and only when a person asks: it lists documents past their
  period and destroys the ones a reviewer picks, with a signed certificate. It handles two triggers
  (`care_ended` and `created`); documents of any other class are never offered.
- Crypto-shredding exists **for the whole organisation only** (two people, step-up, the organisation's
  Cloud KMS key destroyed). For a subset of records, ADR-0109 chose per-object deletion of stored
  files and soft delete then hard delete of rows, with the certificate recording when point-in-time
  recovery stops holding them. Database columns are not field-encrypted, so there is no per-subject key
  to shred: rows must be deleted or cleared.
- Legal holds exist (on a person or on one record) and are checked before a document is destroyed.
- Phase 2 added **187 tables** (migrations 0073 to 0152). **135** hold personal data. Every one of the
  135 has `tenant_id` and forced row-level security. **120** have a class in retention.md (103 named in
  the mapping table, 17 only in a class's notes); **15** have none. **2** are swept today, and only
  partly: `import_row` (staged rows deleted at expiry) and `lone_worker_location` (coordinates cleared,
  the empty row kept). **133** are never swept.
- 55 of the 135 are append-only (a trigger refuses UPDATE and DELETE for every role) and 43 more refuse
  DELETE by trigger. 64 have no `deleted_at` column. A sweep therefore needs a database exception, of
  the kind sample-data removal already has, owned by a NOLOGIN role.

## 2. Current state

### 2.1 The retention engine today

| Part | What exists | Where |
| --- | --- | --- |
| Schedule | `retention_class` rows seeded from retention.md (global rows with `tenant_id` NULL; a tenant row overrides). The seed test checks that the section 5.1 classes parse | `packages/db/src/schema/platform.ts`, `packages/db/src/seed/demo.ts`, `packages/db/src/seed/reference-data.test.ts` |
| Due date | `retentionDecision(rule, { triggerDate, legalHold }, now)` returns `retain` (until), `eligible_for_destruction` (since), `legal_hold` or `tenant_policy`; `addPeriod` handles month ends; `validateTenantOverride` stops a tenant shortening a period | `packages/domain/src/platform/retention.ts` |
| Trigger dates | Only in the documents route: `care_ended` is `person.deceased_at`, else `discharged_at`; `created` is `document.created_at`. Any other trigger gives no date, so the document is never offered | `eligibleDocuments` in `apps/api/src/routes/documents.ts` |
| Staff file date | `staffFileRetainUntil` works out a leaver's keep-until date once, when the leaving is recorded, into `leaver_record.staff_file_retain_until`. Nothing reads it to destroy anything | `packages/domain/src/workforce/induction.ts`, `apps/api/src/routes/induction.ts` |
| Applicant date | `applicant.retain_until` is set when the last application closes; `redacted_at` exists, and the workforce spec says the retention engine redacts. No job does | `apps/api/src/routes/recruitment.ts`, [workforce.md](../specs/workforce.md) known gaps |
| DSAR erasure check | `erasureCandidates` assesses each collected record against its class (from the export catalogue's `retention` field) and holds, and only records the result: "the retention engine destroys records, never the workbench" | `apps/api/src/services/dsar.ts`, `packages/domain/src/platform/dsar.ts` |
| Candidates | `GET /v1/retention/candidates`: documents past their period with no hold (at most 5,000, oldest first) | `apps/api/src/routes/documents.ts` |
| Destruction | `POST /v1/retention/destroy` (`platform.retention.manage`, step-up): under the organisation's retention lock (`pg_advisory_xact_lock(hashtext('retention:<tenant>'))`), re-checks each id, makes the row a tombstone (`status` `destroyed`, title cleared), issues one signed certificate per class, then deletes every stored version; a failed byte deletion is retried from the outbox (`platform.document.destroyed`). No batch, no review queue and no grace period: the tombstone is immediate | same |
| Certificate | `destruction_certificate` (append-only): class, subject type, subject ids, count, rule, reason, method, signature (Cloud KMS EC P-256, or a local Ed25519 key), key versions, `backups_expire_at`, requester and approver. PDF built on download; verification route | `packages/db/src/schema/records.ts`, `apps/api/src/services/certificates.ts`, `apps/api/src/routes/shred.ts` |
| Whole-organisation shred | `tenant_shred_request`: one member asks (naming a downloaded full export), another approves within 7 days, both with step-up; approval commits first, then the keys are scheduled for destruction and the certificate is issued; the worker retries from the outbox event `platform.tenant.shred_approved` | `apps/api/src/services/shred.ts`, `apps/api/src/routes/shred.ts` |
| Legal hold | `legal_hold`: a person (`person_id`, which refers to `person`, so residents only) or one record (`subject_type`, `subject_id`); reason; release with a reason. `isUnderLegalHold` and `isDocumentUnderLegalHold` (every version of a document, its person and the record it belongs to). Placing a hold takes the same retention lock | `packages/db/src/schema/records.ts`, `packages/domain/src/platform/retention.ts`, `apps/api/src/services/documents.ts` |
| Screens | `/settings/retention`: holds, documents due, destruction, certificates, whole-organisation shred | `apps/web/src/app/(shell)/settings/retention/` |

### 2.2 Sweeps that run today

The worker ([worker.ts](../../apps/api/src/jobs/worker.ts)) schedules pg-boss queues with
`boss.schedule(queue, cron)`; per-tenant work runs through `eachTenant` in
[tasks.ts](../../apps/api/src/jobs/tasks.ts), as the application role in each tenant's context with no
user (the system), one transaction per tenant, and a failure is logged as `worker.job.failed` and
audited as the system without stopping the other tenants. The sweeps that remove data:

| Queue (cron) | What it removes | Phase 2 table |
| --- | --- | --- |
| `import-expiry` (`31 * * * *`) | An import batch's staged rows at `import.staging_expiry_days` | `import_row` |
| `lone-worker-sweep` (every minute) | Location coordinates at `lone_worker.location_days`; the row stays, empty | `lone_worker_location` |
| `speak-up-intake-sweep` (`23 * * * *`) | Rate-limit windows (no personal data) | `speak_up_intake` |
| `invitation-sweep` (`17 3 * * *`) | Invitation addresses when they close (Phase 1) | - |
| `sign-in-erasure-sweep` (`47 3 * * *`) | Unlinked sign-ins (Phase 1) | - |
| `evidence-bundle-sweep` (every 5 minutes) | Rendered evidence pack bundles when the link ends (Phase 1) | - |
| `export-expiry` (every 15 minutes) | Full export archives past expiry (Phase 1) | - |
| outbox `platform.document.destroyed` | Stored bytes of documents already destroyed | - |

None of them reads the retention schedule.

### 2.3 How deletion is blocked today

- The application role (`harbour_app`) has no DELETE grant on tenant tables (add-migration skill).
- `app.forbid_mutation()` refuses UPDATE and DELETE on append-only tables for every role, with two
  exceptions: deleting rows inside `app.remove_sample_batch` (role `harbour_sample_owner` with
  `app.sample_removal = 'on'`, migration 0069) and moving sync routing columns (migration 0146).
  `audit_event` and `record_version` are excluded from both exceptions. Many mutable Phase 2 tables have
  a `no_delete` trigger with the same function.
- Sample-data removal is the nearest precedent for a retention purge: a fixed table list
  (`app.sample_removal_tables()`, children before parents), a NOLOGIN owner granted DELETE on exactly
  those tables, a transaction flag, and a test that fails when a table referring to a person is in
  neither list.
- [retention-and-deletion.md](../compliance/retention-and-deletion.md) section 2 says destruction runs
  as "a separate, audited maintenance role used only by the retention job". That role does not exist.

### 2.4 Audit events, record versions, documents and stored files

| Store | Retention today | Gap |
| --- | --- | --- |
| `audit_event` | Class `audit_event` (8 years from creation), extended by `audit_event.care_record`; search events carry `scope.retentionClass`. Append-only with a per-tenant hash chain (`chain_position`, `prev_hash`, `hash`, `app.audit_chain_head`). The production audit archive bucket is locked for 365 days | Nothing deletes audit events. Deleting from the middle of a chain breaks verification unless the design anchors it. retention-and-deletion.md says audit events about a record go with it, except the destruction event; retention.md says they are kept at least as long as the record. The `reason` column is free text |
| `record_version` | Every UPDATE of a mutable row copies the old row as JSON (redacted for some tables, for example lone-worker sessions and complaints) | Never deleted. Destroying or redacting a row leaves its earlier versions, with names and free text; the workforce spec records this for applicants. Excluded from both `forbid_mutation` exceptions |
| `document` and the documents bucket | Destroyed on request as above. Categories carry a class: `staff_hr_document` (`staff_file`, or `right_to_work_copy`, or `sickness_absence` for fit notes), `training_certificate` (`training_record`), `disclosure_pack` (`serious_incident`) | `staff_file` is not a schedule row (the rows are `staff_file.after_leaving` and `staff_file.to_75th_birthday`), so HR documents find no rule; `right_to_work_copy` and `sickness_absence` use `record_closed`, which the route does not handle. So no Phase 2 document is ever offered |
| Exports bucket | Full export archives expire (sweep). DSAR bundles are kept under `dsar/` beyond that expiry and "destroyed with the case" (retention.md, `data_rights_case`) | Nothing destroys a DSAR bundle; no case is ever destroyed |
| Files with no row | A file stored for a transaction that failed (`destroyingOnFailure`) or for a removed sample person stays in the bucket | No orphan sweep (STATUS.md follow-ups) |
| Backups | Point-in-time recovery 7 days (Enterprise) or 35 (Enterprise Plus); the certificate states `backups_expire_at` | Accepted by ADR-0109 for rows |
| Devices | Records leave devices through sync eviction and remote wipe | Phase 2 tables in sync streams: `clock_event`, `competence_sign_off`, `competence_withdrawal`, `covert_medication_record`, `medication`, `medication_administration`, `medication_dosing_record`, `medication_schedule`, `shift`. Soft-deleted rows must leave the streams |

## 3. Inventory of Phase 2 tables holding personal data

The 135 tables below hold personal data (the export catalogue marks them `personal`, or they carry
staff or person ids and retention.md gives them a class). For all 135:

- **`tenant_id`: yes, and forced row-level security: yes** (checked against every migration's
  `FORCE ROW LEVEL SECURITY` statements and loops).
- **Encryption: plain columns.** No database column is field-encrypted (ADR-0109, "Database rows"), so
  no row can be destroyed by destroying a key: each must be deleted, or its personal columns cleared.
  Only stored files (documents, export archives, DSAR bundles) are envelope-encrypted, each with its own
  data key under the organisation's Cloud KMS key.

Column key:

- **Class in retention.md**: the class the mapping table gives; "(notes only)" means only a class's
  notes name the records, with no mapping row; "(catalogue only)" means only the export catalogue's
  `retention` field gives one; "none" means neither retention.md nor a usable catalogue value. `staff_file`
  means "the tenant's chosen staff file row" (`staff_file.after_leaving`, 6 years after employment ends,
  or `staff_file.to_75th_birthday`, the default).
- **Deletion**: "append-only" means a trigger refuses UPDATE and DELETE; "no-delete" means a trigger
  refuses DELETE (UPDATE allowed, versioned); "grants only" means no trigger, but `harbour_app` has no
  DELETE grant. Some tables also have state guards on UPDATE.
- **Swept today**: whether any job destroys or clears it now.

| Table (migration) | Class in retention.md | Trigger, period | Trigger date from | `deleted_at` | Deletion | Swept today | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `compliance_item` (0073) | `staff_file` | employment_ended_or_75th_birthday, tenant row | `leaver_record.staff_file_retain_until` (via the member's `staff_profile`) | yes | no-delete | no | - |
| `staff_profile` (0073) | `staff_file` | employment_ended_or_75th_birthday, tenant row | `leaver_record.staff_file_retain_until` (via the member's `staff_profile`) | yes | no-delete | no | - |
| `dependency_assessment` (0074) | `care_record` | care_ended, 8 years | `person.deceased_at` or `discharged_at` (via `person_id`) | no | append-only | no | - |
| `safeguarding_concern` (0075) | `serious_incident` | record_closed, 20 years | `closed_at` | yes | grants only | no | row `retention_class` |
| `evidence_link` (0076) | none | - | - | yes | no-delete | no | links evidence to the framework; follows the record it tags |
| `dsar_case` (0077) | `data_rights_case` | record_closed, 3 years | `responded_on`; a withdrawal has no date column | yes | grants only | no | - |
| `dsar_item` (0077) | `data_rights_case` | record_closed, 3 years | parent `dsar_case` | yes | grants only | no | - |
| `competence_sign_off` (0079) | `training_record` | created, 10 years | `observed_on` | no | append-only | no | synced to devices |
| `competence_withdrawal` (0079) | `training_record` | created, 10 years | `created_at` | no | append-only | no | synced to devices |
| `revalidation_evidence` (0079) | `training_record` | created, 10 years | `created_at` (or `confirmed_on`) | yes | no-delete | no | - |
| `supervision_record` (0079) | `staff_file` | employment_ended_or_75th_birthday, tenant row | `leaver_record.staff_file_retain_until` (via the member's `staff_profile`) | yes | no-delete | no | - |
| `training_record` (0079) | `training_record` | created, 10 years | `completed_on` | yes | no-delete | no | - |
| `complaint` (0080) | `complaint` (notes only) | record_closed, 10 years | `closed_at` | yes | grants only | no | row `retention_class` |
| `compliment` (0080) | `complaint` (notes only) | record_closed, 10 years | none: a compliment never closes | yes | grants only | no | row `retention_class`; no `record_closed` date |
| `audit_action` (0081) | `quality_audit` (notes only) | record_closed, 5 years | parent `audit_record.completed_at` | no | append-only | no | catalogue says organisation_document |
| `audit_record` (0081) | `quality_audit` (notes only) | record_closed, 5 years | `completed_at` | yes | no-delete | no | catalogue says organisation_document |
| `dp_breach` (0082) | `dp_breach` | record_closed, 6 years | `closed_at` | yes | grants only | no | - |
| `dp_complaint` (0082) | `data_rights_case` | record_closed, 3 years | `closed_on` | yes | grants only | no | - |
| `processor_breach_notice` (0082) | `dp_breach` | record_closed, 6 years | closure of the tenant's breach entry; no link column | no | append-only | no | one Thapsus notice, many tenants |
| `processor_breach_notice_ack` (0082) | `dp_breach` | record_closed, 6 years | `acknowledged_at` when no register entry | no | append-only | no | - |
| `roster_override` (0083) | `rota_and_timesheet` | created (pay period end), 6 years | end of the pay reference period (no column; derive from `pay_run.period_end` or the pay frequency) | no | append-only | no | - |
| `rota` (0083) | `rota_and_timesheet` | created (pay period end), 6 years | `ends_on`, then end of the pay reference period (no column; derive from `pay_run.period_end` or the pay frequency) | yes | no-delete | no | - |
| `rota_publication` (0083) | `rota_and_timesheet` | created (pay period end), 6 years | end of the pay reference period (no column; derive from `pay_run.period_end` or the pay frequency) | no | append-only | no | - |
| `shift` (0083) | `rota_and_timesheet` | created (pay period end), 6 years | `ends_at`, then end of the pay reference period (no column; derive from `pay_run.period_end` or the pay frequency) | yes | no-delete | no | synced to devices |
| `shift_assignment` (0083) | `rota_and_timesheet` | created (pay period end), 6 years | parent `shift` | yes | no-delete | no | - |
| `applicant` (0085) | `applicant.unsuccessful` | record_closed, 6 months | `retain_until` (set when the last application closes); `talent_pool_until` | yes | no-delete | no | redact (`redacted_at`), not delete; `record_version` copies too |
| `application` (0085) | `applicant.unsuccessful` | record_closed, 6 months | `closed_on` | yes | no-delete | no | - |
| `application_event` (0085) | `applicant.unsuccessful` | record_closed, 6 months | parent `application` | no | append-only | no | - |
| `equality_monitoring` (0085) | `applicant.unsuccessful` | record_closed, 6 months | `vacancy.closes_on` | no | append-only | no | no person link (anonymous form) |
| `interview` (0085) | `applicant.unsuccessful` | record_closed, 6 months | parent `application` | no | append-only | no | - |
| `job_offer` (0085) | `applicant.unsuccessful` | record_closed, 6 months | parent `application` | yes | no-delete | no | a hired applicant moves to staff_file |
| `speak_up_case_member` (0086) | `speak_up_concern` | record_closed, 6 years | parent concern | yes | grants only | no | restricted silo |
| `speak_up_concern` (0086) | `speak_up_concern` | record_closed, 6 years | `closed_at` | yes | grants only | no | row `retention_class`; restricted silo |
| `speak_up_message` (0086) | `speak_up_concern` | record_closed, 6 years | parent concern | no | append-only | no | restricted silo |
| `speak_up_reporter` (0086) | `speak_up_concern` | record_closed, 6 years | parent concern | no | append-only | no | restricted silo |
| `policy_signature` (0087) | `training_record` | created, 10 years | `signed_at` | no | append-only | no | - |
| `import_batch` (0088) | `audit_event` | created, 8 years | `uploaded_at` | no | grants only | no | ids, counts and times only |
| `import_commit` (0088) | `audit_event` | created, 8 years | `committed_at` | no | grants only | no | - |
| `import_row` (0088) | not retained | `import.staging_expiry_days` | `import_batch.expires_at` | no | grants only | yes: hourly import expiry | deleted on commit, discard or expiry |
| `care_certificate_progress` (0091) | `staff_file` | employment_ended_or_75th_birthday, tenant row | `leaver_record.staff_file_retain_until` (via the member's `staff_profile`) | yes | no-delete | no | - |
| `induction_plan` (0091) | `staff_file` | employment_ended_or_75th_birthday, tenant row | `leaver_record.staff_file_retain_until` (via the member's `staff_profile`) | yes | no-delete | no | - |
| `leaver_record` (0091) | `staff_file` | employment_ended_or_75th_birthday, tenant row | `staff_file_retain_until` (its own column) | yes | no-delete | no | computed once, when the leaving is recorded |
| `probation_review` (0091) | `staff_file` | employment_ended_or_75th_birthday, tenant row | `leaver_record.staff_file_retain_until` (via the member's `staff_profile`) | no | append-only | no | - |
| `reference_request` (0091) | `staff_file` | employment_ended_or_75th_birthday, tenant row | `leaver_record.staff_file_retain_until` (via the member's `staff_profile`) | yes | no-delete | no | - |
| `shadow_shift` (0091) | `staff_file` | employment_ended_or_75th_birthday, tenant row | `leaver_record.staff_file_retain_until` (via the member's `staff_profile`) | no | append-only | no | - |
| `staff_checklist_item` (0091) | `staff_file` | employment_ended_or_75th_birthday, tenant row | `leaver_record.staff_file_retain_until` (via the member's `staff_profile`) | no | append-only | no | - |
| `outbreak` (0093) | `serious_incident` | record_closed, 20 years | `closed_at` | yes | no-delete | no | catalogue: not personal |
| `outbreak_case` (0093) | `care_record` / `outbreak_staff_case` | residents: care_ended, 8 years; staff: record_closed, 3 years | residents: `person.deceased_at` or `discharged_at` (via `person_id`); staff: `outbreak.closed_at` | no | append-only | no | class depends on the row (`type`); catalogue says by_category |
| `ldss_claim` (0097) | `staff_file` | employment_ended_or_75th_birthday, tenant row | `leaver_record.staff_file_retain_until` (via the member's `staff_profile`) | yes | grants only | no | - |
| `sponsor_absence` (0097) | `sponsor_record` | record_closed, 2 years | parent `sponsored_worker` | yes | grants only | no | - |
| `sponsor_report` (0097) | `sponsor_record` | record_closed, 2 years | parent `sponsored_worker` | yes | grants only | no | - |
| `sponsored_worker` (0097) | `sponsor_record` | record_closed, 2 years | later of `ended_on` and the employment end | yes | grants only | no | - |
| `staff_image_consent` (0097) | `staff_file` | employment_ended_or_75th_birthday, tenant row | `leaver_record.staff_file_retain_until` (via the member's `staff_profile`) | no | append-only | no | - |
| `staff_privacy_acknowledgement` (0097) | `staff_file` | employment_ended_or_75th_birthday, tenant row | `leaver_record.staff_file_retain_until` (via the member's `staff_profile`) | no | append-only | no | - |
| `death_record` (0099) | none | - | `closed_at` (if serious_incident) | yes | grants only | no | catalogue says serious_incident |
| `death_step` (0099) | none | - | parent `death_record` | no | append-only | no | catalogue says serious_incident |
| `herbert_profile` (0099) | none | - | `person.deceased_at` or `discharged_at` (via `person_id`) | yes | grants only | no | catalogue says care_record |
| `missing_episode` (0099) | none | - | `person.deceased_at` or `discharged_at` (via `person_id`) or `closed_at` | yes | grants only | no | catalogue says as_subject |
| `missing_event` (0099) | none | - | parent `missing_episode` | no | append-only | no | catalogue says as_subject |
| `employee_case` (0101) | `staff_file` / `casework_no_sanction` | employment_ended_or_75th_birthday, tenant row; or record_closed, 6 years | `leaver_record.staff_file_retain_until` (via the member's `staff_profile`); or `closed_on` | yes | no-delete | no | row `retention_class`, set on closing; restricted silo |
| `employee_case_event` (0101) | `staff_file` / `casework_no_sanction` | employment_ended_or_75th_birthday, tenant row; or record_closed, 6 years | parent case | no | append-only | no | restricted silo |
| `employee_case_hearing` (0101) | `staff_file` / `casework_no_sanction` | employment_ended_or_75th_birthday, tenant row; or record_closed, 6 years | parent case | yes | no-delete | no | restricted silo |
| `employee_case_member` (0101) | `staff_file` / `casework_no_sanction` | employment_ended_or_75th_birthday, tenant row; or record_closed, 6 years | parent case | yes | no-delete | no | restricted silo |
| `disclosure_item` (0103) | `data_rights_case` (built as `serious_incident`) | record_closed, 3 years | parent request | yes | grants only | no | catalogue: not personal |
| `disclosure_request` (0103) | `data_rights_case` (built as `serious_incident`) | record_closed, 3 years | `handed_over_at` or `released_at`; no closed column | yes | grants only | no | no per-row class yet |
| `agency_awr_record` (0104) | `rota_and_timesheet` | created (pay period end), 6 years | `to_on` | no | append-only | no | - |
| `agency_booking` (0104) | `rota_and_timesheet` | created (pay period end), 6 years | end of the pay reference period (no column; derive from `pay_run.period_end` or the pay frequency) | yes | no-delete | no | - |
| `agency_worker` (0104) | `rota_and_timesheet` | created (pay period end), 6 years | last booking's pay period end | yes | no-delete | no | an agency worker has no leaving date |
| `agency_worker_feedback` (0104) | `rota_and_timesheet` | created (pay period end), 6 years | `created_at` | no | append-only | no | - |
| `location_induction` (0104) | `rota_and_timesheet` | created (pay period end), 6 years | `inducted_on` | no | append-only | no | - |
| `absence` (0107) | `sickness_absence` (notes only) | record_closed, 6 years | `ends_on` | yes | no-delete | no | one table for every kind of absence; class notes cover sickness only |
| `fit_note` (0107) | `sickness_absence` (notes only) | record_closed, 6 years | parent `absence.ends_on` | no | append-only | no | - |
| `return_to_work` (0107) | `sickness_absence` (notes only) | record_closed, 6 years | parent `absence.ends_on` | no | append-only | no | - |
| `shift_cover_need` (0107) | `rota_and_timesheet` (catalogue only) | created (pay period end), 6 years | `resolved_at` | no | no-delete | no | catalogue only |
| `clock_event` (0109) | `rota_and_timesheet` | created (pay period end), 6 years | end of the pay reference period (no column; derive from `pay_run.period_end` or the pay frequency) | no | append-only | no | synced to devices |
| `sleep_in_awake_period` (0109) | `rota_and_timesheet` | created (pay period end), 6 years | end of the pay reference period (no column; derive from `pay_run.period_end` or the pay frequency) | no | append-only | no | - |
| `timesheet_entry` (0109) | `rota_and_timesheet` | created (pay period end), 6 years | end of the pay reference period (no column; derive from `pay_run.period_end` or the pay frequency) | yes | no-delete | no | - |
| `working_time_opt_out` (0109) | `working_time_opt_out` | record_closed, 2 years | `ends_on`, withdrawal or employment end | yes | no-delete | no | - |
| `working_time_result` (0109) | `working_time_record` | created, 2 years | `created_at` | no | append-only | no | - |
| `medication` (0111) | `mar_chart` | care_ended, 8 years | `person.deceased_at` or `discharged_at` (via `person_id`) | yes | grants only | no | synced to devices |
| `medication_reconciliation` (0111) | `mar_chart` | care_ended, 8 years | `person.deceased_at` or `discharged_at` (via `person_id`) | yes | grants only | no | - |
| `medication_reconciliation_decision` (0111) | `mar_chart` | care_ended, 8 years | `person.deceased_at` or `discharged_at` (via `person_id`) | yes | grants only | no | - |
| `medication_reconciliation_item` (0111) | `mar_chart` | care_ended, 8 years | `person.deceased_at` or `discharged_at` (via `person_id`) | no | append-only | no | - |
| `medication_reconciliation_source` (0111) | `mar_chart` | care_ended, 8 years | `person.deceased_at` or `discharged_at` (via `person_id`) | no | append-only | no | - |
| `medication_schedule` (0111) | `mar_chart` | care_ended, 8 years | `person.deceased_at` or `discharged_at` (via `person_id`) | no | append-only | no | synced to devices |
| `elearning_attempt` (0112) | `training_record` | created, 10 years | `finished_at` | yes | no-delete | no | - |
| `elearning_statement` (0112) | `training_record` | created, 10 years | parent attempt | no | append-only | no | - |
| `lone_worker_alarm` (0113) | `lone_worker` | record_closed, 3 years | session `finished_at` | yes | grants only | no | row `retention_class`; an alarm that led to an incident follows it |
| `lone_worker_event` (0113) | `lone_worker` (or `lone_worker_check_in`) | record_closed, 3 years; or created, 3 months | session `finished_at`, or `received_at` for a routine check-in | no | append-only | no | two classes claim routine check-ins |
| `lone_worker_location` (0113) | not retained | `lone_worker.location_days` | `delete_after` | no | grants only | yes: per-minute erasure (coordinates only) | coordinates cleared; the empty row stays |
| `lone_worker_session` (0113) | `lone_worker` | record_closed, 3 years | `finished_at` | yes | grants only | no | row `retention_class` |
| `supervision_note` (0114) | `staff_file` | employment_ended_or_75th_birthday, tenant row | `leaver_record.staff_file_retain_until` (via the member's `staff_profile`) | no | append-only | no | - |
| `pulse_survey_participation` (0115) | `staff_wellbeing` (notes only) | created, 2 years | parent survey `closed_at` | no | append-only | no | staff_survey_response (12 months) also claims it |
| `pulse_survey_response` (0115) | `staff_wellbeing` (notes only) | created, 2 years | parent survey `closed_at` | no | append-only | no | anonymous; staff_survey_response also claims it |
| `recognition` (0115) | `staff_wellbeing` (notes only) | created, 2 years | `created_at` | no | append-only | no | - |
| `wellbeing_check_in` (0115) | `staff_wellbeing` (notes only) | created, 2 years | `created_at` | no | no-delete | no | - |
| `pay_profile` (0116) | `staff_file` | employment_ended_or_75th_birthday, tenant row | `leaver_record.staff_file_retain_until` (via the member's `staff_profile`) | yes | no-delete | no | - |
| `pay_run` (0116) | `rota_and_timesheet` | created (pay period end), 6 years | `period_end` | yes | no-delete | no | catalogue: not personal; holds calculations |
| `pay_run_exception` (0116) | `rota_and_timesheet` | created (pay period end), 6 years | parent `pay_run.period_end` | yes | no-delete | no | - |
| `pay_run_line` (0116) | `rota_and_timesheet` | created (pay period end), 6 years | parent `pay_run.period_end` | no | append-only | no | - |
| `vetting_check` (0120) | `staff_file` | employment_ended_or_75th_birthday, tenant row | `leaver_record.staff_file_retain_until` (via the member's `staff_profile`) | yes | no-delete | no | - |
| `vetting_consent` (0120) | `staff_file` | employment_ended_or_75th_birthday, tenant row | `leaver_record.staff_file_retain_until` (via the member's `staff_profile`) | yes | no-delete | no | - |
| `casework_support_ticket` (0121) | `staff_file` | employment_ended_or_75th_birthday, tenant row | the case's subject leaver date | yes | no-delete | no | - |
| `medication_administration` (0123) | `mar_chart` | care_ended, 8 years | `person.deceased_at` or `discharged_at` (via `person_id`) | no | append-only | no | synced to devices |
| `medication_administration_witness` (0123) | `mar_chart` | care_ended, 8 years | `person.deceased_at` or `discharged_at` (via `person_id`) | no | append-only | no | - |
| `medication_dosing_record` (0123) | `mar_chart` | care_ended, 8 years | `person.deceased_at` or `discharged_at` (via `person_id`) | no | grants only | no | synced to devices |
| `payroll_export` (0127) | `payroll_export` (notes only) | created (pay period end), 6 years | the run's `period_end` | no | append-only | no | catalogue says rota_and_timesheet |
| `payroll_export_result` (0127) | `payroll_export` (notes only) | created (pay period end), 6 years | parent export | no | append-only | no | catalogue says rota_and_timesheet |
| `controlled_drug_entry` (0128) | `controlled_drugs_register` and `mar_chart` | last_entry, 2 years; care_ended, 8 years | last entry on the page (`max(occurred_at)`); administrations: `person.deceased_at` or `discharged_at` (via `person_id`) | no | append-only | no | longest wins |
| `controlled_drug_page` (0128) | `controlled_drugs_register` | last_entry, 2 years | `max(controlled_drug_entry.occurred_at)` on the page | no | append-only | no | - |
| `controlled_drug_stock_check` (0128) | `controlled_drugs_register` | last_entry, 2 years | `checked_at` or the page's last entry | no | append-only | no | - |
| `controlled_drug_witness_assertion` (0128) | `controlled_drugs_register` | last_entry, 2 years | `expires_at` | no | grants only | no | a short-lived witness token |
| `lms_import` (0132) | none | - | `closed_at` | yes | no-delete | no | catalogue says training_record |
| `lms_import_row` (0132) | none | - | parent `lms_import.closed_at` | yes | no-delete | no | staged learner rows; no expiry sweep like `import_row` |
| `lms_learner_link` (0132) | none | - | `leaver_record.staff_file_retain_until` (via the member's `staff_profile`) | yes | no-delete | no | catalogue says training_record |
| `ocr_extraction` (0133) | `care_record` | care_ended, 8 years | `person.deceased_at` or `discharged_at` (via `person_id`) | yes | grants only | no | - |
| `ocr_field` (0133) | `care_record` | care_ended, 8 years | `person.deceased_at` or `discharged_at` (via `person_id`) | yes | grants only | no | - |
| `signature_request` (0133) | class of the document | as the document | the document's trigger | yes | grants only | no | - |
| `medication_administration_conflict` (0134) | `mar_chart` | care_ended, 8 years | `person.deceased_at` or `discharged_at` (via `person_id`) | no | grants only | no | - |
| `medication_error` (0135) | `serious_incident` | record_closed, 20 years | the incident's closure | yes | grants only | no | row `retention_class` |
| `medication_review` (0135) | `mar_chart` | care_ended, 8 years | `person.deceased_at` or `discharged_at` (via `person_id`) | yes | grants only | no | row `retention_class` |
| `medicine_disposal` (0138) | `medicines_disposal_log` (notes only) | created, 3 years | `recorded_at` | yes | no-delete | no | catalogue says mar_chart |
| `medicine_order` (0138) | none | - | `submitted_at` | yes | no-delete | no | catalogue says mar_chart; catalogue: not personal |
| `medicine_order_line` (0138) | none | - | `person.deceased_at` or `discharged_at` (via `person_id`) or `created_at` | yes | no-delete | no | catalogue says mar_chart |
| `medicine_stock_item` (0138) | `medicines_stock_log` (notes only) | created, 2 years | `opened_at` | no | append-only | no | catalogue says mar_chart |
| `medicine_stock_movement` (0138) | `medicines_stock_log` (notes only) | created, 2 years | `recorded_at` | no | append-only | no | catalogue says mar_chart; CD movements keep the CD class |
| `medicine_temperature_reading` (0138) | `temperature_log` (notes only) | created, 2 years | `recorded_at` | no | append-only | no | catalogue says mar_chart |
| `covert_medication_record` (0140) | `mar_chart` | care_ended, 8 years | `person.deceased_at` or `discharged_at` (via `person_id`) | yes | grants only | no | synced to devices |
| `homely_remedy_administration` (0140) | `mar_chart` | care_ended, 8 years | `person.deceased_at` or `discharged_at` (via `person_id`) | no | append-only | no | - |
| `self_administration_assessment` (0140) | `mar_chart` | care_ended, 8 years | `person.deceased_at` or `discharged_at` (via `person_id`) | no | append-only | no | - |
| `hr_person_link` (0141) | none | - | `leaver_record.staff_file_retain_until` (via the member's `staff_profile`) | yes | no-delete | no | catalogue says staff_file |
| `prn_outcome` (0143) | `mar_chart` | care_ended, 8 years | `person.deceased_at` or `discharged_at` (via `person_id`) | no | append-only | no | - |
| `prn_protocol` (0143) | `mar_chart` | care_ended, 8 years | `person.deceased_at` or `discharged_at` (via `person_id`) | yes | grants only | no | - |
| `hr_pay_rate` (0148) | none | - | end of the pay reference period (no column; derive from `pay_run.period_end` or the pay frequency) | yes | no-delete | no | catalogue says rota_and_timesheet |
| `hr_pay_unit` (0148) | none | - | end of the pay reference period (no column; derive from `pay_run.period_end` or the pay frequency) | no | append-only | no | catalogue says rota_and_timesheet |

### 3.1 Phase 2 tables without personal data (not swept)

52 tables need no retention sweep: global reference data (`dmd_*` (8), `framework_evidence_category`,
`framework_key_question`, `framework_statement`, `framework_version`, `ipc_code_criterion`,
`audit_starter_template`) and organisation configuration or documents, kept while current or under
`organisation_document` (`tenant_policy`): `agency`, `audit_schedule`, `audit_template`,
`clock_setting`, `dependency_scale`, `dependency_scale_version`, `dspt_assertion`, `dspt_evidence`,
`dspt_submission`, `security_certificate` (interim `audit_event`, H-810), `elearning_course`,
`framework_mapping`, `homely_remedy_protocol`, `hr_delivery`, `hr_location_link`, `hr_pay_period`,
`hr_sync_state`, `job_template`, `lms_course_map`, `lms_source`, `medicine_list_item`,
`medicine_order_cycle`, `medicine_storage`, `pay_rule_set`, `payroll_connection`, `policy`,
`policy_version`, `pulse_survey`, `pulse_survey_response_pending` (released at close),
`quality_indicator_target`, `shift_pattern`, `shift_template`, `speak_up_intake`, `sso_connection`,
`sso_domain`, `training_requirement`, `vacancy` and `tenant_shred_request` (kept permanently as proof).
Some hold member ids in `*_by` columns; those are accountability evidence and follow the record.

### 3.2 Flags

**Tables with no class (15).** `evidence_link`; `death_record`, `death_step`, `herbert_profile`,
`missing_episode`, `missing_event` (deaths and missing people, slice 37: the catalogue says
`serious_incident`, `care_record` or "as subject", retention.md says nothing); `lms_import`,
`lms_import_row`, `lms_learner_link` (the learning-system import; `lms_import_row` holds staged learner
rows with no expiry sweep, unlike `import_row`); `medicine_order`, `medicine_order_line`;
`hr_person_link`, `hr_pay_rate`, `hr_pay_unit` (the Thapsus-HR link); `shift_cover_need` (catalogue
only).

**Tables named only in a class's notes (17).** `complaint`, `compliment` (`complaint`); `audit_record`,
`audit_action` (`quality_audit`); `absence`, `fit_note`, `return_to_work` (`sickness_absence`);
`pulse_survey_participation`, `pulse_survey_response`, `recognition`, `wellbeing_check_in`
(`staff_wellbeing`); `payroll_export`, `payroll_export_result` (`payroll_export`); `medicine_disposal`
(`medicines_disposal_log`); `medicine_stock_item`, `medicine_stock_movement` (`medicines_stock_log`);
`medicine_temperature_reading` (`temperature_log`).

**The export catalogue disagrees with retention.md.** The catalogue's `retention` field is the only
table-to-class map in code (the DSAR erasure check uses it). It says `mar_chart` for the medicines stock,
disposal, temperature and order tables (retention.md: 2, 3 and 2 years from the entry); `organisation_document`
for `audit_record` and `audit_action` (retention.md: `quality_audit`, 5 years from completion);
`rota_and_timesheet` for `payroll_export` (retention.md: `payroll_export`; same period); `staff_file`
and `lone_worker_location`, which are not schedule rows; and one value per table where the class depends
on the row (`outbreak_case`, `employee_case`, `letter`).

**Duplicate or competing classes.**

| Classes | Problem | Suggested answer |
| --- | --- | --- |
| `lone_worker_check_in` (3 months from the check-in) and `lone_worker` (3 years from the session's finish) | Both claim routine check-ins in `lone_worker_event`; the mapping table gives the whole table `lone_worker` | DPO decides (question 2). Either retire `lone_worker_check_in`, or clear routine check-in events at 3 months, which needs a per-event rule inside a session |
| `whistleblowing` and `speak_up_concern` | Same records, same period (6 years from closure); `whistleblowing` says it "replaces the interim complaint class when slice 24 lands", and `speak_up_concern` did | Retire `whistleblowing` (no table uses it) |
| `payroll_export` and `rota_and_timesheet` | Same period and trigger; the catalogue uses `rota_and_timesheet` for `payroll_export` | Keep `payroll_export` for the export record and fix the catalogue |
| `staff_survey_response` (12 months from close) and `staff_wellbeing` (2 years) | Both claim survey responses | DPO decides (question 2) |
| `medicines_stock_log`, `medicines_disposal_log`, `temperature_log` and `mar_chart` | The catalogue says `mar_chart` (8 years after care ends) for records the schedule keeps 2 or 3 years from the entry; temperature readings and most stock are about no person, so `care_ended` never fires | Follow retention.md; fix the catalogue |
| `quality_audit` | A class no table uses (catalogue says `organisation_document`) | Map `audit_record` and `audit_action` to it |
| `staff_file` | Used as a class by documents, `employee_case.retention_class` and the catalogue, but not a schedule row | Resolve to the tenant's chosen row in one domain function |

**Classes with no Phase 2 table.** `whistleblowing`, `staff_survey_response`, `lone_worker_check_in`
(above); `right_to_work_copy` (documents only); `cctv` (no table; `tenant_policy`);
`applicant.talent_pool`, `casework_no_sanction` and `outbreak_staff_case` (values a row takes, not
tables).

**The mapping table repeats itself.** Rows for the medication tables appear six times, and
`outbreak`, `outbreak_case`, `controlled_drug_entry`, the controlled drug page rows, `staff_profile`,
the induction tables, the casework tables, `letter` and the letter templates twice or more. Two pairs
disagree: the second `outbreak_case` row still says staff "follow it for now" (settled by H-767), and the
second casework row says "a shorter period for some cases is open" (settled by H-806, migration 0121).
A sweep driven from this table needs it cleaned first (slice 0). Done in slice 0 (08/11/2026), with rows added for the 32 tables above
(provisional, H-1557 and H-1558).

**Trigger dates with no column.** A compliment never closes (no `record_closed` date); a withdrawn DSAR
case has no withdrawal date; a disclosure request has no closed date; the end of the pay reference period
is not stored on shifts, clock events or timesheets; a Thapsus breach notice has no link to the tenant's
breach entry; an agency worker has no end date; a leaver's keep-until date is worked out once and does
not move if the tenant's row or the date of birth changes (workforce.md known gaps).

**Found by slices 2 and 3 (08/11/2026).** Building the registry against the schema found the
following; each is marked in the registry (`provisional`) and none changes a record.

- **The plan was wrong once.** `processor_breach_notice.breach_id` refers to the organisation's
  `dp_breach` entry, so a Thapsus breach notice does close with the breach it reports (no
  derived date needed, H-NEW-4 narrows).
- **Phase 0 and 1 tables with a class only in the export catalogue** (no mapping row in
  retention.md; the catalogue's class is used, for the DPO to confirm): `access_grant`,
  `role_assignment` and `support_access_request` (`audit_event`), `person_assignment`
  (`care_record`), `form_submission` and `notification` (the class of the record they link).
- **Tables with no class anywhere** (kept, never offered, until the DPO decides): the membership
  `tenant_user`, the organisation's officers on `tenant`, `notification_preference` and
  `operator_user` (kept while current); the sign-in schema `auth.user`, `auth.account`,
  `auth.passkey`, `auth.two_factor`, `auth.session` and `auth.verification` (removed with the
  sign-in or at expiry, but no sweep deletes expired sessions or verifications); `request_quota`
  (rewritten in place, never deleted); `integration_inbound` (staged inbound messages, no sweep);
  and the trigger of a `statutory_notification` with no incident (its submission, proposed).
- **Organisation material marked personal by the catalogue** (it names authors and approvers):
  `dependency_scale_version`, `policy_version`, `statement_of_purpose_version` and
  `letter_template_version` have entries under `organisation_document` (never offered), though
  section 3.1 lists the first two as holding no personal data. `homely_remedy_protocol` is mapped
  to `mar_chart` but is a location's configuration about no person; it is listed as holding none.
- **Clearing (H-1560) is not possible yet where a column is NOT NULL or a check needs it**:
  `audit_record.started_by`, `audit_action.owner_id`, `rota_publication.published_by`,
  `shift_assignment.worker_id`, `pay_run_line.member_id`, `pay_run_exception.member_id` and the
  `outbreak_case` check that a resident row names a person. These are deleted for now; keeping the
  anonymous row needs an expand migration (slice 8). Rotas, shifts and pay runs clear their
  personal columns; applicants are redacted; lone-worker locations keep today's clearing.
- **Classes the registry cannot yet tell apart per row**: a person closed without admission
  (`not_admitted`) takes `enquiry_not_assessed` and `pre_admission_not_admitted` together, the
  longer winning, until the sweep checks whether an assessment exists; `applicant.talent_pool` is
  applied by the sweep from `talent_pool_until`, not as a second class; `audit_event.care_record`
  waits for slice 14; a downtime pack in force during an outage is checked against outages; every
  kind of `absence` takes `sickness_absence`, whose notes name sickness only (DPO to confirm).
- **Parents and children with different periods**: a stock item (2 years from opening) is older
  than its movements and its disposals (3 years), and a controlled drug administration (also
  `mar_chart`) can outlive its register page. The purge (slice 10) must never delete a parent while a child is kept.
- **Phase 2 tables the catalogue marks not personal** but this inventory lists (`rota`, `shift`,
  `pay_run`, `outbreak`, `medicine_order`, `medicine_temperature_reading`, `audit_record`,
  `audit_action`, `import_batch`, `import_commit`, the breach notice tables,
  `payroll_export_result`, `pulse_survey_response`, `disclosure_item`, `lms_import`) have entries;
  their catalogue `personal` flag is unchanged.

**Two rules for the staff file choice.** `retainUntil` in `apps/api/src/routes/induction.ts` chooses
`staff_file.after_leaving` when the tenant has its own row for it, not from `tenant.staff_file_option`,
which the onboarding checklist records. The sweep needs one rule (question 8).

## 4. Gaps

1. **No row destruction.** No job or route destroys, clears or soft-deletes any Phase 2 row past its
   period (133 of 135 tables).
2. **Triggers.** Only `care_ended` and `created` are handled, and only for documents. `record_closed`,
   `last_entry` and `employment_ended_or_75th_birthday` are not, nor "longest wins" when a record has two
   classes, nor a class that varies by row, nor the tenant's staff file choice.
3. **No registry.** Nothing says, per table, which class applies, which column gives the trigger date,
   how the table links to a person or member of staff, which parent it is destroyed with, or whether it
   is deleted or cleared. The export catalogue has the class only, and disagrees with retention.md.
4. **No batch, review or grace period.** retention-and-deletion.md describes a nightly list, a tenant
   review with step-up, soft delete, a grace period (`[30]` days, to confirm) and then purge. The
   documents route skips straight to the tombstone.
5. **Database refuses deletion.** 98 tables refuse DELETE by trigger; there is no retention role or
   exception in `app.forbid_mutation`.
6. **Soft delete has nowhere to go** on the 64 tables without `deleted_at`; on the others `deleted_at`
   already has feature meanings (for example the Thapsus-HR link clears it on a leaver record), so a
   retention soft delete could be undone by ordinary code.
7. **Copies outside the row.** `record_version` copies, audit events (hash-chained), search vectors (go
   with the row), stored files linked to the record, DSAR bundles and devices.
8. **Legal holds are narrow.** A hold can name a resident or one record. It cannot name a member of
   staff, an applicant, a record type, a location or a date range, all of which
   [retention-and-deletion.md](../compliance/retention-and-deletion.md) section 3 promises. Open
   DSARs, complaints and safeguarding enquiries do not hold their records automatically, though
   retention.md says a hold should be placed "whenever" one concerns the record.
9. **Staged rows.** `lms_import_row` has no expiry like `import_row`.
10. **Document drift.** Section 4 of retention-and-deletion.md still says crypto-shredding is "not built
    yet" and has duplicated rows; the certificate field table has duplicate "Approval" and "Method" rows.

## 5. Proposed design

### 5.1 Principles

- Report before acting; propose before destroying; destroy one class at a time, shortest and least
  sensitive first, medicines and care records last.
- Nothing is destroyed without a person's approval (retention-and-deletion.md section 1). The sweep
  proposes; a reviewer with `platform.retention.manage` and step-up approves.
- A legal hold always wins, checked when the batch is proposed, when it is approved and again under the
  retention lock when rows are purged.
- One list of tables, one owner role, one exception in `app.forbid_mutation`, each pinned by a test, as
  sample-data removal is.
- No statutory figure in code: periods come from `retention_class`; the grace period and the batch size
  come from the rate table (`docs/specs/rates.md`).

### 5.2 Domain (tests first)

In `packages/domain/src/platform/retention.ts` (or a sibling `retention-sweep.ts`), pure functions with
table-driven tests, one case table per class row of retention.md:

| Function | Does |
| --- | --- |
| `resolveRule(recordClass, rows, tenant)` | The tenant's row, else the global row; `staff_file` resolves to the tenant's chosen row; an unknown class is `tenant_policy` (never destroyed) |
| `triggerDate(trigger, facts)` | One branch per trigger: `care_ended` (death, else discharge; a person still receiving care gives none), `last_entry` (the latest entry on the page), `record_closed` (closed date; an open record gives none), `employment_ended_or_75th_birthday` (via `staffFileRetainUntil`: never before employment ends), `created` (the creation date, or the end of the pay reference period or financial year when the class says so), `tenant_policy` (none) |
| `dueDate(rule, triggerDate)` | `addPeriod`, or the staff file date as computed |
| `longestWins(decisions)` | The latest due date of every class a record belongs to (a controlled drug administration: `controlled_drugs_register` and `mar_chart`) |
| `holdCovers(record, holds)` | Extends `isUnderLegalHold` to a member of staff, an applicant, a record class, a location and a date range, and treats an open DSAR case, complaint or safeguarding enquiry about the subject as a hold (question 11) |
| `sweepDecision(record, rules, holds, now)` | `retain` (until), `held`, `no_trigger_yet`, `tenant_policy` or `due` (since, rule), built on `retentionDecision` |

Tests: one row per class (period, unit, trigger, leap day and month-end cases, tenant override longer
than default, open record, person still in care, staff member still employed, 75th birthday before and
after leaving, hold on person, staff member, record, class, location and range, released hold, longest
wins). The domain coverage gate (90%) applies.

### 5.3 The retention registry

A typed registry, one entry per table that holds personal data (Phase 1 and Phase 2):

```ts
// Shape only, for discussion; not code to copy.
interface RetentionTable {
  table: string;                        // "lone_worker_session"
  recordClass: string | { column: string }; // fixed, or the row's retention_class column
  trigger: TriggerSource;               // how to read the trigger date (a named SQL fragment)
  subject: "person" | "staff" | "applicant" | "none"; // for holds and longest-wins
  parent?: string;                      // destroyed with this parent; children before parents
  method: "delete" | "clear_columns" | "tombstone";   // applicant: clear_columns (redact)
  documents?: "by_subject" | "by_person";             // stored files that go with it
}
```

Make it the single source: the export catalogue's `retention` field is derived from it (or checked
against it), so the DSAR erasure check and the sweep agree. A `packages/db` test fails when a table
with personal data (the catalogue's `personal: true`) has no entry, when an entry names a class that is
not a retention.md row, or when its trigger column does not exist. Split the registry into one file per
bounded context, so each PR stays small.

### 5.4 The worker job

- Queue `retention-sweep`, scheduled nightly (for example `29 2 * * *`, outside the busy hours), run
  through `eachTenant`, so one organisation's failure never stops another's and is logged as
  `worker.job.failed` and audited as the system.
- A mode per organisation and class, held as a tenant setting through OpenFeature: `off` (default),
  `report`, `propose`, `destroy`. The mode only ever moves one step at a time, and `destroy` is set per
  class.
- **Report mode** reads only: for each registry entry it counts records due, held, waiting for a
  trigger and under `tenant_policy`, and writes one audit event per tenant
  (`platform.retention.sweep_reported`, counts per class and table, no ids) and a row in a
  `retention_report` table (counts only) that `GET /v1/retention/due` shows. Nothing is changed.
- **Propose mode** also writes a `destruction_batch` (status `proposed`) per class with its
  `destruction_batch_item` rows (table, record id, class, trigger date, due date, subject reference).
  Items are append-only. A record already in an open batch is skipped. Batch size from the rate table.
- **Destroy mode** adds the purge of batches whose grace period has ended (5.6).
- Each batch is processed in its own transaction under the organisation's retention lock (the same
  advisory lock key the documents route and the hold routes take), so a hold placed meanwhile waits and
  is seen.

### 5.5 Soft delete

- A reviewer opens the proposed batch (counts per table, the rule, a sample of records they may read),
  and approves it with step-up (`platform.retention.manage`). Approval re-checks holds under the lock,
  drops held items (recorded as `held` on a new item state row, never deleted), and calls
  `app.retention_soft_delete(batch_id)`.
- That function sets `deleted_at` on every row in the batch. Two choices need the ADR:
  - **Option A (recommended): add `retention_deleted_at`** (nullable, no default) to each table in the
    registry, in expand migrations per context, so retention's soft delete cannot be confused with, or
    undone by, a feature's own `deleted_at`. A restrictive SELECT policy for `harbour_app`
    (`retention_deleted_at IS NULL`) hides the rows from every API read, search, export and DSAR
    collection in one place; the sync streams filter it too.
  - **Option B: reuse `deleted_at`**, adding it to the 64 tables without it, and audit every read path
    that ignores `deleted_at` or clears it.
- During the grace period (rate table key `retention.grace_days`, `[30]` days to confirm), a hold placed
  on any record in the batch restores it (`app.retention_restore`), and Thapsus support can restore a
  batch on the tenant's written request (retention-and-deletion.md section 1). Both are audited.

### 5.6 Purge, then the certificate

- At `grace_ends_at`, the worker (destroy mode) re-checks holds under the lock and calls
  `app.retention_purge(batch_id)`, which, in one transaction:
  1. deletes the rows children first (order from the registry), or clears the listed columns where the
     method is `clear_columns` (applicants: names and contact details, then `redacted_at`);
  2. deletes the `record_version` rows of those records, including those of a row whose columns were
     cleared, so no earlier copy keeps what was cleared;
  3. tombstones linked documents as the documents route does and publishes
     `platform.document.destroyed` for each, so the bytes go after commit and are retried;
  4. issues one signed `destruction_certificate` per class and table, with `subject_ids`, the rule and
     its retention.md version, the reviewer and step-up time, method (`row_delete`,
     `row_clear_columns`, `storage_delete_all_versions`), holds checked, and `backups_expire_at`
     (point-in-time recovery window); add a `batch_id` column to the certificate (expand migration);
  5. marks the batch `purged` with the certificate ids.
- DSAR bundles under `dsar/` in the exports bucket are deleted with their case in the same way (outbox
  event, retried).
- Crypto-shredding by key stays the whole-organisation path only (ADR-0109); per-record destruction of
  stored files is per-object deletion, as ADR-0109 decided. No per-subject keys are introduced.

### 5.7 Append-only and no-delete tables (ADR-0133)

- A new NOLOGIN role, `harbour_retention_owner`, created by `pnpm db:bootstrap`
  (`packages/db/src/admin/roles.ts`) with SET-only membership for `harbour_owner`; never a login role,
  never a superuser, never `BYPASSRLS`. It is narrower than a context definer but reaches every context,
  which ADR-0133's one-owner-per-context rule does not cover: the new ADR records why (one list, one
  exception, as `harbour_sample_owner` does for sample removal).
- It owns three `SECURITY DEFINER` functions, `app.retention_soft_delete`, `app.retention_restore` and
  `app.retention_purge`, each with `SET search_path = pg_catalog, public, pg_temp`, EXECUTE granted to
  `harbour_app` only, the ACL set before the owner changes (add-migration skill), and listed in
  `packages/db/test/definer-acls.test.ts`.
- Table names come only from a fixed list inside the database (`app.retention_tables()`, like
  `app.sample_removal_tables()`), never from an argument; each function checks the batch belongs to the
  tenant in context and is in the right state.
- Grants: DELETE on the listed tables and on `record_version`; UPDATE on `retention_deleted_at` (or
  `deleted_at`) and on the clearable columns only; the SELECT the row-level policies need. Pinned by
  `definer-acls.test.ts`.
- `app.forbid_mutation()` gains a third exception, replaced as its owner the way migration 0151 replaces
  functions: DELETE, or an UPDATE that changes only the retention column or the listed clearable
  columns, when `current_user = 'harbour_retention_owner'` and
  `current_setting('app.retention_destruction', true) = 'on'`; `record_version` is allowed only for
  DELETE by this role; `audit_event` stays refused (5.8). The table-level `no_delete` triggers use the
  same function, so they follow.
- Tests: a table in the registry but not in `app.retention_tables()` (or the reverse) fails; another role
  with the flag set is refused; this role without the flag is refused; another tenant's batch is
  refused; a held record is never deleted.

### 5.8 Audit events

- Every step is audited with ids and counts only: `platform.retention.sweep_reported`,
  `platform.retention.batch_proposed`, `platform.retention.batch_approved` (reviewer, step-up),
  `platform.retention.item_held`, `platform.retention.restored`, `platform.retention.purged`
  (certificate ids), `platform.retention.sweep_failed`.
- Audit events themselves are not destroyed by the first slices. They hold opaque ids and codes, plus a
  free-text `reason`. Destroying them needs a chain-aware design (for example, delete whole chain
  segments older than the class period and keep a signed anchor of the last hash), and the archive
  bucket's 365-day lock means archived copies outlive any deletion by up to a year. This is a later
  slice after the DPO answers question 4.

### 5.9 Report first

The first sweep that runs anywhere is report mode, on staging with demo data, then on a pilot tenant.
The report is the evidence for the DPO's sign-off of each class before its `destroy` mode is turned on.

## 6. Slices

Each slice is one PR of about 400 lines or fewer, in this order. The first four change nothing in any
tenant's data.

| # | Slice | Contents | Changes data? |
| --- | --- | --- | --- |
| 0 | Spec and ADR (`docs/retention-sweeps-spec`) | The ADR (section 8); retention.md mapping table de-duplicated and the 32 tables without a mapping row added (with the DPO's interim answers); retention-and-deletion.md section 4 and 5 drift fixed; the human actions in section 7 | No |
| 1 | Domain rules (`feat/platform-retention-rules`) | 5.2 with table-driven tests per class; no database | No |
| 2 | Registry, part 1 (`feat/platform-retention-registry`) | The type, the platform, people and care entries, and the `packages/db` test that a personal table without an entry fails (with an allow-list for the contexts not yet done); export catalogue alignment for those contexts. **Built 08/11/2026** with slice 3 in one branch: `packages/domain/src/platform/retention-registry/`, `packages/db/src/retention-registry.test.ts` | No |
| 3 | Registry, parts 2 to 4 | Workforce and scheduling; medicines; safety, quality and comms. Fix the catalogue's medicines, audit and payroll classes. The allow-list ends empty. **Built 08/11/2026** (`feat/platform-retention-registry`): 237 entries (the 135 Phase 2 tables, 96 Phase 0 and 1 tables and 6 sign-in tables) and 76 tables listed as holding no personal data; no allow-list was needed; 45 catalogue `retention` values corrected | No |
| 4 | Report-only sweep (`feat/platform-retention-report`) | `retention-sweep` queue in report mode, `retention_report` table (counts only, forced RLS), `GET /v1/retention/due`, audit event, tests with a clock | No (writes reports only) |
| 5 | Report screen | `/settings/retention` "Due for destruction" counts per class, with axe tests | No |
| 6 | Batches (`feat/platform-retention-batches`) | `destruction_batch`, `destruction_batch_item` (append-only), propose mode, list and cancel routes, step-up; no soft delete yet | No (proposals only) |
| 7 | Retention role and exception | Bootstrap role `harbour_retention_owner`; `app.retention_tables()`; `forbid_mutation` exception; grants; definer ACL tests; bootstrap before migration in every environment | No (capability only) |
| 8 | Retention column, by context (3 or 4 PRs) | `retention_deleted_at` expand migrations, the restrictive SELECT policy, sync stream filters | No |
| 9 | Soft delete and restore | `app.retention_soft_delete`, `app.retention_restore`, approve route with step-up, hold-on-grace restores, screen | Yes: hides rows |
| 10 | Purge and certificate | `app.retention_purge`, `record_version` deletion, linked documents, DSAR bundles, `batch_id` on certificates, destroy mode | Yes: deletes |
| 11 | Turn on classes, one PR each | In this order, each after the DPO signs off its report: `applicant.unsuccessful` (redaction, with versions), `staff_wellbeing`, `lone_worker`, `data_rights_case`, `dp_breach`, `sponsor_record`, `working_time_*`, `sickness_absence`, `training_record`, `rota_and_timesheet`, `staff_file` and casework, `speak_up_concern`, `complaint`, medicines logs, `controlled_drugs_register`, `mar_chart`, `care_record`, `serious_incident` | Yes |
| 12 | Legal hold scope | Holds on a member of staff, an applicant, a class, a location and a date range (expand migration on `legal_hold`), and the implicit holds of question 11 | No |
| 13 | Staged and orphaned files | `lms_import_row` expiry; an orphan sweep for files with no row | Yes |
| 14 | Audit events | After question 4: the chain-aware purge, or a recorded decision to keep them as ids only | Depends |

Slice 12 must land before slice 11 reaches any workforce class, because holds cannot yet name a member
of staff.

## 7. Questions for the DPO

Each is worded so it can go into [human-actions.md](human-actions.md) as it stands (owner: DPO). Slice 0
(08/11/2026) logged them there under "Phase 2: retention sweeps (plan and slice 0)". **Every answer is
provisional**: each took its recommended answer as an owner-accepted recommendation, pending DPO review
at the testing phase (ADR-0132), so no slice waits. Questions 6 to 12 carry placeholders (`H-NEW-1` to
`H-NEW-7`) until they are numbered at merge, as the next free numbers on `main` after H-1580.

| # | ID | Action | What the build produced | Unblocks |
| --- | --- | --- | --- | --- |
| 1 | H-1556 (provisional) | Confirm the grace period between soft delete and permanent deletion of records past retention (proposed: 30 days, as retention-and-deletion.md section 1), and that Thapsus support may restore a batch only on the organisation's written request in that time | This plan, section 5.5 | Slice 9 |
| 2 | H-1557 (provisional) | Decide which class governs routine lone-worker check-ins (`lone_worker_check_in`, 3 months from the check-in, or `lone_worker`, 3 years from the session's finish) and staff survey responses (`staff_survey_response`, 12 months from close, or `staff_wellbeing`, 2 years); retire the one not chosen, and retire `whistleblowing` in favour of `speak_up_concern` | Section 3.2 | Slices 0 and 11 |
| 3 | H-1558 (provisional) | Set classes for the tables that have none: deaths and missing episodes (`death_record`, `death_step`, `herbert_profile`, `missing_episode`, `missing_event`), the learning-system import (`lms_import`, `lms_import_row`, `lms_learner_link`), medicine orders (`medicine_order`, `medicine_order_line`), the Thapsus-HR link (`hr_person_link`, `hr_pay_rate`, `hr_pay_unit`), `evidence_link` and `shift_cover_need`; and confirm the classes named only in notes for complaints and compliments, audits, absences, wellbeing, payroll exports and medicines stock, disposal and temperature logs | Section 3.2 | Slice 0 |
| 4 | H-1559 (provisional) | Decide whether audit events about a destroyed record are destroyed with it (retention-and-deletion.md section 2) or kept for their own class (8 years from creation) as opaque ids, given they are hash-chained and archived in a bucket locked for 365 days; and whether the free-text `reason` must be cleared earlier | Section 2.4, 5.8 | Slice 14 |
| 5 | H-1560 (provisional) | Confirm that, where a record has organisational value (rota, pay runs, audits, outbreak line lists), clearing the personal columns and keeping the anonymous row is an acceptable alternative to deleting it, and for which classes | Section 5.3 (`clear_columns`) | Slices 3 and 11 |
| 6 | H-NEW-1 (provisional) | Confirm that one reviewer with `platform.retention.manage` and step-up may approve a destruction batch, or require a second person as the whole-organisation shred does | Section 5.5 | Slice 9 |
| 7 | H-NEW-2 (provisional) | Confirm that deleted rows leaving point-in-time recovery after 7 (or 35) days, stated on the certificate, meets the "crypto-shred" requirement for database rows, as ADR-0109 decided, or require field-level encryption first | ADR-0109; section 5.6 | Slice 10 |
| 8 | H-NEW-3 (provisional) | Confirm which setting decides the staff file period: the organisation's `staff_file_option` from the onboarding checklist, or whether it has its own `staff_file.after_leaving` row (today's code), and whether a keep-until date must be worked out again when the period or the date of birth changes | Section 3.2 | Slice 11 (`staff_file`) |
| 9 | H-NEW-4 (provisional) | Confirm the trigger dates where the record has no column: a compliment (never closes; propose 10 years from receipt), a withdrawn DSAR case (propose the withdrawal's audit time), a disclosure request (propose hand-over, else release), a Thapsus breach notice (propose its acknowledgement), an agency worker (propose the last booking), and the pay reference period end for rota and time records | Section 3.2 | Slices 2 and 3 |
| 10 | H-NEW-5 (provisional) | Confirm that records whose class is `tenant_policy` (organisation documents, CCTV) are never offered for destruction until the organisation sets a period | retention.md | Slice 4 |
| 11 | H-NEW-6 (provisional) | Decide whether an open DSAR case, complaint, safeguarding enquiry or employee relations case about a person or member of staff holds their records automatically, without someone placing a hold | Section 4 item 8 | Slice 12 |
| 12 | H-NEW-7 (provisional) | Confirm the order in which classes are turned on (section 6, slice 11) and that each needs the DPO's sign-off of its report from a pilot organisation first | Section 6 | Slice 11 |

## 8. Is an ADR needed?

Yes, one ADR before slice 7, drafted in slice 0 as
[ADR-0135](../decisions/0135-retention-row-destruction.md) (proposed; number confirmed at merge). It decides:

1. **Row destruction**: soft delete through a retention-only column (option A) or `deleted_at` (option
   B), a grace period, then hard delete or column clearing, with a signed certificate per batch, class
   and table; per-object deletion for stored files; no per-subject keys (confirming ADR-0109 for rows).
2. **The owner**: one NOLOGIN `harbour_retention_owner` reaching every context, with a fixed table list
   and a third `forbid_mutation` exception, as a recorded exception to ADR-0133's one owner per context,
   and why per-context owners were not chosen (a purge must delete children before parents across
   contexts in one transaction).
3. **The registry** as the single table-to-class source, with the export catalogue derived from or
   checked against it.
4. **`record_version`**: deleted with the record.
5. **Audit events**: out of scope for the first slices; kept until a chain-aware decision follows the
   DPO's answer.
6. **Modes and approval**: `off`, `report`, `propose`, `destroy` per class; nothing destroyed without a
   reviewer's step-up approval.
