# Phase 2 slice 26, the import wizard API for people (PLAT-014)

Branch `feat/platform-import-wizard`, no pull request yet.

## What changed

- Spec first: platform.md "Import wizard: schema and API (slice 26, ADR-0092)" with the schema, the
  permission matrix, rules 18 to 26 and the test list.
- Domain, `packages/domain/src/platform/imports.ts`: reading a CSV file (RFC 4180, byte order mark,
  blank lines, limits), matching columns to fields by mapping, key or label and refusing the rest by
  position only (a file without a header row would make a person's details the headings), the people
  rules (an NHS number or a local identifier, dates of birth from 1900, the postcode, control
  characters, a local identifier on one row), matching against people already in the organisation
  without ever merging (HZ-130), the dry-run report with the rows imported with allergy status unknown
  and those with allergies to record (HZ-007), the commit check, and the staging expiry and undo
  deadline from the rate table.
- Schema, migration 0088 (one file with its security SQL): `import_batch`, `import_row` (staged rows
  in quarantine) and `import_commit`, each with `tenant_id`, forced row-level security, the tenant
  policy and a restrictive policy reaching them only for a holder of `platform.import.run` across the
  organisation in a request scoped to it, or a job with no member. A guard moves a batch forward only;
  staged rows are insert-only and deleted by `app.import_batch_closed` in the transaction that commits,
  discards or expires their batch; `app.undo_import_batch` removes a commit's people whole or not at
  all while they are unchanged and nothing refers to them. Both are owned by the new no-login role
  `harbour_import_owner` (bootstrap; H-684). Export catalogue: batches and commits exported (audit
  class), staged rows not exported.
- API, `apps/api/src/routes/platform-imports.ts`: `POST /v1/imports` (CSV or JSON rows with a
  mapping), `GET /v1/imports`, `GET /v1/imports/{id}`, `POST /v1/imports/{id}/dry-run`,
  `POST /v1/imports/{id}/commit` (whole, step-up, idempotent, possible duplicates acknowledged),
  `POST /v1/imports/{id}/undo` (once, within `import.undo_window_days`, step-up) and
  `DELETE /v1/imports/{id}` (discard). Every route needs `platform.import.run` (reused from the
  catalogue, now a care-record permission) and `people.person.create`, both across the whole
  organisation; anyone else gets one answer, `organisation_wide_required`, before the request is
  read, so matching never tells anyone whether a person at another home exists, and another
  organisation's people are never read. People are created `active` at the batch's location. Audited
  with ids and counts only: `platform.import.uploaded`, `.read`, `.dry_run`, `.committed`,
  `.undone`, `.discarded`, `.expired`, and `people.person.imported` per person. An hourly
  `import-expiry` job expires staged batches. OpenAPI and the typed client regenerated.
- Rates: `import.staging_expiry_days` (7, `to-verify`, a data-minimisation default).
- Clinical safety: HZ-130 added (every code control has a `hazard HZ-130` test); HZ-007's import
  control built; HZ-001's duplicate check on import built; HZ-072 gains the import path's test. The
  medical-device boundary was re-checked: the import stores, validates and matches identifiers, with
  no clinical inference, score or recommendation; no change to the boundary document.
- Data protection: records of processing (the import row and a note), data standards (the import
  contract), retention (staged rows deleted at commit, discard or expiry, at most
  `import.staging_expiry_days` after upload; batches and commits audit class).
- ADR-0092 (proposed: the CSO and the DPO accept it, H-680 and H-681).

## What is next

- Slice 67: the web wizard (mapping beside the file's first rows, the report in words, commit, undo).
- Contacts, allergies and staff imports (matched to their person by identifier only), and the round
  trip with the full export (HZ-071: the export's `YYYY-MM-DD` dates and column names through a JSON
  or export-format mapping keeping `import_source_id`).
- Migration 0088 merges after the lower Phase 2 numbers; the lead renumbers at merge time if needed.
- Human actions H-685 to H-689 are spare.

## Human actions logged

- H-680 (CSO): HZ-130 and ADR-0092's clinical decisions.
- H-681 (DPO): the staging period, retention and R26 measures.
- H-682 (tenant): check the source export, sign off a sample after committing.
- H-683 (Brian, CSO, DPO): whether home-scoped importing is wanted.
- H-684 (engineering): `pnpm db:bootstrap` before migration 0088 in every environment.

## Tests

- `packages/domain/src/platform/imports.test.ts` (64, table-driven; domain coverage 99.67% lines,
  `imports.ts` 99.64%), `packages/db/test/imports.test.ts` (13), `apps/api/test/imports.test.ts`
  (18), with `definer-acls`, `rls-coverage`, `migration-journal`, `migrations`, `isolation`, the
  export catalogue and `route-gates` passing.
