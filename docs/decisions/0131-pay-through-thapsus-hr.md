---
status: "accepted"
date: 2026-11-07
decision-makers: engineering (Claude Code sessions), under section 20 rule 2 (Appendix defaults)
consulted: clinical safety officer (HZ-140, H-1441), payroll adviser (H-1442)
informed: Brian (owner), Thapsus-HR engineering
---

# Pay through Thapsus-HR: its periods and rates in, units by pay code out, one route per period

## Context and problem statement

[ADR-0126](0126-thapsus-hr-link.md) makes Thapsus-HR the owner of pay rates and pay periods, and
Harbour the owner of timesheets and pay units. [integrations.md](../specs/integrations.md)
section 11.5 rules 11 and 12 say Harbour sends units, never money, reads the hourly rate only
for its minimum wage check, and never pays a period through both routes. Slice 89 builds this.

Three questions were open:
- How does a pay run use Thapsus-HR's pay periods?
- What units go out, and how are they grouped?
- When does a change of route take effect, and what happens if a unit has no pay code?

Thapsus-HR's pay items (K4) and pay read (K5) are planned in its Phase 19 and not yet published.

## Decision drivers

- Nobody paid twice or not at all (rule 12; HZ-133, HZ-140).
- The minimum wage check uses the rate the employee is actually paid.
- The pay run keeps its own checks: approved time only, two people, exceptions block the lock.
- Build now against the contract-tested mock; go live only when Thapsus-HR publishes K4 and K5.

## Considered options

- **A. One route per pay period, decided when the run is drafted, calculated and locked.**
  A period paid through Thapsus-HR is one of its pay periods exactly, uses its rate, and on lock
  keeps its units and sends them by pay code, replacing that period's items.
- **B. Send units as each timesheet is approved.** Units would reach payroll before a person
  checked the run, and a later correction would have to undo individual items.
- **C. Send money (the pay line) instead of units.** Rule 11 forbids it: Thapsus-HR applies its
  own rates.

## Decision outcome

Chosen option: **A**.

1. **Route.** Each pay run's route is fixed when it is drafted and never changes; a correction
   takes its original's (enforced in the database). The link's settings hold the route for periods
   with no run yet (Harbour's export by default) and at most one change waiting, from the first
   day of a later pay period than any run. A move to Thapsus-HR needs a fresh step-up, both pay
   capabilities available, pay rates and periods owned by Thapsus-HR and timesheets by Harbour,
   and must start on one of its pay periods. A run drafted with the link disconnected or its flag
   off pays through Harbour's export; a run whose route is Thapsus-HR is never locked while the
   link cannot take pay (it never falls back to the export).
2. **Periods and rates.** Read once a day (and on a manual sync), checked at the boundary and
   written by the sync alone (migration 0148). A pay period whose dates change is raised, never
   moved. Only the employee, the hourly rate in whole pence and its effective date are kept.
3. **Pay runs.** A run for a period paid through Thapsus-HR must match one of its pay periods
   exactly. Its calculation uses the lowest of each member's Thapsus-HR rates in force during the
   period for the minimum wage check, and is refused when rates were not read in the last two
   days; a member with no rate gets the "no role rate" exception, which cannot be overridden for
   such a run.
4. **Units.** Hours split exactly as the pay line splits them (by night, weekend, bank holiday and
   overtime), plus sleep-ins, on-call periods away and miles. They go out per employee and pay
   code, summed and rounded to 2 places.
5. **Lock.** The units are those of the calculation the second person checked (its stored
   inputs, never live timesheets). Before locking, every member with units must be matched and
   every unit kind must have a pay code (mapped by a pay approver); otherwise the lock is refused,
   naming what is missing. On lock the units and their pay codes are kept (append-only) and
   Harbour's export is not offered.
6. **Sending.** The latest locked run of each period (a correction carries the whole period,
   and one with no units empties it) replaces that period's items in Thapsus-HR with the pay
   codes kept at lock, through the delivery log with its idempotency key. A refusal, a member no
   longer matched, and locked pay unsent when the link is disconnected go to pay approvers.

### Consequences

- Good: one route per period, decided before anything is paid; the existing pay run checks stay.
- Good: a correction replaces the period's items rather than adding to them.
- Bad: the pay codes must be mapped before the first lock, and rounding to 2 places can differ by
  a penny's worth of time from the pay line (H-1442).
- Bad: nothing goes live until Thapsus-HR publishes K4 and K5 and the mock is re-pinned.

### Confirmation

- Domain: `thapsus-hr-pay.test.ts` and the HZ-140 cases in `pay-run.test.ts`.
- Database: `packages/db/test/hr-link-pay.test.ts`.
- API: `apps/api/test/hr-link-pay.test.ts`, and the mock's contract tests.
