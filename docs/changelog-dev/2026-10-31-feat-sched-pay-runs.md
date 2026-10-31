# Pay calculation runs (SCHED-005, SCHED-006, SCHED-007, Phase 2 slice 36)

Branch `feat/sched-pay-runs`, cut from `feat/sched-time-attendance` with `feat/sched-absence-leave`
(slice 40) merged in. Rules, schema, migration and API. The screens are slice 60, and the payroll
export file is slice 76 (only its port is here).

## What changed

- **Merge of slice 40:** absence and leave become scheduling.md section 17. The drizzle journal keeps
  every entry, sorted by idx, with `when` strictly increasing, and snapshots 0107 and 0109 are
  rechained so 0109 holds the whole schema.
- **Spec:** scheduling.md section 18, written first.
- **Domain** (`packages/domain/src/scheduling/pay/pay-run.ts`), with table-driven tests against
  the rate table:
  - a member's line for a period (`payRunLine`), from approved time;
  - paid time split at UK midnight and the night window, with weekend, bank holiday and overtime
    enhancements;
  - the minimum wage, with a top-up line and an exception;
  - holiday accrual and rolled-up holiday pay;
  - SSP, never on a day worked;
  - auto-enrolment flags;
  - agency lines with the AWR clock;
  - a correction's difference, and canonical inputs revived for reproduction.
  - Fix: `canonicalInput` now keeps an instant as its ISO text, where before a `Date` became `{}`.
- **Migration** `0116_pay_runs.sql`, with forced row-level security on all five tables:
  - tables `pay_rule_set` (approved by someone who neither wrote nor changed it, then fixed),
    `pay_profile`, `pay_run`, `pay_run_line` (append-only) and `pay_run_exception`;
  - a run is locked only by someone who neither created nor calculated it, with no open exception,
    and then never changes;
  - pay permissions count only organisation-wide (`app.holds_pay_permission`).
- **Permissions:** `scheduling.pay.manage` and `scheduling.pay.approve`, held by Owner and
  Finance.
- **API** (`apps/api/src/routes/pay.ts`, `apps/api/src/services/pay.ts`):
  - rule sets and pay profiles;
  - runs drafted, calculated, checked and locked;
  - exceptions overridden with a reason;
  - corrections in a later run;
  - a line reproduced from its stored inputs and rate rows;
  - a member's own locked lines;
  - the `scheduling.pay_run_locked` outbox event and the `PayrollExportPort`.
- **Data protection:** records of processing, data standards, retention and the export catalogue.
- **Hazard log:** HZ-011 tests; there is no new clinical hazard, because pay does not touch care.
- **Human actions:** H-1100 to H-1109.
