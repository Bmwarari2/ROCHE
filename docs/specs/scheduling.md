# Rostering, time and pay (`scheduling`) - specification

Master prompt section 12.3, with section 10.1 (the dependency tool) and 18 (data model). Phase 2
builds rotas, time and attendance and the pay rules engine for care homes
([phase-2.md](../plans/phase-2.md), lane C); domiciliary visits and ECM arrive in Phase 4. Payroll
is integrated, not built (section 12). Slice 5 wrote this specification and the Working Time rules
(SCHED-003); slice 6 added the pay rules (section 4b), and the schema slices (12, 21, 27, 30, 36,
40, 44, 46) confirm their tables against section 2. Slice 12 adds the dependency tool and the
required care hours per shift (section 13); slice 21 adds the rota builder (section 14). Status
per feature:
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

## 2. Schema (for the schema and API slices)

Section 18 names `shift`, `timesheet_entry` and `pay_rule`: start and end, type (day, night,
sleep-in, on-call), role required, skills required, actual times, breaks, travel, enhancements,
NMW check result; reproducible pay. Every table has `tenant_id`, forced RLS and a policy
(ADR-0002); a worker's own rows are visible to them through `scheduling.timesheet.self`. The
tables the working time rules read, and where each comes from:

| Table | Slice | Kind | What the rules take from it | Retention class |
| --- | --- | --- | --- | --- |
| `shift`, `shift_assignment` | 21 | mutable, `expected_version` | Planned periods: start, end, kind (`work`, `sleep_in`, `on_call_at_workplace`, `on_call_away`, `training`), the duty a split shift's parts share, planned breaks | `rota_and_timesheet` |
| `clock_event` | 30 | append-only, client UUID | Device and server time; becomes the recorded start and end | `rota_and_timesheet` |
| `timesheet_entry` | 30 | mutable until approved, then corrected by a new entry with `supersedes_id` | Recorded periods with kind, breaks, travel journey (`between_assignments`, `home_to_first_assignment`, `last_assignment_to_home`, `commute_to_fixed_workplace`), sleep-in detail (sleep expected, suitable facilities) and occasional overtime | `rota_and_timesheet` |
| `sleep_in_awake_period` | 30 | append-only | Each time awake for the purposes of working, logged per event | `rota_and_timesheet` |
| `other_employment_hours` | 30 | mutable | Hours a young worker declares for another employer (reg 5A(2), 12(5)) | `working_time_record` |
| `working_time_opt_out` | 30 | mutable, versioned | Signed date, end date if for a specified period, the agreement's own notice period, the date notice was given, the signed document | `working_time_opt_out` |
| `working_time_setting` | 30 | tenant configuration per location or service, versioned and audited | Derogations (special case per service; agreements; shift work), reference period arrangements, agreed night time, weekly rest basis and start, the reg 11(7) reasons, hospital or similar establishment | tenant configuration |
| `working_time_exception` | 30 | append-only | A young worker exception (basis, reason, the two reg 27A(1) conditions) attached to a shift or entry, recorded by a manager | `working_time_record` |
| `working_time_result` | 30 | append-only per run | The report: findings with their outcome, conditions, basis and compensatory rest owed; the averages with their working; the night worker assessment; the input hash and rate rows used, so a result reproduces | `working_time_record` |
| `compensatory_rest` | 30 | append-only | Rest given against a conditional finding, with who confirmed it | `working_time_record` |
| `dependency_scale`, `dependency_scale_version` | 12 | mutable, `expected_version`; a version is fixed once approved | The organisation's own dependency scale: shift periods, categories with care minutes per period, skill-mix minimums (section 13) | `organisation_document` |
| `dependency_assessment` | 12 | append-only with `supersedes_id` | A person's category and one-to-one minutes, with the reason and who decided (section 13) | `care_record` |

Excluded days for the 48-hour average come from absence and leave (slice 40): statutory annual
leave days only (never extra contractual leave), sick leave, and maternity, paternity, adoption
and parental leave. The worker's date of birth and employment start date come from the staff
file (slice 11), read through the workforce port, never a cross-module join.

## 3. Permissions

In the catalogue since Phase 0 ([permissions.md](permissions.md)): `scheduling.rota.read`,
`scheduling.rota.manage`, `scheduling.rota.approve`, `scheduling.visit.manage` (Phase 4),
`scheduling.timesheet.self`. The Phase 2 working time features use them as below and add one
permission, in the catalogue when slice 30 adds its tables. Each permission has its own scope
(ADR-0071); "location" means the locations the member works at.

| Permission | Allows | Held by (built-in roles) | Scope | Added |
| --- | --- | --- | --- | --- |
| `scheduling.rota.read` | See rotas and the working time warnings on them | As today | Location | Phase 0 |
| `scheduling.rota.manage` | Build and publish rotas; see the working time check before publishing | Owner, Registered Manager, deputy, care coordinator | Location | Phase 0 |
| `scheduling.rota.approve` | Approve timesheets; confirm compensatory rest given against a conditional finding; record a young worker exception | Owner, Registered Manager, deputy | Location | Phase 0 |
| `scheduling.timesheet.self` | Own clock events, timesheets, working time summary and opt-out (read); declare hours for another employer | As today | Self | Phase 0 |
| `scheduling.working_time.manage` | Record and withdraw opt-outs from the signed document; change the working-time setting (derogations, agreements, night time, weekly rest basis) | Owner, Registered Manager, HR | Location (setting: tenant-wide for owner) | Slice 30 |
| `scheduling.dependency.manage` | Write, approve and archive the organisation's dependency scale (section 13) | Owner, Registered Manager, deputy | Location (the organisation-wide scale: tenant-wide only) | Slice 12 |
| `care.dependency.assess` | Record a person's dependency category and one-to-one minutes (care record, MFA) | Owner, Registered Manager, deputy, clinical lead or nurse, team leader | Location | Slice 12 |

Separation of duties: timesheet approval is by someone other than the worker (section 12.3); the
same applies to confirming compensatory rest and recording an exception for oneself. Pay
permissions (slices 6 and 36), absence (40), wellbeing (44) and lone-worker check-ins (46) are set
by those slices.

## 4. Rules that are easy to get wrong

Every rule has a table-driven test in `packages/domain/src/scheduling/` (section 9). Figures come
from `rate_table` through `resolveWorkingTimeRates` (keys `wtr.*`, all statutory and verified on
legislation.gov.uk; [rates.md](rates.md)), never as literals: `rates.test.ts` fails if a number
other than 0, 1 or 2 appears in the scheduling source outside the calendar units. A tenant row
never overrides a statutory figure; what an employer may lawfully agree is the working-time
setting, checked against the figures. Regulation numbers are the Working Time Regulations 1998.

The checks advise; they never block a rota or a timesheet on their own. A **breach** is a limit
exceeded with nothing recorded that allows it. A **conditional** finding is a departure the law
allows only on conditions, which it lists: compensatory rest owed (with the minutes), adult
supervision, protection for health and safety, or a recorded reason.

### Working time

