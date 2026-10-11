---
status: accepted
date: 2026-10-11
decision-makers: Brian (Thapsus Cargo Ltd, Appendix default); recorded by Claude Code
---

# NHS DSCR assurance: pursue it, collecting evidence from Phase 1

## Context and problem statement

About 80% of providers already use a digital social care record, and councils fund only NHS-assured
products. Assurance needs MODS and PRSB alignment, dm+d, DCB0129, GP Connect, the DSPT, and (since the
information governance uplift of 1 September 2026) ISO 27001 and an annual penetration test. From
1 October 2027 assurance moves to a supplier-pays model. Should Harbour pursue assurance, and when?

## Decision drivers

- Assured status opens council-funded and NHS-linked sales.
- Evidence is far cheaper to collect as features are built than to reconstruct.
- The indicative schedule (section 19, starting 20 October 2026) ends Phase 5 around mid-October 2027,
  so a submission lands at or just after the start of the supplier-pays model.

## Considered options

- Pursue assurance; collect evidence from Phase 1; start ISO 27001 in Phase 2.
- Do not pursue; sell to self-funder-heavy providers without assurance.

## Decision outcome

Chosen option: "Pursue assurance; collect evidence from Phase 1 and start ISO 27001 in Phase 2",
because it is the Appendix default.

### Consequences

- Good, because MODS and PRSB mapping (`docs/specs/data-standards.md`), the hazard log and safety case,
  and ISO 27001 and Cyber Essentials control mappings in `docs/compliance/` grow with the code.
- Bad, timing risk: on the indicative schedule the submission falls around October 2027, when the
  supplier-pays model has started. Either Phases 3–4 are compressed to submit before 1 October 2027, or
  the assurance fee is budgeted. The build keeps the phase order (compressing finance and home care
  would trade quality for timing) and logs the budget decision for Brian.
- The Phase 5 gate generates the assurance evidence pack from the repository.

## More information

- Takes effect: Phase 5 (evidence collection starts in Phase 1).
- Human actions: ISO 27001 certification, external penetration test, CSO signature (ADR-0006),
  DSPT for Thapsus (ADR-0020), and the assurance submission itself; budget decision on supplier-pays.
- How to change: supersede this ADR to drop assurance (GP Connect then stays unbuilt or mocked) or to
  compress Phases 3–4.
