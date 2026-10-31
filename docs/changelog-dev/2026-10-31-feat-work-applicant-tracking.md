# Applicant tracking (WORK-001, plan slice 23)

Branch `feat/work-applicant-tracking`, stacked on `feat/work-staff-profile` (slice 11).

## What changed

- Spec: [workforce.md](../specs/workforce.md) section 2b (eight tables), rules 11 to 13, the routes
  in section 5, data protection for applicants (purpose B15) and the tests in section 9.
- Domain (`packages/domain/src/workforce/recruitment.ts`): how an application moves from applied
  through shortlisting (every essential criterion met, or rejected with a reason), a values-based
  interview (a panel of 1 to 5, every question scored 1 to 4; the total is shown, never used to
  decide), a conditional offer (the role's Schedule 3 items) and its response; closed applications
  never reopen. Equality monitoring counts with any count under 5 shown as "fewer than 5" and a
  question too few answered withheld. How long an applicant is kept: while any application is
  open, then 6 months after the last closes (`applicant.unsuccessful`), or the talent pool period
  they agreed to when later.
- Schema and migration 0085 (one file): `job_template`, `vacancy`, `applicant`, `application`,
  `application_event` and `interview` (append-only), `job_offer`, `equality_monitoring` (insert
  only, a random id and the date only, read by nobody, counted through the definer function
  `app.equality_monitoring_counts`). Forced row-level security; only holders of
  `workforce.recruitment.manage` read or write; a closed application never reopens; a redacted
  applicant stays redacted.
- API (`apps/api/src/routes/recruitment.ts`): templates, vacancies, applications, shortlisting,
  closing, interviews, offers, the offer response (accepting needs `workforce.staff_file.manage`
  too and creates the staff profile with the offer's conditions outstanding, never one's own),
  talent pool consent, and equality monitoring forms and counts. Refusals audited; audit events
  carry ids and codes only.
- `workforce.recruitment.manage` now needs MFA (`sensitive`), as the staff file permissions do.
- Retention rows `applicant.unsuccessful` and `applicant.talent_pool`; export catalogue entries;
  records of processing (B15 and its categories row), data standards, feature register.
- The merge of main into the staff file branch left two migration snapshots with one parent; the
  0073 snapshot is rebuilt on top of 0071 (its SQL is unchanged), so drizzle-kit generates again.
  The retention candidates list now reads HR-only staff documents as not readable (a merge typing
  issue). Biome's file size limit is raised to 2 MiB: the generated client has passed 1 MiB and
  was no longer formatted.

## What is next

- Screens (slice 58). Redacting applicants after `retain_until` in the retention engine's sweep.
- The DPIA's R29 measures (slice 84) can cite: monitoring kept apart and counted only, the
  retention rows, talent pool consent.

## Human actions logged

- H-730 to H-735 (Pathway categories and values, the smallest count shown, retention defaults,
  equality questions, monitoring in the tenant export, the privacy notice).

## Tests

- `packages/domain/src/workforce/recruitment.test.ts` (41), `packages/db/test/applicant-tracking.test.ts`
  (10), `apps/api/test/recruitment.test.ts` (11); RLS coverage, definer ACLs, migration journal,
  tenant export, seed, staff files and route gates re-run.

## Review rounds

- None yet.