1. **The 48-hour average** (reg 4). Average weekly working time over the reference period may not
   exceed `wtr.weekly_max_hours`; exactly the figure is within it. Calculated exactly as reg 4(6):
   (A + B) / C. A is working time in the period; C is its number of weeks; B is working time after
   the period on as many days worked as there were excluded days in it. Excluded days (reg 4(7))
   are statutory annual leave (regs 13, 13A, 15B), sick leave, maternity, paternity, adoption and
   parental leave, and days under an opt-out. They are neither zero-hour days (which would hide a
   breach) nor simply dropped: later days stand in for them. Extra contractual leave, shared
   parental leave, bereavement and carer's leave are not in reg 4(7), so they count as days with no
   hours (H-580). Until the stand-in days are known the average is `provisional`, unless it is
   already over.
   - Reference period: `wtr.reference_period_weeks`; `wtr.reference_period_weeks.special_case`
     where reg 21 applies (reg 4(5); care in residential institutions); an agreement may set up
     to `wtr.reference_period_weeks.agreement_max` weeks (reg 23(b)). Rolling ("any period of
     17 weeks", one ending on every day) unless a relevant agreement sets successive periods from
     a date (reg 4(3)).
   - Short service (reg 4(4)): until the worker has served a full period, the period is the time
     since they started, checked at each whole week of service (a single day would multiply a
     shift by seven).
   - A run of overlapping periods over the limit is one finding, with the worst average.
2. **Days under an opt-out** are excluded days. Hours worked on them are left out of A, since
   the later days already stand in for them; otherwise a worker who withdraws an opt-out would be
   "over" at once on hours the limit never applied to. This is a purposive reading of reg 4(6)
   and (7)(d) for the employment law adviser to confirm (H-580).
3. **Opt-outs** (reg 4(1), 5). In writing; in force from the day signed; for a specified period
   (last day in force) or indefinitely. The worker ends it by written notice: the agreement's own
   period, which may not exceed `wtr.opt_out.max_notice_months` (a longer one is capped and
   flagged), or else `wtr.opt_out.default_notice_days`. Notice runs from the day after it is
   given; the limit applies again from the day after the notice ends. An opt-out lifts only the
   48-hour average: never the night limits, rest, breaks or any young worker limit. The employer
   keeps up-to-date records of who has opted out (reg 4(2); retention `working_time_opt_out`).
4. **Daily rest** (reg 10). In each 24 hours from the start of a spell of work there must be
   `wtr.daily_rest_hours` of consecutive rest (`wtr.young_worker.daily_rest_hours` for a young
   worker). Measured in elapsed time: 20:00 to 07:00 is 10 hours on the night the clocks go
   forward, although the clock face says 11, and 21:00 to 07:00 is 11 the night they go back. A
   sleep-in is working time, so a day shift followed by a sleep-in leaves no daily rest. A rest
   break inside a shift is not rest. A young worker's rest may be interrupted for split or short
   work (reg 10(3)) with the reason recorded.
5. **Weekly rest** (reg 11). `wtr.weekly_rest_hours` uninterrupted in each 7-day period, or, if
   the employer chooses, two such rests or one of `wtr.fortnightly_rest_hours` in each 14-day
   period. Periods start at 00:00 UK time on Monday (reg 11(6)), from the week employment began
   for fortnights (reg 11(5)), unless a relevant agreement sets the start. Weekly rest may not
   include the daily rest (reg 11(7)), so it needs the weekly and the daily figures together in
   one rest, unless the setting records the objective, technical or work-organisation reasons that
   allow it. A young worker needs `wtr.young_worker.weekly_rest_hours` in each 7 days, reduced to
   no less than `wtr.young_worker.weekly_rest_reduced_min_hours` for a recorded technical or
   organisation reason, or interrupted for split or short work with the reason recorded
   (reg 11(8)).
6. **Rest breaks** (reg 12). A duty of more than `wtr.break_threshold_hours` (exactly the figure
   needs none) needs one uninterrupted break of `wtr.break_minutes` inside it: not at its start or
   end, and two shorter breaks do not add up. One break meets the law however long the day; more is
   tenant policy. Parts of a split shift share a duty, and the gap between them is its break. A
   young worker needs `wtr.young_worker.break_minutes` once the day's working time, with hours for
   other employers that day (reg 12(5)), is over `wtr.young_worker.break_threshold_hours`; it
   should be one break "if possible", so shorter breaks adding up are allowed with a reason.
7. **Derogations** (regs 21 to 24). Where the work needs continuity of service (reg 21(c)(i),
   care in residential institutions, the `special_case`), under a collective or workforce
   agreement (reg 23(a)), on a shift worker's change of shift or for split shifts (reg 22), the
   adult daily rest, weekly rest and break rules (and, for the first two grounds, the night limits)
   may be departed from, with equivalent compensatory rest (reg 24): the finding is conditional and
   carries the minutes owed (the whole break for a missed break; protection for health and safety
   for the night limits). No derogation touches the 48-hour average (only the worker's own opt-out
   lifts it; the special case lengthens its reference period) or any young worker limit. Which
   services are a special case is the tenant's setting: on for residential and nursing care by
   default; domiciliary care and supported living are for the adviser to confirm (H-580, H-581).
8. **Night work** (reg 2, 6). Night time is `wtr.night_time.default_start_minute` to
   `wtr.night_time.default_end_minute`, or what a relevant agreement sets: at least
   `wtr.night_time.min_hours` long and covering `wtr.night_time.core_start_minute` to
   `wtr.night_time.core_end_minute` (an agreement that does not is refused). It is UK wall-clock
   time, so the night the clocks go back holds 8 hours of it and the night they go forward 6. A
   night worker works at least `wtr.night_worker.min_night_hours` of the day's working time in
   night time on the majority (more than half) of the days they work, counted by the UK date each
   duty starts, or is one by contract or agreement.
   - Average (reg 6(5)): A / (B - C), where A is normal hours (occasional overtime left out,
     regular overtime in), B the days in the period and C the weekly rest taken under reg 11
     divided by 24 (in each week, the longest rest up to `wtr.weekly_rest_hours`, so rest not taken
     is never subtracted). It may not exceed `wtr.night_work.average_max_hours`. Leave is not taken
     out (unlike rule 1). Reference period `wtr.night_work.reference_period_weeks`, or as an
     agreement sets; reg 4(5) does not lengthen it. No opt-out lifts it.
   - Special hazards (reg 6(7), (8)): where a risk assessment or agreement identifies them, no more
     than `wtr.night_work.hazard_max_hours` in any 24 hours in which the worker works at night,
     not averaged.
   - The free health assessment before and during night work (reg 7) is offered and recorded by
     the workforce module (H-581).
9. **Young workers** (reg 2, 5A, 6A, 27A). A worker is a young worker until 00:00 UK time on the
   birthday given by `wtr.young_worker.until_age_years`; someone born on 29 February reaches it on
   1 March in other years, the later reading, so protection never ends early. Only time before
   that instant is checked against these limits.
   - No more than `wtr.young_worker.daily_max_hours` a day and `wtr.young_worker.weekly_max_hours`
     a week, never averaged; the week starts at midnight between Sunday and Monday (reg 5A(3));
     hours for every employer count. Allowed only where the work is needed for continuity of
     service or a surge in demand, no adult is available and education or training is not affected
     (reg 27A(1)), recorded with its reason.
   - No work in the restricted period, `wtr.young_worker.restricted_start_minute` to
     `wtr.young_worker.restricted_end_minute`, or the `restricted_late_*` figures where the
     contract provides for work after 22:00. Allowed only in a hospital or similar establishment in
     the reg 27A(1) circumstances, recorded on every period worked in it, and then with adult
     supervision where needed and equivalent compensatory rest (reg 27A(4)). Whether a care home is
     a "similar establishment" is the tenant's setting, off by default (H-580). Real lengths differ
     on clock-change nights (9 hours of 22:00 to 06:00 in October, 7 in March).
   - No opt-out or adult derogation lifts any of these. Children below compulsory school age are
     not young workers; the staff file (slice 11) decides whether to refuse them.
10. **Sleep-ins** (section 12.3; Mencap 2021). A sleep-in is time on call at the workplace, so all
    of it is working time for these rules (gov.uk "Calculating your working hours"). For the
    minimum wage only time awake for the purposes of working counts, when the worker is expected to
    sleep for all or most of the shift and has suitable sleeping facilities; otherwise the whole
    shift counts (gov.uk minimum wage guidance). Awake periods are logged per event and counted
    once where they overlap. The flat sleep-in allowance is the tenant's pay rule set (slice 6).
11. **Travel and on call.** Travel between visits is working time and minimum-wage time. Home to
    the first visit and the last visit to home are working time for a worker with no fixed place
    of work, but not minimum-wage time. Commuting to a fixed workplace is neither. On call away
    from the workplace is not working time; a call-out is recorded as work.
12. **Time.** Instants are UTC; hours are elapsed time (a night shift from 20:00 to 08:00 is 13
    hours on 24/25 October 2026 and 11 on 28/29 March 2026); days, weeks, night time and the
    restricted period are UK local time (Europe/London). Every check is tested across both clock
    changes.
13. **Inputs and completeness.** A check covers the UK dates asked for: findings that start, and
    reference periods that end, on those dates. The caller passes the reference period before
    them, the days after them that stand in for excluded days, and the span over which the hours
    are complete; outside it, averages are provisional. Invalid input (a period ending before it
    starts, travel without its journey, a sleep-in without its details, a break outside its
    period, an invalid agreed night time or reference period) is refused, never guessed.

### 4b. Pay rules (slice 6: SCHED-005, 006, 007, 009, 010)

Pure functions in `packages/domain/src/scheduling/pay/` (ADR-0086). Money is whole pence; every
result carries its working (one line per step, in words) and a canonical input string the API
hashes, so a calculation reproduces exactly. Every figure comes from the rate table through
`resolvePayRates`, and the no-literal test in `rates.test.ts` covers this folder too. Statutory
figures ignore tenant rows (a lower minimum wage cannot be configured); only tenant defaults, the
Bradford window today, take a tenant's own figure. Which hours count is section 4's rule:
`nmwMinutesIn` (rules 10 and 11) gives the minutes the minimum wage check takes. The figures were
checked on gov.uk, legislation.gov.uk and The Pensions Regulator on 31 October 2026.

1. **Pay rule set** (`pay-rules.ts`). A tenant's versioned set: hourly rates by role, enhancements
   (a percentage or a flat amount an hour, by kind: night, weekend, bank holiday, overtime), the
   sleep-in flat allowance, mileage in pence a mile, on-call flat amount per period. Gross pay for
   timesheet entries applies each in a fixed order and shows each line, with the sleep-in, on-call
   and mileage amounts kept apart. Several enhancements on the same hours do not stack unless the
   set says so; the highest applies. Amounts are rounded down to the penny per line.
2. **NMW per pay reference period** (`nmw.ts`). The rate and the band are those in force on the
   first day of the period (an April increase or a birthday applies from the next period that
   starts after it); the band is decided by age on that day (`nmw.age.*`); the apprentice rate
   applies to an apprentice under `nmw.apprentice.age_limit`, or older and within
   `nmw.apprentice.first_year_months` of starting. Pay that counts (`nmwPayFromGross`): basic
   pay and the sleep-in allowance, less overtime and shift premiums above the basic rate, less
   deductions for the employer's own use (a uniform the worker pays for); mileage (an expense)
   and an on-call allowance for time at home never count. Accommodation: free accommodation adds
   `nmw.accommodation_offset.daily` for each day; a charge up to the offset changes nothing; a
   charge above it takes the excess off. Hours that count: `nmwMinutesIn` over the period (visits,
   travel between them, a sleep-in's awake times when sleep is expected with suitable facilities,
   otherwise the whole sleep-in; never home to the first visit, time asleep or rest breaks). What
   the hours must earn at the band's rate (`nmw.hourly.*`) is rounded up; the shortfall is shown
   in pence.
3. **Holiday for irregular-hours and part-year workers** (`holiday.ts`; Working Time Regulations
   1998 regs 15B and 16A). From leave years starting on or after 1 April 2024: on the last day of
   each pay period, accrual of `holiday.accrual_percentage.irregular_hours` of the hours worked in
   it; or, if the tenant chooses rolled-up holiday pay, that percentage of the remuneration for the
   period (every payment that counts towards a week's pay, so regular enhancements but not
   mileage), shown as its own line on the payslip and never folded into the hourly rate. The
   holiday ledger (slice 36) applies the rest of reg 15B: no more than 28 days' accrual in a leave
   year, and the accrued total rounded to the nearest hour (half an hour or more up); and reg 15C
   and 16A(4) to (6) during sick or statutory leave (the average over the previous 52 weeks).
   Applies only where the rate table has a row for the nation (no Northern Ireland row yet).
4. **SSP** (`ssp.ts`; Social Security Contributions and Benefits Act 1992 ss 152 to 157 as amended
   by the Employment Rights Act 2025 from 6 April 2026, S.I. 2026/373). Payable from the first day
   of a period of incapacity for work, which is now one day or more; no waiting days
   (`ssp.waiting_days`) and no lower earnings limit. The weekly rate is the lower of
   `ssp.earnings_percentage` of normal weekly earnings and `ssp.weekly`; a day's SSP is the weekly
   rate divided by the qualifying days in the week, a week beginning on Sunday (s 157(3)).
   Entitlement ends when the payments reach `ssp.max_weeks` times the weekly rate (s 155(4)), which
   for a steady pattern is that many weeks of qualifying days. Spells no more than 8 weeks apart
   are one period of incapacity: the caller passes the days already paid in it. The payment is the
   exact amount rounded up to the next penny once (SSP (General) Regulations 1982 reg 11). A day on
   which the employee worked at all is not a sick day. Only where the rate table has the nation's
   rows (no Northern Ireland row: its law has not changed; H-529).
5. **Statutory family pay** (`family-pay.ts`). Maternity and adoption: the first
   `smp.higher_rate_weeks` weeks at `family_pay.earnings_percentage` of average weekly earnings,
   then the lower of that and the standard rate, for at most `smp.total_weeks` weeks; paternity,
   shared parental and parental bereavement pay at the lower of the two. Maternity pay's standard
   rate is `smp.standard_weekly` (from 5 April 2026); the others use `family_pay.standard_weekly`
   (from 6 April 2026), as gov.uk gives the two dates. Each week's payment is rounded up to the
   next penny, as each kind's regulations say. Eligibility (service, earnings) is recorded by HR,
   not decided here.
6. **AWR** (`awr.ts`; Agency Workers Regulations 2010 reg 7). An agency worker qualifies for equal
   basic terms after `awr.qualifying_weeks` continuous calendar weeks in the same role with the same
   hirer; a week counts if any work was done in it. A break keeps the weeks before it only if the
   break as a whole is covered: any break of up to `awr.break_reset_weeks` weeks; or a break wholly
   for sickness or injury of up to `awr.sickness_pause_max_weeks` weeks; or wholly for protected
   leave (pregnancy, maternity, adoption, paternity), other leave, the hirer's shutdown or
   industrial action, or a mix of those. Otherwise, or in a substantively different role, the clock
   resets: a sickness break longer than its limit resets it, and so does a long break that is only
   partly for a covered reason. Pregnancy, maternity, adoption and paternity leave within the
   assignment's original or likely length counts as weeks worked (reg 7(6)). Jury service (up to
   28 weeks) is not modelled yet: record it as a covered break until slice 27 adds it.
