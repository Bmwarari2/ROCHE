# 2026-11-07 feat/integrations-hr-link-pay: pay through the Thapsus-HR link (slice 89)

INTG-014, SCHED-005, SCHED-008; [ADR-0131](../decisions/0131-pay-through-thapsus-hr.md); migration
0151; HZ-133, new HZ-140; H-1441 to H-1444.

## What changed

- **One route to payroll per pay period.** The link's settings hold the route (Harbour's export by
  default) and one change waiting, from the first day of a later pay period than any run, with a
  fresh step-up. A move to Thapsus-HR needs its pay items and pay read available, the default
  owners, and a start on one of its pay periods. With the link off or disconnected, Harbour's
  export as before.
- **Pay periods and rates in**, once a day and on a manual sync, checked at the boundary, written
  by the sync alone (`hr_pay_period`, `hr_pay_rate`); rates read by pay holders only.
- **Pay runs** for a period paid through Thapsus-HR must be one of its pay periods exactly, and
  check the minimum wage with its rate; no rate blocks the lock.
- **Units by pay code out.** Hours split as the pay line splits them, sleep-ins, on-call periods
  and miles. The lock is refused until every member with units is matched and every unit kind has
  a pay code; the units are then kept unchanged (`hr_pay_unit`), the export is not offered, and the
  latest locked run replaces the period's items in Thapsus-HR through the delivery log.
- **Mock.** Thapsus-HR's Phase 19 pay items (K4) and pay read (K5) are served only with
  `phase19` switched on; at the pinned commit (d9888cef) they still answer `planned`, so nothing
  goes live (H-1443).
- Docs: ADR-0131, integrations.md section 11.5, HZ-140, records of processing, data standards,
  feature register, H-1441 to H-1444.

## Reviews

- Security reviewer, request changes (fixed): units from the checked calculation's stored inputs;
  pay codes kept on each unit at lock and mapped only by a pay approver; each run's route fixed
  when drafted, corrections inheriting it (database trigger), and a run never falling back to the
  export when the link is down; owners checked on every change while pay goes through Thapsus-HR;
  read size capped; the pay-record alert limited to pay approvers.
- Clinical safety reviewer, request changes (fixed): the same route and units fixes; no rate
  cannot be overridden for such a run; the lowest rate in force during the period; calculation
  refused on rates over two days old; alerts for a member unmatched after lock and for locked pay
  left unsent on disconnecting; HZ-140 re-rated on the plan's matrix (2, target 1) with a test for
  each code control; H-1441 and H-1442 updated.
- Clinical safety reviewer, second pass (fixed): the unsent-pay check on disconnecting compares
  the latest run's digest, so a correction locked after an earlier send is counted; tested.
- Security reviewer, second pass: approve.

## Checks

See the branch's head commit message for the suites run on a private Postgres.

## Left

- Pay through Thapsus-HR goes live only when Thapsus-HR publishes K4 and K5 and the mock is
  re-pinned (H-1443).
- Rates are read daily, not yet on `employee.changed`; Thapsus-HR periods and rates it stops
  listing are kept, not retired.
- A run drafted while the link is down or off pays through Harbour's export even when the
  settings say Thapsus-HR (never twice, but without a warning); slice 90 adds the warning.
- Turning the flag off pauses delivery of locked pay without an alert (delivery runs at lock).
- The lock reads the link's settings without locking its row; each run's fixed route makes this
  safe for routing, and a concurrent pay code change applies only to the next lock.
- Screens for the route to payroll and the pay codes (slice 90).
