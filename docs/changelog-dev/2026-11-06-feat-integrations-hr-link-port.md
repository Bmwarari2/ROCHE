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

## Reviews

- Security reviewer: no critical or high findings. Fixed: the UK check now runs on the URL the
  adapter really sends to; the mock enforces the allow-lists, refuses nested values and keeps
  idempotency keys per route for 24 hours, answering conflict for a reused key with another body;
  staleness ignores an out-of-range limit and distrusts a sync in the future; absence ids and dates
  are checked; credentials in the URL are refused.
- Clinical safety reviewer: request changes, all fixed. Two different employee numbers never match
  through email and date of birth; a leaving date that is not a real day refuses sign-in, and a
  sync that drops or moves a leaving date later never restores access; pay units to Thapsus-HR are
  guarded as well as the export, and a pay route changes only from a later period; the rota stays
  with this product until slice 88's checks exist.

## Left

- The mock follows the facts ADR-0126 records at d9888cef; it is checked against Thapsus-HR's
  published OpenAPI document and re-pinned to its main when this session can read that repository.
- H-1340 to H-1345 are unchanged. For the CSO: rate HZ-133 (H-1345), confirm the staleness limit
  (H-1344), and decide whether a provider may make Thapsus-HR the rota owner once slice 88 ships.