7. **Auto-enrolment flags** (`auto-enrolment.ts`; Pensions Act 2008 ss 1 and 3). For a pay
   reference period of a week or a month: eligible jobholder (aged
   `auto_enrolment.eligible_min_age` and under state pension age, earnings over the period's
   earnings trigger), non-eligible jobholder (aged `auto_enrolment.min_age` to
   `auto_enrolment.max_age` and earnings over the lower level of qualifying earnings, or eligible by
   earnings but outside the age band), entitled worker (below the lower level). The per-period
   thresholds are The Pensions Regulator's table. State pension age is an input (it depends on date
   of birth); the flag never enrols anyone by itself.
8. **Bradford factor** (`bradford.ts`). Spells of absence (consecutive days merged, and days apart
   only by days the worker was not due to work) times days, squared spells: S x S x D, over the
   last `absence.bradford.window_weeks` weeks (a tenant default). The caller leaves out absences
   that must not count against a worker: pregnancy-related sickness, and absence a reasonable
   adjustment discounts (Equality Act 2010; slice 40 records why). The score is shown with its
   working and never triggers an action by itself (no solely automated decision, section 5.1).
9. **Not in force** (ADR-0087). Guaranteed hours, short-notice cancellation payments and shift notice
   (Employment Rights Act 2025): Harbour records hours, offers, notice and cancellations, but
   calculates no entitlement until the regulations commence and the rate table has their rows.

