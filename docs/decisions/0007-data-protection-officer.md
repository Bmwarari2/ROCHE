---
status: accepted
date: 2026-10-11
decision-makers: Brian (Thapsus Cargo Ltd, Appendix default); recorded by Claude Code
---

# Data protection lead: Brian as named lead, ICO registration in Phase 0

## Context and problem statement

Thapsus is a processor for its tenants and a controller for its own data (staff, customers, operator
logs). It needs a Data Protection Officer or named data protection lead, registration with the
Information Commissioner's Office (ICO), and template data processing agreements and privacy notices.

## Decision drivers

- UK GDPR accountability and Article 28 processor duties apply from the first pilot.
- ICO registration (data protection fee) is a legal requirement for most organisations processing
  personal data and has a short lead time.
- The build produces the templates; signatures are human actions.

## Considered options

- Appoint an external DPO before the first pilot.
- Brian acts as named data protection lead; register with the ICO in Phase 0; appoint a DPO later if
  scale or the core-activities test requires it.

## Decision outcome

Chosen option: "Brian as named lead; ICO registration in Phase 0", because it is the Appendix default
and covers the obligations that apply now.

### Consequences

- Good, because a named lead exists from day one and registration is not left late.
- Bad, because Brian carries the role alongside others; an independent DPO may be needed once Thapsus
  processes special category data at scale for many tenants (reassess at the first paying tenant).
- The build drafts in `docs/compliance/`: Article 28 DPA template, sub-processor register, privacy
  notices (staff, residents and families, website), records-of-processing register and the DPIA
  template; tenants record their own DPO, Caldicott Guardian and SIRO in-app (section 5.1).

## More information

- Takes effect: Phase 0.
- Human actions: register Thapsus Cargo Ltd with the ICO and pay the fee; approve the DPA and privacy
  notice templates.
- How to change: supersede this ADR naming the appointed DPO and their contact route.
