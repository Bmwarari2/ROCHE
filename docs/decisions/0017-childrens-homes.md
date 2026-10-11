---
status: accepted
date: 2026-10-11
decision-makers: Brian (Thapsus Cargo Ltd, Appendix default); recorded by Claude Code
---

# Children's homes: build the Ofsted module in Phase 7

## Context and problem statement

Children's homes are regulated by Ofsted under the Children's Homes (England) Regulations 2015, not by
CQC. They reuse most of the platform but need their own quality standards and cycles. Build or drop?

## Decision drivers

- The goal is the whole design (section 19 definition of complete includes a demo children's home).
- The configurable compliance framework and nation-pack mechanism already support another regulator.

## Considered options

- Build the children's homes module in Phase 7.
- Drop it.

## Decision outcome

Chosen option: "Build it in Phase 7", because it is the Appendix default and the definition of complete
requires it.

### Consequences

- Good, because an adjacent market opens with modest extra code (framework, forms, schedules).
- Bad, because safeguarding, consent and records for children differ from adults; Phase 7 starts with
  its own spec, permission matrix (including Reg 44 independent visitors) and hazard review.
- Scope: Ofsted quality standards framework, Reg 44 monthly independent visits, Reg 45 six-monthly
  reviews, placing-authority reporting; adult-only features (DoLS, CHC, FNC) stay disabled for that
  service type.

## More information

- Takes effect: Phase 7. Phase 7 gate: Reg 44 and Reg 45 cycles run in the demo children's home.
- How to change: supersede this ADR to drop the module; the feature register rows prefixed `EXP` for
  children's homes are then marked out of scope by the same ADR.
