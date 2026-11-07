# User guides: workforce and scheduling (Phase 2 slice 82)

Branch `docs/guides-workforce-scheduling`, from `main` at b65e7b61 (after the rename, #181).

## What changed

- 63 new guides, each one task, with the steps as they are on screen (names copied from the
  catalogues), who can do it in roles, and what Thapsus Care never does.
- **HR lead (27, new folder `hr-lead/`)**: staff files and Schedule 3 checks, sponsored workers,
  training requirements, the matrix and recording training, e-learning courses, supervision,
  revalidation evidence, job templates, vacancies, applications, shortlisting, interviews and
  offers, induction, probation and the Care Certificate, leavers and references, and employee
  relations casework.
- **Registered Manager (12)**: shift templates, building, checking and publishing a rota, the
  rostering rule override, dependency scales, timesheets, working time, leave, the lone-working
  on-call route, staff surveys and team sharing.
- **Senior carer (4)**: competence sign-off and withdrawal, a person's dependency category, and
  responding to a lone-working alarm.
- **Care worker (17)**: shifts, the clock, pay, leave, surveys, wellbeing check-ins and thanks,
  e-learning, privacy choices and lone working on the web; and on the phone, shifts, clocking in,
  lone working (start, check in, ask for help) and training courses offline.
- **Owner (3)**: pay rule sets, pay runs and the staff privacy notice.
- The role indexes, the user guides README (with the HR lead role) and the feature register's user
  docs column link every guide.

## No screen yet, so no guide (or only part)

- WORK-007 LDSS claims; the talent pool and entering equality answers (WORK-001); the employment
  history form, DBS risk assessment and HR-only documents (WORK-002); a worker's own induction and
  training record (WORK-004, WORK-005); LMS import (WORK-006); a nurse entering their own
  revalidation evidence (WORK-012); TUPE import (WORK-013).
- SCHED-008 payroll export (API only); SCHED-009 agencies, bookings and the AWR clock; swaps and
  offering open shifts (SCHED-002, H-838); sickness, fit notes, return to work, Bradford factor,
  family leave, postponing and cancelling leave (SCHED-010); mileage, hand-entered entries,
  corrections, exceptions and opt-outs (SCHED-003, SCHED-004).
- On the phone: swap requests, NFC or location evidence at clock-in (H-527), the offline check-in
  reminder (H-1313) and help from the lock screen (H-1314).

## Found, not fixed here (for the builders)

- A manager can decline carer's or parental leave on the absences page, but the database refuses
  it and there is no postpone.
- The Care Certificate's "observed competent" needs a staff file permission as well, so team
  leaders and clinical leads who observe cannot record it.
- E-learning says finishing adds to "your training record", which a care worker cannot open.
- The revalidation planner lets HR tick the confirmer's confirmation (workforce.md rule 8 says only
  the confirmer records it).
- Retiring an e-learning course has no confirmation; the regulator referral heading has a capital
  mid-sentence ("Record the Professional regulator referral decision").
- My time shows all four clock buttons whatever has been recorded; the Working time page is reached
  only from Timesheets; there is no pay profile screen, so "No pay profile" can only be overridden.
- On the phone, a course can show "Finished" when the server refused it (it is in "Not saved:
  needs attention"), and that list's words say "Tell the nurse in charge" for clock and training
  items.
- `scheduling.md` has duplicated headings from a merge (lone working as both 19 and 17, with
  19.x and 17.x subsections; wellbeing screens under section 19).
- The register's status lags the screens: WORK-005, 008, 009, 012 and SCHED-011 are `todo` with
  web screens on main.
