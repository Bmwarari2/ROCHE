# Induction, the Care Certificate and leavers (WORK-004, WORK-013, plan slice 29)

Branch `feat/work-onboarding-leavers`, stacked on `feat/work-casework` (slice 39) with
`feat/quality-policy-library` (slice 25) merged in.

## What changed

- Spec: [workforce.md](../specs/workforce.md) section 2d (seven tables), section 3 (who does
  what), rules 19 to 23, the routes in section 5, data protection in section 8, the tests in
  section 9 and the known gaps in section 11.
- Domain (`packages/domain/src/workforce/induction.ts`):
  - the induction checklist, from the offer to probation, with each item ticked by hand or worked out (the staff file, read-and-sign, the Care Certificate, probation);
  - the Care Certificate's 16 standards, by id and short title only (H-531), each assessed and then observed by someone other than the worker;
  - shadow shifts and probation reviews, and decisions (passed, extended or not passed);
  - leaving, with access ended from the day after the leaving date, the exit interview, references, and how long the staff file is kept.
- Schema and migration 0091 (one file):
  - Tables: `induction_plan`, `staff_checklist_item`, `shadow_shift` and `probation_review` (the last three append-only), `care_certificate_progress`, `leaver_record` and `reference_request`.
  - Forced row-level security following the staff file. Assessors (`workforce.competence.observe`) read and sign the Care Certificate only, never their own.
  - Definers: `app.staff_profile_worker`; `app.induction_policy_signing`, which gives counts only, to the worker or a staff file reader; `app.end_leaver_access`, which marks the member as left, ends their roles and revokes their grants, once.
- API (`apps/api/src/routes/induction.ts`):
  - induction, the Care Certificate, leaving and references;
  - the hourly `leaver-access` sweep;
  - refusals audited; audit events carry ids and codes only.
- Rate table: `retention.staff_file.birthday_age` (75). Export catalogue entries, retention rows,
  records of processing (the categories row and purpose B3), data standards, and the feature
  register (WORK-004 and WORK-013 partial).
- Merge of the policy library:
  - The journal now orders 0087 after 0085: its `when` moved just past 0085's, and 0091 sits between 0087 and 0101.
  - The 0087, 0091 and 0101 snapshots are rebuilt so the chain is linear, with no schema drift.
  - A local database that already applied 0101 skips 0087 and 0091 (their `when` is earlier), so apply them by hand. Fresh databases and CI are unaffected.

## What is next

- Screens (slice 58); TUPE import (slice 51); shadow shifts linked to the rota; revoking leavers'
  devices; correcting a leaving date.

## Human actions logged

- H-870 to H-879:
  - the induction items;
  - the Care Certificate titles and assessment steps;
  - leaving reasons and when access ends;
  - staff file retention without a date of birth, and the 75th birthday figure;
  - the reference policy;
  - the privacy notice;
  - probation not passed through a case;
  - leavers' devices and access to their own file.

## Tests

- `packages/domain/src/workforce/induction.test.ts` (60, table-driven), `packages/db/test/induction.test.ts`
  (16), `apps/api/test/induction.test.ts` (10). Also re-run: RLS coverage, definer ACLs, the
  migration journal, isolation, seed, route gates.
