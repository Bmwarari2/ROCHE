# Slice 13 search part 1, the search index (PLAT-013)

Branch `feat/platform-search-schema`, PR #91.

## What changed

- Migration 0066 (after 0065, the sub-processor notices): `app.search_terms` (equal to the domain's
  `searchTerms`), `app.search_vector`, the `app.harbour_search` configuration, and generated vectors
  on `person` (names, room), `tenant_user` (display name), `document` (title and file name) and
  `care_note` (text), declared in the Drizzle schema and internal in the export catalogue. No GIN
  index: the app role could not use one under forced RLS (ADR-0070 as built).
- Docs: platform-completions.md section 10s, ADR-0070, HZ-011, the register, data standards,
  STATUS.

## What is next

- The search route (#93), the search page (#94), then break-glass search with
  `break_glass_event.kind`.

## Human actions logged

- H-380 (DPO): the search vectors are plain-text copies beyond crypto-shredding.

## Tests

- `packages/db/test/search-index.test.ts` (24).

## Review rounds

- Round 1: a lock note and `lock_timeout` in the migration, and a search-index runbook
  (maintenance window for live tenants, the batched alternative, rebuilding the vectors after a
  Postgres upgrade); the vectors recorded as plain-text copies beyond crypto-shredding (ADR-0070,
  retention-and-deletion.md, H-380) and in records of processing; the redundant NHS number index
  removed; document title tests across tenants and scopes.
- Main merged after 0065: the journal and snapshot regenerated with drizzle-kit; this entry moved
  here from `docs/CHANGELOG-DEV.md` (ADR-0073).
