# Thapsus-HR link added to the plan (INTG-014)

Branch `docs/plan-thapsus-hr-link`.

## What changed

- The owner asked for Harbour to connect to Thapsus-HR, so that a provider using both doesn't
  export shifts, rotas, time, pay or staff records between them.
- [ADR-0126](../decisions/0126-thapsus-hr-link.md) gives each kind of data one owner per tenant,
  and the other system holds a read-only copy:
  - **Thapsus-HR owns** employee records, leavers, pay rates, leave and sickness.
  - **Harbour owns** care shifts, clocking, timesheet approval and pay units, recruitment, DBS,
    training and competence.
- The link is UK only, never sends data about the people supported, and is off by default.
- [integrations.md](../specs/integrations.md#11-thapsus-hr-link-intg-014) section 11 is the full
  specification: flows, schema, permissions, rules, API, data protection, tests, and the changes
  Thapsus-HR needs.
- New register row INTG-014 (234 rows; 60 in Phase 2).
- [phase-2.md](../plans/phase-2.md) gains:
  - slices 86 to 90, with migration 0139 and 0140 if needed;
  - hazard HZ-133;
  - DPIA risk R30;
  - a gate item.
- Human actions H-1340 to H-1345 are logged, each with its recommended answer.

## What is next

- Slice 86: the port, a contract mock built from Thapsus-HR's OpenAPI document, and the domain
  rules. This starts after the Phase 2 rota, time and pay slices (21, 30 and 36) have merged.
- Thapsus-HR needs:
  - events for shifts, leave, sickness and timesheets;
  - shifts and clock events owned by a partner;
  - a pay inputs route;
  - a narrow pay-rate read.
  Until they ship, only employees, leavers, locations, leave and sickness can go live (H-1343).
