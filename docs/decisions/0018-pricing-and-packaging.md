---
status: accepted
date: 2026-10-11
decision-makers: Brian (Thapsus Cargo Ltd, Appendix default); recorded by Claude Code
---

# Pricing and packaging: price list drafted in Phase 3 with the finance module

## Context and problem statement

Harbour is licensed per client by subscription. The pricing model affects metering in the operator
console and the module licensing flags. When is it set?

## Decision drivers

- No sale happens before Phase 1; metering must exist before the first sale.
- Brian's existing terms: a £200 set-up fee and a 12-month minimum.
- The free data export promise is a differentiator and belongs in the contract.

## Considered options

- Set prices now.
- Draft the price list in Phase 3 alongside the finance module, using the model in the Appendix.

## Decision outcome

Chosen option: "Draft the price list in Phase 3", because it is the Appendix default. Working model:
per bed per month (care homes) and per client or per carer per month (home care), module tiers, AI as an
add-on, an implementation fee, the free data export promise in the contract, and the existing set-up fee
and 12-month minimum.

### Consequences

- Good, because pricing is set when the finance module and real costs (hosting, AI tokens, support) are
  known.
- From Phase 0, the operator console records module licensing flags, seats and beds per tenant so any
  of these models can be metered.
- Bad, because early sales conversations rely on indicative pricing.

## More information

- Takes effect: before the first sale (drafted in Phase 3).
- Human action: Brian approves the price list.
- How to change: supersede this ADR with the approved price list reference.
