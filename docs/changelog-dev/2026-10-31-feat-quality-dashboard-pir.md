# Quality dashboard and PIR prefill (API)

Branch `feat/quality-dashboard-pir` (Phase 2 slice 47: QUAL-005, QUAL-006), cut from
`feat/web-policies-data-security`. The screens are slice 65 part 2.

## What changed

- `GET /v1/quality/dashboard?locationId&from&to`: each of the ten indicators for one location and
  period. Every figure carries its working: numerator, denominator, period, source and method,
  with a status against the organisation's own target.
  - Built today: falls, pressure ulcers and medication errors per 1,000 occupied bed-days,
    overdue care plan and risk assessment reviews (as at today), and incidents reviewed in time.
  - Missed visits, training compliance, agency hours, complaints and staff turnover show
    "No data: Harbour does not record this yet".
- Never rated (HZ-129):
  - a source not built;
  - a period that is unfinished or starts before the location used Harbour;
  - no bed-days;
  - no target (the value is shown, unrated);
  - a small number: a count of 1 to 4 (`quality.indicator.min_group_size`) is withheld so no
    one can be identified.
- Targets: `GET` and `PUT /v1/quality/indicator-targets`, and `POST .../{id}/clear`. Each target
  is an organisation default or a location's own, with the location's own winning. Green and
  amber must be in the indicator's direction.
- `GET /v1/quality/pir?locationId`: the last 12 months to yesterday. Each data point in the
  question set is prefilled, or marked to complete with the reason. Nothing is submitted.
- Migration 0108 adds:
  - `quality_indicator_target`, with forced RLS, writes only where the member holds
    `quality.audit.manage`, a history trigger and no delete;
  - `app.quality_indicator_counts`, a security-definer function owned by the new no-login role
    `harbour_quality_reader`. It checks the permission at the location itself and returns
    numbers only ([ADR-0108](../decisions/0108-quality-indicator-counts.md)).
- Domain: `dashboardIndicator`, `INDICATOR_SOURCES`, `targetFor`, `pirPrefill`,
  `PIR_QUESTION_SET`, and the `source_not_built` and `small_number` reasons. New rate rows
  `quality.indicator.min_group_size` and `quality.incident_review.target_days`.
- HZ-129 added to the hazard log. quality.md section 22 covers rules 38 to 44, the permission
  matrix and tests. The medical-device boundary and records of processing are updated.

## Found, not fixed here

- Plan slice 47 says "from events the source slices publish". No such events exist yet, so the
  counts are read where the records are, through one definer function (ADR-0108). It is the
  first function of its kind that reads several modules' tables.
- Bed-days include days away in hospital, and pressure ulcers present on admission cannot yet be
  told apart (H-983).

## Human actions logged

- H-980 to H-989.

## Tests

- Domain: quality indicators and PIR, table-driven (`hazard HZ-129 ...`).
- `packages/db/test/quality-indicators.test.ts` (17): targets by permission and location,
  direction, one live target, no delete; counts by UK day, every incident at the location
  whatever the reader may see, corrected and healed marks, bed-days, reviews, incident response,
  numbers only, refusals, execute rights.
- `apps/api/test/quality-dashboard.test.ts` (16): permissions, period checks, not built and
  incomplete never rated, small numbers withheld, targets with the location's own winning, audit,
  and the PIR prefill.
