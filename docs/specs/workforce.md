# Workforce (`workforce`) - specification

Master prompt sections 12.1, 12.2 and 12.4, with section 4 (roles) and 18 (data model). Phase 2
builds the whole employee file from application to leaving ([phase-2.md](../plans/phase-2.md),
lane B). Payroll itself is integrated, not built (section 12). Sections 2 to 4 and 9 were written by
slice 4 (the domain rules) and extended by slice 11 (the staff file: sections 2a, 3, 5, 8 and 9),
slice 23 (applicant tracking: sections 2b, 4 rules 11 to 13, 5, 8 and 9), slice 39 (employee
relations casework: sections 2c, 3, 4 rules 14 to 18, 5, 8, 9 and 11) and slice 29 (induction,
the Care Certificate and leavers: sections 2d, 3, 4 rules 19 to 23, 5, 8, 9 and 11);
sections 5 to 8 grow with the schema, API and screen slices. Status per
feature: [feature register](feature-register.md).

## 1. Purpose and register rows

Section 12: recruit, vet, train and develop staff, and handle employee relations, so that a worker
without a required check or competence never does the work that needs it.

| Row | Feature (register) | Phase | Plan slices |
| --- | --- | --- | --- |
| WORK-001 | Applicant tracking (Care Workforce Pathway job templates, shortlisting, values-based interviews, offers, talent pool) | 2 | 23, 58 |
| WORK-002 | Reg 19 Schedule 3 pre-employment file (ID, right to work with re-checks, DBS and Update Service, history and gaps, references, conduct, health, qualifications, NMC PIN) | 2 | 4, 11, 56 |
| WORK-003 | Sponsor-licence compliance (Appendix D records, salary floor check, 10-working-day reporting) | 2 | 4, 35, 56 |
| WORK-004 | Onboarding and Care Certificate (16 standards) induction | 2 | 29, 58 |
| WORK-005 | Training matrix with Skills for Care topics and Oliver McGowan tiers | 2 | 4, 17, 57 |
| WORK-006 | SCORM and xAPI e-learning player and LMS integration | 2 | 43, 57, 72, 78 |
| WORK-007 | LDSS claim tracking | 2 | 35, 57 |
| WORK-008 | Observed competence sign-offs that gate actions | 2 | 4, 17, 57 |
| WORK-009 | Supervision and appraisal scheduler with spot checks | 2 | 4, 17, 57 |
| WORK-010 | Employee relations casework (disciplinary, grievance, capability, appeals) with DBS and NMC referrals | 2 | 39, 58 |
| WORK-011 | Staff data protection (privacy notice, staff DSARs, HR-only immigration documents, monitoring DPIA) | 2 | 11, 15, 35, 56 |
| WORK-012 | Qualifications and NMC revalidation planner | 2 | 4, 17, 57 |
| WORK-013 | Transfers and leavers (TUPE import, leaver checklist, references) | 2 | 29, 51, 58 |

Identity and vetting adapters are INTG-007 ([integrations.md](integrations.md)). Workforce returns
(ASC-WDS) are QUAL-007 in Phase 3.

## 2. Schema

