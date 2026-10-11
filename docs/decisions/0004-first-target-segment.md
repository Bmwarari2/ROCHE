---
status: accepted
date: 2026-10-11
decision-makers: Brian (Thapsus Cargo Ltd, Appendix default); recorded by Claude Code
---

# First target segment: residential and nursing homes first

## Context and problem statement

Harbour covers residential and nursing homes, supported living, domiciliary care, complex care at home
and day services. Phase 1 must ship a vertical slice a real provider can use. Which segment does
Phase 1 serve: care homes, or home care (which would swap Phases 1 and 4)?

## Decision drivers

- Richer regulation and higher spend per site in residential and nursing care.
- Brian's reference clients are more likely to be care homes.
- Medicines, DoLS, bed board and notifications are densest in care homes, so building them first
  exercises the hardest parts of the platform early.

## Considered options

- Residential and nursing first (Phase 1 as written in section 19).
- Home care first (swap Phases 1 and 4: packages, run planning and ECM before the residential MVP).

## Decision outcome

Chosen option: "Residential and nursing first", because it is the Appendix default and matches the
reference clients, the richer regulation and the higher spend per site.

### Consequences

- Good, because the residential MVP (section 19, Phase 1) drives the care record, offline mobile,
  capacity and DoLS, incidents and the family feed to depth first.
- Bad, because domiciliary-only prospects wait until Phase 4 for scheduling and electronic call
  monitoring.
- The demo tenant's first location is a 60-bed nursing home; the 300-hour-a-week home-care agency is
  added in Phase 4.

## More information

- Takes effect: Phase 0 (planning) and Phase 1 (build).
- How to change: tell Claude Code "home care first" or supersede this ADR; Phases 1 and 4 swap and
  `docs/plans/STATUS.md` and the feature register phases are updated in the same PR.
