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
| complaint | 10 | years | record_closed | NHS Records Management Code of Practice; master prompt 5.1 | Reg 16 complaints, responses and appeals. Compliments follow the evidence library item they support; until the evidence library (slice 14) lands they are stored with this class. |
| serious_incident | 20 | years | record_closed | NHS Records Management Code of Practice; master prompt 5.1 | Incidents graded serious, with investigations, notifications, candour correspondence and disclosure packs. |
| riddor_report | 3 | years | created | RIDDOR 2013 (statutory minimum); master prompt 5.1 | The RIDDOR record and submission evidence. The underlying incident keeps its own (longer) class. |
| staff_file.after_leaving | 6 | years | employment_ended_or_75th_birthday | NHS Records Management Code of Practice; master prompt 5.1, 12 | Tenant option: 6 years after employment ends. The tenant selects this row or the next one for all staff files. |
| staff_file.to_75th_birthday | 0 | years | employment_ended_or_75th_birthday | NHS Records Management Code of Practice; master prompt 5.1, 12 | Default option (section 12 rules say staff files to the 75th birthday): kept until the person's 75th birthday, so the period after that trigger is 0. Never destroyed before employment has ended. |
| right_to_work_copy | 2 | years | record_closed | https://www.gov.uk/check-job-applicant-right-to-work (statutory guidance); master prompt 12.1 | Copies of right-to-work documents and check results, kept during employment and for 2 years after it ends (record_closed is the employment end date). |
| applicant.unsuccessful | 6 | months | record_closed | ICO Employment Practices Code, recruitment and selection (keep only as long as needed to answer a claim); Equality Act 2010 s.123 (six-month claim window for most claims, plus early conciliation); master prompt 12.1 | Applicants whose last application closed without being hired: their details, applications, stage history, interviews and offers. Counted from the closing date of their last application (record_closed). Equality monitoring forms follow it from the vacancy's closing date. A hired applicant's record follows the staff file instead. Harbour default for the DPO to confirm (H-732). |
| applicant.talent_pool | 12 | months | created | UK GDPR Art 6(1)(a) and 7 (consent, withdrawable at any time); Art 5(1)(e); master prompt 12.1 | The talent pool: an applicant who agreed is kept until 12 months after the consent was recorded (created), or until they withdraw it, if later than their applicant.unsuccessful date. Harbour default for the DPO to confirm (H-732). |
| training_record | 10 | years | created | Master prompt 5.1 | From the date the training or competence sign-off was completed. |
| rota_and_timesheet | 6 | years | created | National Minimum Wage record-keeping; master prompt 5.1, 12 | Rotas, timesheets, clock-in events, sleep-in and travel-time records, pay calculations with their inputs. Counted from the end of the pay reference period. |
| working_time_record | 2 | years | created | Working Time Regulations 1998 (statutory minimum); master prompt 5.1, 12 | Working-time calculations and night-work assessments, counted from when the record was made. |
| working_time_opt_out | 2 | years | record_closed | Working Time Regulations 1998; master prompt 5.1 | Opt-out agreements, kept while in force and for 2 years after withdrawal or the end of employment. |
| financial_record | 6 | years | created | HMRC and Companies Act accounting records; master prompt 5.1 | Invoices, credit notes, charge lines, funding arrangements, remittances, residents' ledger entries, petty cash. Counted from the end of the financial year the record relates to. |
| water_hygiene_record | 5 | years | created | HSE ACoP L8 and HSG274; master prompt 13.4 | Legionella risk assessment actions, sentinel temperatures, flushing, descaling and TMV records. |
| organisation_document | 0 | years | tenant_policy | Master prompt 9.1 (document store: retention class per document) | Policies, procedures, statement of purpose versions and templates. Kept while current; the tenant's records policy sets how long superseded versions are kept, so the engine never offers them for destruction automatically. |
| downtime_pack | 1 | months | created | Harbour default for data minimisation (UK GDPR Art 5(1)(c) and (e)); master prompt 13.4 | Nightly downtime packs and their snapshots. Each is replaced the next night, so a copy is kept only long enough to answer "what did the pack say?". A pack in force during a declared outage is kept as downtime_record instead. Printed copies are shredded when replaced (deployer control). DPO to confirm (H-96). |
| downtime_record | 8 | years | record_closed | NHS Records Management Code of Practice (as care_record); master prompt 13.4 | Outage windows, their reconciliation and the downtime packs in force during them: the evidence for every back-entry's late time. Counted from reconciliation, and never destroyed while a back-entry that cites the outage is kept (the engine checks the citing records first). |
| evidence_pack | 6 | years | created | Limitation Act 1980 ss.2 and 5 (six-year period for claims, as the basis for keeping proof of a disclosure); master prompt 11.2 | The inspector evidence pack's manifest: recipient, purpose, items with record ids and versions, redactions with reasons, watermark, link issue, opens and revocation. The rendered PDF bundle is deleted when its link expires or is revoked; the manifest can rebuild it from the record versions. Harbour default for the DPO to confirm (H-96). |
| cctv | 0 | months | tenant_policy | Master prompt 5.1 (CCTV per the tenant's policy); ICO CCTV guidance | No product default. The tenant sets the period in its CCTV policy and DPIA (starter template in 11.2) before any CCTV still or clip is attached to a record. |
| audit_event | 8 | years | created | NHS Records Management Code of Practice (record-keeping evidence); master prompt 5.3, 5.5 | Default for every audit event (logins, permission changes, exports, views, sync). Chosen so the audit trail supports a care record for its full Records Code period, well above the 6-month security-log minimum in section 5.3. |
| audit_event.care_record | 8 | years | care_ended | NHS Records Management Code of Practice; master prompt 5.5 | Audit events about a person's record are kept at least as long as that record (longest period wins), so the history view and signed exports for inspectors, coroners and courts stay complete. |
| security_log | 6 | months | created | Master prompt 5.3; NCSC logging guidance | Floor for security logs outside `audit_event` (authentication service, Cloud Armor and the load balancer, infrastructure). In production they sit in a locked Cloud Logging bucket in europe-west2, kept 400 days by default ([ADR-0098](../decisions/0098-production-on-google-cloud.md)). Logs carry opaque IDs only, never personal data. |
| ai_interaction_log | 12 | months | created | Master prompt 16.2 | Pseudonymised prompts, context sets, model and version, outputs and user actions from the AI gateway. |
| dpia | 8 | years | record_closed | Interim: as audit_event (UK GDPR Art 5(2) and 35 accountability evidence); #81 security review | DPIA versions: the prefill, the organisation's answers, residual risks, the preparers and the signature bound to the version read. Counted from when a later signed version supersedes it (record_closed), so the DPIA in force is never offered for destruction. Interim period: the DPO sets it (H-115). |
| invitation | 12 | months | created | Harbour default for data minimisation (UK GDPR Art 5(1)(c) and (e)); #43 review M4 | Invitations to join an organisation. The address is cleared as soon as the invitation is accepted, revoked or lapses (a nightly sweep), so a closed invitation holds opaque ids and times only; the audit trail keeps who was given access, by whom and when, for its own period. DPO to confirm (H-355). |
| data_rights_case | 3 | years | record_closed | NHS Records Management Code of Practice 2023 (subject access requests and disclosure correspondence: 3 years after closure); ADR-0090 | Data subject requests (`dsar_case`, `dsar_item`): the request, identity check (how, never the document), clock dates, decisions and reasons per record, the outcome and the bundle's hash. Counted from the response or withdrawal (record_closed). The case holds table and record ids; the bundle as issued is kept in the exports bucket under `dsar/`, which the exports' 30-day expiry does not reach, and destroyed with the case. A case under complaint to the ICO or in litigation is kept longer by a legal hold. DPO to confirm (H-613). |

## Mapping of Phase 0 and Phase 1 tables to record classes

| Table or record | Record class |
| --- | --- |
| `person`, `contact`, `allergy`, `placement`, `about_me` | care_record |
| `pre_admission_assessment`, `admission_decision`, `admission_condition`, `bed_occupancy`, `welcome_checklist_item`, `property_item`, `key_issue`, `care_plan_change`, `review_record`, `hospital_transfer`, `exit_record`, `exit_checklist_item`, `sharing_decision`, `about_me_share_link` ([people.md](people.md)) | care_record |
| `break_glass_event`, `break_glass_weekly_report` | audit_event |
| `device_binding`, `device_session`, `device_discard_entry`, `handed_over_entry` (Care mode devices, the sessions bound to them, the entries their deletions listed and the entries hand-overs sent; [care.md](care.md) section 6) | audit_event |
| `refused_entry` (the server copy of an entry the API refused from a device) | care_record |
| `device_discard_record` (one row per stage of a deletion of unsent entries, with its coded reason; [care.md](care.md) section 6, Device integrity part 8) | audit_event |
| `entry_device_deletion_flag` (the server's flag on an entry its device recorded deleting) | care_record, as the entry |
| `discard_reason`, `escalation_policy_link` (the organisation's coded deletion reasons and the escalation policy each validated tool's result links; [care.md](care.md) section 5) | tenant configuration, kept while current; each change kept in `record_version` and the audit trail |
| `care_plan`, `care_plan_item`, `assessment`, `risk_assessment`, `care_note`, `observation` | care_record |
| `consent_record`, `capacity_assessment`, `best_interests_decision`, `dols_authorisation`, `dols_legal_change_review` | care_record |
| `safeguarding_concern` (the safeguarding log; [safety.md](safety.md) "Safeguarding log"; DPO to confirm, H-596) | serious_incident |
| `incident` with `retention_class` `care_record` (no notification applies), and its `incident_person`, `classifier_answer` and `investigation` rows | care_record |
| `incident` with `retention_class` `serious_incident` (set once any notification applies), its people, answers, `candour_record` and `investigation`, and `statutory_notification` | serious_incident |
| `statutory_notification` of a RIDDOR kind (`riddor_*`) | riddor_report (the incident keeps serious_incident; longest wins) |
| `outbreak` ([safety.md](safety.md) section 11) | serious_incident, as its UKHSA report |
| `outbreak_case` | care_record for residents; staff cases follow it for now, to be confirmed by the DPO (H-767) |
| `medication`, `medication_schedule`, `medication_administration` | mar_chart |
| `controlled_drug_entry` | controlled_drugs_register (and mar_chart for administrations) |
| `staff_profile`, `compliance_item` | staff_file (tenant's chosen row) |
| `induction_plan`, `staff_checklist_item`, `shadow_shift`, `probation_review`, `care_certificate_progress`, `leaver_record`, `reference_request` (induction and leavers, slice 29; [workforce.md](workforce.md) section 2d) | staff_file (tenant's chosen row), from the leaving date; `leaver_record.staff_file_retain_until` holds the date worked out when the leaving is recorded (rule 23; the birthday age is `retention.staff_file.birthday_age`, H-874, H-875) |
| `employee_case`, `employee_case_member`, `employee_case_hearing`, `employee_case_event` (employee relations casework, slice 39; [workforce.md](workforce.md) section 2c) | staff_file (tenant's chosen row), from the end of the employment of the member of staff the case is about; a warning that has stopped counting (`warning_expires_on`) is kept as the record of the decision, never used again; a shorter period for some cases is open (H-806). A restricted silo: the retention engine's destruction batches reach it as the system, and its certificates carry ids only |
| `applicant`, `application`, `application_event`, `interview`, `job_offer` (slice 23) | applicant.unsuccessful, or applicant.talent_pool when later; a hired applicant's records follow the staff file |
| `equality_monitoring` (slice 23) | applicant.unsuccessful, from the vacancy's closing date |
| `job_template`, `vacancy` (slice 23) | organisation_document |
| `document` of category `staff_hr_document` (HR-only staff documents, slice 11) | staff_file; right to work copies `right_to_work_copy` (2 years after employment ends) |
| `task` of kind `workforce.compliance_expiry` (staff check expiry reminders) | staff_file, as the compliance item it concerns |
| `sponsored_worker`, `sponsor_absence`, `sponsor_report`, `staff_privacy_acknowledgement`, `staff_image_consent`, `ldss_claim` (slice 35) | staff_file (tenant's chosen row); as Harbour reads the guidance for sponsors, sponsor records must be kept for at least a year after sponsorship ends, which the staff file rows outlast (to confirm, H-901) |
| `training_record`, `competence` | training_record |
| `competence_sign_off`, `competence_withdrawal`, `revalidation_evidence` (slice 17) | training_record |
| `supervision_record` (slice 17) | staff_file (tenant's chosen row) |
| `training_requirement` (slice 17) | tenant configuration, kept while current; each change kept in `record_version` |
| `task` of kind `workforce.training_expiry` or `workforce.competence_expiry` | training_record, as the record it concerns |
| `shift`, `timesheet_entry` | rota_and_timesheet |
| `shift_template`, `shift_pattern`, `rota`, `rota_publication`, `shift_assignment`, `roster_override` ([scheduling.md](scheduling.md) section 14, slice 21) | rota_and_timesheet; never deleted (archived, cancelled or removed with a reason); publications and overrides append-only |
| `ledger_entry`, `invoice`, `charge_line`, `funding_arrangement` | financial_record |
| `compliance_check` for water systems | water_hygiene_record |
| `audit_event` | audit_event, extended by audit_event.care_record |
| `document` | by category: photos, care attachments and documents about a person follow `care_record`; organisation documents `organisation_document` |
| `document_signature` | the class of the signed document |
| `legal_hold`, `destruction_certificate` | kept permanently (proof of records management); never destroyed by the engine |
| `task`, `task_series`, `workflow_instance`, `workflow_transition` | the class of the record they concern (care_record for tasks about a person) |
| `handover`, `handover_item`, `handover_note`, `handover_acknowledgement` ([care.md](care.md) rule 8) | care_record: a handover is a record of the care handed over at a location, kept as long as the care records it lists |
| `downtime_pack` ([operations.md](operations.md)) | downtime_pack, or downtime_record when in force during a declared outage |
| `outage` | downtime_record |
| Back-entered care events (the back-entry columns on `care_note`, `observation` and the others) | care_record, as the event |
| `evidence_pack`, `evidence_pack_item`, `evidence_pack_link`, `evidence_pack_link_code` ([quality.md](quality.md)) | evidence_pack; the rendered bundle is deleted when the link ends |
| `evidence_pack_bundle` | deleted (content cleared) when the link ends or the pack is revoked or discarded (migration 0057); the row stays as proof of the deletion under evidence_pack |
| `letter_template`, `letter_template_version` ([comms.md](comms.md)) | organisation_document |
| `dependency_scale`, `dependency_scale_version` ([scheduling.md](scheduling.md) section 13) | organisation_document; a version a rota rests on is kept at least as long as that rota (rota_and_timesheet) until the DPO decides (H-711) |
| `dependency_assessment` (a person's dependency category) | care_record |
| `letter` | `retention_class` per row: serious_incident for an incident or candour letter about an incident graded serious, otherwise care_record (`letterRetentionClass`; migration 0059) |
| `statement_of_purpose_version`, `letter_template`, `letter_template_version` ([comms.md](comms.md)) | organisation_document |
| `policy`, `policy_version` ([quality.md](quality.md) section 18) | organisation_document |
| `policy_signature` (read-and-sign records) | training_record (from signing; H-742) |
| `task` of kind `quality.policy_read_and_sign` or `quality.policy_review` | as the policy version it concerns |
| `letter` | care_record; serious_incident only for an incident follow-up or duty of candour letter about an incident graded serious (`letterRetentionClass`) |
| `feed_item`, `feed_item_withdrawal`, `visit_booking` ([comms.md](comms.md)) | care_record; photo updates and their photo documents stay care_record after photo consent is withdrawn (taken down from the feed, kept as the history of what was shared) |
| `feed_view` (what a family member saw, under which decision) | audit_event.care_record |
| `family_channel`, `family_notification_setting` | care_record, with the contact; push tokens are deleted when the device signs out, not retained |
| `family_notification` and its deliveries | the class of the record they relate to (care_record) until the DPO sets a shorter period (H-106) |
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
| Other search audit events (staff, organisation documents, no results, refusals) | audit_event for now; whether they may use security_log is for the DPO (H-121) |
| Break-glass search records (the typed reason) | audit_event, as other break-glass records |
| Sample data load and removal events | audit_event; sample records themselves are removed on demand, never retained |
| `import_batch`, `import_commit` (the import wizard's record of each upload and commit; [platform.md](platform.md) rules 18 to 26, ADR-0092) | audit_event: opaque ids, counts and times only |
| `import_row` (an upload's staged rows in quarantine: personal data that is not yet anyone's record) | Not retained: deleted, every row of the batch, in the transaction that commits, discards or expires it, and at the latest within the hour after `import.staging_expiry_days` (7 days by default, rates.md) from upload, by the hourly expiry sweep; never exported. Committed rows live on as the records they became (`person`: care_record). The DPO confirms the period (H-681) |
| People created by an import | care_record, as any person; an undo within `import.undo_window_days` removes them outright (they were never meant to be there), and the audit events about them keep the audit_event class |

## Gaps to settle before the module that needs them ships

These record types have no period in the master prompt, so no row exists yet. Each needs an ADR or a
spec decision (with its source) before its module ships; until then the engine treats them as the class
of the record they attach to.

- Enquiries and pre-admission assessments of people who are never admitted (Phase 1 people lifecycle;
  human action H-39). Until a period is set they follow care_record, counted from the date the
  enquiry closed.
- Family notification delivery logs and channel opt-out and bounce records (Phase 1 family feed;
  human action H-106). They hold an address, a template id and a status, never update content;
  until a period is set they follow care_record with the contact. An opt-out must be remembered for
  as long as the address is held, so it is never sent to again.
- DBS certificate information: settled for slice 11 as a spec decision ([workforce.md](workforce.md)
  section 2a), for the DPO to confirm (H-575). Following the DBS code of practice, Harbour keeps no
  copy of a certificate and nothing of what it disclosed; the record of the check (level, issue date,
  certificate number, clear or disclosed, Update Service status, the barred list check date and the
  risk assessment decision) is part of the staff file and kept under `staff_file`. An upload of a
  DBS certificate copy is refused.
- DSAR cases, breach register entries and data-protection complaints (Phase 2).
- DBS certificate information: the DBS code of practice limits how long certificate details may be kept;
  confirm the period before the Phase 2 pre-employment file stores them.
- Breach register entries and data-protection complaints (Phase 2). DSAR cases have their own
  class, data_rights_case (ADR-0090).
- DSAR cases (Phase 2, slice 15), breach register entries, Thapsus breach notices and their
  acknowledgements, and data-protection complaints (slice 20, migration 0082): interim audit_event
  (8 years from creation) until the DPO sets periods (H-670).
- DSPT assertions, evidence links and submissions, and Cyber Essentials and ICO registration records
  (slice 32, migration 0094): interim audit_event (8 years from creation) until the DPO sets periods
  (H-810).
- DPIA versions and sign-offs, sub-processor notice responses and onboarding decisions: interim
  audit_event (8 years from creation) until the DPO confirms a period (H-115).
- ECM visit events (Phase 4): likely care_record and rota_and_timesheet together (longest wins).
- Children's home records (Phase 7), which have their own statutory periods.