Tables come with slice 11 (migration from the plan's table); slice 4 writes only the domain types
they will store, in `packages/domain/src/workforce/`. Section 18 names `staff_profile` and
`compliance_item` (role, pathway category, start date; DBS level, date, number, barred-list result
and Update Service; right to work type, expiry and re-check; registration body, PIN and expiry;
sponsor CoS and visa expiry; expiry tasks), `training_record`, `competence` and `er_case`.

| Domain type (slice 4) | Will be stored in (slice 11, 17) | Holds |
| --- | --- | --- |
| `Schedule3Item` | `compliance_item` | One Schedule 3 requirement for a worker: kind (code list below), status, evidence date, expiry, who checked it |
| `RightToWorkCheck` | `compliance_item` (kind `right_to_work`) | Permission type (`unlimited` or `time_limited`), check date and method, expiry of a time-limited permission, follow-up check date |
| `DbsCheck` | `compliance_item` (kind `dbs`) | Level (`enhanced_adults_barred` for regulated activity), certificate date, issued or awaited, Update Service subscription and last status check, the risk assessment that lets someone start before the certificate |
| `EmploymentPeriod` | `compliance_item` detail | From and to (year and month), employment, education or explained gap with its explanation |
| `TrainingRecord` | `training_record` | Topic (code list below), completed on, valid until, Oliver McGowan tier |
| `CompetenceSignOff` | `competence` | Kind, observed on, observer, the observer's permission at the time, valid until |
| `SupervisionRecord` | `supervision` (slice 17) | Kind (`supervision`, `appraisal`, `spot_check`), held on |
| `Registration` | `compliance_item` (kind `professional_registration`) | Body (`nmc`, `hcpc`, `swe`, `gmc`), PIN, renewal date, revalidation date, revalidation evidence counts |
| `SponsorEvent` | sponsor records (slice 35) | Reportable change, when it happened, when it was reported |

### 2a. Staff profile and pre-employment file (slice 11, migration 0073)

Two tenant tables, with forced row-level security and the policies in section 3; both are mutable
aggregates (`version`, `expected_version` on every change, earlier versions in `record_version`),
never deleted.

| Table | Columns | Rules |
| --- | --- | --- |
| `staff_profile` | `tenant_user_id` (the member of staff; one profile each), `location_id` (where they mainly work, or empty), `job_title`, `pathway_category` (Care Workforce Pathway role category, optional), `registration_body` (`nmc`, `hcpc`, `swe`, `gmc` or empty: adds professional registration), `previous_care_work` (adds conduct evidence), `date_of_birth` (optional: for the `staff_file.to_75th_birthday` retention row and the under-18 working time rules), `starts_on`, `left_on` | Keeps its member. Never written by the member themselves |
| `compliance_item` | `staff_profile_id`, `kind` (one of the Schedule 3 items, one row per kind), `detail` (JSON, `ComplianceDetail` for the kind), `verified_on` and `verified_by` (who saw the evidence, set together), `risk_assessment_signed_on` and `_by` (DBS only), `expires_on` and `recheck_due_on` (worked out from the detail when saved, for the reminder sweep) | Keeps its profile and kind; the detail's `kind` is the row's. Verified in the verifier's own name by a holder of manage; the risk assessment signed in the signer's own name by a holder of `workforce.dbs_risk_assessment.sign`; neither ever the worker |

What each kind's `detail` holds (data minimisation: only what the rule needs):

| Kind | Detail | Satisfied when (rule) |
| --- | --- | --- |
| `identity_with_photo` | The document seen (`passport`, `photocard_driving_licence`, `national_identity_card`, `biometric_residence_permit`, `other_photo_document`); a copy may be added as an HR-only document | Verified |
| `dbs_certificate` | Certificate level, issue date, the 12-digit number and whether it was clear or disclosed information (never what it disclosed); Update Service subscription with the last status check and result; the date of a clear adults' barred list check made before the certificate | Verified and clear (rule 3): a disclosure needs a risk assessment signed on or after the issue date; supervised-only is shown but not satisfied. No copy of the certificate is kept |
| `conduct_in_care_work` | How many earlier care employers were asked | Verified |
| `references` | How many references were received | Verified and at least one |
| `relevant_qualifications` | The qualifications' names | Verified |
| `employment_history` | History start, application month, periods (employment, education or an explained gap with its explanation) | Verified and no unexplained gap (rule 4) |
| `health_fitness` | Declared fit, and whether adjustments were agreed (never the health details: the questionnaire is an HR-only document) | Verified and declared fit |
| `right_to_work` | Each check: date, method (`manual_document`, `online_share_code`, `idsp`), permission (`unlimited`, `time_limited`) and the expiry of a time-limited one; never the share code | Verified and the latest check allows work (rule 2); a first check after the start date is noted |
| `professional_registration` | Body, PIN, renewal date, revalidation date | Verified and current (rule 8) |

`staffFileState` (`staff-file.ts`) works out every item on the UK date asked about: an item
verified by the worker themselves, or on a later date, is not satisfied; satisfaction is never
stored. HR-only documents are `document` rows of category `staff_hr_document` (subject the
compliance item, no person); right to work copies are kept as `right_to_work_copy`, everything else
as the staff file.

### 2b. Training, competence, supervision and revalidation (slice 17, migration 0079)

Keyed by the member of staff (`worker_id`, a `tenant_user` id), not the staff profile, so a
training or supervision lead reads them without the pre-employment file. Forced row-level
security on every table; the policies in section 3.

| Table | Columns | Rules |
| --- | --- | --- |
| `training_requirement` | `role_key` (a role's key), `topic` (`TRAINING_TOPICS`), `refresh_years` (the organisation's own, or empty for the default), `tier` (1 or 2, Oliver McGowan only), `active` | One per role and topic; the matrix of a member is every active requirement of their roles in force. Mutable, never deleted |
| `training_record` | `worker_id`, `topic`, `tier`, `completed_on`, `expires_on` (a certificate's own last valid day), `provider` | Mutable with history (a correction is a change with `expected_version`); never by the worker |
| `competence_sign_off` | `worker_id`, `competence` (`COMPETENCES`), `observed_on`, `observer_id`, `valid_until` (the day before observed plus the competence's refresh months) | Append-only. Observed in the observer's own name by a holder of `workforce.competence.observe`, never the worker, on a day no later than today |
| `competence_withdrawal` | `sign_off_id` (one each), `reason` (at least 10 characters), `withdrawn_by` | Append-only; by a holder of `workforce.competence.observe` or `workforce.training.manage`, never the worker |
| `supervision_record` | `worker_id`, `kind` (`supervision`, `appraisal`, `spot_check`), `held_on`, `held_by` | Mutable with history; by a holder of `workforce.supervision.manage` in their own name, never for themselves. No notes are kept (a supervision's notes stay with the supervisor's own records until slice 57) |
| `revalidation_evidence` | `worker_id`, `cycle_due_on`, practice, CPD and participatory CPD hours, feedback pieces, reflective accounts, and whether the reflective discussion, health and character declaration, professional indemnity and confirmation are done | One per member and cycle; mutable with history; by a holder of `workforce.training.manage`, never the worker |

Competences (`COMPETENCES` in `packages/domain/src/workforce/competence-port.ts`):
`medicines_administration`, `controlled_drugs`, `insulin_administration`,
`epilepsy_rescue_medication` (medicines: refreshed every `competence.medicines.refresh_months`),
`moving_and_handling_hoist`, `catheter_care`, `enteral_feeding`, `oxygen_therapy` (every
`competence.default_refresh_months`, a Harbour default to verify, H-690).

Retention classes ([retention.md](retention.md)): `staff_file.after_leaving` or
`staff_file.to_75th_birthday` (the tenant's choice) for the staff file and casework;
`right_to_work_copy`; `training_record` for training and competence. The gaps (unsuccessful
applicants, DBS certificate information) are listed there.

### 2b. Applicant tracking (slice 23, migration 0085)

WORK-001: job templates, vacancies, applicants and their applications, shortlisting, values-based
interviews, conditional offers and the talent pool; an accepted offer creates the staff profile
(section 2a) and hands its conditions to the pre-employment file. Eight tenant tables with forced
row-level security. Applicants are people who may never be employed: their data is purpose B15,
kept for a short period after an unsuccessful application (retention class
`applicant.unsuccessful`), or for the talent pool period they agreed to (`applicant.talent_pool`).

| Table | Columns | Rules |
| --- | --- | --- |
| `job_template` | `title`, `pathway_category` (Care Workforce Pathway role category, `PATHWAY_CATEGORIES`), `registration_body` (as the staff profile), `essential_criteria` (2 to 20 short statements), `values_questions` (2 to 12: a key, the value it explores from `RECRUITMENT_VALUES` and the question), `archived_at` | Mutable; a template in use by an open vacancy is not archived |
| `vacancy` | `job_template_id`, `location_id` (or empty for organisation-wide), `title`, `positions` (1 to 50), `opens_on`, `closes_on`, `status` (`draft`, `open`, `closed`, `filled`, `withdrawn`) | Mutable; `closes_on` on or after `opens_on`; applications only while `open` |
| `applicant` | `given_name`, `family_name`, `email`, `phone`, `talent_pool_until` and `talent_pool_consented_at` (set together, consent only), `retain_until` (set when their last application ends unsuccessfully), `redacted_at` | Mutable; names and contact details are cleared (redacted) after `retain_until` by the retention engine, never deleted by hand |
| `application` | `vacancy_id`, `applicant_id` (one each per vacancy), `stage` (`APPLICATION_STAGES`), `stage_reason` (a code, `CLOSING_REASONS`), `shortlist` (each essential criterion met or not, with who decided and when), `closed_on` | Mutable; the stage moves only as `checkApplicationMove` allows |
| `application_event` | `application_id`, `from_stage`, `to_stage`, `reason`, `occurred_at` | Append-only: the stage history |
| `interview` | `application_id`, `held_on`, `panel` (1 to 5 members of staff), `scores` (each values question 1 to 4), `notes`, `recommendation` (`proceed`, `do_not_proceed`) | Append-only; a later interview is a new row |
| `job_offer` | `application_id` (one each), `made_on`, `proposed_start_on`, `conditions` (the Schedule 3 items the role needs, `requiredItems`), `status` (`made`, `accepted`, `declined`, `withdrawn`), `responded_on`, `staff_profile_id` | Mutable; accepted only with the member of staff the profile is for |
| `equality_monitoring` | `vacancy_id`, `answers` (age band, sex, gender identity matches sex registered at birth, ethnic group, disability, religion, sexual orientation; each with `prefer_not_to_say`); a random id and no date | Insert only, once the vacancy has closed and before its counts are released (`vacancy.equality_summarised_at`); never linked to an applicant or application; nobody reads a row, only the counts (rule 12) |

### 2c. Employee relations casework (slice 39, migration 0101)

WORK-010: grievance, disciplinary, capability, sickness absence and probation cases, run as the
Acas Code of Practice on disciplinary and grievance procedures sets out, with investigation,
hearings, outcome, appeal, suspension, the timeline, and the DBS barring and regulator referral
decisions linked to the safeguarding log. A restricted silo (ADR-0089; rule 14): four tenant
tables with forced row-level security, read only by the members named on a case. No
`capture_version` (`record_version` is read widely); every change is audited by id instead.

| Table | Columns | Rules |
| --- | --- | --- |
| `employee_case` | `case_type`, `subject_tenant_user_id` (the member of staff it is about), `subject_registered` (set by the database from the staff profile when opened), `summary`, `opened_on`, `stage` and `stage_since`, `outcome`, `outcome_decided_on`, `warning_expires_on`, `appeal_outcome`, `appeal_decided_on`, `suspended_on` and `suspension_review_on`, `closed_reason`, `closed_on`, `dbs_referral`, `_on`, `_reason`, `regulator_referral`, `_on`, `_reason`, `safeguarding_incident_id` | Mutable (`expected_version`). Opened only through `app.open_employee_case` (which names the opener its first case manager and writes the opening event), open with nothing decided, never about the opener; keeps its type, subject and summary; moves forward only; an outcome stays once decided; a chair who is not a case manager changes only their own decision; a closed case never changes; the safeguarding link is set once, to a concern the member can see |
| `employee_case_member` | `case_id`, `tenant_user_id`, `member_role` (`CASE_MEMBER_ROLES`), `independence_exception`, `added_by`, `removed_at`, `removed_by` | Mutable, only ever removed. Never the subject; nobody names themselves (the opener is named by the opening); independence counts parts someone was removed from; the last case manager stays |
| `employee_case_hearing` | `case_id`, `kind` (`investigation_meeting`, `hearing`, `appeal_hearing`), `led_by`, `invited_on`, `scheduled_at`, `issue_set_out`, `evidence_shared`, `companion_right_given`, `state`, `held_on`, `accompanied`, `postponed_reason` | Mutable. Led by the member in the matching role; a held, unattended or cancelled one is final |
| `employee_case_event` | `case_id`, `kind`, `from_stage`, `to_stage`, `occurred_on`, `body` (a note or the appeal grounds only), `recorded_by` | Append-only: the timeline. Written in one's own name, never after the case closes |

### 2d. Induction, the Care Certificate and leavers (slice 29, migration 0091)

WORK-004 and WORK-013: from the accepted offer to the end of probation (a checklist, policy
read-and-sign at induction, shadow shifts, probation reviews and the decision), the Care
Certificate's 16 standards, and leaving (the record, a checklist, access ended at the end of the
leaving day, the exit interview, references and how long the staff file is kept). Seven tenant
tables with forced row-level security, each belonging to a staff profile and following the staff
file's rules (section 3). TUPE import comes with slice 51.

| Table | Columns | Rules |
| --- | --- | --- |
| `induction_plan` | `staff_profile_id` (one each), `care_certificate_held` (already holds it, or the Level 2 Adult Social Care Certificate), `probation_ends_on`, `probation_outcome`, `_decided_on`, `_decided_by` | Mutable; a probation passed or not passed stays decided |
| `staff_checklist_item` | `staff_profile_id`, `checklist` (`induction`, `leaving`), `kind` (the ticked items, `TICKED_INDUCTION_ITEMS`, `TICKED_LEAVER_ITEMS`), `done_on`, `done_by` | Append-only, once per item, in the ticker's own name |
| `shadow_shift` | `staff_profile_id`, `shift_on`, `location_id`, `shadowed_id` (the colleague shadowed), `recorded_by` | Append-only; never shadowing oneself |
| `probation_review` | `staff_profile_id`, `review_on`, `reviewer_id`, `outcome` (`on_track`, `concerns`), `notes` | Append-only, in the reviewer's own name |
| `care_certificate_progress` | `staff_profile_id`, `standard_id` (`cc01` to `cc16`), `knowledge_assessed_on`, `_by`, `observed_on`, `_by` | Mutable once: the observation is added to the assessment and then never changes; neither by the worker |
| `leaver_record` | `staff_profile_id` (one each), `leaving_on`, `reason` (`LEAVING_REASONS`), `access_removed_at`, `_by` (empty for the sweep), `exit_interview` (`not_offered`, `offered`, `declined`, `held`), `exit_interview_on`, `exit_interview_summary`, `staff_file_retain_until` | Mutable; the date and reason stay; ended access stays ended; the exit interview only moves forward. Recording one sets the staff profile's `left_on` |
| `reference_request` | `staff_profile_id`, `requested_on`, `requester` (an organisation, never a person's name), `kind` (`factual`, `conduct`), `state` (`requested`, `sent`, `declined`), `sent_on`, `sent_by`, `declined_reason` | Mutable once: answered once, sent in the sender's own name |

### 2e. Identity and vetting adapters (slice 77, migration 0120)

WORK-002 and ADR-0094: electronic routes for four of the staff file's checks, each off until the
organisation configures a provider for its port (`integration_connection`), with manual entry and
uploaded evidence the default. No vendor is chosen (H-521 to H-523); the only adapter is the
contract-tested mock, which never runs in production. Two tenant tables with forced row-level
security, following the staff file's rules (section 3), and two columns added to `compliance_item`.

| Table | Columns | Rules |
| --- | --- | --- |
| `vetting_consent` | `staff_profile_id`, `purpose` (`dbs_application`, `dbs_update_service`), `given_on`, `recorded_by`, `withdrawn_on`, `withdrawn_by` | Mutable once: withdrawn once, never given again on the same row (a new consent is a new row); one consent in force per purpose; recorded and withdrawn in the recorder's own name, never by the worker |
| `vetting_check` | `staff_profile_id`, `kind` (`idsp_right_to_work`, `dbs_application`, `dbs_status_check`, `nmc_register_check`), `provider`, `consent_id` (the DBS checks), `requested_by`, `requested_at`, `checked` (what was checked: the IDSP document, the certificate number or the PIN), `state` (`pending`, `completed`, `failed`), `external_reference`, `result` (the port's result, strictly parsed), `error`, `completed_at`, `applied_at`, `applied_by`, `compliance_item_id` | Mutable forward only: pending to completed or failed, and a completed check applied once, in the applier's own name, never by the worker; keeps its file, kind and what was checked |
| `compliance_item` (added) | `evidence_source` (`manual` by default, or the check's kind), `vetting_check_id` | Recording an item by hand sets `manual`; applying a check sets its kind and id |

## 3. Permissions

In the catalogue since Phase 0 ([permissions.md](permissions.md)): `workforce.recruitment.manage`,
`workforce.training.manage`, `workforce.competence.observe`, `workforce.supervision.manage`,
`workforce.casework.manage`, `workforce.self.read`. Slice 4 adds no permission to the catalogue (it
has no routes); the matrix the API slices use:

| Action | Permission | Notes |
| --- | --- | --- |
| Read and update a worker's Schedule 3 file, right to work and DBS | `workforce.recruitment.manage` | Immigration and sponsor documents: HR only, audited on view (section 12.4); a separate `workforce.immigration.read` comes with slice 35 |
| Record DBS risk assessment before clearance | `workforce.recruitment.manage` | Signed by a Registered Manager (role check in slice 11) |
| Manage the training matrix and records | `workforce.training.manage` | |
| Sign off observed competence | `workforce.competence.observe` | Never for oneself; the observer must hold a valid sign-off for the same competence where the tenant requires it |
| Schedule and record supervision, appraisal and spot checks | `workforce.supervision.manage` | |
| See own file, training, competence and revalidation dates | `workforce.self.read` | |
| Roster a worker missing a required check (override) | `workforce.recruitment.manage` with a typed justification | Logged and reported (section 12 rule); scheduling reads the result through the published port (ADR-0085, slice 17) |

Slice 11 adds four permissions so that HR data has its own (section 12.4), replacing
`workforce.recruitment.manage` for the staff file (recruitment keeps applicants, slice 23):

| Permission | Lets the holder | Built-in roles |
| --- | --- | --- |
| `workforce.staff_file.read` | See staff profiles and where each check stands, with the details | Owner, Registered Manager, deputy manager, HR |
| `workforce.staff_file.manage` | Create and change profiles, record and verify checks (never on their own file) | Owner, Registered Manager, deputy manager, HR |
| `workforce.hr_document.read` | Open and add HR-only staff documents; every view is audited | Owner, HR (a manager is given it by a grant or a role change) |
| `workforce.dbs_risk_assessment.sign` | Sign the DBS risk assessment for a supervised start or a disclosure (never for themselves) | Owner, Registered Manager |
| `workforce.self.read` (existing) | See their own profile and where each of their checks stands | Every staff role |

Slice 17 adds no permission. Training, competence, supervision and revalidation rows are read by
holders of `workforce.training.manage`, `workforce.competence.observe`,
`workforce.supervision.manage` or `workforce.staff_file.read` (organisation-wide, as the staff
file), and by the member for their own (`workforce.self.read`); written as section 2b says, never
by the member about themselves. None of them is special category data, so they need MFA only where
the role does. Medicines and scheduling never read these tables: they ask the competence port
(ADR-0085).

Slice 23 adds no permission: applicant tracking uses `workforce.recruitment.manage` (Owner,
Registered Manager, deputy manager and HR in the built-in roles), as section 12.1 intends, and the
database holds it organisation-wide as it does the staff file permissions
(`app.holds_staff_permission`). Accepting an offer also needs `workforce.staff_file.manage`, which
creates the staff profile; nobody records their own application or offer.

Slice 39 makes `workforce.casework.manage` a silo permission (ADR-0089; `SILO_PERMISSIONS`), now
needing MFA (`sensitive`). It lets its holder open a case, and nothing more: a case is read only by
the members named on it, its holder included. Built-in roles built from every permission (owner,
Registered Manager, deputy manager) leave it out, and HR's role no longer carries it; the new
built-in role `employee_relations_lead` (Employee relations caseworker, no person scope) carries
it alone. Migration 0101 removes it from existing roles that carry anything else, and the database
refuses a role mixing it with any other permission, an access grant carrying it, someone
appointing themselves to a role carrying it, a role already held being edited into one carrying
it, and holding it together with a role that manages users or roles (`platform.user.manage`,
`platform.role.manage`), whichever comes first, by assignment or by editing a role; the migration
stops if anyone already holds both. Members give the caseworker role through the operator or
support for now: `app.may_assign_role` needs the giver to hold every permission of the role
through an organisation or location role, and no such role carries the silo permission (H-803). What each
member may do on a case comes from their part on it (rule 16), not from a permission:

| Action | Who |
| --- | --- |
| Open a case (never about oneself); become its first case manager | Holder of `workforce.casework.manage` |
| Read the case, its members, hearings and timeline; add a note | Any member named on it (MFA) |
| Name or remove members; arrange hearings; move the case on (investigation, hearing, appeal, close); suspension; referral decisions; the safeguarding link | A case manager of the case |
| Decide the outcome | The hearing chair |
| Decide the appeal (as the case closes) | The appeal chair |
| Record what happened at a meeting or hearing | The member leading it, or a case manager |

Slice 29 adds no permission. Induction and leaving are the staff file's: read with
`workforce.staff_file.read` (and the worker's own with `workforce.self.read`), written with
`workforce.staff_file.manage`, never on one's own file. A Care Certificate standard is assessed by
a holder of `.manage` or of `workforce.competence.observe`, and observed only by a holder of
`workforce.competence.observe`, never the worker; an assessor reads Care Certificate progress
across the organisation but nothing else of the staff file. Ending a leaver's access at once
needs `.manage`; the sweep does it as the system.

Staff files are the organisation's employment records, not people's care records, and HR functions
are organisation-wide (master prompt section 4): a tenant or location role or a grant anywhere
reaches every file, and so does a role with no person scope (HR's). A role scoped to assigned
people or to the person themselves counts only for `workforce.self.read`. The DBS risk assessment
is signed only where the worker works (or by an organisation-wide holder). Every permission above
except `workforce.self.read` needs MFA, as care records do (`sensitive` in the catalogue): the file
holds special category and criminal offence data. Details changed under a verification are verified
again by whoever changed them; a signed risk assessment is never unsigned; HR-only documents on a
holder's own file are hidden from them; earlier versions of staff files in `record_version` follow
the files' read rule. The database enforces each row (migration 0073):
`app.holds_staff_permission`, the read, insert and update policies, the guard triggers and the
`document_hr_only` policy, which hides HR-only documents from everyone else whatever their document
permissions. The general document routes never serve them and search never finds them.

## 4. Rules that are easy to get wrong

Pure functions in `packages/domain/src/workforce/`, each with a table-driven test. Every figure is
read from the rate table through `workforce/rates.ts` (`resolveWorkforceRates`); dates are UK
calendar dates (`yyyy-mm-dd`, from `ukIsoDate`), so a check due "on" a day is due on that UK day
whatever the clock change.

1. **Schedule 3 file** (`schedule3.ts`). The items a role needs (Health and Social Care Act 2008
   (Regulated Activities) Regulations 2014, Schedule 3): proof of identity with a recent photograph;
   the DBS certificate (enhanced, with the adults' barred list for regulated activity); conduct in
   previous health or social care work, and why that work ended; satisfactory evidence of conduct in
   other work with vulnerable adults or children (references); qualifications relevant to the role;
   a full employment history with a written explanation of any gaps; health information (the person
   is physically and mentally able to do the work, after reasonable adjustments); right to work; and
   professional registration for registered roles (NMC PIN for nurses). The file is complete only
   when every required item is satisfied and none has expired; an item expiring raises reminders at
   `document_expiry.reminder_days.first`, `.second` and `.third` days before, once each.
2. **Right to work** (`right-to-work.ts`). A check made before employment starts gives a statutory
   excuse. An unlimited permission needs no follow-up; a time-limited permission needs a follow-up
   check on or before the day it expires, and from the day after expiry without one the worker has no
   right to work on record (blocking). A check made after the start date is flagged: the excuse does
   not cover the time before it.
3. **DBS** (`dbs.ts`). Clear when an enhanced certificate with the adults' barred list has been seen
   and recorded, or the Update Service status check of a subscribed certificate says no new
   information. Before the certificate, a worker may start only with a clear adults' barred list
   check, a signed risk assessment and supervised shifts only; the risk assessment never clears them
   for unsupervised work. A subscribed certificate's status is re-checked every
   `dbs.update_service.check_interval_months` (a tenant default, to verify: there is no statutory
   interval); a missed re-check is due, not blocking.
4. **Employment history gaps** (`employment-history.ts`). From leaving full-time education (or the
   start of the history the worker gives) to the application month, every calendar month not
   covered by a period of work, education or an explained gap is a gap needing a written
   explanation. Overlapping periods are allowed; months are counted inclusively.
5. **Training matrix** (`training.ts`). Topics from Skills for Care's core and mandatory training
   guidance, each required per role by the tenant; a record is valid until its own expiry, or
   completion plus `training.default_refresh_years` (or the topic's own refresh years); the Oliver
   McGowan Mandatory Training (England) at tier 1 for staff who need general awareness and tier 2
   for those who may support autistic people or people with a learning disability, refreshed every
   `training.oliver_mcgowan.refresh_years`; a tier 1 record never satisfies a tier 2 requirement,
   a tier 2 record satisfies both. Status as a word and an icon, never colour alone: `valid`,
   `due_soon` (expires within `document_expiry.reminder_days.first` days), `expired`, `missing`.
6. **Observed competence** (`competence.ts`). Valid from the day it was observed to the day before
   observed plus the competence's refresh months (`competence.medicines.refresh_months` for
   medicines). Never signed off by the worker themselves, and only by an observer who held
   `workforce.competence.observe` when they signed. The gate: an action needing a competence is
   allowed only with a valid sign-off; otherwise it is blocked with the reason (`missing`,
   `expired`, `self_signed`), unless an override with a justification is recorded (ADR-0085, slice 17).
7. **Supervision and appraisal** (`supervision.ts`). `supervision.per_year` supervisions and
   `appraisal.per_year` appraisals a year: the next is due one interval (12 months divided by the
   number) after the last, or after the start date when none has been held; overdue from the day
   after. Spot checks are recorded but do not count as supervisions.
8. **Qualifications and NMC revalidation** (`registration.ts`). A registered nurse's registration
   must be current on the day worked; revalidation is due every `nmc.revalidation.cycle_years` years
   on the renewal date the NMC gives; the planner counts `nmc.revalidation.practice_hours` practice
   hours, `nmc.revalidation.cpd_hours` CPD hours (of which `nmc.revalidation.participatory_cpd_hours`
   participatory), `nmc.revalidation.feedback_count` pieces of practice-related feedback and
   `nmc.revalidation.reflective_accounts` reflective accounts, plus a reflective discussion, a
   health and character declaration, professional indemnity and confirmation; reminders at the
   document-expiry days.
9. **Sponsor licence** (`sponsor.ts`). A reportable change is due within
   `sponsor.change_report_working_days` working days of the day it happened (the location nation's
   bank holidays; the event's own day never counts). The salary check: guaranteed basic gross pay
   per year at least `sponsor.salary_floor.care_worker` and at least
   `sponsor.salary_floor.care_worker_hourly` an hour, the hourly figure worked out over the
   contracted weekly hours, counting at most `sponsor.counted_weekly_hours_max` hours a week. Both
   floors must be met. `sponsor.switching_evidence_months` is undefined in the source (H-524) and not
   applied.
10. **Rostering** (`rostering.ts`). A worker can be rostered to a shift only if, on the shift's UK
    date, their DBS is clear (or cleared for supervised work and the shift is supervised), they have
    a right to work, their registration is current where the role needs one, and every competence
    the shift needs is valid. Otherwise the result lists each blocker in words; a manager override
    needs a justification, is logged and reported, and never covers a missing right to work (illegal
    working cannot be overridden).

11. **Applications** (`recruitment.ts`, `checkApplicationMove`). Stages: `applied`, `shortlisted`,
    `interviewed`, `offered`, `accepted`, and the closed stages `rejected`, `withdrawn`, `declined`.
    An application is shortlisted only when every essential criterion of its template has been
    assessed and met; a criterion recorded as not met allows only rejection (with a reason code).
    An interview is recorded only once shortlisted, by a panel of 1 to 5 members of staff, with
    every values question scored 1 to 4; the scores are the panel's and the total is shown with
    them, never used to decide (section 5.1: no solely automated significant decision). An offer
    is made only after an interview whose panel recommended proceeding; it is conditional on the
    Schedule 3 items the role needs (`requiredItems`), which the staff profile then lists as
    outstanding. Accepting needs the member of staff (invited through the usual invitation) and
    creates their staff profile; declining or withdrawing closes the application. Closed stages
    never reopen; a new application is made instead.
12. **Equality monitoring** (`equalityMonitoringSummary`). Special category data, kept apart from
    the application (a random id, no date) and reported only as counts for a vacancy. Forms are
    added together once applications have closed, so their timing says nothing about which
    application each came with; the counts are released once the vacancy has closed, and no form
    is added after, so counts read before and after a form can never be compared. A count below
    `EQUALITY_MONITORING_MIN_COUNT` (5) never leaves the database (`app.equality_monitoring_counts`
    returns it as null) and reads "fewer than 5"; a lone small count in a question takes the next
    smallest shown count with it (complementary suppression); a question with no count at the
    minimum, or a vacancy with fewer forms, shows nothing. Answers are optional, and
    `prefer_not_to_say` is always offered.
13. **Keeping applicants' data** (`applicantRetainUntil`). While any application is open the
    applicant is kept. When the last one closes unsuccessfully, the applicant is kept until the
    closing date plus the `applicant.unsuccessful` period (retention.md), or the end of the
    talent pool period they agreed to, whichever is later; withdrawing talent pool consent ends
    that period at once. A hired applicant's details move to the staff file and follow it.

14. **Who reads a case** (ADR-0089). Only the members named on it and not removed: no role, grant
    or break-glass reaches a case, the owner and the Registered Manager included, and a holder of
    `workforce.casework.manage` reads only the cases they are named on. The member of staff a case
    is about is never a member of it (they are told in writing, outside Harbour, until slice 58).
    Every route needs MFA.
15. **How a case moves** (`casework.ts`, `checkCaseMove`). Stages `open`, `investigation`,
    `hearing`, `outcome`, `appeal`, `closed`. An investigation needs an investigator named; a
    hearing may follow the investigation or, where none is needed, the opening. The outcome is
    decided only after a hearing was held (or, where the employee did not attend twice without
    good reason, without one; Acas Code paragraph 25), is one the case type allows
    (`CASE_OUTCOMES`), carries for a warning the date it stops counting (after the decision; the
    tenant's policy, H-808), and is confirmed with the right of appeal. An appeal follows the
    outcome, with its grounds; it is decided by the appeal chair after an appeal hearing, as the
    case closes. Other closings: the outcome accepted, resolved informally (open or under
    investigation), no case to answer (after investigation), withdrawn, or the member of staff
    leaving. A case never closes while a suspension is in force or a referral decision due
    (rule 17) is missing; a closed case never reopens. Dates never go before the current stage's.
    The timeline shows the days between steps and at the current stage, with no target: what delay
    is unreasonable is the people's judgement (`caseTimeline`).
16. **Who takes which part** (`checkMemberAppointment`, `checkMemberRemoval`). Never the member of
    staff the case is about; nobody names themselves. Where practicable (Acas Code paragraphs 6
    and 27) the investigator does not chair the hearing, and the appeal is heard by someone who
    neither investigated nor chaired; a small organisation records why not
    (`no_other_manager_available`). One person may hold several other parts. The last case
    manager is never removed.
17. **Referral decisions** (`referralDecisionsDue`, `checkReferralDecision`). A regulated activity
    provider must refer to the DBS someone it dismissed, or would have dismissed had they not
    left, because they harmed or posed a risk of harm (Safeguarding Vulnerable Groups Act 2006
    section 35); a registered professional's fitness to practise concerns go to their regulator.
    A DBS decision is due before closing a disciplinary or capability case ending in dismissal (or
    the member leaving during it), a probation not passed, or any case linked to a safeguarding
    concern; a regulator decision when the member of staff is on a register and the case ended in
    dismissal or a final written warning (disciplinary or capability), or is linked to a
    safeguarding concern. A decision is `referred` on a date or `not_required` with a reason code.
    Harbour never decides or makes a referral (H-802).

    H-802 (recommended answer applied 31/10/2026, reviewed at testing): the DBS decision is also due when a disciplinary or capability case ends in redeployment, or in an action short of dismissal marked as removing the member from regulated activity (`removes_from_regulated_activity`, decided with the outcome), because the Safeguarding Vulnerable Groups Act 2006 s 35 duty applies to any such removal. Harbour still only asks for the decision.

    H-806: a case closed as a grievance, with no case to answer or withdrawn takes `casework_no_sanction` (6 years after closure); one ending in a sanction, dismissal or referral, or concerning safeguarding, stays with the staff file (`caseRetentionClass`; set by the database as the case closes, migration 0121). Expired warnings stay on the case marked as no longer counting.

    H-804: when every case manager has left, a holder of `platform.user.manage` raises a support ticket naming the case by id and the new case manager (never themselves, the approver or the member of staff the case is about); the data protection lead (`platform.dpia.sign`) approves it with step-up; Thapsus support appoints them once (`app.operator_appoint_case_manager`) without reading the case, audited to the organisation, whose owners are told.

    H-805: a case manager exports their case as JSON with a fresh step-up (`GET /v1/workforce/cases/{id}/export`, audited); the organisation-wide export still never carries casework. A staff subject access request raises a task for each case about or naming the requester for its case manager (`raiseCaseworkDsarTasks`, through `app.casework_for_subject_access`, ids only); a case with no case manager employed goes to support (H-804).
18. **Hearings and suspension** (`checkHearingInvitation`, `checkHearingChange`,
    `checkSuspension`). A hearing or appeal hearing is arranged only once the employee has the
    issue in writing (and, in a disciplinary or capability case, the evidence) and has been told
    of their statutory right to be accompanied (Employment Relations Act 1999 section 10), for a
    later date; how much notice is reasonable is the tenant's policy (H-808). An investigation
    meeting is led by the investigator, a hearing by the hearing chair, an appeal hearing by the
    appeal chair. A meeting is held (with whether the employee was accompanied, never by whom),
    not attended, postponed with a reason and rearranged, or cancelled; a held, unattended or
    cancelled one is final. Suspension is only in a disciplinary case, a precaution while the
    facts are established and never a sanction: it always carries its next review date, is
    shown as overdue in words the day after, and ends before the case closes.

19. **The induction checklist** (`induction.ts`, `inductionState`). Ticked by hand: the contract
    issued, system access set up, uniform and badge, the induction at the location, the fire
    safety briefing and shadowing signed off. Worked out: the pre-employment checks (the staff file
    complete, rule 1), policy read-and-sign (every published policy the worker's roles need signed,
    quality.md rule 26, counted by `app.induction_policy_signing` without reading anyone's
    signatures), the Care Certificate (all 16 standards, or not needed when already held) and
    probation (passed). An item due before the start date is overdue from the start date while
    outstanding; the probation decision from the day after probation was due to end. Status is a
    word and an icon, never colour alone.
20. **The Care Certificate** (`checkStandardChange`, `careCertificateProgress`). Its 16 standards
    by id and short title only (`CARE_CERTIFICATE_STANDARDS`; the text is Skills for Care's,
    H-531, H-871). Each is first assessed for knowledge, then the worker is observed competent in
    practice; each step by someone other than the worker, in their own name, never before the
    start date or after today, never twice; the observation only by a holder of
    `workforce.competence.observe`, never before the knowledge assessment. Complete once all 16
    are competent, on the last observation's date.
21. **Shadow shifts and probation** (`checkSupervisedEntry`, `checkProbationDecision`). A shadow
    shift is with a colleague, never the worker; a probation review and the decision are by
    someone other than the worker, never before the start date. Probation is passed, extended to a
    later date (and decided again), or not passed. A probation not passed is a dismissal decision
    made through an employee relations case of type `probation` (rule 15); the plan only notes it.
22. **Leaving** (`checkLeaving`, `accessRemovalDue`, `checkExitInterview`, `leaverState`). The
    leaving date is on or after the start, recorded once, by someone other than the leaver. Access
    ends at the end of the leaving day: the hourly sweep ends it from the UK day after
    (`app.end_leaver_access`: the member is marked as left, so they hold nothing; their roles end
    now and their grants are revoked; their open invitations end), or a manager ends it at once
    (with step-up). A member who manages users, roles or grants, or holds a silo role, has their
    access ended only by a holder of `platform.user.manage` (or the sweep), and the organisation's
    last active member who manages users keeps theirs; the sweep ends each leaver on its own, so
    one it cannot end is audited and never holds the others back. Access is marked ended only by
    the function that ends it.
    The exit interview moves from not offered to offered, then declined or held (with its date and
    a summary the leaver may see). A reference request names the organisation asking; it is sent
    once, in the sender's own name, or declined with a reason. Leaving items are overdue from the
    day after the leaving date.

    H-873 (applied 31/10/2026): the sweep ends access at the later of the end of the leaving day and the end of the last rostered shift that starts on it (`accessEndsAt`; the rota through `RotaPort`), so a night worker is never cut off mid-shift; ending access at once with step-up stays for dismissals. H-879: the sweep then signs the leaver out of every device, unless they still work for another organisation, keeping unsent entries on the device for hand-over; a leaver keeps no access to their own staff file and asks through a subject access request. H-876: a reference request is a conduct reference by default, and "requester not verified" replaces "no consent to share" (references rest on legitimate interests with the staff privacy notice, never consent).
23. **Keeping the staff file** (`staffFileRetainUntil`). From the leaving date: the organisation's
    own `staff_file.after_leaving` row when it set one (6 years by default), otherwise the default
    to the later of leaving and the birthday at `retention.staff_file.birthday_age` (75); with no
    date of birth the file is kept and the date left empty for a person to decide (H-874).

    H-874 (applied 31/10/2026): a leaver with no date of birth gives HR a task to record it at leaving; until it is, the file is kept and comes up for a person's decision once the after-leaving period (`staff_file.after_leaving`) has passed (`staffFileReviewDue`, a task raised once by the leaver sweep), never kept indefinitely without review. Each organisation chooses its staff file row once at onboarding, approved by its data protection lead.

24. **Vetting adapters** (`vetting.ts`; ADR-0094). A check starts only when its port is on, on
    someone else's file, with no check of that kind pending (`vettingRequestProblem`). The IDSP
    checks only a valid British or Irish passport or an Irish passport card; everyone else is
    checked with the Home Office online share code or by hand. A DBS application needs the
    worker's consent to it, and an Update Service status check their consent to status checks, in
    force on the day (`consentActive`: from the day given until the day withdrawn), a subscribed
    certificate's number and their date of birth. An NMC check needs the role's register to be the
    NMC and a PIN on the file. A result changes nothing by itself: a holder of
    `workforce.staff_file.manage` applies it (`vettingApplication`), verifying the item in their
    name on the check's date with the check as its source. An IDSP verification adds an unlimited
    `idsp` right to work check; an issued certificate records its level, number, issue date and
    whether it is clear, and nothing it disclosed; a status check records its date and result (new
    information then blocks, rule 3); an NMC registration moves the renewal date. Not verified,
    withdrawn, details not matched, not registered and registered with conditions are never
    applied, and a result is not applied once the file's certificate number or PIN has changed
    (`vettingCheckStillMatches`). Once the worker withdraws their consent, a pending DBS check is
    neither asked about nor applied, and an answer arriving after it fails the check
    (`consent_withdrawn`); it can be cancelled. The database names a check as an item's source only
    when the same transaction applied it, and refuses any change under that label: recorded by hand,
    the item goes back to `manual`.

Rate keys in use: `retention.staff_file.birthday_age`, `training.default_refresh_years`, `training.oliver_mcgowan.refresh_years`,
`competence.medicines.refresh_months`, `supervision.per_year`, `appraisal.per_year`,
`document_expiry.reminder_days.first`, `.second`, `.third`, `nmc.revalidation.cycle_years`,
`nmc.revalidation.practice_hours`, `nmc.revalidation.cpd_hours`,
`nmc.revalidation.participatory_cpd_hours`, `nmc.revalidation.feedback_count`,
`nmc.revalidation.reflective_accounts`, `dbs.update_service.check_interval_months`,
`sponsor.salary_floor.care_worker`, `sponsor.salary_floor.care_worker_hourly`,
`sponsor.change_report_working_days`, `sponsor.counted_weekly_hours_max`.

## 5. API and events

Slice 11 (the staff file). Every change takes `expectedVersion` (409 when stale) and writes an
audit event with opaque ids only; refusals are audited too. Dates are UK dates (`yyyy-mm-dd`).

| Route | Permission | Does |
| --- | --- | --- |
| `GET /v1/workforce/staff-files` | `workforce.staff_file.read` | Every profile with its file state today: complete or not, outstanding items, items due soon |
| `POST /v1/workforce/staff-files` | `workforce.staff_file.manage` | Create a profile for a member of staff (not oneself); 409 if they have one |
| `GET /v1/workforce/staff-files/{id}` | `workforce.staff_file.read` | The profile, each item with its details, status and notes (`staffFileState`), and the HR-only documents' titles to holders of `workforce.hr_document.read` |
| `PATCH /v1/workforce/staff-files/{id}` | `workforce.staff_file.manage` | Change the profile |
| `PUT /v1/workforce/staff-files/{id}/items/{kind}` | `workforce.staff_file.manage` | Record or replace one item's details, and verify it (in the caller's name) or leave it unverified; works out `expires_on` and `recheck_due_on`, and ends open reminder tasks when the reminder date changes |
| `POST /v1/workforce/staff-files/{id}/items/dbs_certificate/risk-assessment` | `workforce.dbs_risk_assessment.sign` | Sign the DBS risk assessment, in the caller's name, never their own |
| `POST /v1/workforce/staff-files/{id}/items/{kind}/documents` | `workforce.staff_file.manage` and `workforce.hr_document.read` | Add an HR-only document to an item (the file as the body, as the document store takes it); never to `dbs_certificate` |
| `GET /v1/workforce/staff-files/{id}/documents/{documentId}/content` | `workforce.hr_document.read` | Open an HR-only document; every open writes `workforce.hr_document.viewed` |
| `GET /v1/workforce/vetting/ports` | `workforce.staff_file.read` or `.manage` | Which vetting ports the organisation has switched on, and their provider (slice 77) |
| `GET /v1/workforce/staff-files/{id}/vetting` | `workforce.staff_file.read` or `.manage` | The file's consents and checks |
| `POST /v1/workforce/staff-files/{id}/vetting/consents` | `workforce.staff_file.manage` | Record the worker's consent to a DBS application or to Update Service status checks, with the date given (never one's own); 409 while one is in force |
| `POST /v1/workforce/staff-files/{id}/vetting/consents/{consentId}/withdraw` | `workforce.staff_file.manage` | Record its withdrawal, once |
| `POST /v1/workforce/staff-files/{id}/vetting/checks` | `workforce.staff_file.manage` | Start a check through the port's adapter (rule 24); 409 `adapter_off` when the port is off |
| `POST /v1/workforce/staff-files/{id}/vetting/checks/{checkId}/refresh` | `workforce.staff_file.manage` | Ask the adapter again about a pending check; 409 `not_sent` for one that never reached the provider, `consent_withdrawn` for a DBS check whose consent is no longer in force |
| `POST /v1/workforce/staff-files/{id}/vetting/checks/{checkId}/cancel` | `workforce.staff_file.manage` | Mark a pending check failed (`cancelled`), so a new one can start |
| `POST /v1/workforce/staff-files/{id}/vetting/checks/{checkId}/apply` | `workforce.staff_file.manage` | Apply a completed check to its item, verified in the caller's name on the check's date with the check as its source; the item's `expectedVersion` when it exists |
| `PUT /v1/integrations/{port}` (a vetting port) | `integrations.connection.manage`, fresh step-up | Switch a vetting port on with a known provider (`mock` outside production only) |

Audit events (slice 77): `workforce.vetting.viewed` (every read of a file's consents and checks:
DBS results are criminal offence data), `workforce.vetting_consent.recorded`, `.withdrawn`,
`workforce.vetting_check.started`, `.refreshed`, `.answered` (the state and error code stored),
`.applied`, `.cancelled`, each with opaque ids and codes only, and refusals with their reason.
| `GET /v1/me/staff-file` | `workforce.self.read` | The member's own profile and where each of their checks stands |

Audit actions: `workforce.staff_file.created`, `.updated`, `workforce.compliance_item.recorded`,
`workforce.dbs_risk_assessment.signed`, `workforce.hr_document.added`, `workforce.hr_document.viewed`.

Slice 17 (training, competence, supervision, revalidation; members by `tenant_user` id):

| Route | Permission | Does |
| --- | --- | --- |
| `GET /v1/workforce/training-requirements` | `workforce.training.manage` | The organisation's matrix: requirements by role |
| `PUT /v1/workforce/training-requirements` | `workforce.training.manage` | Add or change one role and topic's requirement (`expectedVersion` when it exists) |
| `GET /v1/workforce/members/{memberId}/development` | read (section 3, as the database counts it: a reader whose permission comes only from a role scoped to assigned people or to the person gets 404) | The member's training matrix today (`trainingMatrix`), records, competences with their state, next supervision and appraisal after the last one held (`nextMeeting`; none before the first, since the start date is in the staff file), and the revalidation plan (`revalidationPlan`) |
| `POST /v1/workforce/members/{memberId}/training-records` | `workforce.training.manage` | Record training |
| `PATCH /v1/workforce/members/{memberId}/training-records/{recordId}` | `workforce.training.manage` | Correct a record (`expectedVersion`) |
| `POST /v1/workforce/members/{memberId}/competences` | `workforce.competence.observe` | Sign off an observed competence in the caller's name; publishes `workforce.competence.changed` |
| `POST /v1/workforce/members/{memberId}/competences/{signOffId}/withdraw` | `workforce.competence.observe` or `workforce.training.manage` | Withdraw a sign-off with a reason; publishes `workforce.competence.changed` |
| `POST /v1/workforce/members/{memberId}/supervisions` | `workforce.supervision.manage` | Record a supervision, appraisal or spot check held by the caller |
| `PUT /v1/workforce/members/{memberId}/revalidation` | `workforce.training.manage` | Record revalidation evidence for a cycle |
| `GET /v1/me/development` | `workforce.self.read` | The member's own development record |

The competence port (ADR-0085): `competencePort(tx, memberId, competence, at)` in
`apps/api/src/services/competence-port.ts`, for medicines and scheduling on the server; it reads
that member's unwithdrawn sign-offs with the system's rights for that one question and returns
`competenceDecision` (allowed until a date, or blocked as `missing`, `expired` or `withdrawn`).
No route takes a competence from the client.

Training and competence reminders: the same hourly job raises a task (kind
`workforce.training_expiry` or `workforce.competence_expiry`, generic title, assigned to the `hr`
role, no person or location) at each document-expiry reminder day before a required topic's or a
competence's valid-until date, once each. Task visibility (migration 0079): a task about no person
and no location whose required permission is a workforce one is visible to holders of that
permission, so HR's role sees its reminders; without MFA a session does not list staff file tasks.

Expiry tasks (rule 1): the `staff-file-expiry-reminders` job runs hourly. For each item with an
expiry or a re-check date, at `document_expiry.reminder_days.first`, `.second` and `.third` days
before it, it raises one task through the task engine (kind `workforce.compliance_expiry`, the
generic title "Renew a staff check before it expires", no name; `requiredPermission`
`workforce.staff_file.manage`; assigned to the `hr` role; with no location, so care staff never
see whose check is due (organisation-wide roles do; an inbox for HR's role comes with the task
port); source the
compliance item, with the offset and the date in its details), once each: a task already raised
for that item, offset and date, whatever its status, stops a second, and the job never changes the
item. Recording the item again with a new date cancels its open reminder tasks (as the system,
for that item only), and the new date's reminders follow. Competence changes are published for
medicines and scheduling (ADR-0085, slice 17).

Slice 23 (applicant tracking). Permission `workforce.recruitment.manage` throughout (MFA: the
records are about job applicants, special category for equality monitoring); changes take
`expectedVersion` where the record is mutable; refusals are audited; audit events carry opaque ids
and codes only, never names or answers.

| Route | Does |
| --- | --- |
| `GET`, `POST /v1/workforce/job-templates`; `PATCH /v1/workforce/job-templates/{id}` | Templates by Care Workforce Pathway role |
| `GET`, `POST /v1/workforce/vacancies`; `PATCH /v1/workforce/vacancies/{id}` | Vacancies and their status |
| `GET`, `POST /v1/workforce/vacancies/{id}/applications` | Applications to a vacancy; posting records the applicant (or finds them by email) and the application |
| `GET /v1/workforce/applications/{id}` | The application with its applicant, stage history, interviews and offer |
| `POST /v1/workforce/applications/{id}/shortlist` | Record each essential criterion met or not, and shortlist or reject |
| `POST /v1/workforce/applications/{id}/close` | Reject or record a withdrawal, with a reason code |
| `POST /v1/workforce/applications/{id}/interviews` | Record an interview |
| `POST /v1/workforce/applications/{id}/offer` | Make the conditional offer |
| `POST /v1/workforce/offers/{id}/response` | Accepted (with the member of staff: creates the staff profile), declined or withdrawn |
| `PUT /v1/workforce/applicants/{id}/talent-pool` | Record or withdraw talent pool consent |
| `POST /v1/workforce/vacancies/{id}/equality-monitoring` | Add one anonymous equality monitoring form |
| `GET /v1/workforce/vacancies/{id}/equality-monitoring` | The counts (rule 12) |

Audit actions: `workforce.job_template.created`, `.updated`, `workforce.vacancy.created`,
`.updated`, `workforce.application.created`, `.viewed`, `.shortlisted`, `.closed`,
`workforce.interview.recorded`, `workforce.offer.made`, `.responded`, `workforce.applicant.talent_pool`,
`workforce.equality_monitoring.added`, `.summarised`.

Slice 39 (employee relations casework). Every route needs MFA; a case the caller is not named on
is not found; changes to a case take `expectedVersion` (409 when stale); refusals are audited;
audit events carry the case id and codes only, never the member of staff, the summary, the
grounds, notes or names.

| Route | Who | Does |
| --- | --- | --- |
| `GET /v1/workforce/cases` | Any member of staff | The cases the caller is named on, with their parts |
| `POST /v1/workforce/cases` | `workforce.casework.manage` | Open a case about another member of staff; the caller becomes its case manager |
| `GET /v1/workforce/cases/{id}` | A member | The case, members, hearings, referral decisions (with whether each is due) and timeline; audited |
| `POST /v1/workforce/cases/{id}/members`; `POST .../members/{memberId}/remove` | A case manager | Name a member (rule 16); remove one |
| `POST /v1/workforce/cases/{id}/move` | Case manager; hearing chair (outcome); appeal chair (appeal decided) | Move the case on (rule 15) |
| `POST /v1/workforce/cases/{id}/hearings`; `PATCH .../hearings/{hearingId}` | A case manager; the member leading it | Arrange a meeting or hearing; record what happened (rule 18) |
| `PUT /v1/workforce/cases/{id}/suspension` | A case manager | Suspend, review or end (rule 18) |
| `PUT /v1/workforce/cases/{id}/referrals` | A case manager | Record a DBS or regulator referral decision (rule 17) |
| `PUT /v1/workforce/cases/{id}/safeguarding-link` | A case manager who can see the concern | Link the safeguarding concern, once |
| `POST /v1/workforce/cases/{id}/notes` | A member | Add a note, until the case closes |

Audit actions: `workforce.case.opened`, `.listed`, `.viewed`, `.member_named`, `.member_removed`,
`.moved`, `.hearing_arranged`, `.hearing_updated`, `.suspension`, `.referral_recorded`,
`.safeguarding_linked`, `.note_added`. No outbox event is published: nothing outside the case
learns of it.

Slice 29 (induction, the Care Certificate and leavers). Changes take `expectedVersion` where the
record is mutable; refusals are audited; audit events carry the staff file's id and codes only,
never notes, the exit interview summary or the requester. The routes are under
`/v1/workforce/staff-files/{id}`:

| Route | Permission | Does |
| --- | --- | --- |
| `GET .../induction`; `GET /v1/me/induction` | `workforce.staff_file.read`; `workforce.self.read` | The checklist with each status, read-and-sign counts, the Care Certificate, shadow shifts and probation |
| `PUT .../induction` | `.manage` | The plan: probation end date, Care Certificate already held |
| `POST .../induction/items/{kind}` | `.manage` | Tick an item, in the caller's name |
| `POST .../induction/shadow-shifts`; `POST .../induction/probation-reviews`; `POST .../induction/probation-decision` | `.manage` | Rule 21 |
| `PUT .../care-certificate/{standardId}` | `.manage` or `workforce.competence.observe` | Assess knowledge, then observe (observers only); returns the Care Certificate alone |
| `GET`, `POST .../leaving` | `.read`; `.manage` | The leaving; recording it sets `left_on` and the keep-until date |
| `POST .../leaving/items/{kind}`; `PUT .../leaving/exit-interview`; `POST .../leaving/end-access` | `.manage` | Rule 22 |
| `POST .../references`; `PATCH .../references/{referenceId}` | `.manage` | A reference request and its answer |

Audit actions: `workforce.induction.viewed`, `.plan_set`, `.item_ticked`, `.shadow_shift`,
`.probation_review`, `.probation_decided`, `workforce.care_certificate.recorded`,
`workforce.leaving.viewed`, `.recorded`, `.item_ticked`, `.exit_interview`, `.access_ended`
(by the sweep with no actor), `workforce.reference.requested`, `.answered`. The
`leaver-access` job runs hourly at 7 past.

### Screens (slice 58)

Web screens for WORK-001, WORK-004, WORK-010 and WORK-013, on the routes above. Every screen checks
the permission again in the API; the web only decides what to offer.

| Screen | Path | Offered to | Does |
| --- | --- | --- | --- |
| Job templates | `/workforce/job-templates` | `workforce.recruitment.manage` | List and add templates: Care Workforce Pathway role, registration, essential criteria, values-based questions |
| Vacancies | `/workforce/vacancies`, `/workforce/vacancies/{id}` | `workforce.recruitment.manage` | Add and open vacancies; the applications, each stage as an icon and a word; add an application; change status; equality counts, withheld below the minimum |
| Application | `/workforce/applications/{id}` | `workforce.recruitment.manage` | Shortlist against each criterion, record an interview (panel from the colleagues list, each answer scored 1 to 4, the total shown, never a decision), make an offer, record the response, close it (with confirmation) |
| Staff | `/workforce/staff` | `workforce.staff_file.read` or `.manage` | Each member's file state, with links to their induction and leaving |
| Induction | `/workforce/staff/{id}/induction` | as Staff; assessors for the Care Certificate | Checklist ticks, plan, shadow shifts, probation reviews and decision, each Care Certificate standard assessed and observed |
| Leaving | `/workforce/staff/{id}/leaving` | as Staff | Record a leaving, the checklist, end access now (confirmation and step-up), exit interview, references |
| Employee relations | `/workforce/cases`, `/workforce/cases/{id}` | the case's members; opening a case to `workforce.casework.manage` | My cases; members, hearings, suspension, referrals, outcome, appeal, timeline and notes, each action offered only to the part that may take it |

- **The silo in the navigation.** "Employee relations" appears only for holders of
  `workforce.casework.manage`. The navigation never shows whether anyone is on a case, so a member
  named on a case without the permission reaches it by its link. The list and the case page show
  nothing to a non-member: the API answers 404, and the page answers "not found".
- **Colleagues.** `GET /v1/workforce/colleagues` (any of `workforce.recruitment.manage`,
  `workforce.staff_file.read`, `workforce.staff_file.manage`, `workforce.casework.manage`) lists
  colleagues by name and job title only. A colleague is an invited or active member holding a role
  in force (started, not ended, not archived) that is neither a portal role nor one in
  `NON_STAFF_ROLE_KEYS` (inspector, external professional, agency worker, family, person receiving
  care). Naming a case member or an interview panel refuses anyone else (422), so the rule holds past
  the picker. The read is audited (`workforce.colleague.listed`) without names. It needs no verified
  second factor: it holds staff names only, never a care record.
- **Names on cases.** `CaseSummary.subjectName` and `CaseDetail.staff` name only the people the case
  references, and only to its active members.
- **After a save** the page opens again at `?done=<catalogue key>&at=…`. The status says what was
  done and focus moves to the page's heading. Only a known `workforce.*` key is said, so the address
  cannot put words on the page. The form is cleared, so an append-only entry is not sent twice.
- **Destructive steps** (remove a case member, close an application, close a case, end access now)
  say what follows and need a confirmation box; ending access also needs step-up.
- Strings are en-GB; Welsh entries are marked untranslated. Dates are dd/mm/yyyy, times 24-hour.

## 6. Offline behaviour

Section 17.1: e-learning modules downloaded in advance are completed offline (plan slice 72).

## 7. Clinical safety

Expired competence that fails to block an action is a hazard (HZ-119, added by slice 3); a worker
rostered without a required check is HZ-124, in the hazard log from slice 4 with the rostering rule
as its first control. Slice 17 adds controls to both: the stored sign-offs with the database's
guards (observer's own name, the permission, never self, never in the future, append-only,
withdrawal), the competence port that medicines and scheduling call on the server (ADR-0085), and
the expiry reminders. HZ-124's verification rows are in the hazard log; HZ-119 is being written by
slice 3, so its rows from this slice are listed here for that entry:

| Test (slice 17) | For HZ-119 |
| --- | --- |
| `packages/domain/src/workforce/competence-port.test.ts`: `hazard HZ-119 ...` (allowed through the valid-until day, expired from the day after; a withdrawal blocks the competence until a new observation on or after it, whatever older sign-offs say; missing; future sign-offs ignored; a device's time can only block; the UK day across the autumn clock change) | Passing (slice 17) |
| `packages/db/test/training-competence.test.ts`: `hazard HZ-119 ...` (a sign-off only in the observer's own name, by a holder of the observe permission, never self, never dated in the future, never before a withdrawal, valid exactly until the day before its refresh whoever inserts it, never changed or deleted; a withdrawal never by the worker) | Passing (slice 17) |
| `apps/api/test/training-competence.test.ts`: `hazard HZ-119 ...` (the port blocks missing, expired and withdrawn competence, a backdated re-sign-off and a device's earlier time, and allows a valid one, about another member whose training the caller cannot read; a sign-off changes the answer at once) | Passing (slice 17) |

Decisions for the CSO from the slice 17 review are in H-691: whether a withdrawal blocks the
competence as a whole (built so: the safer reading), which time medicines and the rota pass,
retiring `competenceGate`, whether a later, shorter refresh applies to sign-offs already made, who
receives competence reminders, and the month-end rule (31 March plus a month is valid until 29
April; 29 February plus a year until 27 February, always on the short side).

The competence catalogue is the organisation's own record of observed practice, not a clinical
judgement about a person receiving care: it stays inside the medical-device boundary
([medical-device-boundary.md](../compliance/medical-device-boundary.md); re-checked for slice 17).

## 8. Data protection

Purpose B3 in the [records of processing](../compliance/records-of-processing.md). Section 12.4:
staff privacy notice, staff DSARs in the section 5 workbench, HR-only immigration and sponsor
documents, staff photo and image consent, and an employee-monitoring DPIA.

The pre-employment file (slice 11) holds special category data (health: the fitness declaration
and any health questionnaire; possibly racial or ethnic origin and religion seen on identity and
right to work documents) and criminal offence data (the DBS check). Conditions:

- Article 6(1)(c) legal obligation (Health and Social Care Act 2008 (Regulated Activities)
  Regulations 2014 regulation 19 and Schedule 3; Immigration, Asylum and Nationality Act 2006
  sections 15 to 25), and 6(1)(b) for the contract of employment.
- Health: Article 9(2)(b) (employment) with DPA 2018 Schedule 1 Part 1 paragraph 1.
- DBS: Article 10 with DPA 2018 section 10(5) and Schedule 1 Part 1 paragraph 1 (employment), and
  Part 2 paragraph 18 (safeguarding of children and individuals at risk).
- Both need the controller's appropriate policy document (Schedule 1 Part 4) and an entry in its
  records of processing that says so (paragraph 41); the provider is the controller (H-576).

Minimisation: no DBS certificate copy and nothing of what one disclosed (only the level, date,
number, clear or disclosed, and the risk assessment decision; the DBS code of practice); no share
codes; no health details, only the declaration; HR-only documents behind their own permission with
every view audited. Retention: the staff file row the tenant chose; right to work copies
`right_to_work_copy` ([retention.md](retention.md)).

Applicants (slice 23) are purpose B15: people who apply and may never be employed. Lawful basis
Article 6(1)(b) (steps at the applicant's request before a contract) and 6(1)(f) for running the
recruitment; the talent pool only with the applicant's consent (Article 6(1)(a)), recorded with
its date and end, and withdrawn at once. Equality monitoring answers are special category data:
voluntary, with `prefer_not_to_say` on every question, Article 9(2)(g) with DPA 2018 Schedule 1
paragraph 8 (equality of opportunity or treatment), under the appropriate policy document (H-576);
they are kept apart from the application with no link back to the applicant, read by nobody row
by row, and reported only as suppressed counts per vacancy (rule 12; DPIA risk R29). Applicants'
data is used only for the recruitment it was given for: interview notes, scores and the stage
history are never copied into the staff file, which receives only the job, the role's Schedule 3
conditions and the start date. Retention: `applicant.unsuccessful` and `applicant.talent_pool`
([retention.md](retention.md)); equality monitoring rows follow `applicant.unsuccessful` from the
vacancy's closing date.

Employee relations casework (slice 39) is purpose B3: special category data (health, in sickness
absence and capability cases) and allegations of criminal conduct (disciplinary cases and DBS
referral decisions), possibly more in free text. Lawful basis Article 6(1)(b) and (c) (the
contract; the Employment Rights Act 1996 and Employment Relations Act 1999 duties; the DBS
referral duty under the Safeguarding Vulnerable Groups Act 2006 section 35) and 6(1)(f) for
running fair procedures. Health: Article 9(2)(b) with DPA 2018 Schedule 1 Part 1 paragraph 1.
Allegations and offences: Article 10 with section 10(5), Schedule 1 Part 1 paragraph 1 and Part 2
paragraph 18. All under the appropriate policy document (H-576, H-800). Minimisation and
confidentiality: only the members named on a case read it (rule 14), never the owner or a manager
as such; no copy in `record_version`; no outbox event; audit events with the case id and codes
only; who accompanied the employee is never recorded; the case is left out of the
organisation-wide export (H-805). Retention: with the staff file, from the end of the member of
staff's employment ([retention.md](retention.md); H-806). The DPIA's R21 (a silo reached by a
wider role, or the subject of a case disclosed) is answered by the silo and its tests.

Induction and leaving (slice 29) are purpose B3, part of the staff file: probation review notes and
the exit interview summary are free text that may hold opinions about the worker (and, rarely,
health); reference requests name the organisation asking, never a person. Lawful basis Article
6(1)(b) (the contract) and 6(1)(f) (running induction and fair references); the Care Certificate
evidences training the Health and Social Care Act 2008 (Regulated Activities) Regulations 2014
regulation 18 requires (6(1)(c)). Minimisation: Care Certificate standards stored by id only; no
reference text is stored (only that one was sent, when and by whom); assessors see only the Care
Certificate. Retention: the staff file row (rule 23; [retention.md](retention.md)), from the
leaving date. The worker sees their own induction, probation reviews and exit interview summary.

## 9. Acceptance criteria and tests

Slice 4 (domain, table-driven, `packages/domain/src/workforce/*.test.ts`, coverage at least 90%):

- `schedule3.test.ts`: the items per role (registered nurse adds the NMC PIN); complete only with
  every item satisfied and none expired; reminders on the first, second and third reminder day,
  once each.
- `right-to-work.test.ts`: unlimited needs no follow-up; time-limited due on expiry, blocking from
  the day after; a check after the start date flagged.
- `dbs.test.ts`: cleared by a certificate or a clear Update Service check; supervised-only start
  with a barred list check and a signed risk assessment; Update Service re-check due dates.
- `employment-history.test.ts`: gaps by calendar month, overlaps, explained gaps, a gap of one month.
- `training.test.ts`: refresh from the topic or the default; Oliver McGowan tiers; due soon at the
  first reminder day; missing and expired.
- `competence.test.ts`: validity to the day before the refresh; self sign-off refused; observer
  without the permission refused; the gate's reasons.
- `supervision.test.ts`: intervals from the rate table; due from the start date; overdue.
- `registration.test.ts`: lapsed registration; revalidation due date; evidence counts against each
  rate.
- `sponsor.test.ts`: working-day deadlines across a bank holiday and a weekend; both salary floors;
  the weekly hours cap.
- `rostering.test.ts`: each blocker; supervised start; override refused for right to work.
- Every rule across a clock change: an instant late on the last Sunday of March or October resolves
  to the right UK date.

Slice 11:

- `staff-file.test.ts` (domain): every kind satisfied and not; self-verified and future-verified
  items; a disclosure accepted only by a risk assessment signed on or after the certificate;
  supervised only; the right to work's latest check wherever it is listed and a late first check;
  gaps; the whole file per role; reminders on each offset, once each, and to the DBS re-check.
- `packages/db/test/staff-file.test.ts`: another organisation's files, items and HR-only
  documents never seen or written; HR's role with no person scope reads and writes; a location's
  manager reads across the organisation; the worker reads only their own file and writes nothing;
  a manager never writes their own file; verification and signing only in one's own name; the
  sign permission; nothing deleted; earlier versions kept; HR-only documents seen and added only by
  holders of `workforce.hr_document.read`.
- `apps/api/test/staff-files.test.ts`: each route's permission and refusal audit; the file state;
  stale `expectedVersion`; the HR-only document added, refused through the general routes, opened
  and audited; the worker's own file; the reminder job raising each task once and the tasks ended
  by a renewal.

Slice 17:

- `competence-port.test.ts` (domain): the decision through the valid-until day, expired,
  withdrawn, missing, future sign-offs; refresh months per competence from the rate table.
- `packages/db/test/training-competence.test.ts`: another organisation's rows never seen; readers
  and writers per section 3; the member reads only their own and writes nothing; sign-offs and
  withdrawals append-only and guarded; task visibility for workforce reminders.
- `apps/api/test/training-competence.test.ts`: each route's permission and audit; the matrix with
  Oliver McGowan tiers; the port; the outbox events; the reminders once each; HR sees its
  reminders.


Slice 77:

- `vetting.test.ts` (domain, table-driven): ports, items and sources line up; consent in force on
  the day; every reason a check may not start (own file, port off, a check pending, IDSP documents,
  consent, certificate number, subscription, date of birth, register, PIN); applying every outcome
  of every port, and a result dated after today; a result for a changed certificate or PIN.
- `apps/api/src/integrations/vetting.test.ts`: the shared contract suite
  (`vetting.contract.ts`) run on every mock scenario: answers parse strictly, retries are
  idempotent, requests carry only the declared fields, health reports, the mock refused in
  production; the adapter chooser off without a connection.
- `packages/db/test/vetting.test.ts`: another organisation's consents and checks never seen or
  written; the worker reads their own and writes none; one consent in force per purpose;
  withdrawn once; a check moves forward only and is applied once in the applier's own name; the
  evidence source checks; nothing deleted.
- `apps/api/test/vetting.test.ts`: ports off by default; switching one on needs step-up and a known
  provider; each route's permission and refusal audit; consent required for the DBS checks; the
  IDSP, DBS, Update Service and NMC journeys through the mock to an applied item with its source;
  outcomes that are never applied; a result for a replaced certificate.

API, web and mobile tests come with slices 35, 56 and 57; the Phase 2 gate needs expired
competence to block administration (with [medicines.md](medicines.md)).

Slice 23:

- `recruitment.test.ts` (domain, table-driven): every allowed and refused stage move; shortlisting
  only with every criterion met, rejection with a criterion not met; interviews only once
  shortlisted, with every question scored 1 to 4 and a panel of 1 to 5; offers only after a
  recommendation to proceed, with the role's Schedule 3 conditions; closed stages never reopen;
  the equality monitoring counts with small numbers suppressed and a question withheld; the
  applicant's keep-until date with and without the talent pool, and with an open application.
- `packages/db/test/applicant-tracking.test.ts`: another organisation's templates, vacancies,
  applicants, applications, interviews, offers and monitoring never seen or written; only holders
  of `workforce.recruitment.manage` read or write; equality monitoring rows never read by anyone,
  only counted through `app.equality_monitoring_counts`; interviews and stage events never
  changed or deleted.
- `apps/api/test/recruitment.test.ts`: the routes' permission and audited refusals; the whole
  path from template to accepted offer creating the staff profile with the offer's conditions
  outstanding; stale `expectedVersion`; the counts suppressed; the keep-until date set when the
  last application closes and extended by talent pool consent.

Slice 39:

- `casework.test.ts` (domain, table-driven): every allowed and refused move; outcomes per case
  type; warnings with and without their end date; the appeal; closing refused while suspended or
  with a referral decision missing; referral decisions due for each case type and outcome, a
  registered professional and a safeguarding link; who may take which part, with and without the
  exception; the last case manager; the hearing invitation's steps; hearing changes; suspension
  start, review and end; warnings counting; the timeline across a clock change; the silo
  permission held only by the caseworker role, alone.
- `packages/db/test/casework.test.ts`: the owner (with every other permission, user and role
  management included), the Registered Manager, the member of staff, a caseworker not named,
  a person not yet named, break-glass and another organisation read nothing; only a holder of
  the silo permission opens a case, never about themselves, and open; members never named
  by themselves or by anyone but a case manager; the subject never named; the investigator not
  chairing without the exception; a removed member reads nothing; the last case manager stays;
  hearings led by the matching member and final once held; forward moves only; a decided outcome
  kept; an unknown safeguarding concern refused; a closed case never changed; the timeline never
  changed or deleted; the role, grant, self-appointment and user-management guards.
- `apps/api/test/casework.test.ts`: the owner and the Registered Manager refused opening a case
  (audited); not found for the owner, the manager, the member of staff and others until named;
  MFA for a named member; a disciplinary case from opening through investigation, suspension, a
  hearing with the Acas steps, the outcome by the hearing chair, an appeal by someone not
  involved, the DBS decision and the suspension ended, to the appeal decided; stale versions; a
  member removed; audit events with ids and codes only.

Slice 29:

- `induction.test.ts` (domain, table-driven): the 16 standards; each Care Certificate step and its
  refusals (the worker, the future, before the start, twice, observation before knowledge or by a
  non-observer); completion; every induction item's status and when it is overdue; probation
  decisions; shadow shifts and reviews; leaving; access due from the day after; the exit
  interview; the leaving checklist; the staff file's keep-until date with and without a date of
  birth.
- `packages/db/test/induction.test.ts`: another organisation reads nothing; HR reads and writes,
  the worker reads their own and writes nothing, HR never writes its own file; an assessor sees
  the Care Certificate and nothing else; entries in one's own name; never shadowing oneself;
  append-only rows never changed; observations only by observers and never changed; a passed
  probation stays; read-and-sign counted for HR and the worker, refused to others; access ended
  once, by HR, never by the leaver or an assessor; the exit interview only forward; a reference
  answered once in the sender's name.
- `apps/api/test/induction.test.ts`: the permissions and audited refusals; the checklist and its
  statuses; the plan, ticks, shadowing, reviews and the probation decision with stale versions
  refused; the Care Certificate by an assessor, never the worker; leaving with the keep-until date,
  the exit interview, a reference, access ended at once (and the leaver then holding nothing) and
  by the sweep the day after, once; audit events with ids and codes only.

## 10. Open questions

The decisions and defaults are in [phase-2.md](../plans/phase-2.md) (ADR-0022, ADR-0085, ADR-0089,
ADR-0093, ADR-0094) and the human actions in [human-actions.md](../plans/human-actions.md) (H-52,
H-521 to H-527, H-531, H-532; slice 4: H-570 to H-574; slice 11: H-575 to H-579; slice 17: H-690
to H-693; slice 23: H-730 to H-735; slice 39: H-800 to H-809; slice 29: H-870 to H-879; slice 77:
H-1120 to H-1129).

## 11. Known gaps

Left open by slice 11 (its security review), each with the slice expected to close it:

| Gap | Effect now | To close |
| --- | --- | --- |
| Expiry reminder tasks have no person and no location, and `app.task_visible` did not read `required_permission` | Closed by slice 17 (migration 0079): holders of the task's workforce permission see it | - |
| Supervision and appraisal due dates raise no tasks yet | Shown in the development record only | Slice 57 (the supervision screens and their reminders) |
| Revalidation evidence is recorded by HR, not by the nurse | A nurse cannot record their own evidence | Self-service with review (slice 57, H-693) |
| Reminders cover upcoming expiry only: required training never done, a member with no records, and an expired or withdrawn competence raise no task (the matrix and the port show them) | HR sees them in the development record, not in tasks | Slice 57 with the matrix screens (H-691) |
| `withSystemRights` answers the port's and the record's narrow questions inside the caller's transaction; callers must await it alone | A concurrent query on the same transaction would run with the system's rights | Security-definer functions owned by a NOLOGIN role (ADR-0002), before slice 22 calls the port |
| A location's team leader (`workforce.competence.observe`) reads development records and signs off competence across the organisation; the rule that an observer holds a valid sign-off for the same competence where the tenant requires it is not built | Wider than need-to-know; withdrawal reasons are free text | DPO decision (H-694); the observer rule in slice 57 |
| Equality monitoring forms are entered by staff (slice 23) | Someone with `workforce.recruitment.manage` could add made-up forms before the counts are released, to lift a small count above the minimum; each form added is audited | Applicants submit their own form through a one-time link with their application (slice 58), and staff entry is withdrawn |
| An applicant's earlier versions in `record_version` keep their names and contact details (slice 23) | Redaction after `retain_until`, and withdrawing talent pool consent, leave those copies; no job redacts applicants yet | The retention sweep redacts the applicant and their versions together (with the retention engine's destruction batches) |
| Talent pool consent is recorded by staff with no evidence of the applicant's agreement (slice 23) | The consent's source is not kept | The applicant gives it themselves through the same link (slice 58), or the form records how it was given |
| HR-only documents carry retention class `staff_file`, which has no rule of its own; the tenant's choice of `staff_file.*` and the leaving-date trigger are not in the retention engine; right to work copies' `record_closed` trigger is not handled | Nothing destroys HR-only documents or right to work copies yet | The retention engine's employment triggers (with H-575) |
| Employment gap explanations (free text) are in `compliance_item.detail` | Readable by holders of `workforce.staff_file.read`, not HR only | Move to an HR-only field or document (slice 56, with the screens) |
| Upload titles and file names travel in the query string, as on `/v1/documents` | They may reach proxy logs | A header or multipart field for every upload route |
| A refused HR upload (malware, wrong type) | Not audited as `workforce.hr_document.added` denied | Wrap the document store's refusals in audited refusals |
| The full tenant export runs as the system | Holders of `platform.export.create` export staff files and HR-only documents | Decide with the DPO whether the export needs the HR permissions too (H-577) |
| Casework does not stop someone holding the caseworker role from being named on a case about a colleague they are close to, or a member reading a case after their own conflict arises (slice 39) | Conflicts of interest are for the case manager to manage | A declared-conflict check when naming members (slice 58) |
| A case nobody can read once its last case manager leaves (slice 39) | Closed by H-804 (31/10/2026): a support ticket, raised by a user manager and approved by the data protection lead, lets Thapsus support appoint the case manager it names, without reading the case | Screens to raise and approve tickets (the routes exist) |
| Audit events show that a case exists and who acts on it (by ids) to readers of the audit log (slice 39) | The owner and quality lead see case ids and action codes, never the subject or the content | An audit view that hides casework events from those not named (with the speak-up silo, ADR-0089) |
| Casework is left out of the organisation-wide export (slice 39) | H-805 (31/10/2026): each case manager exports their case with step-up; a staff subject access request raises a task for the case manager of each case about or naming the requester (`raiseCaseworkDsarTasks`) | The DSAR workbench (on main) calls `raiseCaseworkDsarTasks` when a staff request opens, once the two are merged |
| Migration 0101 carries its own silo guards for `workforce.casework.manage`; migration 0086 (speak-up) carries the same for `safety.speak_up.manage` | Two sets of guard triggers, one per silo permission | Fold both into `app.silo_permissions()` once both are merged |
| Opening a case tells the opener whether the member of staff is on a professional register (`subject_registered`, copied from the staff file, which the caseworker role cannot read) (slice 39) | A caseworker learns one fact of a colleague's staff file by opening a case about them; every opening is audited | Accepted: rule 17 needs it; reviewed with the screens (slice 58) |
| Read-and-sign at induction counts the published policies the worker's roles need now (slice 29) | A policy published later joins the count; who has not signed which policy is the policy library's view (quality.md) | Nothing to close; documented |
| Shadow shifts are recorded by HR, not by the colleague shadowed, and are not linked to the rota (slice 29) | The shift is the manager's account | Link to rota shifts (slice 17's rota port) |
| A leaving date, once recorded, is not corrected (slice 29) | A wrong date needs support to correct it, with the audit trail | A correction that records the change and recomputes access and retention (slice 58) |
| Device sessions of a leaver are not ended by the sweep (slice 29) | Closed by H-879 (31/10/2026): the sweep signs the leaver out of every device unless they still work for another organisation; entries not yet sent stay on the device for hand-over (HZ-040, HZ-110) | Nothing to close |
| Access ends after a rostered shift that starts on the leaving day (H-873) | The rota is not merged here, so `NO_ROTA` answers no shift and access ends at the end of the leaving day | Wire the rota builder's adapter to `RotaPort` when scheduling merges |
| The keep-until date is worked out once, when the leaving is recorded (slice 29) | A later change of the organisation's retention row or date of birth does not move it | The retention engine's employment triggers (with H-575) |
| A member named on a case without `workforce.casework.manage` has no navigation entry (slice 58) | They reach the case by its link (the silo shows nothing in the navigation) | Show the entry when `GET /v1/workforce/cases` is not empty, without a count, if the CSO and DPO agree (H-933) |
| A case manager who does not hold `workforce.casework.manage` cannot load the colleagues list (slice 58) | They cannot name members from the screen; a caseworker names them | Let active case managers read colleagues for their case (H-934) |
| Linking a safeguarding concern to a case has no screen (slice 58) | The API route exists; the timeline shows a link made there | A picker for the safeguarding concerns the member may read (with the safety screens) |
| The demo seed has no casework holder (slice 58) | The web journeys cover the silo (no entry, nothing shown) and recruitment; running a case is covered by the API tests | A demo caseworker in the e2e seed (H-936) |
| Welsh copy for the workforce screens (slice 58) | Welsh shows the English words, marked untranslated | Translation (H-939) |
| The vetting adapters have no screens (slice 77) | HR uses the API; the routes and the evidence source on each item exist | The staff file screens (slice 56, H-1129) |
| No vendor adapter exists (slice 77) | Every vetting port stays off in production; manual entry is the only route | One adapter per contracted provider, passing the shared contract suite (H-1120 to H-1123) |
| The worker cannot record or withdraw their own DBS consent (slice 77) | HR records both, with the date the worker gave or withdrew it | Self-service, if decided (H-1128) |
| Pending checks are refreshed or cancelled by hand (slice 77) | A DBS application stays pending until HR asks again; one that never reached the provider is cancelled and started again | A worker job polling pending checks, or the provider's webhook through the inbound quarantine, once a provider is chosen |
| An IDSP's own report is not kept (slice 77) | The item records the check's method, date and the checker | Keep it as an HR-only document if the adviser says so (H-1127) |

## 12. Sponsor licence, staff data protection and LDSS (slice 35, migration 0097)

Register rows WORK-003, WORK-007 and WORK-011 (section 12 of the master prompt). Harbour keeps the
sponsor's records and clocks; it never decides a worker's immigration status. Every figure comes
from the rate table; the rules are Harbour's reading of the Home Office guidance for sponsors, for
an immigration adviser to confirm (H-524, H-900 to H-902).

### 12.1 Records

- `sponsored_worker`: the certificate of sponsorship (number, date), SOC 2020 code, route, visa
  expiry, contracted weekly hours, guaranteed yearly pay, how English language was shown, the date
  switching evidence was checked, which Appendix D records are held, and whether sponsorship has
  ended. One active record per member. Mutable, versioned.
- `sponsor_absence`: dates (inclusive) and whether authorised.
- `sponsor_report`: a reportable change (`SPONSOR_REPORT_KINDS`), the day it happened, and the day
  it was reported on the sponsor management system with its reference (set together).
- `tenant.staff_privacy_notice_version`: the organisation's staff privacy notice in force.
- `staff_privacy_acknowledgement` (append-only): a member's acknowledgement of a version, once.
- `staff_image_consent` (append-only): a member's decision on each optional use of their photo or
  image (`IMAGE_PURPOSES`); the latest stands, and no decision means no use.
- `ldss_claim`: a Learning and Development Support Scheme claim for a member's course, with its
  status, reference, dates and reason. Harbour holds no LDSS funding figure (H-903).

### 12.2 Rules (`packages/domain/src/workforce/sponsorship.ts`, table-driven tests)

1. Unauthorised absence for more than `sponsor.unauthorised_absence_working_days` consecutive
   working days is reportable. Weekends and the nation's bank holidays inside a spell neither count
   nor break it; an authorised day breaks it. The change happens on the working day the limit is
   passed, and the report is due `sponsor.change_report_working_days` working days later (rule 9).
2. A visa is `due_soon` from `sponsor.visa_expiry_warning_days` before it expires and `expired`
   after the expiry date.
3. Appendix D gaps are the items of `APPENDIX_D_ITEMS` not held.
4. The salary check is rule 9's `salaryCheck`, shown on every record.
5. LDSS claims move planned to submitted (reference and date) or withdrawn; submitted to paid
   (date), rejected or withdrawn (a reason); rejected back to submitted. Paid and withdrawn are
   final.
6. A member has acknowledged the notice only when they acknowledged the version in force; a
   changed notice asks again.

### 12.3 Permissions

| Action | Permission | Built-in roles | Database |
| --- | --- | --- | --- |
| Read sponsor records, absences, reports, their versions | `workforce.immigration.read` (sensitive) | Owner, HR; not the Registered Manager | Restrictive read policies; never one's own |
| Record or change them | `workforce.sponsor.manage` (sensitive) | Owner, HR | Insert and update policies; never one's own |
| Set the staff privacy notice version | `platform.tenant.manage` | Owner | Tenant isolation |
| Acknowledge the notice, decide on image use | `workforce.self.read` (one's own only) | Staff roles | Insert only for one's own member id; no update or delete |
| Read a member's acknowledgements and image consent | `workforce.staff_file.read` | Managers, HR | Read policy: own, staff file holders, the organisation's system context |
| LDSS claims | `workforce.ldss.manage` | Owner, Registered Manager, HR | Read: own or holders; write: holders |

No role may delete these rows. The organisation's system context (the full export and the DSAR
collector) reads them, so a staff DSAR finds the sponsor record, acknowledgements, image consent and
LDSS claims. Absences and reports link to the sponsor record, not to a member, so the DSAR workbench
lists them under "not searched"; the reviewer reads them from the sponsor record.

### 12.4 API

`GET`/`POST /v1/workforce/sponsored-workers`, `PUT /v1/workforce/sponsored-workers/{id}`,
`POST /v1/workforce/sponsored-workers/{id}/absences`, `POST .../{id}/reports`,
`POST /v1/workforce/sponsor-reports/{id}/reported`; `PUT /v1/workforce/staff-privacy-notice`,
`GET /v1/me/staff-privacy`, `POST /v1/me/staff-privacy/acknowledgements`,
`POST /v1/me/staff-image-consent`, `GET /v1/workforce/members/{id}/staff-privacy`;
`GET`/`POST /v1/workforce/ldss-claims`, `POST /v1/workforce/ldss-claims/{id}/status`. Every write
and every read of sponsor records or a member's choices is audited
(`workforce.sponsored_worker.*`, `workforce.sponsor_absence.recorded`,
`workforce.sponsor_report.*`, `workforce.staff_privacy_notice.*`,
`workforce.staff_image_consent.decided`, `workforce.staff_privacy.viewed`,
`workforce.ldss_claim.*`) with opaque ids and codes only: never a certificate number, reference,
pay or date of absence. Screens follow with slice 56.

### 12.5 Tests

- `packages/domain/src/workforce/sponsorship.test.ts`: absence runs across weekends, bank holidays
  and authorised days; visa windows; Appendix D gaps; every LDSS transition; acknowledgement of the
  version in force; the latest image decision.
- `packages/db/test/sponsorship.test.ts`: cross-tenant denial; HR only and never one's own; the
  worker sees none of their sponsor records; shape checks; versions hidden like the records; no
  delete; acknowledgements and consent made only by the member, append-only, read by HR; LDSS for
  holders, read by the member.
- `apps/api/test/sponsorship.test.ts`: each route's permission, own records refused, the clocks,
  stale versions, ids-only audit, and a staff DSAR collecting the new tables.

### 12.6 Known gaps

| Gap | To close |
| --- | --- |
| No reminder task for a visa due soon or a report due | The reminder sweep, as for staff checks (slice 17) |
| Unauthorised absence is not drawn from the rota or leave records | Rota and leave (slice 36 onward) |
| The family feed does not yet check staff image consent before a staff photo is published | Feed publishing checks (slice 56, H-905) |
| Sponsor records follow the staff file's retention row; any sponsor-specific minimum is unconfirmed | H-901 |
