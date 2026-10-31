# Workforce (`workforce`) - specification

Master prompt sections 12.1, 12.2 and 12.4, with section 4 (roles) and 18 (data model). Phase 2
builds the whole employee file from application to leaving ([phase-2.md](../plans/phase-2.md),
lane B). Payroll itself is integrated, not built (section 12). Sections 2 to 4 and 9 were written by
slice 4 (the domain rules) and extended by slice 11 (the staff file: sections 2a, 3, 5, 8 and 9)
and slice 23 (applicant tracking: sections 2b, 4 rules 11 to 13, 5, 8 and 9);
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

Slice 23 adds no permission: applicant tracking uses `workforce.recruitment.manage` (Owner,
Registered Manager, deputy manager and HR in the built-in roles), as section 12.1 intends, and the
database holds it organisation-wide as it does the staff file permissions
(`app.holds_staff_permission`). Accepting an offer also needs `workforce.staff_file.manage`, which
creates the staff profile; nobody records their own application or offer.

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

Rate keys in use: `training.default_refresh_years`, `training.oliver_mcgowan.refresh_years`,
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
| `GET /v1/me/staff-file` | `workforce.self.read` | The member's own profile and where each of their checks stands |

Audit actions: `workforce.staff_file.created`, `.updated`, `workforce.compliance_item.recorded`,
`workforce.dbs_risk_assessment.signed`, `workforce.hr_document.added`, `workforce.hr_document.viewed`.

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

## 6. Offline behaviour

Section 17.1: e-learning modules downloaded in advance are completed offline (plan slice 72).

## 7. Clinical safety

Expired competence that fails to block an action is a hazard (HZ-119, added by slice 3); a worker
rostered without a required check is HZ-124, in the hazard log from slice 4 with the rostering rule
as its first control.

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

API, web and mobile tests come with slices 17, 35, 56 and 57; the Phase 2 gate needs expired
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

## 10. Open questions

The decisions and defaults are in [phase-2.md](../plans/phase-2.md) (ADR-0022, ADR-0085, ADR-0089,
ADR-0093, ADR-0094) and the human actions in [human-actions.md](../plans/human-actions.md) (H-52,
H-521 to H-527, H-531, H-532; slice 4: H-570 to H-574; slice 11: H-575 to H-579; slice 23:
H-730 to H-735).

## 11. Known gaps

Left open by slice 11 (its security review), each with the slice expected to close it:

| Gap | Effect now | To close |
| --- | --- | --- |
| Equality monitoring forms are entered by staff (slice 23) | Someone with `workforce.recruitment.manage` could add made-up forms before the counts are released, to lift a small count above the minimum; each form added is audited | Applicants submit their own form through a one-time link with their application (slice 58), and staff entry is withdrawn |
| An applicant's earlier versions in `record_version` keep their names and contact details (slice 23) | Redaction after `retain_until`, and withdrawing talent pool consent, leave those copies; no job redacts applicants yet | The retention sweep redacts the applicant and their versions together (with the retention engine's destruction batches) |
| Talent pool consent is recorded by staff with no evidence of the applicant's agreement (slice 23) | The consent's source is not kept | The applicant gives it themselves through the same link (slice 58), or the form records how it was given |
| Expiry reminder tasks have no person and no location, and `app.task_visible` does not read `required_permission` | Organisation-wide roles see them; HR's role (scope none) does not see them in `GET /v1/tasks` | Task visibility for holders of the task's required permission (slice 17, if small) |
| HR-only documents carry retention class `staff_file`, which has no rule of its own; the tenant's choice of `staff_file.*` and the leaving-date trigger are not in the retention engine; right to work copies' `record_closed` trigger is not handled | Nothing destroys HR-only documents or right to work copies yet | The retention engine's employment triggers (with H-575) |
| Employment gap explanations (free text) are in `compliance_item.detail` | Readable by holders of `workforce.staff_file.read`, not HR only | Move to an HR-only field or document (slice 56, with the screens) |
| Upload titles and file names travel in the query string, as on `/v1/documents` | They may reach proxy logs | A header or multipart field for every upload route |
| A refused HR upload (malware, wrong type) | Not audited as `workforce.hr_document.added` denied | Wrap the document store's refusals in audited refusals |
| The full tenant export runs as the system | Holders of `platform.export.create` export staff files and HR-only documents | Decide with the DPO whether the export needs the HR permissions too (H-577) |
