# Retention schedule

The default retention periods the retention engine applies (master prompt sections 5.1 and 9.1, "Retention
and legal hold"). The seed script parses the table under **Retention schedule** into the tenant's
retention settings; application code never hard-codes a period. Tenants may lengthen a default (see
overrides below); every override is versioned, audited and needs a recorded reason.

## How the engine applies this schedule

- **Format**: the table under `## Retention schedule` has exactly one header row and one separator row,
  with columns `record_class | period | unit | trigger | source | notes`. `period` is a plain number and
  `unit` is `years` or `months`.
- **Triggers**: `care_ended` (the person's last placement or package ended, including death),
  `last_entry` (the last entry in the register or record), `record_closed` (the case, complaint, incident
  or agreement was closed or ended), `employment_ended_or_75th_birthday` (see the two staff file rows),
  `created` (the record was created; for period-based records such as timesheets, the end of the period
  it covers), `tenant_policy` (no product default: the tenant must set the period in its policy before
  records of that class are stored; `period` is then `0`).
- **Destruction date** = trigger date + period. When a record belongs to more than one class (for
  example a controlled-drug administration is both a register entry and part of the person's MAR), the
  longest period wins. A legal hold suspends destruction until it is lifted; place one whenever a DSAR,
  complaint, safeguarding enquiry, investigation, claim or inquest concerns the record.
- **Mechanism**: review of destruction batches, soft delete, grace period, cryptographic shredding and
  destruction certificates are specified in `docs/compliance/retention-and-deletion.md`. This file holds
  only the periods.
- **Overrides**: a tenant may lengthen a period or choose between options the schedule offers (the two
  staff file rows); it cannot set a period below a statutory minimum (controlled drugs, RIDDOR, NMW and
  Working Time records, right-to-work copies) or below the Records Code period in this schedule. CQC sets
  no retention periods; the NHS Records Management Code of Practice periods are the accepted standard.

## Retention schedule

| record_class | period | unit | trigger | source | notes |
| --- | --- | --- | --- | --- | --- |
| care_record | 8 | years | care_ended | NHS Records Management Code of Practice; master prompt 5.1 | Care plans, assessments, risk assessments, daily notes, observations and charts, body maps, consent and capacity records, DoLS records, About Me, and incidents that are not serious incidents. CQC sets no period. |
| mar_chart | 8 | years | care_ended | NHS Records Management Code of Practice; CQC guidance on medicines administration records; master prompt 5.1 | Medication administrations, PRN outcomes, covert administration records and the person's medicines list and reconciliation history. |
| controlled_drugs_register | 2 | years | last_entry | Misuse of Drugs Regulations 2001 (statutory minimum); master prompt 5.1 | Counted from the last entry on the register page (person, drug, form, strength). Entries that also record an administration stay for the longer mar_chart period. |
| complaint | 10 | years | record_closed | NHS Records Management Code of Practice; master prompt 5.1 | Reg 16 complaints, responses and appeals. Compliments follow the evidence library item they support. |
| serious_incident | 20 | years | record_closed | NHS Records Management Code of Practice; master prompt 5.1 | Incidents graded serious, with investigations, notifications, candour correspondence and disclosure packs. |
| riddor_report | 3 | years | created | RIDDOR 2013 (statutory minimum); master prompt 5.1 | The RIDDOR record and submission evidence. The underlying incident keeps its own (longer) class. |
| staff_file.after_leaving | 6 | years | employment_ended_or_75th_birthday | NHS Records Management Code of Practice; master prompt 5.1, 12 | Tenant option: 6 years after employment ends. The tenant selects this row or the next one for all staff files. |
| staff_file.to_75th_birthday | 0 | years | employment_ended_or_75th_birthday | NHS Records Management Code of Practice; master prompt 5.1, 12 | Default option (section 12 rules say staff files to the 75th birthday): kept until the person's 75th birthday, so the period after that trigger is 0. Never destroyed before employment has ended. |
| right_to_work_copy | 2 | years | record_closed | https://www.gov.uk/check-job-applicant-right-to-work (statutory guidance); master prompt 12.1 | Copies of right-to-work documents and check results, kept during employment and for 2 years after it ends (record_closed is the employment end date). |
| training_record | 10 | years | created | Master prompt 5.1 | From the date the training or competence sign-off was completed. |
| rota_and_timesheet | 6 | years | created | National Minimum Wage record-keeping; master prompt 5.1, 12 | Rotas, timesheets, clock-in events, sleep-in and travel-time records, pay calculations with their inputs. Counted from the end of the pay reference period. |
| working_time_record | 2 | years | created | Working Time Regulations 1998 (statutory minimum); master prompt 5.1, 12 | Working-time calculations and night-work assessments, counted from when the record was made. |
| working_time_opt_out | 2 | years | record_closed | Working Time Regulations 1998; master prompt 5.1 | Opt-out agreements, kept while in force and for 2 years after withdrawal or the end of employment. |
| financial_record | 6 | years | created | HMRC and Companies Act accounting records; master prompt 5.1 | Invoices, credit notes, charge lines, funding arrangements, remittances, residents' ledger entries, petty cash. Counted from the end of the financial year the record relates to. |
| water_hygiene_record | 5 | years | created | HSE ACoP L8 and HSG274; master prompt 13.4 | Legionella risk assessment actions, sentinel temperatures, flushing, descaling and TMV records. |
| organisation_document | 0 | years | tenant_policy | Master prompt 9.1 (document store: retention class per document) | Policies, procedures, statement of purpose versions and templates. Kept while current; the tenant's records policy sets how long superseded versions are kept, so the engine never offers them for destruction automatically. |
| cctv | 0 | months | tenant_policy | Master prompt 5.1 (CCTV per the tenant's policy); ICO CCTV guidance | No product default. The tenant sets the period in its CCTV policy and DPIA (starter template in 11.2) before any CCTV still or clip is attached to a record. |
| audit_event | 8 | years | created | NHS Records Management Code of Practice (record-keeping evidence); master prompt 5.3, 5.5 | Default for every audit event (logins, permission changes, exports, views, sync). Chosen so the audit trail supports a care record for its full Records Code period, well above the 6-month security-log minimum in section 5.3. |
| audit_event.care_record | 8 | years | care_ended | NHS Records Management Code of Practice; master prompt 5.5 | Audit events about a person's record are kept at least as long as that record (longest period wins), so the history view and signed exports for inspectors, coroners and courts stay complete. |
| security_log | 6 | months | created | Master prompt 5.3; NCSC logging guidance | Floor for security logs outside `audit_event` (authentication service, WAF, infrastructure). Logs carry opaque IDs only, never personal data. |
| ai_interaction_log | 12 | months | created | Master prompt 16.2 | Pseudonymised prompts, context sets, model and version, outputs and user actions from the AI gateway. |

## Mapping of Phase 0 and Phase 1 tables to record classes

| Table or record | Record class |
| --- | --- |
| `person`, `contact`, `allergy`, `placement`, `about_me` | care_record |
| `pre_admission_assessment`, `admission_decision`, `admission_condition`, `bed_occupancy`, `welcome_checklist_item`, `property_item`, `key_issue`, `care_plan_change`, `review_record`, `hospital_transfer`, `exit_record`, `exit_checklist_item`, `sharing_decision`, `about_me_share_link` ([people.md](people.md)) | care_record |
| `break_glass_event`, `break_glass_weekly_report` | audit_event |
| `care_plan`, `care_plan_item`, `assessment`, `risk_assessment`, `care_note`, `observation`, `capacity_record`, `dols_authorisation` | care_record |
| `incident` (not serious), `investigation` | care_record |
| `incident` (serious), `notification` | serious_incident |
| `medication`, `medication_schedule`, `medication_administration` | mar_chart |
| `controlled_drug_entry` | controlled_drugs_register (and mar_chart for administrations) |
| `staff_profile`, `compliance_item`, `er_case` | staff_file (tenant's chosen row) |
| `training_record`, `competence` | training_record |
| `shift`, `timesheet_entry` | rota_and_timesheet |
| `ledger_entry`, `invoice`, `charge_line`, `funding_arrangement` | financial_record |
| `compliance_check` for water systems | water_hygiene_record |
| `audit_event` | audit_event, extended by audit_event.care_record |
| `document` | by category: photos, care attachments and documents about a person follow `care_record`; organisation documents `organisation_document` |
| `document_signature` | the class of the signed document |
| `legal_hold`, `destruction_certificate` | kept permanently (proof of records management); never destroyed by the engine |
| `task`, `task_series`, `workflow_instance`, `workflow_transition` | the class of the record they concern (care_record for tasks about a person) |

## Gaps to settle before the module that needs them ships

These record types have no period in the master prompt, so no row exists yet. Each needs an ADR or a
spec decision (with its source) before its module ships; until then the engine treats them as the class
of the record they attach to.

- Enquiries and pre-admission assessments of people who are never admitted (Phase 1 people lifecycle;
  human action H-39). Until a period is set they follow care_record, counted from the date the
  enquiry closed.
- Unsuccessful job applicants' data (Phase 2 recruitment).
- DBS certificate information: the DBS code of practice limits how long certificate details may be kept;
  confirm the period before the Phase 2 pre-employment file stores them.
- DSAR cases, breach register entries and data-protection complaints (Phase 2).
- ECM visit events (Phase 4): likely care_record and rota_and_timesheet together (longest wins).
- Children's home records (Phase 7), which have their own statutory periods.
