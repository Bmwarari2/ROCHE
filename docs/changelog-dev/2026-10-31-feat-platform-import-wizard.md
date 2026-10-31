# Phase 2 slice 26, the import wizard API for people (PLAT-014)

Branch `feat/platform-import-wizard`, PR #150.

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

## Review round 1 (security and clinical, #150)

Main merged first (migration 0071 and the afternoon's pull requests; the journal runs 0071 then
0088). The generated client's format step now allows a file past Biome's 1 MiB default, which the
unformatted output had crossed.

- Security H1: a control character or a lone surrogate in any cell is refused at upload, naming the
  row and field (`uploadCellProblem`), before anything is written; a database failure writing
  imported values is rethrown as `ImportWriteFailed`, carrying only its SQLSTATE; main's
  `loggableError` already logs only an error's kind, code and stack frames. A test uploads a NUL
  and a lone surrogate and finds nothing personal logged.
- Security M1: `person.import_batch_id` ties each imported person to its batch, set only as the
  batch commits and never changed (`app.person_import_batch_guard`); `app.undo_import_batch`
  removes only those people and exactly the commit's ids, and reads the undo window from the rate
  table itself (`app.location_rate`).
- Security M2: the CSV reader enforces the row, column and cell limits while scanning.
- Security lows: every import command needs `people.person.create` across the organisation in
  row-level security too (`app.import_reachable(record_type)`); no commit past `expires_at` (route
  and guard); the acknowledgement must list exactly the warnings found; own keys only for fields.
- Clinical H1 (HZ-007): every imported allergy status is `unknown`, confirmed by no one; the dry
  run reports what the file stated and the commit returns those people to check first.
- Clinical H2 (HZ-130): undo is refused once a phone may hold the people (a sync token carrying
  people issued in the organisation from one token's lifetime before the commit). Chosen over
  holding imported people off phones until confirmed: simpler, no sync stream change, and new
  residents are visible at the point of care at once. Recorded in ADR-0092 and H-680.
- Clinical M1: possible duplicates also for different case, accents, apostrophes, hyphens, middle
  names, swapped names, the same family name or the same given name with the date of birth.
- Clinical M2: warnings name the other row or the existing record; the commit's
  `acknowledgedWarnings` must list exactly the keys found now, so a new warning stops it.
- Clinical M3: the dry run says in words what committing does (`whatHappens`); `mayCommit` stays
  false until possible duplicates are acknowledged (`needsAcknowledgement`).
- Clinical lows: 999-range test NHS numbers and 0000000000 are refused unless
  `IMPORT_TEST_NHS_NUMBERS` is on (demonstration and test environments; off by default in
  production); the spec, the report and HZ-001 say imported people have no photo, room or
  placement.
- Docs: platform.md rules 18 to 26, data standards, HZ-007, HZ-130 and HZ-001 in the hazard log,
  the DCB0160 deployer control, ADR-0092 (still proposed), records of processing, H-680, H-682 and
  H-684.
- Tests after the round: `packages/domain/src/platform/imports.test.ts` (80; `imports.ts` 100%
  lines), `packages/db/test/imports.test.ts` (18), `apps/api/test/imports.test.ts` (22), with
  `definer-acls`, `rls-coverage`, `route-gates`, the migration and journal tests, the export
  catalogue, sample data, the export worker and `api.test` passing.
