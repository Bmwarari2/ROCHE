# Rostering, time and pay (`scheduling`) - specification

Master prompt section 12.3, with section 10.1 (the dependency tool) and 18 (data model). Phase 2
builds rotas, time and attendance and the pay rules engine for care homes
([phase-2.md](../plans/phase-2.md), lane C); domiciliary visits and ECM arrive in Phase 4. Payroll
is integrated, not built (section 12). **Stub**: written with the Phase 2 plan to hold the headings
and the rows; slice 5 writes it in full before any code. Status per feature:
[feature register](feature-register.md).

## 1. Purpose and register rows

Section 12.3: staff the service safely against a stated method, keep Working Time and NMW rules,
and pay people correctly with working that can be shown and reproduced.

| Row | Feature (register) | Phase | Plan slices |
| --- | --- | --- | --- |
| CARE-004 | Dependency tool (tenant-editable categories with care hours per category) | 2 | 12, 59 |
| SCHED-001 | Dependency-based safe staffing planner | 2 | 12, 21, 59 |
| SCHED-002 | Rota builder with skills, continuity, swaps, bank and agency | 2 | 21, 59, 71 |
| SCHED-003 | Working Time compliance (48-hour average, rest, breaks, night work, under-18 rules, sleep-ins, travel time) | 2 | 5, 30, 60 |
| SCHED-004 | Time and attendance (clock in and out, exceptions, timesheet approval, mileage) | 2 | 30, 60, 71 |
| SCHED-005 | Pay rules engine with enhancements and NMW checks per pay reference period | 2 | 6, 36, 60 |
| SCHED-006 | Holiday accrual at 12.07% and rolled-up holiday pay | 2 | 6, 36, 60 |
| SCHED-007 | SSP 2026 and guaranteed-hours readiness | 2 | 6, 36, 60 |
| SCHED-008 | Payroll and pension exports (Xero Payroll first, Staffology, Sage, BrightPay; auto-enrolment flags) | 2 | 76 |
| SCHED-009 | Agency workers and AWR 12-week tracking | 2 | 6, 27, 59 |
| SCHED-010 | Absence and leave (Bradford factor, return to work, fit notes, statutory family leave) | 2 | 6, 40, 60 |
| SCHED-011 | Staff wellbeing and voice surveys | 2 | 44, 61 |
| SCHED-012 | Lone-worker check-ins, overdue alarm and panic button | 2 | 46, 61, 71 |

CARE-004 is a `care` feature (section 10.1) specified here because the staffing planner is its
only consumer; [care.md](care.md) keeps the rest of section 10.1. The payroll adapters are in
[integrations.md](integrations.md).

## 2. Schema

To be written in slice 5. Section 18 names `shift`, `timesheet_entry` and `pay_rule`: start and
end, type (day, night, sleep-in, on-call), role required, skills required, actual times, breaks,
travel, enhancements, NMW check result; reproducible pay.

Retention classes ([retention.md](retention.md)): `rota_and_timesheet` for shifts, timesheets,
clock-in events, sleep-in and travel-time records and pay calculations; `working_time_record` and
`working_time_opt_out`.

## 3. Permissions

In the catalogue since Phase 0 ([permissions.md](permissions.md)): `scheduling.rota.read`,
`scheduling.rota.manage`, `scheduling.rota.approve`, `scheduling.visit.manage` (Phase 4),
`scheduling.timesheet.self`. Slice 5 sets the matrix for the Phase 2 features and any permission
they add.

## 4. Rules that are easy to get wrong

To be written in slices 5 and 6 with a table-driven test for each. From section 12.3:

- Working time: 48-hour average with opt-outs on file, 11-hour daily rest, 20-minute breaks over
  6 hours, weekly rest, night-work limits, under-18 rules (`wtr.*`).
- Sleep-ins: only time awake for the purposes of working counts towards NMW (Mencap 2021); a flat
  sleep-in allowance per tenant; awake periods logged per event.
- Travel time between domiciliary visits counts as working time.
- NMW checks per pay reference period, including travel time and uniform deductions (`nmw.*`).
- Holiday accrual for irregular-hours workers with optional rolled-up holiday pay itemised
  (`holiday.accrual_percentage.irregular_hours`).
- SSP from day one at the lower of the earnings percentage or the statutory rate (`ssp.*`).
- Guaranteed-hours and short-notice cancellation payment tracking, ready for 2027.
- AWR 12-week clock (`awr.qualifying_weeks`); auto-enrolment flags (`auto_enrolment.*`).
- Every pay calculation shows its working and is reproducible from stored inputs; rotas and
  timesheets are kept 6 years and working-time records 2 years (section 12 rules).
- A worker without the required DBS result, right to work or competence cannot be rostered to a
  shift that needs it (section 12 rules; [workforce.md](workforce.md)).

### 4b. Pay rules (slice 6: SCHED-005, 006, 007, 009, 010)

Pure functions in `packages/domain/src/scheduling/pay/` (ADR-0086), kept apart from slice 5's
working-time files. Money is whole pence; every result carries its working (one line per step, in
words) and a canonical input string the API hashes, so a calculation reproduces exactly. Every
figure comes from the rate table through `resolvePayRates`; nothing here is a literal. Which hours
count (sleep-in time awake for the purposes of working only, travel time between visits) is slice
5's rule: the pay functions take those hours as inputs.

