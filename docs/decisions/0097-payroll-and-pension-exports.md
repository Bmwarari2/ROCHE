---
status: "accepted"
date: 2026-10-31
decision-makers: Claude Code (Phase 2 lane, slice 76), on the plan's default and the H-520 recommended answer
consulted: master prompt sections 12.3 and 15.3; ADR-0013; docs/plans/phase-2.md (ADR block); docs/plans/recommended-answers.md (H-520)
informed: Brian, the DPO (review at testing)
---

# Payroll and pension exports

## Context and problem statement

Harbour calculates pay but does not run payroll (ADR-0013). A locked pay run's figures have to
reach the organisation's payroll product: Xero Payroll UK first, then Staffology, Sage or BrightPay.
Pension auto-enrolment is the employer's own duty with its provider. The questions are:
- what leaves Harbour;
- when, and on whose say;
- how an export can be checked later;
- whose processor the payroll provider is.

## Considered options

- Push every locked run to the provider automatically, from the `scheduling.pay_run_locked` event.
- Export only when a holder asks, with step-up, through a port (an API adapter or a file), keeping a
  record and a hash, not the file.
- Keep a copy of every exported file in Harbour.

## Decision outcome

Chosen option: export only on request, through the port, keeping a record and a hash, not the file.

- Only a locked run's current calculation leaves Harbour. It leaves only when a holder of
  `finance.payroll.export` across the organisation, who also reads pay, asks for it, with a fresh
  sign-in. `finance.payroll.export` becomes a step-up permission.
- What leaves is the payroll reference, the hours, each pay element, the total, the holiday accrued
  and the pension auto-enrolment flags (category and qualifying earnings). Never a name, date of
  birth, NI number, bank detail, health information or the working.
- Each export records its format, line count and the SHA-256 of what was produced. The file is made
  again, identically, from the locked run. A re-export is allowed, but needs confirming and is
  flagged.
- Xero Payroll UK is reached through `XeroPayrollAdapter`, with OAuth tokens in the managed secret
  store under a reference the connection holds. Only a contract-tested mock exists until the
  developer app is registered (H-518, H-1190). The other providers get file exports whose layouts
  are to verify (H-519, H-1191).
- No pension provider is called. The flags are for the organisation's own pension process.
- **Processor role (H-520 recommended answer):** the organisation's payroll provider is the
  organisation's own processor, under its own contract, not a Thapsus sub-processor. Harbour
  transmits on the organisation's instruction. The sub-processor register says so, and the DPO
  confirms it at testing.

### Consequences

- Good:
  - nothing reaches payroll without a person deciding it;
  - an export can always be checked against the locked run;
  - Harbour keeps no second copy of pay data.
- Bad:
  - the organisation must remember to export;
  - the file layouts may need small changes once each provider confirms them.
