# Workforce (`workforce`) - specification

Master prompt sections 12.1, 12.2 and 12.4, with section 4 (roles) and 18 (data model). Phase 2
builds the whole employee file from application to leaving ([phase-2.md](../plans/phase-2.md),
lane B). Payroll itself is integrated, not built (section 12). Sections 2 to 4 and 9 were written by
slice 4 (the domain rules); sections 5 to 8 grow with the schema, API and screen slices. Status per
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

Retention classes ([retention.md](retention.md)): `staff_file.after_leaving` or
`staff_file.to_75th_birthday` (the tenant's choice) for the staff file and casework;
`right_to_work_copy`; `training_record` for training and competence. The gaps (unsuccessful
applicants, DBS certificate information) are listed there.

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

Rate keys in use: `training.default_refresh_years`, `training.oliver_mcgowan.refresh_years`,
`competence.medicines.refresh_months`, `supervision.per_year`, `appraisal.per_year`,
`document_expiry.reminder_days.first`, `.second`, `.third`, `nmc.revalidation.cycle_years`,
`nmc.revalidation.practice_hours`, `nmc.revalidation.cpd_hours`,
`nmc.revalidation.participatory_cpd_hours`, `nmc.revalidation.feedback_count`,
`nmc.revalidation.reflective_accounts`, `dbs.update_service.check_interval_months`,
`sponsor.salary_floor.care_worker`, `sponsor.salary_floor.care_worker_hourly`,
`sponsor.change_report_working_days`, `sponsor.counted_weekly_hours_max`.

## 5. API and events

To be written in slice 4 (operations) and slices 11, 17, 23, 29, 35, 39 and 43. Competence changes
are published for medicines and scheduling (ADR-0085).

## 6. Offline behaviour

Section 17.1: e-learning modules downloaded in advance are completed offline (plan slice 72).

## 7. Clinical safety

Expired competence that fails to block an action is a hazard (HZ-119); a worker rostered without a
required check is HZ-124. Both are added by the slices the plan names.

## 8. Data protection

Purpose B3 in the [records of processing](../compliance/records-of-processing.md). Section 12.4:
staff privacy notice, staff DSARs in the section 5 workbench, HR-only immigration and sponsor
documents, staff photo and image consent, and an employee-monitoring DPIA.

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

API, web and mobile tests come with slices 11, 17, 35, 56 and 57; the Phase 2 gate needs expired
competence to block administration (with [medicines.md](medicines.md)).

## 10. Open questions

The decisions and defaults are in [phase-2.md](../plans/phase-2.md) (ADR-0022, ADR-0085, ADR-0089,
ADR-0093, ADR-0094) and the human actions in [human-actions.md](../plans/human-actions.md) (H-52,
H-521 to H-527, H-531, H-532; slice 4: H-570 to H-574).
