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
- Human actions H-582 to H-585 (lane C); the register rows' paths.

## Clinical safety and data protection

- Not clinical; no hazard assigned to slice 6 by the plan.
- No personal data stored or processed (pure functions); pay records arrive with slices 12 and 30.

## What is next

- Slice 5's working-time rules supply the hours that count; the API slices store inputs with the
  rule set version and the hash of the canonical input (ADR-0086).

## Human actions logged

- H-582 to H-585.

## Tests

- `packages/domain/src/scheduling/pay/*.test.ts` (10 files, 87 tests, table-driven against
  `rates.md`; 100% lines and 97.9% branches of the folder), including the figures in force either
  side of 1 April 2026, a 29 February birthday and Northern Ireland, where holiday accrual and SSP do
  not apply yet.

## Review rounds

- Integration with slice 5 (#136), 31 October 2026:
  - Human actions renumbered H-582 to H-585, as slice 5 took H-580 and H-581.
  - `origin/feat/sched-domain-working-time` merged in, so this branch stacks on #136; the domain
    index, rates.md, the register, STATUS, scheduling.md (slice 5's full spec with these rules as
    section 4b) and human-actions keep both sides.
  - Wiring: `nmwMinutesIn` (slice 5's classification, clipped to a pay reference period, this
    employer only) gives `nmwCheck` its minutes; `nmwPayFromGross` gives it its pay, leaving out
    mileage and on-call allowances; `hours-to-pay.test.ts` feeds a week with a sleep-in, travel and
    another employer's hours through both. No rate key is duplicated: the NMW age rows and slice
    5's `wtr.young_worker.until_age_years` belong to different regimes and agree on a 29 February
    birthday (tested).
  - Figures checked on 31 October 2026 and fixed where the law differs:
    - SSP: the Employment Rights Act 2025 changes commenced on 6 April 2026 (S.I. 2026/373; no
      waiting days, no lower earnings limit, a one-day period of incapacity, the lower of £123.25
      and 80%). Payments are now rounded up to the next penny (SSP (General) Regulations 1982
      reg 11), not down, from the exact weekly rate.
    - Family pay: £194.32 and £187.18 verified on gov.uk; maternity pay's rate starts on
      5 April 2026 and the others' on 6 April 2026, so maternity has its own row
      (`smp.standard_weekly`); each payment is rounded up, as the regulations say. Rows verified;
      H-582 closed.
    - NMW: free accommodation now adds the offset to pay (gov.uk), which the check had left out.
    - AWR: a break is judged as a whole under reg 7(8) and (9); a sickness break over 28 weeks now
      resets the clock, a long break only partly for a covered reason resets it, industrial action
      is a covered break, and protected leave within the assignment counts as weeks worked
      (reg 7(6)). Rows verified on legislation.gov.uk.
    - Auto-enrolment: the per-period thresholds match The Pensions Regulator's 2026-2027 table
      and the age bands the Pensions Act 2008; rows verified; H-584 closed.
    - Statutory figures no longer take a tenant row (only the Bradford window, a tenant default,
      does); the no-literal test now scans the pay folder, with the money and calendar units named
      in `money.ts` and `intervals.ts`.
  - H-585 reworded to the three readings still open. ADR-0086's rounding bullet names the
    round-up exceptions.
  - Tests: the pay folder has 103 tests in 11 files (`hours-to-pay.test.ts` new); the scheduling
    folder 262 in all.
