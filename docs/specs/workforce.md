# Workforce (`workforce`) - specification

Master prompt sections 12.1, 12.2 and 12.4, with section 4 (roles) and 18 (data model). Phase 2
builds the whole employee file from application to leaving ([phase-2.md](../plans/phase-2.md),
lane B). Payroll itself is integrated, not built (section 12). **Stub**: written with the Phase 2
plan to hold the headings and the rows; slice 4 writes it in full before any code. Status per
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

To be written in slice 4. Section 18 names `staff_profile` and `compliance_item` (role, pathway
category, start date; DBS level, date, number, barred-list result and Update Service; right to work
type, expiry and re-check; registration body, PIN and expiry; sponsor CoS and visa expiry; expiry
tasks), `training_record`, `competence` and `er_case`.

Retention classes ([retention.md](retention.md)): `staff_file.after_leaving` or
`staff_file.to_75th_birthday` (the tenant's choice) for the staff file and casework;
`right_to_work_copy`; `training_record` for training and competence. The gaps (unsuccessful
applicants, DBS certificate information) are listed there.

## 3. Permissions

In the catalogue since Phase 0 ([permissions.md](permissions.md)): `workforce.recruitment.manage`,
`workforce.training.manage`, `workforce.competence.observe`, `workforce.supervision.manage`,
`workforce.casework.manage`, `workforce.self.read`. Section 12.4 asks for casework in a restricted
permission silo, and immigration and sponsor documents visible to HR only and audited. Slice 4 sets
the matrix.

## 4. Rules that are easy to get wrong

To be written in slice 4 with a table-driven test for each. The section 12 rules:

- A worker without the required DBS result, right to work or competence cannot be rostered to a
  shift that needs it; a manager override with justification is logged and reported.
- Expiring documents create tasks at 90, 30 and 7 days (`document_expiry.reminder_days.*`).
- Staff files are kept to the 75th birthday (or 6 years after leaving, by tenant choice).

Rate keys in use: `training.default_refresh_years`, `training.oliver_mcgowan.refresh_years`,
`competence.medicines.refresh_months`, `supervision.per_year`, `appraisal.per_year`,
`nmc.revalidation.practice_hours`, `nmc.revalidation.cpd_hours`, `sponsor.salary_floor.care_worker`,
`sponsor.salary_floor.care_worker_hourly`, `sponsor.change_report_working_days`,
`sponsor.switching_evidence_months`.

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

To be written in slice 4. The Phase 2 gate needs expired competence to block administration in
tests (with [medicines.md](medicines.md)).

## 10. Open questions

The decisions and defaults are in [phase-2.md](../plans/phase-2.md) (ADR-0022, ADR-0085, ADR-0089,
ADR-0093, ADR-0094) and the human actions in [human-actions.md](../plans/human-actions.md) (H-52,
H-521 to H-527, H-531, H-532).
