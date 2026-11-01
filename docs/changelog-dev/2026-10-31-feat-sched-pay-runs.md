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

## Review fixes

I ran the security and clinical-safety reviewers and fixed what they found.

### Pay calculation

- An entry is counted in the period it starts, for pay and for minimum wage hours alike.
- A day a night shift touches is never an SSP sick day. That includes the first day of a period
  when the previous period's night ran into it.
- SSP is worked out at each day's rate, so days either side of 6 April use their own rate.
- New exception: `no_qualifying_days`.
- Bank holidays are loaded past the period's end, for nights that run into a bank holiday.

### Exceptions and overrides

- A line's hash now covers the rates as well as the inputs, so an override no longer carries
  forward after the rate table changes.
- An override carries forward only from the previous calculation, and only with the line's own
  hash.
- An override's time is set by the database. Its creator and soft delete are fixed.
- Only a missing rate-table figure becomes `rate_missing`.

### Access

- The pay permissions need MFA.
- The API checks pay is held organisation-wide with the database's own function, and a test
  covers a manager holding pay permissions at one location only.
- A run's creator is set by the database.
- A member reads their own lines with `workforce.self.read` or `scheduling.timesheet.self`.

### Migrations

- The 0109 opt-out record-version policy fix now lives in 0116, so a database that already applied
  0109 gets it. 0109 is unchanged from slice 30.

### Docs

- Records of processing: pay holds special category data.
- Medical-device boundary: the slice 36 re-check.
- Human actions: H-1101, H-1102, H-1104 and H-1106 extended.
- New domain tests for the clock-change nights.


## Merged forward: main, bank and agency, time and attendance

`feat/sched-time-attendance` is merged in, which brings in `origin/main` (migrations 0000 to 0103)
and the bank and agency recommended answers (H-921, H-924, H-927).

- **Snapshots:** rebuilt as a chain from the merged schema: 0104, then 0107 (absence), then 0109
  (time and attendance), then 0116 (pay).
- **Export catalogue:** duplicate entries for the rota tables (now on main) are removed.
- **Policies:** the pay and time record-version policies name the organisation's own read
  (`app.is_system()`) outright, for main's DSAR collector check.

## Existing tenants' roles

- Migration 0116 now backfills `scheduling.pay.manage` and `scheduling.pay.approve` into every
  existing tenant's built-in Owner and Finance copies, audited as
  `platform.role.permissions_migrated` (as 0038 does). Without it, an organisation created before
  pay runs would never hold them.
- `packages/db/test/builtin-role-backfills.test.ts` fails when the built-in definitions grant a
  permission beyond the baseline (main's definitions on 1 November 2026,
  `test/support/builtin-roles-baseline.json`) that no migration backfills, and re-runs the 0116
  backfill against copies that lack the permissions.