1. **Pay rule set** (`pay-rules.ts`). A tenant's versioned set: hourly rates by role, enhancements
   (a percentage or a flat amount an hour, by kind: night, weekend, bank holiday, overtime), the
   sleep-in flat allowance, mileage in pence a mile, on-call flat amount per period. Gross pay for
   timesheet entries applies each in a fixed order and shows each line. Several enhancements on the
   same hours do not stack unless the set says so; the highest applies.
2. **NMW per pay reference period** (`nmw.ts`). The band is decided by age on the first day of the
   period (`nmw.age.*`); the apprentice rate applies to an apprentice under
   `nmw.apprentice.age_limit`, or older and within `nmw.apprentice.first_year_months` of starting.
   Pay that counts: basic pay and allowances that count, less overtime and shift premiums above the
   basic rate, less deductions for the employer's own use (a uniform the worker pays for), less
   accommodation charges above the offset (`nmw.accommodation_offset.daily`, for each day provided).
   Hours that count: the working time given (including travel and time awake on a sleep-in). Pay
   counted divided by hours counted must reach the band's rate (`nmw.hourly.*`); the shortfall is
   shown in pence.
3. **Holiday for irregular-hours and part-year workers** (`holiday.ts`). From leave years starting
   on or after 1 April 2024: accrual of `holiday.accrual_percentage.irregular_hours` of hours worked
   in each pay period; or, if the tenant chooses rolled-up holiday pay, that percentage of the pay
   for the period, shown as its own line on the payslip and never folded into the hourly rate.
   Applies only where the rate table has a row for the nation (no Northern Ireland row yet).
4. **SSP** (`ssp.ts`). From the first qualifying day of sickness (`ssp.waiting_days`), at the lower
   of `ssp.earnings_percentage` of average weekly earnings and `ssp.weekly`, divided over the
   qualifying days in the week; at most `ssp.max_weeks` weeks of entitlement in a period of
   incapacity. No lower earnings limit applies from 6 April 2026. Only where the rate table has the
   nation's rows (H-529).
5. **Statutory family pay** (`family-pay.ts`). Maternity: the first `smp.higher_rate_weeks` weeks at
   `family_pay.earnings_percentage` of average weekly earnings, then the lower of that and
   `family_pay.standard_weekly`; paternity, adoption (after its first weeks, as maternity), shared
   parental and parental bereavement pay at the lower of the two. Eligibility (service, earnings) is
   recorded by HR, not decided here.
6. **AWR** (`awr.ts`). An agency worker qualifies for equal basic terms after
   `awr.qualifying_weeks` calendar weeks in the same role with the same hirer. A week counts if any
   work was done in it. A break of up to `awr.break_reset_weeks` weeks pauses the clock; a longer
   break, or a substantively different role, resets it. Sickness or injury pauses it for up to
   `awr.sickness_pause_max_weeks` weeks; pregnancy, maternity and paternity leave, annual leave and
   the hirer's shutdown pause it without a limit.
7. **Auto-enrolment flags** (`auto-enrolment.ts`). For a pay reference period of a week or a month:
   eligible jobholder (aged `auto_enrolment.eligible_min_age` to state pension age, earnings over the
   period's earnings trigger), non-eligible jobholder (aged `auto_enrolment.min_age` to
   `auto_enrolment.max_age` and earnings over the lower level of qualifying earnings, or eligible by
   earnings but outside the age band), entitled worker (below the lower level). State pension age is
   an input (it depends on date of birth); the flag never enrols anyone by itself.
8. **Bradford factor** (`bradford.ts`). Spells of absence (consecutive days merged) times days, squared
   spells: S x S x D, over the last `absence.bradford.window_weeks` weeks. The score is shown with
   its working and never triggers an action by itself (no solely automated decision, section 5.1).
9. **Not in force** (ADR-0087). Guaranteed hours, short-notice cancellation payments and shift notice
   (Employment Rights Act 2025): Harbour records hours, offers, notice and cancellations, but
   calculates no entitlement until the regulations commence and the rate table has their rows.

Tests: `packages/domain/src/scheduling/pay/*.test.ts`, table-driven against the rate table (the
gate's NMW, holiday and SSP rule tables).

## 5. API and events

To be written in slice 5 (operations) and slices 12, 21, 27, 30, 36, 40, 44 and 46.

## 6. Offline behaviour

Section 17.1: view shifts, request swaps (queued), clock in and out with device time plus server
time on sync (plan slice 71).

## 7. Clinical safety

Staffing below the assessed need (HZ-123), an ineligible worker rostered (HZ-124) and a lone-worker
alarm not escalated (HZ-125) are added by the slices the plan names. Agency access ends at shift end
plus `access.agency.post_shift_hours` (HZ-011). The dependency tool is the tenant's own scale, not a
clinical score ([medical-device-boundary.md](../compliance/medical-device-boundary.md) section 6).

## 8. Data protection

Purpose B3 in the [records of processing](../compliance/records-of-processing.md). Clock-in
location and lone-worker check-ins fall under the employee-monitoring DPIA (section 12.4).

## 9. Acceptance criteria and tests

To be written in slice 5. The Phase 2 gate needs the NMW, holiday and SSP rule tables to pass.

## 10. Open questions

The decisions and defaults are in [phase-2.md](../plans/phase-2.md) (ADR-0013, ADR-0086 to
ADR-0088, ADR-0097) and the human actions in [human-actions.md](../plans/human-actions.md) (H-518,
H-519, H-527, H-529, H-539, H-547).
