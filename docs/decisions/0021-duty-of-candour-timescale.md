---
status: accepted
date: 2026-10-11
decision-makers: Brian (Thapsus Cargo Ltd, Appendix default); recorded by Claude Code
---

# Duty of candour: written notification target is tenant-configurable, 10 working days by default

## Context and problem statement

Regulation 20 of the Health and Social Care Act 2008 (Regulated Activities) Regulations 2014 requires a
provider, after a notifiable safety incident, to notify the relevant person in person and then in writing
"as soon as reasonably practicable". The regulation sets no fixed number of days. A 10-working-day
written notification timescale is common in guidance and contracts, but the research could not confirm
it from an opened page (section 21, items not confirmed; Appendix, open questions). The candour workflow
(section 11.1) needs a deadline clock.

## Decision drivers

- The regulation wins over any product default; the product must not present a target as the law.
- Managers need a visible clock so notifications are not forgotten.
- Commissioner contracts and tenant policies may set a shorter target.

## Considered options

- No clock: record the dates only.
- A fixed 10-working-day statutory-looking deadline.
- A tenant-configurable service level target, starting at 10 working days, labelled as a target under
  "as soon as reasonably practicable".

## Decision outcome

Chosen option: "Tenant-configurable target, 10 working days by default", because it gives managers a
clock without misstating the regulation.

- The rate table holds `candour.written_notification.working_days` = 10 with status `to-verify`
  (`docs/specs/rates.md`); tenants may set a shorter value.
- The UI wording is "Target: written notification within N working days. The law requires notification
  as soon as reasonably practicable." It never says "statutory deadline".
- The clock starts when the incident is assessed as a notifiable safety incident; working days are
  computed in Europe/London with bank holidays for the location's nation.

### Consequences

- Good, because managers see a countdown and the record shows whether the target and the legal duty
  were met.
- Bad, because a tenant may read 10 working days as safe even when sooner was practicable; the wording
  above and the escalation log mitigate this.

## More information

- Takes effect: Phase 1 (incidents with the candour workflow).
- To verify: Brian confirms the timescale to encode (Appendix open question). If CQC guidance or a
  regulation sets a fixed period, the regulation wins and this ADR is superseded.
- How to change: supersede this ADR or change the tenant setting.
