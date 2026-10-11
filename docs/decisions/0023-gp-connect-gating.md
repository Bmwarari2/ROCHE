---
status: accepted
date: 2026-10-11
decision-makers: Brian (Thapsus Cargo Ltd, Appendix default); recorded by Claude Code
---

# GP Connect is enabled per tenant only when the tenant holds DSPT "Standards Met"

## Context and problem statement

GP Connect access (Access Record HTML) requires the supplier to be NHS-assured and the care provider
to hold Data Security and Protection Toolkit (DSPT) "Standards Met". The Appendix asks whether first
clients hold it; the answer is not yet known.

## Decision drivers

- NHS prerequisites for GP Connect cannot be bypassed by configuration.
- Tenants without Standards Met must still get a working product.

## Considered options

- Enable GP Connect for every tenant once Harbour is assured.
- Gate GP Connect per tenant on a recorded DSPT "Standards Met" status.

## Decision outcome

Chosen option: "Gate per tenant on DSPT Standards Met", because it is the only option consistent with
the NHS prerequisites.

- The GP Connect feature flag can be switched on only when the tenant's DSPT status is recorded as
  "Standards Met" with the assessment year and evidence (section 11.2 data security evidence), Harbour's
  assurance is current, and staff sign in with NHS CIS2.
- The flag switches off automatically when the recorded DSPT status lapses (the annual 30 June
  submission deadline passes without a new Standards Met record).

### Consequences

- Good, because no tenant can reach NHS data without meeting the prerequisites.
- Bad, because some early tenants will not have GP Connect; they keep the manual GP contact and
  medicines reconciliation workflows.
- The GP Connect and PDS adapters are built behind interfaces with contract-tested mocks (section 15.3),
  so the gate is the only difference between tenants.

## More information

- Takes effect: Phase 5.
- Open question for Brian: do the first clients hold DSPT Standards Met?
- How to change: supersede this ADR only if NHS England changes the prerequisites.
