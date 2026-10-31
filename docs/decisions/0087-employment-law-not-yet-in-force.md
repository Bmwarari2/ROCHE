---
status: "accepted"
date: 2026-10-31
decision-makers: Claude Code (Phase 2 lane C)
consulted: master prompt section 12.3; docs/plans/phase-2.md (decisions); employment adviser (H-529)
informed: Brian
---

# Employment law not yet in force: record, do not calculate

## Context and problem statement

Section 12.3 asks for guaranteed-hours and short-notice cancellation payment tracking "ready for
2027". The Employment Rights Act 2025 provides for guaranteed hours offers, reasonable notice of
shifts and payment for shifts cancelled at short notice, but the regulations that set the reference
periods, the notice and the payment have not been made. Building an entitlement calculation now would
mean inventing figures.

## Considered options

- Record the facts now; calculate nothing until the regulations commence.
- Calculate with assumed figures, marked to verify.
- Do nothing until the regulations are made.

## Decision outcome

Chosen option: record the facts now and calculate nothing, because it keeps the evidence an
employer will need (hours worked over time, offers made, notice given, shifts cancelled and when)
without presenting an assumed entitlement as law.

- Harbour records hours, offers, notice given and cancellations with their times (scheduling slices).
- No guaranteed-hours, notice or cancellation figure is added to `rates.md`, and no rule computes an
  entitlement, until the regulations commence. Then a slice adds the rows with their sources and a
  table-driven rule, and this ADR is superseded.
- Screens say plainly that the law is not yet in force.

### Consequences

- Good, because nothing presents an invented figure as the law.
- Bad, because the calculation must be built when the regulations are made (tracked by H-529).
