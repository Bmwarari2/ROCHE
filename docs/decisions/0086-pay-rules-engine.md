---
status: "accepted"
date: 2026-10-31
decision-makers: Claude Code (Phase 2 lane C)
consulted: master prompt sections 12.3 and 18; docs/plans/phase-2.md (decisions); security review at the API slice
informed: Brian
---

# Pay rules engine: pure functions over stored inputs, in whole pence, with their working

## Context and problem statement

Harbour checks pay against the law (NMW per pay reference period, holiday pay for irregular-hours
workers, SSP, statutory family pay) and works out gross pay from a tenant's pay rules, but does not
run payroll (section 12; payroll is integrated). A worker, a manager, HMRC or a tribunal may later ask
why a figure came out as it did, so every result must reproduce exactly from what was stored at the
time, and statutory figures must never be literals (section 18).

## Decision drivers

- Reproducible to the penny years later, after rates and rule sets have changed.
- Every statutory figure from `rate_table`; tenant figures (enhancements, sleep-in allowance,
  mileage) from the tenant's own versioned pay rule set.
- Explainable: a person reads the working, not a number.
- Testable without a database (domain coverage at least 90%).

## Considered options

- Pure functions in `packages/domain/src/scheduling/pay` over stored inputs, money in whole pence.
- SQL functions in Postgres computing pay where the timesheets are.
- Hand the calculation to the payroll provider and show its answer.

## Decision outcome

Chosen option: pure domain functions, because only they meet all four drivers and they run the same
in the API, the worker and tests.

- Inputs: the timesheet entries (and the hours slice 5 says count), the pay rule set version, and
  the resolved rates in force on the dates concerned (`resolvePayRates`). The API stores the inputs
  and the pay rule set version with each result.
- Money is whole pence (integers) throughout; percentages are applied once per line and rounded
  down to the penny, so the worker is never shown more than the rule gives and the rounding is
  stated in the working. The exception is a statutory payment whose regulations say a fraction of
  a penny is rounded up (SSP, SSP (General) Regulations 1982 reg 11; maternity, paternity,
  adoption, shared parental and parental bereavement pay): those are worked out exactly and
  rounded up once per payment. What the hours must earn under the minimum wage is also rounded
  up, never in the employer's favour.
- Every result carries `working`: one line per step in plain English with the figure and its rate
  key or rule, and `canonicalInput`: a deterministic serialisation (sorted keys) of everything the
  result depends on. The domain does no hashing; the API stores a SHA-256 of `canonicalInput` so a
  recalculation can be proved identical.
- Pay rule sets are versioned per tenant; a version in use is never edited, a change is a new
  version from a date.

### Consequences

- Good, because a result can be recomputed and compared byte for byte; disputes have the working.
- Good, because the rules are tested as tables without Postgres.
- Bad, because the API must load the right rate rows and rule set version for each period, and store
  them with the result (slice 12 and slice 30).

### Confirmation

`packages/domain/src/scheduling/pay/*.test.ts` (table-driven against `rates.md`); the API slices add
a test that recomputes a stored result and compares hashes.
