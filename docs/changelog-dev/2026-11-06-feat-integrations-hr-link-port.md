# Thapsus-HR link: port, mock and rules

Branch `feat/integrations-hr-link-port` (Phase 2 slice 86; INTG-014; ADR-0126; integrations.md
section 11). No migration.

## What changed

- **Domain rules** (`packages/domain/src/integrations/thapsus-hr.ts`), table-driven: the owner of
  each kind of staff data (care-specific records and clocking stay with this product); the link
  refused outside the UK (home region `uk`, the UK host, HTTPS); matching by employee number, then
  work email with date of birth, never by name; the outbound field allow-lists (nothing about
  people receiving care) and absences taken as dates and type only; staleness at the limit and
  one minute past (15 minutes by default, at most 60); a leaver's sign-in ending with their
  leaving day; the double-payment guard. The partner kind is `thapsus_care`.
- **Port and mock**: `ThapsusHrPort` and a no-network mock pinned to Thapsus-HR commit d9888cef,
  as ADR-0126 records it, with the Phase 19 capabilities (K1 to K7) answering "planned"; a contract
  test, and a test to re-pin when Phase 19 ships.
- **Hazard HZ-133** in the hazard log with its controls and tests.

## Left

- The mock follows the facts ADR-0126 records at d9888cef; it is checked against Thapsus-HR's
  published OpenAPI document and re-pinned to its main when this session can read that repository.
- H-1340 to H-1345 are unchanged.
