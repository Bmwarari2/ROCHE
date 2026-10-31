# Phase 1 follow-ups: sample data, a flaky test, hazard statuses and a broken link (PLAT-018, HZ-072)

Branch `fix/phase-1-follow-ups`.

## What changed

- Sample data (HZ-072): the downtime pack prints "(Sample)" beside an invented sample person's
  name, on their page, its footer and warnings, with a line saying they are invented; a letter's
  check before sending shows the Sample badge and its PDF says it is about an invented person; an
  evidence pack names a sample person with "(Sample)". Family updates and the notification centre
  name no one beyond screens already marked.
- Sample data: the onboarding page no longer says sample people are left out of notifications. The
  classifier does not look at the sample flag, so a draft about a sample person can appear; the
  page says to decide it not required. Suppressing it is a clinical-safety decision for the CSO
  (H-452); the DPIA template and HZ-072 say the same, and the planned test stays planned.
- Sample data: removal deletes the stored files of the sample people's documents (every version)
  after it commits; a file that cannot be deleted is logged by count only.
- Sample data: confirming with a passkey to remove sample data comes back to the sample data
  section (`/settings/onboarding#sample-data`).
- `apps/api/test/evidence-link.test.ts` "a session for one link opens no other": the tamper wrote
  "A" over a character that is already "A" in about 1 cookie in 64 (the IV is random), leaving the
  cookie unchanged so it opened, the failure seen once on #87. Each tampered part now always
  differs, and the test asserts it.
- Hazard log: HZ-003 (`round.spec.ts`), HZ-008 (`handover.spec.ts`), HZ-021 (`downtime.spec.ts`)
  and HZ-027 (`incident-forms.spec.ts`) marked Passing from CI run 38938760784 on `d77b416`, each
  test checked in that run's log (89 passed).
- `phase-1.md` points to `care.md` for capacity and consent; there is no `mca.md`.

## What is next

- H-452: whether a statutory notification is drafted for an incident about sample people only.
- The other surfaces in `SAMPLE_DATA_TREATMENT` (reports, handover, escalation) when they read the
  flag; the mobile badge (paused).

## Human actions logged

- H-452 (CSO): statutory drafts for sample incidents.

## Tests

- `packages/domain/src/operations/downtime-pack.test.ts`, `apps/api/test/downtime.test.ts`,
  `letters.test.ts`, `evidence-pack-sample.test.ts`, `sample-data.test.ts` (`hazard HZ-072 ...`);
  `apps/api/test/evidence-link.test.ts`; `apps/web/e2e/sample-data.spec.ts` (the step-up returns to
  the section).
