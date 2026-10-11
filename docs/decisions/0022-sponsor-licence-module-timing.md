---
status: accepted
date: 2026-10-11
decision-makers: Brian (Thapsus Cargo Ltd, Appendix default); recorded by Claude Code
---

# Sponsor-licence compliance module stays in Phase 2

## Context and problem statement

Many providers employ sponsored overseas care workers and must keep Appendix D records and report
changes to the Home Office within 10 working days. The Appendix asks whether any first client employs
sponsored workers; if none does, the module can slip to Phase 3.

## Decision drivers

- Sponsor-licence breaches can cost a provider its licence and its workforce.
- The answer from Brian is not yet known; the build does not wait.

## Considered options

- Keep the sponsor module in Phase 2 with the rest of recruitment (section 12.1).
- Move it to Phase 3.

## Decision outcome

Chosen option: "Keep it in Phase 2", because the default is to build it with recruitment unless Brian
says no first client employs sponsored workers.

### Consequences

- Good, because recruitment, right to work and sponsor duties share one compliance file and expiry-task
  engine.
- Bad, because Phase 2 is larger; if Brian confirms no sponsored workers, the module moves to Phase 3.
- The salary floor and reporting period live in the rate table (`sponsor.salary_floor.care_worker`,
  `sponsor.change_report_working_days`), never in code, because the route is changing through 2028.

## More information

- Takes effect: Phase 2.
- Open question for Brian: do any first clients employ sponsored workers?
- How to change: tell Claude Code "no sponsored workers" or supersede this ADR; the feature register
  rows for the sponsor module move to Phase 3.
