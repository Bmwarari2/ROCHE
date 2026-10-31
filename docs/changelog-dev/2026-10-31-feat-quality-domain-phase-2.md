# Phase 2 slice 8: Quality Phase 2 domain rules (QUAL-001, 002, 004, 005, 006, 008, 012)

Branch `feat/quality-domain-phase-2`. Lane E. Domain only: no migration, API or screens.

## What changed

- Spec: [quality.md](../specs/quality.md) section 17, written before the code: domain types, the
  permission matrix (existing permissions only), 31 rules and the test list.
- Domain, new files in `packages/domain/src/quality/`:
  - `quality-framework.ts` (QUAL-001, QUAL-002): framework versions as data (no count of
    statements in code), their workflow, the version in force, historical audits read against the
    version they were scored against, versioned tenant mappings and the mapping in force at a
    moment, evidence tags (restricted silos never tagged) and coverage with the gaps listed.
  - `quality-audits.ts` (QUAL-004): template checks, the weighted score with its method in words
    (null when nothing is answerable, never 0 or 100), completion with actions for what fell short,
    the self-rating on the rate table's CQC scale given by a person (never worked out from the
    score), default action due dates, the next due date, and findings by statement.
  - `quality-indicators.ts` (QUAL-005): the Phase 2 indicators with their methods, the value, tenant
    targets in the indicator's direction, RAG with boundaries in the better band, and the rule for
    HZ-129 (slice 47): missing data is never shown as good.
  - `quality-pir.ts` (QUAL-006): the PIR data points by key question and the draft, which says "Not
    available" rather than 0.
  - `policies.ts` (QUAL-008): the policy workflow, publication checks (review date limit, roles, a
    second reviewer where the tenant asks), read-and-sign by role (minor and major changes),
    reminders and review status.
  - `quality-data-security.ts` (QUAL-012): the DSPT deadline from the rate table and the year's
    status, Cyber Essentials and ICO registration renewals ("missing" is never assumed current).
  - `quality-rates.ts` and `quality-dates.ts`: the figures and UK calendar dates.
- Rate rows (docs/specs/rates.md): `cqc.rating_scale.min` and `.max`,
  `quality.indicator.bed_days_base` (master prompt), `quality.audit.action_due_days`,
  `policy.read_and_sign.reminder_days`, `policy.review_due_soon_days`,
  `policy.review_interval_months.max`, `quality.renewal_reminder_days` (tenant defaults, to verify),
  `cyber_essentials.certificate_valid_months`, `ico.registration.renewal_months` (to verify).
- No new hazard. The register rows are partial (domain rules built).

## What is next

- Slices 14, 19, 25, 32 and 47 (schema and API) and 64 and 65 (web) use these rules.

## Human actions logged

- H-600 to H-605 (indicator methods, audit scoring, PIR data points, tenant defaults, Cyber
  Essentials and ICO periods, minor-change signatures).

## Tests

- `packages/domain/src/quality/` `quality-framework.test.ts`, `quality-audits.test.ts`,
  `quality-indicators.test.ts`, `quality-pir.test.ts`, `policies.test.ts`,
  `quality-data-security.test.ts`, `quality-rates.test.ts`, `quality-dates.test.ts`: table-driven,
  the new files at 100% line coverage; the domain package at 99.7% lines. All 4,391 domain tests pass.
