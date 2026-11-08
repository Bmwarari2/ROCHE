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
  complaint, safeguarding enquiry, investigation, claim or inquest concerns the record. An open DSAR
  case, complaint, safeguarding enquiry or employee relations case is to hold its subject's records
  automatically while it is open (provisional, H-1586; built in slice 12 of
  [the retention sweeps plan](../plans/retention-sweeps.md); until then a hold is placed by hand).
- **No period, no destruction**: records of a `tenant_policy` class are never offered for destruction
  until the organisation sets a period (provisional, H-1585).
- **Staff files**: the organisation's `staff_file_option`, chosen at onboarding, picks the staff file
  row; the keep-until date is worked out again whenever the period or the date of birth changes
  (provisional, H-1583).
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
| complaint | 10 | years | record_closed | NHS Records Management Code of Practice; master prompt 5.1 | Reg 16 complaints, responses and appeals. Compliments follow the evidence library item they support; until the evidence library (slice 14) lands they are stored with this class. |
| serious_incident | 20 | years | record_closed | NHS Records Management Code of Practice; master prompt 5.1 | Incidents graded serious, with investigations, notifications, candour correspondence and disclosure packs. |
| riddor_report | 3 | years | created | RIDDOR 2013 (statutory minimum); master prompt 5.1 | The RIDDOR record and submission evidence. The underlying incident keeps its own (longer) class. |
| staff_file.after_leaving | 6 | years | employment_ended_or_75th_birthday | NHS Records Management Code of Practice; master prompt 5.1, 12 | Tenant option: 6 years after employment ends. The tenant selects this row or the next one for all staff files. |
| staff_file.to_75th_birthday | 0 | years | employment_ended_or_75th_birthday | NHS Records Management Code of Practice; master prompt 5.1, 12 | Default option (section 12 rules say staff files to the 75th birthday): kept until the person's 75th birthday, so the period after that trigger is 0. Never destroyed before employment has ended. |
| casework_no_sanction | 6 | years | record_closed | Limitation Act 1980 s 5 (six-year period for contract claims); ICO employment practices guidance; H-806 recommended answer, 31/10/2026 | Employee relations cases that ended without a sanction, dismissal or referral and concerned no safeguarding: grievances, cases with no case to answer and withdrawn cases. Counted from the case's closing date (record_closed). Set by the database as the case closes; subject to legal hold. Reviewed at testing. |
| right_to_work_copy | 2 | years | record_closed | https://www.gov.uk/check-job-applicant-right-to-work (statutory guidance); master prompt 12.1 | Copies of right-to-work documents and check results, kept during employment and for 2 years after it ends (record_closed is the employment end date). |
| sickness_absence | 6 | years | record_closed | Limitation Act 1980 s 5 (contract claims); HMRC guidance on keeping sick pay records; master prompt 5.1, 12 | Sickness absences, fit notes, return to work records and SSP workings, counted from the end of the absence. Health data: special category (H-973). |
| applicant.unsuccessful | 6 | months | record_closed | ICO Employment Practices Code, recruitment and selection (keep only as long as needed to answer a claim); Equality Act 2010 s.123 (six-month claim window for most claims, plus early conciliation); master prompt 12.1 | Applicants whose last application closed without being hired: their details, applications, stage history, interviews and offers. Counted from the closing date of their last application (record_closed). Equality monitoring forms follow it from the vacancy's closing date. A hired applicant's record follows the staff file instead. Thapsus Care default for the DPO to confirm (H-732). |
| applicant.talent_pool | 12 | months | created | UK GDPR Art 6(1)(a) and 7 (consent, withdrawable at any time); Art 5(1)(e); master prompt 12.1 | The talent pool: an applicant who agreed is kept until 12 months after the consent was recorded (created), or until they withdraw it, if later than their applicant.unsuccessful date. Thapsus Care default for the DPO to confirm (H-732). |
| sponsor_record | 2 | years | record_closed | Home Office workers and temporary workers guidance for sponsors, part 3 and Appendix D (record keeping; verify, H-901, which supersedes the 1 year of the recommended answer to H-525); master prompt 12.1 | Sponsored worker records, absence monitoring and reportable changes. Kept for a year after sponsorship ends (verify) and never less than the 2 years after employment ends kept for right to work copies, whichever is later. Sponsorship never outlasts the employment, so the period counts 2 years from record_closed, the later of the two end dates. An adviser checks Appendix D at testing, including National Insurance number and payslip evidence. Recommended answer applied 31/10/2026 (review at testing). |
| training_record | 10 | years | created | Master prompt 5.1 | From the date the training or competence sign-off was completed. |
| staff_wellbeing | 2 | years | created | Thapsus Care default (scheduling.md section 20); no statutory period | Recognition notes and wellbeing check-ins (`recognition`, `wellbeing_check_in`): kept 2 years from when they were made, then destroyed. Survey answers and who took part follow staff_survey_response instead (provisional, H-1557); until 08/11/2026 this class also claimed them. DPO to confirm (H-1082). |
| rota_and_timesheet | 6 | years | created | National Minimum Wage record-keeping; master prompt 5.1, 12 | Rotas, timesheets, clock-in events, sleep-in and travel-time records, pay calculations with their inputs. Counted from the end of the pay reference period. |
| working_time_record | 2 | years | created | Working Time Regulations 1998 (statutory minimum); master prompt 5.1, 12 | Working-time calculations and night-work assessments, counted from when the record was made. |
| working_time_opt_out | 2 | years | record_closed | Working Time Regulations 1998; master prompt 5.1 | Opt-out agreements, kept while in force and for 2 years after withdrawal or the end of employment. |
| financial_record | 6 | years | created | HMRC and Companies Act accounting records; master prompt 5.1 | Invoices, credit notes, charge lines, funding arrangements, remittances, residents' ledger entries, petty cash. Counted from the end of the financial year the record relates to. |
| water_hygiene_record | 5 | years | created | HSE ACoP L8 and HSG274; master prompt 13.4 | Legionella risk assessment actions, sentinel temperatures, flushing, descaling and TMV records. |
| organisation_document | 0 | years | tenant_policy | Master prompt 9.1 (document store: retention class per document) | Policies, procedures, statement of purpose versions and templates. Kept while current; the tenant's records policy sets how long superseded versions are kept, so the engine never offers them for destruction automatically. |
| downtime_pack | 1 | months | created | Thapsus Care default for data minimisation (UK GDPR Art 5(1)(c) and (e)); master prompt 13.4 | Nightly downtime packs and their snapshots. Each is replaced the next night, so a copy is kept only long enough to answer "what did the pack say?". A pack in force during a declared outage is kept as downtime_record instead. Printed copies are shredded when replaced (deployer control). DPO to confirm (H-96). |
| downtime_record | 8 | years | record_closed | NHS Records Management Code of Practice (as care_record); master prompt 13.4 | Outage windows, their reconciliation and the downtime packs in force during them: the evidence for every back-entry's late time. Counted from reconciliation, and never destroyed while a back-entry that cites the outage is kept (the engine checks the citing records first). |
| evidence_pack | 6 | years | created | Limitation Act 1980 ss.2 and 5 (six-year period for claims, as the basis for keeping proof of a disclosure); master prompt 11.2 | The inspector evidence pack's manifest: recipient, purpose, items with record ids and versions, redactions with reasons, watermark, link issue, opens and revocation. The rendered PDF bundle is deleted when its link expires or is revoked; the manifest can rebuild it from the record versions. Thapsus Care default for the DPO to confirm (H-96). |
| cctv | 0 | months | tenant_policy | Master prompt 5.1 (CCTV per the tenant's policy); ICO CCTV guidance | No product default. The tenant sets the period in its CCTV policy and DPIA (starter template in 11.2) before any CCTV still or clip is attached to a record. |
| audit_event | 8 | years | created | NHS Records Management Code of Practice (record-keeping evidence); master prompt 5.3, 5.5 | Default for every audit event (logins, permission changes, exports, views, sync). Chosen so the audit trail supports a care record for its full Records Code period, well above the 6-month security-log minimum in section 5.3. |
| audit_event.care_record | 8 | years | care_ended | NHS Records Management Code of Practice; master prompt 5.5 | Audit events about a person's record are kept at least as long as that record (longest period wins), so the history view and signed exports for inspectors, coroners and courts stay complete. |
| security_log | 6 | months | created | Master prompt 5.3; NCSC logging guidance | Floor for security logs outside `audit_event` (authentication service, Cloud Armor and the load balancer, infrastructure), and the search audit events that showed no person receiving care, which carry `scope.retentionClass` `security_log` (recommended answer to H-121, 31/10/2026). In production they sit in a locked Cloud Logging bucket in europe-west2, kept 400 days by default ([ADR-0098](../decisions/0098-production-on-google-cloud.md)). Logs carry opaque IDs only, never personal data. |
| ai_interaction_log | 12 | months | created | Master prompt 16.2 | Pseudonymised prompts, context sets, model and version, outputs and user actions from the AI gateway. |
| dpia | 8 | years | record_closed | Interim: as audit_event (UK GDPR Art 5(2) and 35 accountability evidence); #81 security review | DPIA versions: the prefill, the organisation's answers, residual risks, the preparers and the signature bound to the version read. Counted from when a later signed version supersedes it (record_closed), so the DPIA in force is never offered for destruction. Interim period: the DPO sets it (H-115). |
| invitation | 12 | months | created | Thapsus Care default for data minimisation (UK GDPR Art 5(1)(c) and (e)); #43 review M4 | Invitations to join an organisation. The address is cleared as soon as the invitation is accepted, revoked or lapses (a nightly sweep), so a closed invitation holds opaque ids and times only; the audit trail keeps who was given access, by whom and when, for its own period. DPO to confirm (H-355). |
| lone_worker | 3 | years | record_closed | Limitation Act 1980 s.11 (three years for a personal injury claim, as the basis for keeping the record of a lone worker's safety); Thapsus Care default, slice 46 | Lone-working sessions, their check-in, help, duress and finish events, and their alarms with how each ended (`lone_worker_session`, `lone_worker_event`, `lone_worker_alarm`; [scheduling.md](scheduling.md) section 19). Counted from when the session finished (record_closed). An alarm that led to an incident is kept with that incident too, by the incident's own class (a serious incident's 20 years). Employee monitoring: never used to judge performance (H-527). DPO to confirm in the employee-monitoring DPIA (H-1033). Routine check-ins with no alert follow their session under this class too: lone_worker_check_in is retired (provisional, H-1557). |
| speak_up_concern | 6 | years | record_closed | Limitation Act 1980 (six years for claims; a whistleblowing detriment claim reaches the employment tribunal much sooner); verify against the NHS Records Management Code of Practice 2023 | Speak-up concerns, their messages, reporters and case members (`speak_up_concern`, `speak_up_message`, `speak_up_reporter`, `speak_up_case_member`; ADR-0089). Counted from when the concern closed. A legal hold keeps any concern under a claim or tribunal. Replaces the 10 years borrowed from `complaint` (H-721, recommended answer applied 31/10/2026; DPO to confirm at testing). |
| outbreak_staff_case | 3 | years | record_closed | RIDDOR 2013 regulation 12 (3 years) and the 3-year personal injury limitation period (Limitation Act 1980 s.11) | Staff rows on an outbreak's line list (`outbreak_case` of type `staff` or `staff_unnamed`), counted from the outbreak's closure. `care_record`'s trigger never fires for a member of staff, so staff rows needed their own class (H-767, recommended answer applied 31/10/2026). Residents' rows stay `care_record`. |
| data_rights_case | 3 | years | record_closed | NHS Records Management Code of Practice 2023 (subject access requests and disclosure correspondence: 3 years after closure); ADR-0090 | Data subject requests (`dsar_case`, `dsar_item`): the request, identity check (how, never the document), clock dates, decisions and reasons per record, the outcome and the bundle's hash. Counted from the response or withdrawal (record_closed). The case holds table and record ids; the bundle as issued is kept in the exports bucket under `dsar/`, which the exports' 30-day expiry does not reach, and destroyed with the case. A case under complaint to the ICO or in litigation is kept longer by a legal hold. Data protection complaints (`dp_complaint`) and the disclosure log (slice 41) use this class too (recommended answers to H-525 and H-670, 31/10/2026). DPO to confirm (H-613). |
| enquiry_not_assessed | 12 | months | record_closed | No statutory period (recommended answer to H-39, 31/10/2026; DPO reviews at testing, verify): the Local Government and Social Care Ombudsman's 12-month time limit (Local Government Act 1974 s.34D(4)); UK GDPR Art 5(1)(e) | An enquiry about a person that closed without a pre-admission assessment (the `person` row and its contacts while the person stays at `enquiry`), counted from when the enquiry closed. A legal hold while a complaint about it is open. |
| pre_admission_not_admitted | 3 | years | record_closed | No statutory period (recommended answer to H-39, 31/10/2026; verify): Limitation Act 1980 s.11 (three years for personal injury), which also covers an Equality Act 2010 claim (s.118, six months) and the Ombudsman's 12 months | A pre-admission assessment and the decision not to admit (`pre_admission_assessment`, `admission_decision` and its conditions) of a person who was never admitted, counted from the decision not to admit or the withdrawal (record_closed). A person who is later admitted moves to care_record. A legal hold while a complaint is open. |
| family_notification_delivery | 12 | months | created | Thapsus Care default for data minimisation (UK GDPR Art 5(1)(c) and (e)); recommended answer to H-106, 31/10/2026 (verify) | Delivery logs of family notifications (address, template id, channel, status; never update content), counted from sending. Opt-outs and bounce suppressions are not in this class: they stay with the contact (care_record) for as long as the address is held, so an opted-out address is never sent to again, and are deleted with the contact. |
| dp_breach | 6 | years | record_closed | Limitation Act 1980 ss.2 and 5 (six years, covering ICO action and UK GDPR Art 82 claims); recommended answer to H-670, 31/10/2026 (verify) | Breach register entries (`dp_breach`), Thapsus breach notices (`processor_breach_notice`) and their acknowledgements (`processor_breach_notice_ack`), counted from closure of the breach (for a notice, the breach it reports; with no register entry, its acknowledgement). Extended only by a legal hold while an ICO case or claim is open. |
| whistleblowing | 6 | years | record_closed | Limitation Act 1980 ss.2 and 5 (six years for a claim); recommended answer to H-525, 31/10/2026 (verify) | Retired (provisional, H-1557, 08/11/2026): replaced by speak_up_concern, which slice 24 built with the same period; no table uses this class. The row stays for its history. Was: concerns raised under speaking up (slice 24), their messages and outcome, counted from closure, replacing the interim `complaint` class (H-721). |
| medicines_stock_log | 2 | years | created | Misuse of Drugs Regulations 2001 reg 23 (two years, the controlled drugs register minimum, applied by analogy); recommended answer to H-525, 31/10/2026 (verify) | Medicines stock counts and receipts (Phase 2 eMAR), counted from the entry. Controlled drug entries keep controlled_drugs_register; an administration keeps mar_chart (longest wins). |
| medicines_disposal_log | 3 | years | created | Hazardous Waste (England and Wales) Regulations 2005 reg 49 (consignment notes kept three years); recommended answer to H-525, 31/10/2026 (verify) | Medicines disposal and returns, with the consignment note reference, counted from the entry. |
| temperature_log | 2 | years | created | As medicines_stock_log (two years, by analogy with the controlled drugs register minimum); recommended answer to H-525, 31/10/2026 (verify) | Medicines fridge and room temperature readings, counted from the reading. Water system temperatures stay water_hygiene_record. |
| quality_audit | 5 | years | record_closed | NHS Records Management Code of Practice 2023 (clinical audit records, 5 years); recommended answer to H-525, 31/10/2026 (verify) | Audits (slice 19): the audit, its answers, findings and actions, counted from completion. |
| staff_survey_response | 12 | months | record_closed | Thapsus Care default for data minimisation (UK GDPR Art 5(1)(c) and (e)); recommended answer to H-525, 31/10/2026 (verify) | Individual staff survey responses and who took part (`pulse_survey_response`, `pulse_survey_participation`), counted from the survey's close (chosen over staff_wellbeing; provisional, H-1557). The results are kept as organisation_document. |
| lone_worker_check_in | 3 | months | created | Thapsus Care default for data minimisation (UK GDPR Art 5(1)(c) and (e); employee monitoring); recommended answer to H-525, 31/10/2026 (verify) | Retired (provisional, H-1557, 08/11/2026): routine check-ins follow lone_worker (3 years from the session's finish) with their session; no table uses this class. The row stays for its history. Was: routine lone-worker check-ins with no alert, counted from the check-in. |
| payroll_export | 6 | years | created | National Minimum Wage Regulations 2015 reg 59 (six years from the end of the pay reference period); recommended answer to H-525, 31/10/2026 | The record of each payroll export (who, when, period, counts, file hash), counted from the end of the pay reference period. The export file itself is deleted when its link expires and is never kept as a record. |

## Mapping of tables to record classes

Each table appears once. Slice 0 of the [retention sweeps plan](../plans/retention-sweeps.md)
(08/11/2026) removed repeated rows; where two disagreed, the later decision was kept: staff rows of
`outbreak_case` take outbreak_staff_case (H-767), and employee relations cases closed without a
sanction take casework_no_sanction (H-806, migration 0121). The same slice added the 32 Phase 2 tables
that had no row (15 with no class and 17 named only in a class's notes), each marked provisional with
its human action. Where a record has organisational value (rota, pay runs, audits, outbreak line
lists), the retention engine may clear its personal columns and keep the anonymous row; every other
record is deleted (provisional, H-1560).

| Table or record | Record class |
| --- | --- |
| `person`, `contact`, `allergy`, `placement`, `about_me` | care_record |
| `pre_admission_assessment`, `admission_decision`, `admission_condition` of a person who is admitted, `bed_occupancy`, `welcome_checklist_item`, `property_item`, `key_issue`, `care_plan_change`, `review_record`, `hospital_transfer`, `exit_record`, `exit_checklist_item`, `sharing_decision`, `about_me_share_link` ([people.md](people.md)) | care_record |
| `break_glass_event`, `break_glass_weekly_report` | audit_event |
| `device_binding`, `device_session`, `device_discard_entry`, `handed_over_entry` (Care mode devices, the sessions bound to them, the entries their deletions listed and the entries hand-overs sent; [care.md](care.md) section 6) | audit_event |
| `refused_entry` (the server copy of an entry the API refused from a device) | care_record |
| `device_discard_record` (one row per stage of a deletion of unsent entries, with its coded reason; [care.md](care.md) section 6, Device integrity part 8) | audit_event |
| `entry_device_deletion_flag` (the server's flag on an entry its device recorded deleting) | care_record, as the entry |
| `discard_reason`, `escalation_policy_link` (the organisation's coded deletion reasons and the escalation policy each validated tool's result links; [care.md](care.md) section 5) | tenant configuration, kept while current; each change kept in `record_version` and the audit trail |
| `care_plan`, `care_plan_item`, `assessment`, `risk_assessment`, `care_note`, `observation` | care_record |
| `consent_record`, `capacity_assessment`, `best_interests_decision`, `dols_authorisation`, `dols_legal_change_review` | care_record |
| An enquiry that closed without an assessment; a pre-admission assessment, decision and conditions of a person never admitted (H-39) | enquiry_not_assessed; pre_admission_not_admitted |
| `safeguarding_concern` (the safeguarding log; [safety.md](safety.md) "Safeguarding log"; DPO to confirm, H-596) | serious_incident |
| `incident` with `retention_class` `care_record` (no notification applies), and its `incident_person`, `classifier_answer` and `investigation` rows | care_record |
| `incident` with `retention_class` `serious_incident` (set once any notification applies), its people, answers, `candour_record` and `investigation`, and `statutory_notification` | serious_incident |
| `statutory_notification` of a RIDDOR kind (`riddor_*`) | riddor_report (the incident keeps serious_incident; longest wins) |
| `medication`, `medication_schedule`, `medication_administration`, `medication_administration_witness`, `medication_dosing_record`, `medication_administration_conflict`, `medication_reconciliation`, `medication_reconciliation_source`, `medication_reconciliation_item`, `medication_reconciliation_decision`, `covert_medication_record`, `self_administration_assessment`, `homely_remedy_protocol`, `homely_remedy_administration` | mar_chart |
| `controlled_drug_entry` | controlled_drugs_register (and mar_chart for administrations) |
| `controlled_drug_page`, `controlled_drug_witness_assertion`, `controlled_drug_stock_check` | controlled_drugs_register |
| `staff_profile`, `compliance_item`, `er_case` | staff_file (tenant's chosen row) |
| `outbreak` ([safety.md](safety.md) section 11) | serious_incident, as its UKHSA report |
| `outbreak_case` | care_record for residents; outbreak_staff_case for staff, named or unnamed (H-767) |
| `medication_error` (slice 45; one per medication incident, kept with its incident) | serious_incident |
| `medication_review` (slice 45) | mar_chart |
| `prn_protocol`, `prn_outcome` | mar_chart |
| `vetting_consent`, `vetting_check` (identity and vetting adapters, slice 77; [workforce.md](workforce.md) section 2e) | staff_file (tenant's chosen row), as the staff file they belong to; a check's result holds no certificate content |
| `employee_case`, `employee_case_member`, `employee_case_hearing`, `employee_case_event` (employee relations casework, slice 39; [workforce.md](workforce.md) section 2d) | staff_file (tenant's chosen row), from the end of the employment of the member of staff the case is about; a warning that has stopped counting (`warning_expires_on`) is kept as the record of the decision, never used again; a grievance, a case with no case to answer and a withdrawn case take `casework_no_sanction` (6 years after closure) instead, as the database sets `employee_case.retention_class` when the case closes (H-806, migration 0121); a case ending in a sanction, dismissal or referral, or concerning safeguarding, stays with the staff file. `casework_support_ticket` (H-804) follows the staff file. A restricted silo: the retention engine's destruction batches reach it as the system, and its certificates carry ids only |
| `induction_plan`, `staff_checklist_item`, `shadow_shift`, `probation_review`, `care_certificate_progress`, `leaver_record`, `reference_request` (induction and leavers, slice 29; [workforce.md](workforce.md) section 2e) | staff_file (tenant's chosen row), from the leaving date; `leaver_record.staff_file_retain_until` holds the date worked out when the leaving is recorded (rule 23; the birthday age is `retention.staff_file.birthday_age`, H-874, H-875) |
| `applicant`, `application`, `application_event`, `interview`, `job_offer` (slice 23) | applicant.unsuccessful, or applicant.talent_pool when later; a hired applicant's records follow the staff file |
| `equality_monitoring` (slice 23) | applicant.unsuccessful, from the vacancy's closing date |
| `job_template`, `vacancy` (slice 23) | organisation_document |
| `document` of category `staff_hr_document` (HR-only staff documents, slice 11) | staff_file; right to work copies `right_to_work_copy` (2 years after employment ends) |
| `task` of kind `workforce.compliance_expiry` (staff check expiry reminders) | staff_file, as the compliance item it concerns |
| `sponsored_worker`, `sponsor_absence`, `sponsor_report` (slice 35) | sponsor_record (2 years after employment ends, never less than right to work copies; H-901 recommended answer, review at testing) |
| `staff_privacy_acknowledgement`, `staff_image_consent`, `ldss_claim` (slice 35) | staff_file (tenant's chosen row) |
| `training_record`, `competence` | training_record |
| `competence_sign_off`, `competence_withdrawal`, `revalidation_evidence` (slice 17) | training_record |
| `elearning_attempt`, `elearning_statement` (slice 43) | training_record |
| `elearning_course` and its `document` of category `elearning_package` (slice 43) | organisation_document (organisation material, not personal data) |
| `supervision_record` (slice 17) | staff_file (tenant's chosen row) |
| `supervision_note` (slice 57, ADR-0114) | staff_file (tenant's chosen row), with its supervision; append-only, destroyed only with the staff file |
| `training_requirement` (slice 17) | tenant configuration, kept while current; each change kept in `record_version` |
| `task` of kind `workforce.training_expiry` or `workforce.competence_expiry` | training_record, as the record it concerns |
| `shift_template`, `shift_pattern`, `rota`, `rota_publication`, `shift`, `shift_assignment`, `roster_override` ([scheduling.md](scheduling.md) section 14, slice 21) | rota_and_timesheet; never deleted (archived, cancelled or removed with a reason); publications and overrides append-only |
| `agency`, `agency_worker`, `agency_booking`, `location_induction`, `agency_worker_feedback`, `agency_awr_record` ([scheduling.md](scheduling.md) section 15, slice 27) | rota_and_timesheet; agencies archived, bookings cancelled, never deleted; inductions and feedback append-only |
| `clock_setting`, `clock_event`, `timesheet_entry`, `sleep_in_awake_period` ([scheduling.md](scheduling.md) section 16, slice 30) | rota_and_timesheet, counted from the end of the pay reference period; clock events and awake periods append-only; approved entries corrected by superseding, never changed |
| `working_time_opt_out` (slice 30) | working_time_opt_out |
| `working_time_result` (slice 30) | working_time_record |
| `pay_rule_set`, `pay_run`, `pay_run_line`, `pay_run_exception` ([scheduling.md](scheduling.md) section 18, slice 36) | rota_and_timesheet, counted from the end of the pay period; lines append-only; locked runs never changed, corrected in a later run; rule sets kept while a run cites them |
| `pay_profile` (slice 36) | staff_file (tenant's chosen row) |
| `ledger_entry`, `invoice`, `charge_line`, `funding_arrangement` | financial_record |
| `compliance_check` for water systems | water_hygiene_record |
| `audit_event` | audit_event, extended by audit_event.care_record |
| `document` | by category: photos, care attachments and documents about a person follow `care_record`; organisation documents `organisation_document` |
| `document_signature` | the class of the signed document |
| `signature_request` ([integrations.md](integrations.md) section 11, slice 79) | the class of the document asked to be signed (organisation documents: `organisation_document`) |
| `ocr_extraction`, `ocr_field` ([integrations.md](integrations.md) section 11, slice 79) | care_record: the scanned MAR chart and the values a person decided from it are part of the person's medicines record, kept with the image document |
| `legal_hold`, `destruction_certificate` | kept permanently (proof of records management); never destroyed by the engine |
| `task`, `task_series`, `workflow_instance`, `workflow_transition` | the class of the record they concern (care_record for tasks about a person) |
| `handover`, `handover_item`, `handover_note`, `handover_acknowledgement` ([care.md](care.md) rule 8) | care_record: a handover is a record of the care handed over at a location, kept as long as the care records it lists |
| `downtime_pack` ([operations.md](operations.md)) | downtime_pack, or downtime_record when in force during a declared outage |
| `outage` | downtime_record |
| Back-entered care events (the back-entry columns on `care_note`, `observation` and the others) | care_record, as the event |
| `evidence_pack`, `evidence_pack_item`, `evidence_pack_link`, `evidence_pack_link_code` ([quality.md](quality.md)) | evidence_pack; the rendered bundle is deleted when the link ends |
| `evidence_pack_bundle` | deleted (content cleared) when the link ends or the pack is revoked or discarded (migration 0057); the row stays as proof of the deletion under evidence_pack |
| `medicine_list_item` ([medicines.md](medicines.md) section 16) | organisation_document |
| `dependency_scale`, `dependency_scale_version` ([scheduling.md](scheduling.md) section 13) | organisation_document; a version a rota rests on is kept at least as long as that rota (rota_and_timesheet) until the DPO decides (H-711) |
| `dependency_assessment` (a person's dependency category) | care_record |
| `letter` | `retention_class` per row: serious_incident for an incident or candour letter about an incident graded serious, otherwise care_record (`letterRetentionClass`; migration 0059) |
| `statement_of_purpose_version`, `letter_template`, `letter_template_version` ([comms.md](comms.md)) | organisation_document |
| `policy`, `policy_version` ([quality.md](quality.md) section 19) | organisation_document |
| `policy_signature` (read-and-sign records) | training_record (from signing; H-742) |
| `quality_indicator_target` ([quality.md](quality.md) section 22) | organisation_document (no personal data) |
| `task` of kind `quality.policy_read_and_sign` or `quality.policy_review` | as the policy version it concerns |
| `feed_item`, `feed_item_withdrawal`, `visit_booking` ([comms.md](comms.md)) | care_record; photo updates and their photo documents stay care_record after photo consent is withdrawn (taken down from the feed, kept as the history of what was shared) |
| `feed_view` (what a family member saw, under which decision) | audit_event.care_record |
| `family_channel`, `family_notification_setting` | care_record, with the contact; push tokens are deleted when the device signs out, not retained |
| `family_notification` and its deliveries | family_notification_delivery (12 months from sending; H-106); an opt-out or bounce suppression stays with the contact (care_record) |
| `visit_booking_setting` | tenant configuration, kept while current |
| `family_portal_user` | care_record, with the contact |
| `location_visit_restriction` | care_record |
| `sharing_decision_suspension` ([people.md](people.md)) | care_record, with the decision |
| `invitation` ([platform.md](platform.md), Invitations and MFA enrolment; migration 0054) | invitation; its address is cleared when it closes, and the link is only ever a hash |
| `dsar_case`, `dsar_item` ([platform.md](platform.md), Phase 2: the DSAR workbench; migration 0077) | data_rights_case |
| `tenant_export` ([platform-completions.md](platform-completions.md)) | audit_event; the export file itself is deleted at `export.link_expiry_hours` and never kept as a record |
| `dpia` | dpia (above; the period is interim until the DPO sets it, H-115) |
| `sub_processor_response`, `tenant_setting_decision`, `retention_decision` | audit_event (interim: accountability evidence; H-115) |
| `sub_processor_notice` (Thapsus's, the same for every organisation) | audit_event (kept while any response refers to it) |
| Search audit events that showed people | audit_event.care_record: they record views of those people's care records, so they are kept as long as those records |
| Other search audit events (staff, organisation documents, no results, refusals) | security_log (6 months; H-121): they record no view of a care record. Each event carries its class in `scope.retentionClass` (`searchAuditRetentionClass`) |
| Break-glass search records (the typed reason) | audit_event, as other break-glass records |
| Sample data load and removal events | audit_event; sample records themselves are removed on demand, never retained |
| `dp_breach`, `processor_breach_notice`, `processor_breach_notice_ack` (slice 20, migration 0082) | dp_breach (6 years from closure of the breach; H-670) |
| `dp_complaint` (slice 20) | data_rights_case (3 years from closure; H-670) |
| The disclosure log (`disclosure_request`, `disclosure_item`; slice 41, migration 0103) | data_rights_case (3 years from closure), unless it belongs to a serious incident (serious_incident) (H-525). Built as serious_incident for every request: the table has no per-row class yet, so the longer period applies until one is added (follow-up) |
| `import_batch`, `import_commit` (the import wizard's record of each upload and commit; [platform.md](platform.md) rules 18 to 26, ADR-0092) | audit_event: opaque ids, counts and times only |
| `lone_worker_session`, `lone_worker_event`, `lone_worker_alarm` ([scheduling.md](scheduling.md) section 19; migration 0113) | lone_worker, routine check-ins included (lone_worker_check_in retired; provisional, H-1557) |
| `lone_worker_location` (one point attached to one lone-worker event, only while the organisation's flag is on; H-527) | Not retained: the point is erased (its coordinates cleared, the row kept as proof of the erasure, holding nothing) by the per-minute sweep at `lone_worker.location_days` (30 days by default, rates.md) after it was captured; the shortest that lets an alarm be reviewed. The DPO confirms the period (H-1033) |
| `speak_up_concern`, `speak_up_message`, `speak_up_reporter`, `speak_up_case_member` ([safety.md](safety.md), speaking up; ADR-0089) | speak_up_concern (H-721; whistleblowing retired, provisional, H-1557) |
| `import_row` (an upload's staged rows in quarantine: personal data that is not yet anyone's record) | Not retained: deleted, every row of the batch, in the transaction that commits, discards or expires it, and at the latest within the hour after `import.staging_expiry_days` (7 days by default, rates.md) from upload, by the hourly expiry sweep; never exported. Committed rows live on as the records they became (`person`: care_record). The DPO confirms the period (H-681) |
| People created by an import | care_record, as any person; an undo within `import.undo_window_days` removes them outright (they were never meant to be there), and the audit events about them keep the audit_event class |
| `death_record`, `death_step` (deaths; [safety.md](safety.md), slice 37) | care_record, as the person's record, from when their care ended; an incident about the death keeps its own class (serious_incident when graded serious; longest wins) (provisional, H-1558) |
| `herbert_profile`, `missing_episode`, `missing_event` (missing people; slice 37) | care_record, as the person's record; an incident about an episode keeps its own class (longest wins) (provisional, H-1558) |
| `lms_import_row` (a learning-system import's staged learner rows) | Not retained: expires like `import_row`, at `import.staging_expiry_days`; no sweep deletes it yet (retention sweeps plan, slice 13) (provisional, H-1558) |
| `lms_import` (the record of each learning-system import) | audit_event, as `import_batch`: ids, counts and times (provisional, H-1558) |
| `lms_learner_link` (a learning-system learner matched to a member of staff) | training_record, kept as long as the training records it links (provisional, H-1558) |
| `medicine_order`, `medicine_order_line` ([medicines.md](medicines.md)) | medicines_stock_log, counted from the order's submission or the line's creation (provisional, H-1558) |
| `hr_person_link`, `hr_pay_rate`, `hr_pay_unit` (the Thapsus-HR link; ADR-0126) | staff_file (tenant's chosen row), as the staff file they belong to; pay rates and units are also pay calculation inputs (rota_and_timesheet), and the longest wins (provisional, H-1558) |
| `evidence_link` (evidence linked to the quality framework) | the class of the record it links, as `document_signature` (provisional, H-1558) |
| `shift_cover_need` | rota_and_timesheet, counted from the end of the pay reference period (provisional, H-1558) |
| `complaint` ([safety.md](safety.md)) | complaint (provisional, H-1558) |
| `compliment` | complaint, counted from receipt, as a compliment never closes (provisional, H-1558, H-1584) |
| `audit_record`, `audit_action` (audits, slice 19) | quality_audit, counted from the audit's completion (provisional, H-1558) |
| `absence`, `fit_note`, `return_to_work` ([scheduling.md](scheduling.md) section 17, slice 40) | sickness_absence, counted from the end of the absence (provisional, H-1558) |
| `wellbeing_check_in`, `recognition` ([scheduling.md](scheduling.md) section 20) | staff_wellbeing (provisional, H-1557) |
| `pulse_survey_response`, `pulse_survey_participation` | staff_survey_response, counted from the survey's close (provisional, H-1557) |
| `payroll_export`, `payroll_export_result` (slice 76) | payroll_export, counted from the end of the pay reference period (provisional, H-1558) |
| `medicine_disposal` | medicines_disposal_log (provisional, H-1558) |
| `medicine_stock_item`, `medicine_stock_movement` | medicines_stock_log; controlled drug movements keep controlled_drugs_register (longest wins) (provisional, H-1558) |
| `medicine_temperature_reading` | temperature_log (provisional, H-1558) |

## Gaps to settle before the module that needs them ships

These record types have no period in the master prompt, so no row exists yet. Each needs an ADR or a
spec decision (with its source) before its module ships; until then the engine treats them as the class
of the record they attach to.

Settled on 31/10/2026 by the owner's instruction that every open question takes its recommended
answer (`docs/plans/recommended-answers.md`, on `docs/production-google-cloud` until it merges), each reviewed by the DPO at the
testing phase: enquiries and pre-admission assessments of people never admitted (H-39), family
notification delivery logs (H-106), search audit events that showed no person (H-121), the breach
register, Thapsus breach notices and data protection complaints (H-670), and the Phase 2 gaps in
H-525 (whistleblowing, medicines stock, disposal and temperature logs, audits, staff surveys,
lone-worker check-ins, sponsor records, payroll exports and the disclosure log). Unsuccessful
applicants (6 months), DBS check details (with the staff file, no certificate copy; H-575),
safeguarding (serious_incident; H-596), casework (with the staff file) and import batches
(audit_event) stay as built. Rows marked "verify" carry a period the DPO confirms against its
source before a real tenant relies on it.

Settled provisionally on 08/11/2026 by slice 0 of the [retention sweeps plan](../plans/retention-sweeps.md),
each an owner-accepted recommendation pending DPO review at the testing phase: the duplicate classes
(H-1557: lone_worker governs routine check-ins and lone_worker_check_in is retired; staff_survey_response
governs survey answers and staff_wellbeing keeps check-ins and recognition; whistleblowing is retired
in favour of speak_up_concern; the retired rows stay in the schedule, marked retired), and the 32 Phase 2
tables with no mapping row: deaths and missing people, the learning-system import, medicine orders, the
Thapsus-HR link, evidence links and cover needs, and the tables named only in a class's notes (H-1558;
the mapping table above). Audit events about a destroyed record keep their own class as opaque ids,
with the free-text reason cleared when the record is destroyed (H-1559, built in the plan's slice 14).

Still open:

- DSPT assertions, evidence links and submissions, and Cyber Essentials and ICO registration records
  (slice 32, migration 0094): interim audit_event (8 years from creation) until the DPO sets periods
  (H-810).
- DPIA versions and sign-offs, sub-processor notice responses and onboarding decisions: interim
  audit_event (8 years from creation) until the DPO confirms a period (H-115).
- ECM visit events (Phase 4): likely care_record and rota_and_timesheet together (longest wins).
- Children's home records (Phase 7), which have their own statutory periods.
