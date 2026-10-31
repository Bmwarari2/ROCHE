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
