---
status: accepted
date: 2026-10-11
decision-makers: Brian (Thapsus Cargo Ltd, Appendix default); recorded by Claude Code
---

# Payroll partner: Xero Payroll first

## Context and problem statement

Harbour integrates payroll rather than building it (section 12). Approved timesheets and pay elements
go to a payroll product. Which payroll product is integrated first?

## Decision drivers

- A documented public API.
- Common use among small and medium care providers.
- The export interface must accept further providers without changing the pay rules engine.

## Considered options

- Xero Payroll.
- Staffology.
- Sage.
- BrightPay.

## Decision outcome

Chosen option: "Xero Payroll first", because it is the Appendix default and its API is documented.
Staffology, Sage and BrightPay follow behind the same `integrations` payroll export interface, with a
file export for any provider without an API.

### Consequences

- Good, because the first integration targets a documented API with a sandbox.
- Bad, because tenants on other payroll products use the file export until their adapter ships.
- Pay calculations stay in Harbour (NMW checks, holiday accrual, SSP) and show their working; payroll
  receives approved, reproducible figures.

## More information

- Takes effect: Phase 2.
- Human action: Xero developer app registration and per-tenant OAuth connection.
- How to change: supersede this ADR naming the first provider; only adapter order changes.