Also from section 12: rotas and timesheets are kept 6 years and working-time records 2 years; a
worker without the required DBS result, right to work or competence cannot be rostered to a shift
that needs it ([workforce.md](workforce.md); slice 21).

Tests: `packages/domain/src/scheduling/pay/*.test.ts`, table-driven against the rate table (the
gate's NMW, holiday and SSP rule tables).

## 5. API, audit events and outbox events

For the slices that build them (21, 30, 60):

- The rota (slice 21) runs `checkWorkingTime` for each worker on a draft rota with their recorded
  hours before it, shows the findings beside the shifts and before publishing, and never blocks
  publishing on them; publishing with a breach shows it to the approver.
- Time and attendance (slice 30) runs it when a timesheet is approved and nightly for the
  previous day, stores a `working_time_result` with its input hash and rate rows, and raises a
  task to the Registered Manager for each breach and each conditional finding until compensatory
  rest is confirmed.
- Audit events: opt-out recorded, withdrawn and viewed; working-time setting changed; exception
  recorded; compensatory rest confirmed; result viewed and exported.
- Outbox: `scheduling.working_time.finding_raised` (opaque ids only) for the quality dashboard
  (slice 47) and notifications.

## 6. Offline behaviour

Section 17.1: view shifts, request swaps (queued), clock in and out with device time plus server
time on sync (plan slice 71). The checks run on the server against synced records; the phone
shows the worker's own last result.

## 7. Clinical safety

Staffing below the assessed need (HZ-123, added by slice 12; section 13 rules 9 to 12), an
ineligible worker rostered (HZ-124) and a lone-worker alarm not escalated (HZ-125) are added by the
slices the plan names. Agency access ends at shift end
plus `access.agency.post_shift_hours` (HZ-011). The dependency tool is the tenant's own scale, not a
clinical score ([medical-device-boundary.md](../compliance/medical-device-boundary.md) section 6).
The Working Time checks are employment-law compliance, not a clinical control, and slice 5 adds no
hazard; whether staff fatigue from long hours needs a hazard of its own is for the CSO when rating
the Phase 2 hazards (H-543).

## 8. Data protection

Purpose B3 in the [records of processing](../compliance/records-of-processing.md). Clock-in
location and lone-worker check-ins fall under the employee-monitoring DPIA (section 12.4). The
working time rules are pure functions over data other slices store; slice 5 adds no personal data.
Slice 12 adds a person's dependency category and one-to-one minutes, which are health data (B1;
section 13).
Slice 30 adds the date-of-birth read (from the staff file), hours declared for other employers,
opt-outs and results, and updates [data-standards.md](data-standards.md) and the records of
processing. Retention: `rota_and_timesheet` (6 years), `working_time_record` (2 years) and
`working_time_opt_out` ([retention.md](retention.md)). Results and logs carry opaque ids only.

## 9. Acceptance criteria and tests

- Domain (built, slice 5), table-driven, in `packages/domain/src/scheduling/`:
  - `rates.test.ts`: every `wtr.*` key resolves from rates.md for each nation and is verified; a
    tenant row is ignored; a missing figure fails loudly; no figure is a literal in the source.
  - `classification.test.ts`: working time and minimum-wage time for each kind and journey
    (rules 10, 11); sleep-in awake time counted once; breaks taken out; elapsed hours across both
    clock changes; invalid periods refused.
  - `agreements.test.ts`: opt-out last day (default notice, the agreement's own, capped at the
    maximum, a specified period), in force by date, issues; agreed night time (length, core hours);
    reference period lengths (standard, special case, agreed up to the maximum).
  - `weekly-average.test.ts`: (A + B) / C over the limit and at it; each excluded leave reason made
    up from later days; provisional until known, unless already over; opted out; opt-out days
    excluded; short service; the special-case 26 weeks; successive periods; one finding per run.
  - `rest.test.ts`: daily rest (13-hour days, quick return, both clock changes, sleep-in, the
    special case and the other derogations); young daily rest and its interruption; weekly rest
    (seven days worked, Saturday evening to Monday, reg 11(7) with and without the reasons,
    compensatory rest, the fortnightly options); young weekly rest (36 hours with a reason,
    interruption); breaks (threshold, a minute over, inside, at the start, two short, split shift,
    care home); young breaks (30 minutes, split with a reason, other employers).
  - `night.test.ts`: night hours on both clock-change nights; night worker by pattern, majority,
    agreed night time and contract; the night average at and over the limit, no opt-out, care home
    protection, occasional overtime, leave not excluded; special hazards.
  - `young-workers.test.ts`: daily and weekly limits with other employers and the Monday week;
    the reg 27A(1) exception and its conditions; no opt-out; the 18th birthday instant and
    29 February; the restricted period, the contract variant, hospital or similar with supervision
    and compensatory rest, and both clock-change nights.
  - `working-time.test.ts`: a week checked end to end, in order with citations; the same week in a
    care home as conditions with the compensatory rest owed; dates outside the range; refusals; no
    derogation reaches the 48-hour average or a young worker limit.
