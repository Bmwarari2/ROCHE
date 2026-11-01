# Deaths and missing persons (Phase 2 slice 37)

Branch `feat/safety-deaths-missing`. Register rows SAFE-014 and SAFE-015 (schema, API, jobs; no web
screens, which are slice 63). Migration 0099.

## What changed

- Spec: [safety.md](../specs/safety.md) section 2 (five tables), section 4 "Deaths and missing
  persons (plan slice 37)" (six rules, permissions) and section 5 (the routes).
- Domain: `death-record.ts` (the plan with the safer answer until the clinician's judgement is
  recorded, each step's state with the notification steps read from the notification centre, the
  refusals of a step, the mortality review, what closing needs) and `missing-episode.ts` (the
  timeline's entries and their refusals, the episode view on the slice 7 rule, the Herbert Protocol
  profile's required parts, its prefill from the record and its review date), with table-driven
  tests.
- Database (migration 0099, one file): `death_record`, `death_step` (append-only),
  `missing_episode` (one open per person), `missing_event` (append-only, each step of the search once)
  and `herbert_profile` (one per person); forced row-level security with the person scope, guards
  that keep a finished death record or a closed episode unchanged and a profile reviewed in the
  reviewer's own name, grants, record history, and the sample data removal list.
- API: `/v1/deaths` (list, open for an exit, get, the judgement, steps, the mortality review,
  close), `/v1/missing-episodes` (list, open, get, timeline entries, close) and
  `/v1/people/{id}/herbert-profile` (get with the prefill, save), each audited by record id. The
  `people.person.died` handler opens the death record with the death notifications, and the death's
  correction withdraws it. Opening an episode raises the urgent police call task for the Registered
  Manager, due at the target and escalated by the task engine; the police called (with their
  reference) answers the incident's police question, so the CQC notification is drafted; a daily job
  raises a review task for each out-of-date Herbert Protocol profile.
- Export catalogue: the five tables, described column by column.

## Clinical safety and data protection

- New hazard HZ-127 (a missing person's escalation delayed, or the Herbert Protocol profile out of
  date) with its controls and tests; HZ-013 gains the death record's control and tests.
- Medical-device boundary re-checked (section 6): no clinical reasoning; the clinician's judgement
  is recorded, never made.
- Records of processing (deaths and missing persons, B1 and B7, the police disclosure's proposed
  basis) and data standards (the slice 37 code lists and the Herbert Protocol fields) updated.
- Human actions H-770 to H-776.

## Tests

- Domain: `death-record.test.ts`, `missing-episode.test.ts`.
- Database: `deaths-missing.test.ts` (isolation, scope, append-only, guards, codes in step with the
  domain); the RLS coverage, sample data and export catalogue tests with the new tables.
- API: `deaths-missing.test.ts` (seven journeys through the routes, the jobs and the outbox
  handlers).
