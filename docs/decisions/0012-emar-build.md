---
status: accepted
date: 2026-10-11
decision-makers: Brian (Thapsus Cargo Ltd, Appendix default); recorded by Claude Code
---

# eMAR: build it in Phase 2, integrate pharmacy feeds behind an adapter

## Context and problem statement

Medicines are the most inspected area in adult social care. Harbour can build its own electronic MAR
(including the controlled-drugs register) or integrate a pharmacy-linked eMAR vendor and build later.

## Decision drivers

- A care system without eMAR forces providers to buy a second product.
- Medicines need offline rounds, barcode and witness capture and the 10.3 safety rules, which depend on
  tight integration with the care record and the competence model.
- Pharmacy systems differ; Harbour must work for tenants whose pharmacy has no integration.

## Considered options

- Build eMAR in Phase 2 (section 10.2) and integrate pharmacy feeds behind an adapter.
- Integrate a third-party eMAR vendor now and build later.

## Decision outcome

Chosen option: "Build eMAR in Phase 2; integrate pharmacy feeds behind an adapter", because it is the
Appendix default and keeps the highest-risk clinical workflow under Harbour's own clinical safety
management.

### Consequences

- Good, because the eMAR shares the person record, allergies, competence gating and offline sync.
- Bad, because medicines carry the highest clinical risk; every rule in section 10.3 is a hazard-log
  item with a test, and `packages/domain/medicines` has a required reviewer (CODEOWNERS) and a hook that
  refuses changes without test updates.
- Pharmacy order, MAR import and label feeds, and the monthly dm+d sync, sit behind a domain interface
  with a contract test and a mock (section 15.3; Phases 2–3, pharmacy interface completed in Phase 5).

## More information

- Takes effect: Phase 2.
- Human action: a pharmacist or nurse reviews the MAR and CD register exports (Phase 2 follow-up).
- How to change: supersede this ADR naming the vendor to integrate; the medicines module would then
  become an adapter and its hazards move to the DCB0160 deployment template.