- Domain (built, slice 6), table-driven against the rate table, in
  `packages/domain/src/scheduling/pay/`: `rates.test.ts` (every figure, money in pence, Northern
  Ireland without holiday accrual or SSP, figures either side of 1 April 2026, statutory figures
  never taken from a tenant row), `pay-rules.test.ts`, `nmw.test.ts` (bands, apprentices,
  29 February, premiums, uniform deductions, free and charged accommodation, rounding),
  `holiday.test.ts`, `ssp.test.ts` (day one, the lower of the two, rounding up, the entitlement
  limit), `family-pay.test.ts` (both standard rates and their dates, rounding up),
  `awr.test.ts` (pauses, resets, sickness over its limit, mixed breaks, deemed working),
  `auto-enrolment.test.ts`, `bradford.test.ts`, `money.test.ts`, and `hours-to-pay.test.ts`, which
  feeds section 4's hours (`nmwMinutesIn`: a sleep-in, travel, another employer, a pay reference
  period boundary) into the minimum wage check. The scheduling `rates.test.ts` fails if a figure
  appears as a literal in the pay folder (the gate's test).
- Database (slice 30): RLS and isolation for every table in section 2; append-only grants for
  clock events, awake periods, exceptions, results and compensatory rest.
- API (slices 21, 30): rota warnings before publishing; results stored with input hash and rate
  rows and reproduced exactly; audit events.
- Web (slice 60): working time alerts with the regulation and conditions in words (status by icon
  and word), Playwright and axe.
- The Phase 2 gate's NMW, holiday and SSP rule tables pass (slice 6; extended in slice 36).

## 10. Open questions

- The employment law adviser confirms the readings in section 4 (H-580): opt-out days and A
  (rule 2); which absences are excluded days (rule 1); reg 11(7) (rule 5); which services are a
  special case under reg 21 (rule 7); whether a care home is a "similar establishment" for young
  workers (rule 9); sleep-ins and home-to-first-visit travel as working time (rules 10, 11); the
  night average's C (rule 8); notice counting (rule 3).
- Each tenant records its working-time arrangements before relying on the checks (H-581).
- Pay: the Bradford window is a tenant default (H-583); the remaining pay readings, SSP when the
  qualifying days change from week to week, which protected-leave weeks the AWR clock deems worked,
  and the minimum wage treatment of the sleep-in and on-call allowances, are for the adviser
  (H-585, with H-529). The family pay rates (H-582) and the auto-enrolment thresholds (H-584) were
  verified on 31 October 2026.
- The pay decisions and defaults are in [phase-2.md](../plans/phase-2.md) (ADR-0013, ADR-0086 to
  ADR-0088, ADR-0097) and the human actions in [human-actions.md](../plans/human-actions.md) (H-518,
  H-519, H-527, H-529, H-539, H-547).

## 11. As built (slice 5, domain rules)

`packages/domain/src/scheduling/`, pure functions with no I/O. `@harbour/domain` exports
`checkWorkingTime` with its types, the rates, classification, agreements and 48-hour average
functions, `nightMinutes` and `youngWorkerUntil`; the rule-group functions in `rest.ts`,
`night.ts` and `young-workers.ts` take periods prepared inside the module, so callers use
`checkWorkingTime`.

- `rates.ts`: `WORKING_TIME_RATE_KEYS`, `resolveWorkingTimeRates(rows, nation, on)` (no tenant
  override).
- `working-time-types.ts`: `WorkPeriod` and its kinds, `ExcludedDay`, `OptOutAgreement`,
  `NightTime`, `WorkingTimeWorker`, `WorkingTimeSetting`, `WorkingTimeFinding` (rule, citation,
  outcome, conditions, basis, from, to, limit, actual, compensatory rest, period ids),
  `ADULT_DEROGATIONS`, `WORKING_TIME_CITATIONS`.
- `classification.ts`: `classifyWorkingTime`, `workingMinutes`, `nmwMinutes`, and
  `nmwMinutesIn(periods, payReferencePeriod)`, the minutes the pay rules' `nmwCheck` takes.
- `agreements.ts`: `optOutLastDay`, `optOutInForce`, `checkOptOutAgreement`, `checkNightTime`,
  `nightTimeFor`, `weeklyAverageReferenceWeeks`, `nightAverageReferenceWeeks`.
- `weekly-average.ts`, `rest.ts`, `night.ts`, `young-workers.ts`: one file per rule group.
- `working-time.ts`: `checkWorkingTime(input)` returns the findings in time order, the 48-hour
  averages with their working, the night worker assessment, the night averages and the instant
  the young worker rules end.
- Internal: `intervals.ts` (elapsed time, UK days and weeks, daily wall-clock windows, birthdays)
  and `prepared.ts` (periods, duties, reference windows).

Rate rows added: `wtr.reference_period_weeks.special_case`, `wtr.reference_period_weeks.agreement_max`,
`wtr.opt_out.default_notice_days`, `wtr.opt_out.max_notice_months`, `wtr.night_time.*` (5 rows),
`wtr.night_worker.min_night_hours`, `wtr.night_work.hazard_max_hours`,
`wtr.young_worker.until_age_years`, `wtr.young_worker.restricted_*` (4 rows) and
`wtr.young_worker.weekly_rest_reduced_min_hours`, all verified on legislation.gov.uk on 31 October
2026.

## 12. As built (slice 6, pay rules)

`packages/domain/src/scheduling/pay/`, exported from `@harbour/domain` (ADR-0086, ADR-0087):
`resolvePayRates` and `toPence` (`rates.ts`); `percentOf`, `roundUpPence`, `canonicalInput` and
`formatPounds` (`money.ts`); `grossPay` (`pay-rules.ts`); `nmwBand`, `nmwCheck`, `nmwPayFromGross`
and `ageOn` (`nmw.ts`); `irregularHoursHoliday` (`holiday.ts`); `sickPay` (`ssp.ts`); `familyPay`
(`family-pay.ts`); `awrClock` (`awr.ts`); `autoEnrolmentCategory` and `qualifyingEarningsPence`
(`auto-enrolment.ts`); `bradfordFactor` (`bradford.ts`). Rate rows: `nmw.age.*`,
`nmw.apprentice.*`, `smp.*`, `family_pay.*`, `awr.break_reset_weeks`,
`awr.sickness_pause_max_weeks`, the per-period `auto_enrolment.*` thresholds and age bands, and
`absence.bradford.window_weeks` (tenant default, to verify).

## 13. Dependency tool and required care hours (slice 12; CARE-004, SCHED-001)

Master prompt sections 10.1 ("dependency (tenant-editable category scale with care hours per
category)") and 12.3 (the safe staffing planner: "converts each person's category and 1:1 hours
into required care hours per shift; compares with rota hours and skill mix ... shows the gap and
the method"). Regulation 18 of the Health and Social Care Act 2008 (Regulated Activities)
Regulations 2014 needs sufficient numbers of suitably qualified staff, deployed by a systematic
method the provider can explain; it sets no ratio, and Harbour supplies none.

**The scale is the organisation's own tool.** Harbour stores the scale the organisation writes,
records which category each person is in and why, and adds up the organisation's own figures for
the people living at a location. It never assesses a person, never proposes a category, never
scores need or risk and never judges whether staffing is safe
([medical-device-boundary.md](../compliance/medical-device-boundary.md) section 6). Every
required-hours figure carries the scale's name, version and approval and the notice
`DEPENDENCY_TOOL_NOTICE`: "These hours come from your organisation's own dependency scale. Harbour
adds up the figures your organisation set; it does not assess anyone's needs or judge safe
staffing." Harbour ships no default scale and no figure: the rate table gains no row (H-712).

Slice 12 builds the rules, schema and API. The rota comparison (rota hours and skill mix against
the requirement, with the gap shown on the rota) is slice 21; the screens are slice 59.

### Schema

| Table | Kind | Columns | Retention class |
| --- | --- | --- | --- |
| `dependency_scale` | mutable, `expected_version`, soft delete (archive) | `location_id` (null: the organisation-wide scale, used by every location without its own), `name`; one live scale per location and one organisation-wide (unique indexes); the location is fixed once made | `organisation_document` |
| `dependency_scale_version` | mutable while `draft`, then fixed; `expected_version` | `scale_id`, `version_number` (1, 2, ...), `state` (`draft`, `approved`, `superseded`, `discarded`), `definition` (below), `author_id`, `contributor_ids` (the author and everyone who changed the draft, kept by the database), `approved_by`, `approved_at`, `superseded_at`, `discard_reason`; one draft and one approved version per scale | `organisation_document` |
| `dependency_assessment` | append-only, client UUID, idempotent | `person_id`, `scale_id`, `scale_version_id`, `category_key`, `one_to_one` (`[{ periodKey, minutes }]`), `kind` (`initial`, `review`, `correction`), `effective_from` (UK date), `reason`, `decided_by` (the member who decided), `supersedes_id`, `created_by` (who recorded), `recorded_at`; one chain per person (one row without `supersedes_id`; each row superseded at most once) | `care_record` |

The `definition` (`DependencyScaleDefinition`) is the organisation's data, checked by
`checkScaleDefinition` and stored whole with each version:

- `periods`: the shift periods the requirement is given for, `[{ key, label, startMinute }]`, in
  order of their UK wall-clock start (minutes after midnight). Each period ends where the next one
  starts and the last ends where the first starts the next day, so the periods cover the day with
  no gap or overlap (for example day 08:00 and night 20:00).
- `categories`: `[{ key, label, description, careMinutes: [{ periodKey, minutes }] }]`: care
  minutes per person in each period, one entry for every period.
- `skillMix`: `[{ skill, periodKey, minimumStaff }]`: the organisation's minimum number of staff
  holding a skill on each period. Skills: `registered_nurse`, `medicines_competent`,
  `moving_and_handling`, `driver` (`STAFFING_SKILLS`, master prompt 12.3); slice 21 reads who
  holds them through the workforce competence port (ADR-0085).
- `reviewIntervalDays`: how often the organisation reviews a category, or null.

Keys are lower case letters, digits and underscores, starting with a letter. Scales and versions
hold no personal data. They sync to no device in Phase 2 (a management tool on the web).

### Permissions

| Action | Permission | Scope |
| --- | --- | --- |
| Read scales and versions | Any of `scheduling.dependency.manage`, `care.dependency.assess`, `scheduling.rota.manage`, `scheduling.rota.read` | The organisation (no personal data) |
| Make, rename, archive a scale; start, change or discard a draft | `scheduling.dependency.manage` where the scale applies: at its location, or tenant-wide for the organisation-wide scale (the database checks `app.holds_permission_at`) | Location |
| Approve a draft | `scheduling.dependency.manage`, never by the draft's author or anyone who changed it (separation of duties, rule 4) | Location |
| Read a person's dependency record | `care.dependency.assess` or `care.plan.read` (care record; MFA) | The permission's person scope |
| Record a person's category | `care.dependency.assess` (care record; MFA) | The permission's person scope |
| Required care hours for a location | `scheduling.rota.manage` and `care.plan.read` together (it lists each person's category: a care record view) | Only a scope that covers the whole location (rule 10) |

### Rules

1. **Definition** (`checkScaleDefinition`). At least one period and one category; period keys
   unique, labels not blank, starts whole minutes from 0 to 1439 in strictly increasing order;
   category keys unique, labels not blank, care minutes given once for every period and no other,
   whole and not negative; skill-mix rows for known skills and periods, each skill once per period,
   minimums whole and at least 1; a review interval, if any, a whole number of days of at least 1.
   A draft may be saved with problems (they are returned); approval needs none.
2. **Versions** (`DEPENDENCY_SCALE_WORKFLOW`). A scale starts with a draft. A draft changes only
   against the version the editor loaded (`expected_version`); the editor joins its contributors.
   Approval fixes it, supersedes the version in use (which keeps `approved_at` and gains
   `superseded_at`) and applies from that instant. A draft can be discarded with a reason. Only
   one draft and one approved version at a time. Nothing is deleted; the database refuses any
   change to an approved, superseded or discarded version except approved to superseded.
3. **Version in force** (`scaleVersionInForce`, `scaleVersionsEffective`). For a shift period, the
   version that applies at the period's start; a period that starts before the first approval has
   no scale. A version applies from its approval, unless it moves the shift periods of the version
   then in force: then it applies from 00:00 UK time the next day, so one day's periods never come
   from two versions (no gap or overlap; #153 review).
4. **Approval** (`checkScaleApproval`): only a draft, with no definition problems, different from
   the version in use, by a member who is neither its author nor a contributor. Problems:
   `not_draft`, `invalid_scale`, `unchanged`, `author_cannot_approve` (refused 403 as separation of
   duties; the others 422 or 409).
5. **Which scale applies.** A location uses its own live scale, otherwise the organisation-wide
   one. An archived scale applies nowhere; archiving needs `expected_version` and a reason.
6. **A person's category** (`checkDependencyAssessment`). From the version in force of the scale
   that applies at the person's location; the category key must be in that version; one-to-one
   minutes per period for known periods only, each period once, whole and more than 0; a reason
   (not blank) and the member who decided are required; `effective_from` is a UK date no later
   than today. The first record is `initial`; every later one supersedes the person's current
   record (the chain's head), sent as `supersedesId`: a stale one is refused 409 (someone else
   recorded first). A `review` takes effect on or after the superseded record's date; a
   `correction` replaces the superseded record from its own date (the corrected record is shown
   struck through and is never in force). The database enforces the chain, the approved version,
   the category and the periods again (migration 0074).
7. **In force** (`dependencyInForce`). At an instant: of the records not corrected, the latest in
   the chain whose `effective_from` (00:00 UK time) is at or before it.
8. **Shift periods** (`periodWindows`). A period on a UK date starts at its wall-clock start on that
   date and ends at the next period's start (the next day for the last). Lengths are elapsed time,
   so a 20:00 to 08:00 night is 13 hours on 24/25 October 2026 and 11 on 28/29 March 2026; the
   care minutes stay as the scale sets them, and the method and a `clock_change` warning say they
   are not adjusted (whether they should be is for the CSO, H-710).
9. **Required care hours** (`staffingRequirement`). For a location, a UK date and optionally one
   period: the people whose record is at the location (live statuses and `pre_admission`), each
   placed on the date asked (`presenceOn`, #153 review M1): `present` (living there), `away` (on
   leave or in hospital, today or earlier), `planned_admission` (being admitted, with the decision
   in force planning the admission on or before the date), `not_yet_admitted` (planned for later,
   or a past date); and, where the record cannot say, `away_return_unknown` (away today, asked
   about a later date: no return date is recorded), `admission_date_unknown` (being admitted with
   no planned date, asked about today or later) and `unknown` (a date before the person's current
   status began). For each period, the version in force at its start; each person's record in
   force at its start. Required minutes = the sum over counted people (`present`,
   `planned_admission`) of their category's care minutes for the period, plus their one-to-one
   minutes for it. The result lists minutes per
   category (people, minutes each, minutes), one-to-one minutes per person, the period's
   skill-mix minimums and the method in words, step by step, with the scale's name, version and
   approval. No figure is rounded until shown.
10. **Never a falsely low figure** (HZ-123). With no scale in force the result is `no_scale` with a
    warning and no number, never 0. A counted person with no record in force, a record on another
    scale (they moved), or a category or period the version in force does not have is not counted
    and is named in a warning; so is anyone the record cannot place (rule 9); the result is then
    incomplete and the figure is `at_least` ("at least N hours"), or `none` with no number when
    nobody is counted (just after the first approval; #153 review M3). A location with nobody at
    all is an exact 0. A record made on an earlier (or later) version is counted by its category
    key in the version in force and flagged; a record older than the scale's review interval is
    flagged as overdue; a planned admission counted is said. People on leave or in hospital on the
    date are not counted but are listed with the minutes they would add (H-713). The API refuses
    the requirement (403) unless the request's scope covers the whole location, and a period key
    the scale in force does not have (422).
11. **Comparison inputs** (`compareStaffing`, for slice 21). Given the rota's care minutes on the
    period and the number of rostered staff holding each skill: `below` when the care minutes or
    any skill minimum fall short (with the shortfall, "at least" when the figure is), `incomplete`
    when they do not but the requirement is incomplete or has no figure, `met_with_warnings` when
    complete and nothing falls short but the requirement carries warnings (overdue reviews,
    earlier versions, people away, a clock change), `met` only with no warning, `no_scale` when
    there is no scale (no shortfall given). Every warning on the requirement is carried into the
    comparison (#153 review M2). Every status has a word as well as an icon on screen
    (`STAFFING_STATUS_WORDS`); the comparison advises and never blocks a rota.
12. **Labelled as the organisation's tool.** Every requirement and comparison carries the source
    (scale, version, approved by and when) and `DEPENDENCY_TOOL_NOTICE`; none carries a score, a
    risk level or wording that Harbour judges the staffing. The required figure is the
    organisation's figures added up, with the method shown.

### API, audit and outbox

| Route | What |
| --- | --- |
| `GET /v1/dependency-scales` | Scales with the version in use and the open draft, each draft with its problems |
| `POST /v1/dependency-scales` | Make a scale (name, location or organisation-wide) with its first draft |
| `PATCH /v1/dependency-scales/{id}` | Rename, against `version` |
| `POST /v1/dependency-scales/{id}/archive` | Archive with a reason, against `version` |
| `GET /v1/dependency-scales/{id}/versions` | Versions, newest first |
| `POST /v1/dependency-scales/{id}/versions` | Start a draft from the version in use |
| `PUT /v1/dependency-scales/{id}/versions/{versionId}` | Change a draft, against `version` |
| `POST /v1/dependency-scales/{id}/versions/{versionId}/approve` | Approve a draft, against `version` |
| `POST /v1/dependency-scales/{id}/versions/{versionId}/discard` | Discard a draft with a reason, against `version` |
| `GET /v1/people/{id}/dependency` | The person's records, newest first, the one in force and the corrected ones marked |
| `POST /v1/people/{id}/dependency` | Record a category (client `id`, idempotent: the same id and content returns the stored record) |
| `GET /v1/locations/{id}/staffing-requirement?date=&period=` | Required care hours for each period of the date (or one) |

Audit events (opaque ids only, never a category or a reason): `scheduling.dependency_scale.created`,
`.renamed`, `.archived`, `.drafted`, `.edited`, `.approved`, `.discarded`;
`care.dependency.recorded` and `care.dependency.viewed`; `scheduling.staffing_requirement.viewed`
(a care-record view, with the location, date and the number of people listed). Refusals are
audited. Outbox: `scheduling.dependency_scale_approved` (scale, version, location) and
`care.dependency_recorded` (person, record, location) for slice 21 and the quality dashboard.

### Test list

- Domain (`packages/domain/src/scheduling/dependency.test.ts`, table-driven): every definition
  problem; periods covering the day and their windows on ordinary days and both clock-change
  days; the version in force before, at and after an approval; approval problems including author
  and contributor; assessment problems (category, one-to-one, reason, future date, stale head,
  initial twice, review before, correction date); the record in force with corrections and
  reviews; the requirement for present, away, unassessed, other-scale, missing-category,
  earlier-version and review-overdue people; no scale; the comparison statuses; the label and
  notice on every result and no score; no figure as a literal (the existing scheduling source
  check covers the file).
- Database (`packages/db/test/dependency.test.ts`): cross-tenant denial on all three tables;
  scale writes only for holders of `scheduling.dependency.manage` where the scale applies; one
  live scale per location; versions fixed once approved; approval never by an author or a
  contributor; assessments append-only, in the person's scope, only on an approved version with a
  known category and periods, one chain per person.
- API (`apps/api/test/dependency.test.ts`): the scale CRUD with `expected_version` and its audit
  events; approval by a second member; a person's category with reason and decider, a stale head
  refused, an idempotent replay, the view audited; the required hours with the method, the source
  and the notice, a missing scale, an unassessed person, a scope that does not cover the location
  refused; another organisation's ids not found.

### As built (slice 12)

- Domain: `packages/domain/src/scheduling/dependency.ts`, exported from `@harbour/domain`:
  `checkScaleDefinition`, `checkScaleApproval`, `scaleVersionInForce`, `scaleForLocation`,
  `periodWindows`, `checkDependencyRecord`, `dependencyChain`, `currentDependency`,
  `dependencyInForce`, `staffingRequirement`, `compareStaffing`, `formatCareMinutes`, with
  `DEPENDENCY_TOOL_NOTICE`, `STAFFING_STATUS_WORDS` and the message tables.
- Schema: `packages/db/src/schema/dependency.ts`; migration `0074_dependency_tool.sql` (tables,
  RLS, `app.may_manage_dependency_scale`, the scale, version and category guards, grants, the
  role data migration for the two new permissions and the sample-data removal list).
- API: `apps/api/src/routes/scheduling-dependency.ts`; contracts in
  `packages/contracts/src/scheduling.ts`.
- The placement's free-text `dependency_category` (Phase 1 admission form) is left as it is and is
  not read by the requirement; whether to retire it is H-716.

## 14. Rota builder (slice 21; SCHED-001, SCHED-002)

Master prompt section 12.3 (the rota builder with skills, continuity, swaps, bank and agency; the
safe staffing planner comparing rota hours and skill mix with the dependency requirement, showing
the gap and the method) and section 12's rule that a worker without the required DBS result, right
to work or competence cannot be rostered. Hazards HZ-123 and HZ-124. Slice 21 builds the schema
and API; the screens are slice 59, clock-in on the day slice 27, offline swaps slice 71. Human
actions H-830 to H-839.

### Schema (migration 0083)

| Table | Kind | Columns | Retention class |
| --- | --- | --- | --- |
| `shift_template` | mutable, `expected_version`, archived | `location_id`, `name`, `kind` (`SHIFT_KINDS`), `start_minute`, `end_minute` (UK wall clock; an end at or before the start is the next day), `break_minutes`, `required_competences`, `required_skills`, `supervised`, `counts_as_care` | `rota_and_timesheet` |
| `shift_pattern` | mutable, archived | `location_id`, `name`, `cycle_days` (1 to 56), `entries` (`[{ day, templateId, count }]`) | `rota_and_timesheet` |
| `rota` | mutable | `location_id`, `starts_on`, `ends_on` (at most 42 days; live rotas at a location never overlap), `state` (`draft`, `published`), `published_at` | `rota_and_timesheet` |
| `rota_publication` | append-only | `rota_id`, `published_by`, `published_at`, `first_shift_start`, `notice_minutes`, counts of shifts, open shifts, overrides and working time findings, `staffing` (`[{ date, periodKey, status }]`), `check_digest` | `rota_and_timesheet` |
| `shift` | mutable, cancelled with a reason | `rota_id`, `location_id`, `template_id`, `label`, `kind`, `starts_at`, `ends_at`, `break_minutes`, `required_competences`, `required_skills`, `supervised`, `counts_as_care`, `published_at`, `changed_after_publish_at` | `rota_and_timesheet` |
| `shift_assignment` | mutable, removed with a reason | `shift_id`, `location_id` (the shift's), `worker_id`, `published_at`; one live assignment per shift | `rota_and_timesheet` |
| `roster_override` | append-only | `assignment_id`, `location_id`, `worker_id`, `blocker_keys` (each with its reason; never a right to work or `not_active`), `justification` (10 to 1000 characters), `created_by`; given only with the assignment | `rota_and_timesheet` |

A shift is one position for one member. Row-level security: the rota tables are read with
`scheduling.rota.read` or `.manage` where the rota is (`app.reads_rota`) and written with `.manage`
there (`app.manages_rota`); a member reads their own assignments and shifts once published with
`scheduling.timesheet.self` through any role (`app.holds_self_permission`); overrides are read by
holders of `.manage` or `.approve` there and given only with `.approve`, in the giver's name, never
for themselves. Guards: a rota, template or pattern keeps its location; a shift keeps its rota and
starts on one of its dates; an assignment keeps its shift and worker, is to a live shift, and a
member is never on two live shifts that overlap (one member's assignments are serialised with an
advisory lock the API also takes before checking every location); rotas at a location are started
one at a time; an override is for a live assignment of its worker, made in the same transaction. Earlier versions in `record_version` follow the rota's read rule.

### Rules

1. **Shift shapes** (`checkShiftShape`): start and end are whole minutes in the day; a break is
   whole minutes, shorter than the shift; competences are the organisation's observed competences
   (`COMPETENCES`); skills are the dependency scale's (`STAFFING_SKILLS`); each listed once. Times
   are UK wall clock (`shiftTimes`), so a 20:00 to 08:00 night is 13 hours on the night the clocks
   go back and 11 on the night they go forward.
2. **Patterns** (`checkPattern`, `patternShifts`): a cycle of live templates by day; applied to a
   rota, the cycle's day 0 is the UK date the pattern was made, so the next rota carries on. Applying
   makes open shifts.
3. **Assigning** (HZ-124; `combinedRosterDecision` with `rosterChecks` and the competence port):
   on every UK date the shift touches (a night is checked on the date it ends too, so a right to
   work or a sign-off expiring overnight blocks): whether the member works for the organisation
   that day (`memberActiveOn`: active, started, not left; `not_active`, never overridable); the
   staff file's DBS (the newest certificate decides; new information from the Update Service on
   any certificate blocks), right to work and (where the role is registered) a registration on the
   role's own register, counting only items verified by someone other than the member; and each
   competence the shift needs from the competence port, which blocks if the sign-off has lapsed by
   then or now. No staff file means no DBS and no right to work. A blocked member is refused (422
   `not_eligible`; `right_to_work` or `not_active` when those block, never overridable) unless a
   holder of `scheduling.rota.approve` at the location overrides with a justification and the
   blocker keys they were shown (each with its reason: `dbs:<reason>`, `competence:<name>:<reason>`);
   if the blockers have changed since, the override is refused (409 `blockers_changed`). Never for
   their own shift. Only members with a live role at the location or across the organisation are
   answered for; anyone else reads as not found. A member already on an overlapping live shift
   anywhere is refused (409). The answer gives each blocker's kind in words, never a DBS detail. A
   shift's required skills describe the position and do not block (H-836).
4. **Skills held** (`workerSkills`), for the whole shift (on each date it touches):
   `registered_nurse` when the role is on the NMC register and the registration is current (the
   part of the register is not yet recorded, H-835); `medicines_competent` and
   `moving_and_handling` from the competence port (`medicines_administration`,
   `moving_and_handling_hoist`); nobody is a `driver` until drivers are recorded (H-835).
5. **The rota against the requirement** (HZ-123; `staffingProvided` then `compareStaffing`): per
   date of the rota and each shift period of the scale in force, the care minutes of assigned
   `work` shifts the organisation counts as care (`counts_as_care`; not housekeeping, kitchen or
   office) inside the period less each shift's break in proportion, and for each skill the fewest
   holders on shift at any moment of the period (`fewestPresent`: a handover overlap or two
   holders one after the other never count as two); shifts of the neighbouring rotas at the
   location that reach into the period count too; open shifts, sleep-ins, on-call and training give
   no care minutes. The comparison carries the requirement's source, notice, method and every
   warning, adds the rota's own (open care shifts, members on shift under an override), and says
   "met, but" (`met_with_warnings`) whenever a warning stands. It advises and never blocks.
6. **Working time** (advice only; `checkWorkingTime`): for each member on the rota, every live
   assignment of theirs at any location from the longest reference period before the rota to the
   day after it, with planned breaks placed in the middle of each shift (H-833), only the rota's
   own days known; no working-time setting or opt-out is recorded until slice 30, so none is
   applied (H-832); both of a young worker's restricted windows are checked until the contract's
   late working is recorded; a staff file without a date of birth or start date gives
   `cannot_check`, never an adult's rules by default. Findings use hours worked at other locations
   too (only this rota's shift ids are returned).
7. **The check before publishing** (`rotaCheck`; `GET /v1/rotas/{id}/check`): the comparison per
   date and period, each member's working time, every assignment's eligibility again with whether
   an override still covers it (`overrideCovers`: an override covers only what it named), the open
   shifts, the notice the rota would give now and a digest of all of it. It needs
   `scheduling.rota.manage` and `care.plan.read` in a scope covering the whole location (H-837),
   and is audited as a care-record view.
8. **Publishing**: locks the rota (every change to its shifts and assignments takes the same lock),
   and sends back the digest; a changed check is refused (409 `check_changed`) so the new one is
   read first; the publisher must have read that check themselves within the hour (its digest is on
   their own `scheduling.rota.checked` audit event; 409 `check_not_seen`); an assignment the rule
   now blocks with no override covering it is refused (422 `ineligible_assignments`); each period
   that is `below`, `incomplete` or `no_scale` must be acknowledged by name
   (`periodsToAcknowledge`; 422 `periods_not_acknowledged`); any other warning (`met, but`, a
   working time finding or `cannot_check`, an open shift, an override standing) needs
   `acknowledgeWarnings` (422 `warnings_not_acknowledged`). Publishing marks the shifts and assignments
   published, records the publication with the notice before the first shift and what the
   publisher was shown, and raises `scheduling.rota_published`. A change after publishing (a shift
   added or cancelled, a member put on or taken off) is marked on the shift for notice (H-834) and
   the rota is published again; the rota then reads `changedSincePublished` until it is (a task or
   a daily re-check of published rotas is H-839).

### API, audit and outbox

| Route | What |
| --- | --- |
| `GET`, `POST /v1/locations/{id}/shift-templates`; `POST /v1/shift-templates/{id}/archive` | Templates |
| `GET`, `POST /v1/locations/{id}/shift-patterns`; `POST /v1/shift-patterns/{id}/archive` | Patterns |
| `GET`, `POST /v1/locations/{id}/rotas`; `GET /v1/rotas/{id}` | Rotas with shifts, who is on them and publications |
| `POST /v1/rotas/{id}/apply-pattern`, `POST /v1/rotas/{id}/shifts`, `POST /v1/shifts/{id}/cancel` | Shifts |
| `GET /v1/shifts/{id}/eligibility?workerId=` | The rostering rule for a member on a shift |
| `POST /v1/shifts/{id}/assignment`; `POST /v1/shift-assignments/{id}/remove` | Assigning, with an optional override, and the member's working time as advice |
| `GET /v1/rotas/{id}/check`; `POST /v1/rotas/{id}/publish` | The check and publishing |
| `GET /v1/me/shifts?from=&to=` | A member's own published shifts |

Audit events (opaque ids only, never a blocker's detail, a justification or a finding):
`scheduling.shift_template.created`, `.archived`; `scheduling.shift_pattern.created`, `.archived`;
`scheduling.rota.created`, `.pattern_applied`, `.checked`, `.published`; `scheduling.shift.added`,
`.cancelled`, `.assigned`; `scheduling.eligibility.checked`; `scheduling.roster_override.given`;
`scheduling.shift_assignment.removed`. Refusals are audited. Outbox:
`scheduling.rota_published` (rota, location, publication).

### Test list

- Domain: `packages/domain/src/scheduling/rota.test.ts` (shapes, clock changes, patterns, what the
  rota gives on a period, "met, but", working time from planned shifts, notice, overlaps, the
  window) and `packages/domain/src/workforce/roster-checks.test.ts` (the staff file's checks on a
  day; an override covers only what it named).
- Database: `packages/db/test/rota.test.ts` (cross-tenant denial on all seven tables; who reads
  and builds; a member's own published shifts only; no overlapping rotas; shifts inside their rota;
  nobody on two shifts at once; overrides only by an approver, never for a right to work, a short
  justification, another's name or oneself, never changed; publications append-only).
- API: `apps/api/test/rota.test.ts` (templates, patterns at UK times, rotas; the rule on
  assigning, overrides and refusals; working time advice and `cannot_check`; the check with and
  without a scale; publishing with the digest, the acknowledgement and the notice; eligibility
  lapsing before publishing; a member's own shifts; another organisation's rota not found).

### As built (slice 21)

- Domain: `packages/domain/src/scheduling/rota.ts` and `packages/domain/src/workforce/roster-checks.ts`;
  `RosterInput` takes the competence port's decision.
- Schema: `packages/db/src/schema/rota.ts`; migration `0083_rota_builder.sql`.
- API: `apps/api/src/routes/rota.ts`, `apps/api/src/services/rota.ts`; the requirement is shared
  with slice 12's route through `apps/api/src/services/staffing-requirement.ts`; contracts in
  `packages/contracts/src/rota.ts`.
- Not in this slice: swaps with approval and open-shift offers (H-838), the clock-in check on the
  day (slice 27), the screens (slice 59), offline swap requests (slice 71).
