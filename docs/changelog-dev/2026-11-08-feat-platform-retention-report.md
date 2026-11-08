# Retention report (retention sweeps plan, slice 4)

Branch `feat/platform-retention-report`, from `main` at 8d9b4cc8 (the registry, #207).

## What changed

- **The report-only sweep** (plan 5.4 report mode and 5.9; ADR-0135 point 6). A new worker queue,
  `retention-sweep`, runs nightly at `29 2 * * *` through `eachTenant`, as the system in each
  organisation's context, so one organisation's failure never stops another's and is audited as
  `platform.job.tenant_failed` (job `retention-sweep`) and logged as `worker.job.failed`.
- **Mode by flag.** `platform.retention.sweep_report` in the flag catalogue, off by default,
  organisation-wide and never set by Flagsmith: `off` writes nothing; `report` reads and counts.
  `propose` and `destroy` come with their own slices (6 and 10).
- **What it counts** (`packages/domain/src/platform/retention-report.ts`, pure, 100% covered):
  `reportPlan` says how each registry entry is read; `groupStatus` decides a group of rows that
  share every fact with `sweepDecision` (a legal hold first); `tally`, `reportTotals` and
  `countsByClass` add up. The API (`apps/api/src/services/retention-report.ts`) reads each table
  once with a grouped count: the class, the trigger dates to the day in UTC (a column, the first of
  several, the person's death or discharge, the member's leaving date, a looked-up column or the
  latest child), an unreleased legal hold on the record or the person, whether the person is
  receiving care, and the member's date of birth for the staff file kept to the birthday. Rules come
  from `retention_class`, the organisation's staff file option and the rate table
  (`retention.staff_file.birthday_age`): no figure in code.
- **What it does not yet decide**, counted as `not_evaluated` with a reason code: rows whose class
  or dates follow a parent, a linked record, a column's value or a derived rule (the pay period
  end among them), the six sign-in tables, and the four tables the application role cannot read
  (`equality_monitoring`, `pulse_survey_response`, `invitation`, `operator_user`). On the registry
  today 143 of 238 entries are decided. Holds are today's (a person or a record); the wider scopes
  and the implicit holds of open cases wait for slice 12, so the report can show more as due than
  a batch would propose.
- **`retention_report`** (migration 0160): one append-only row per run per organisation with the
  mode, the clock it decided against, the duration, the tables read and skipped, the lines (table,
  classes, reason, counts by status) and the totals. Forced RLS, the tenant policy, a
  tenant-wide-only restrictive policy for `harbour_app`, SELECT and INSERT only, append-only
  triggers. Listed in `no-personal-data.ts` (counts only) and in the export catalogue
  (`permanent`).
- **`GET /v1/retention/due`** (`platform.retention.manage`, step-up, tenant-wide only): the mode and
  the latest report, null until one has run. Audited as `platform.retention.report_viewed` with the
  report id; each run is audited as `platform.retention.sweep_reported` with the report id and the
  counts per class and status. OpenAPI and the typed client regenerated.
- **Nothing is destroyed or changed.** The API test fingerprints every registry table in both test
  organisations (row count and an MD5 of every row) before and after two runs and finds them equal;
  the audit trail gains only the two `sweep_reported` events.

## Tests

- `packages/domain/src/platform/retention-report.test.ts`: a plan per kind of entry, a status per
  trigger and class kind (held, due, kept, in care, no class, unknown class, staff file with and
  without a date of birth, pay period end, register page), and the tallies.
- `packages/db/test/retention-report.test.ts`: each organisation sees only its own reports, in
  tenant-wide scope only; a report for another organisation, an unsupported mode, an update and a
  delete are refused.
- `apps/api/test/retention-report.test.ts`: off by default writes nothing; refused without the
  permission; with the flag on and an injected clock, nothing is due before any record existed and
  some are due in 2200; a held person's records count as held; no id in the report or its audit
  event; another organisation sees none of it.

## Not changed

- No personal data is added, so `data-standards.md` and `records-of-processing.md` are unchanged.
- Not clinical: no hazard log change (the sweep reads and counts; nothing reaches care or
  medicines).

## What is next

- Slice 5: the report screen at `/settings/retention`.
- Provisional DPO decisions, logged in `docs/plans/human-actions.md`: how long reports are kept
  (H-1610, permanent), one organisation-wide report setting (H-1611), today's holds only until
  slice 12 (H-1612) and the 95 entries counted as not evaluated (H-1613).
- Also: #207's second H-1605 is renumbered H-1609 and marked superseded by #210's H-1605, and
  `scripts/check-markdown-links.mjs` now fails on a duplicate H-number or ADR number.
