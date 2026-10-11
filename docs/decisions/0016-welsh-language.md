---
status: accepted
date: 2026-10-11
decision-makers: Brian (Thapsus Cargo Ltd, Appendix default); recorded by Claude Code
---

# Welsh language: full Welsh UI in Phase 7, i18n ready from Phase 0

## Context and problem statement

Welsh tenants need a Welsh interface and the Welsh "Active Offer". When does the Welsh UI ship?

## Decision drivers

- Early tenants are expected in England.
- Retrofitting i18n is expensive; translating catalogues later is not.

## Considered options

- Ship Welsh UI in Phase 7 as written.
- Ship Welsh UI earlier if a Welsh tenant signs.

## Decision outcome

Chosen option: "Phase 7", because it is the Appendix default. The plumbing is in place from Phase 0:
every UI string goes through ICU message format in `packages/i18n` with en-GB and cy catalogues, the
Welsh Active Offer flag exists per tenant, and per-tenant terminology is supported.

### Consequences

- Good, because no string is hard-coded and a Welsh tenant can be served by translating catalogues.
- Bad, because cy catalogues lag English until Phase 7; a CI check reports missing cy keys as a
  warning until Phase 7 and as an error from then on.

## More information

- Takes effect: Phase 7. Phase 7 gate: the Welsh locale renders every screen.
- Human action: professional Welsh translation review; a Welsh tenant completes an inspection pack in
  Welsh.
- How to change: if a Welsh tenant signs earlier, supersede this ADR and move the Welsh UI and the
  Wales nation pack forward.
