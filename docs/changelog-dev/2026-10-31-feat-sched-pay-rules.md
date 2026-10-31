# Pay rules: NMW, holiday, SSP, family pay, AWR, auto-enrolment and Bradford (Phase 2 slice 6)

Branch `feat/sched-pay-rules`. Register rows SCHED-005, SCHED-006, SCHED-007, SCHED-009 and
SCHED-010 (domain rules only; no database, API or screens; no migration).

## What changed

- Spec: [scheduling.md](../specs/scheduling.md) section 4b, nine pay rules, written in its own
  subsection so slice 5 (working time, in progress elsewhere) can write sections 4 and 9 freely.
- ADR-0086 (pay rules engine: pure functions over stored inputs, whole pence, working and a
  canonical input string the API hashes) and ADR-0087 (employment law not yet in force: record,
  do not calculate).
- Domain: `packages/domain/src/scheduling/pay/` (exported from the package): gross pay from a
  versioned tenant pay rule set (highest enhancement unless they stack); NMW per pay reference period
  by age on the period's first day and the apprentice rule, with premiums, employer-use deductions
  and accommodation above the offset taken out, and what the hours must earn rounded up; holiday
  accrual and itemised rolled-up holiday pay for irregular-hours workers (leave years from April
  2024, not Northern Ireland); SSP from day one at the lower of the earnings percentage and the
  weekly rate, with the maximum weeks; statutory family pay; the AWR clock with pauses and resets;
  auto-enrolment categories and qualifying earnings for weekly and monthly periods; the Bradford
  factor over the tenant's window. Each result carries its working in words; the hours that count
  (sleep-in time awake, travel) are inputs from slice 5.
- Rate table: NMW age bands and the apprentice rule (verified at gov.uk); statutory family pay
  rates and weeks; AWR break limits; auto-enrolment thresholds per weekly and monthly period and age
  bands; the Bradford window (tenant default). `GBP_per_month` added to the units.
- Human actions H-580 to H-583 (lane C); the register rows' paths.

## Clinical safety and data protection

- Not clinical; no hazard assigned to slice 6 by the plan.
- No personal data stored or processed (pure functions); pay records arrive with slices 12 and 30.

## What is next

- Slice 5's working-time rules supply the hours that count; the API slices store inputs with the
  rule set version and the hash of the canonical input (ADR-0086).

## Human actions logged

- H-580 to H-583.

## Tests

- `packages/domain/src/scheduling/pay/*.test.ts` (10 files, 87 tests, table-driven against
  `rates.md`; 100% lines and 97.9% branches of the folder), including the figures in force either
  side of 1 April 2026, a 29 February birthday and Northern Ireland, where holiday accrual and SSP do
  not apply yet.
