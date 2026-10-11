---
status: accepted
date: 2026-10-11
decision-makers: Brian (Thapsus Cargo Ltd, Appendix default); recorded by Claude Code
---

# Clinical Safety Officer: build the safety artefacts now, CSO signature gates go-live

## Context and problem statement

DCB0129 requires the manufacturer of health IT to run clinical risk management under a named Clinical
Safety Officer (CSO): a registered clinician trained in clinical risk management who signs the clinical
safety case. NHS DSCR assurance requires it. Thapsus has not yet contracted a CSO.

## Decision drivers

- Safety of the person receiving care is the first principle (section 3).
- Hazards must be identified while features are designed, not retrofitted.
- Only a person can sign the safety case; the build cannot wait for that.

## Considered options

- Contract a CSO before building clinical features.
- Build the hazard log and draft the safety case now; make CSO signature a precondition for a real
  tenant going live and for any assurance submission.

## Decision outcome

Chosen option: "Build the hazard log and draft the safety case now; CSO signature is a precondition
for real-tenant go-live", because it is the Appendix default and keeps clinical risk management running
from day one.

### Consequences

- Good, because `docs/clinical-safety/` (risk management plan, hazard log with the day-one hazards from
  section 5.2, safety case per release) exists from Phase 0 and every hazard has a test.
- Good, because the `clinical-safety-reviewer` agent reviews clinical PRs in the meantime.
- Bad, because hazard assessments are drafted without a clinician's judgement until the CSO reviews
  them; the CSO may re-grade risks and require changes.
- No real tenant goes live, and no DSCR assurance submission is made, until a CSO has reviewed and
  signed the safety case. The operator console blocks marking a tenant "live" without a recorded CSO
  sign-off for the release in use.

## More information

- Takes effect: Phase 1 gate (safety case v0.1 drafted; CSO review is the human follow-up).
- Human action: contract a CSO (part-time is normal), then CSO reviews the hazard log and signs the
  safety case.
- How to change: when a CSO is appointed, supersede this ADR naming them and the review cadence.
