# DSAR searches id lists (PLAT-022)

Branch `fix/platform-dsar-array-subjects`, PR to follow. Label `data-protection`; not clinical.

## What changed

- The DSAR subject map (`dsarSubjectMap`) now searches `uuid[]` columns that the export catalogue
  declares as holding a kind of subject. The declaration is a new column field, `idArray`:
  `{ holds: "person" | "contact" | "staff" }`, or `{ holds: "no_subject", why }`. The catalogue is
  the one source of truth the collector already used; an id list is never guessed from its name.
- Searched today: for a person, `incident.person_ids`, `downtime_pack.person_ids` and
  `evidence_pack.person_ids`; for staff, `compliment.staff_ids`, `interview.panel`,
  `evidence_pack.editor_ids`, `evidence_pack_item.redacted_by`, `feed_item.staff_shown` and the
  `contributor_ids` of `dependency_scale_version`, `letter_template_version` and
  `statement_of_purpose_version`. `evidence_pack_item.redacted_by` had been compared as a single
  id (by its `_by` name) and never matched.
- Declared but not searched, because the catalogue classes their tables as holding no personal
  data: `import_commit.record_ids` (person), `dpia.prepared_by`, `pay_rule_set.contributor_ids`
  and `homely_remedy_protocol.authorised_member_ids` (staff); H-1625.
- Declared as holding no one's ids: location, document, medicine, body-map mark, property item,
  care plan change and care entry id lists, and `destruction_certificate.subject_ids` (documents
  or the tenant on `main`).
- The collector (`apps/api/src/services/dsar.ts`) matches a declared list with
  `col @> ARRAY[$id::uuid]`, which a GIN index serves (checked with `EXPLAIN`; `= ANY` is not
  index-backed). Migration 0162 adds GIN indexes on the ten searched lists that had none
  (`incident.person_ids` already had one).
- A coverage test in `packages/db/src/export-catalogue.test.ts` enumerates every `uuid[]` column in
  the Drizzle schema and fails unless it declares `idArray`, and unless a list a DSAR searches has
  a GIN index; `idArray` is refused on any other column.
- Docs: platform.md DSAR rule 3 and its test list, records of processing (B13 note), data
  standards (`dsar_case.not_searched`), feature register PLAT-022. No hazard-log change: not a
  clinical feature.

## What is next

- #220 adds `destruction_batch_item.subject_ids` (person or applicant ids). When both are on
  `main`, the coverage test fails until that column declares `idArray`; declare it `person` (and
  add a GIN index) if its table is classed personal, or say why not. Applicants are not yet a DSAR
  subject kind.
- H-1624: whether DSARs answered before this fix are re-checked.
- Items decided before this change hash differently once cut to the subject's part, so they go
  back to pending for review (the #149 M3 rule); none exist before go-live.

## Human actions logged

- H-1624 (re-check past DSARs), H-1625 (opaque id lists in tables classed non-personal).

## Tests

- `packages/domain/src/platform/dsar.test.ts`: new block, 6 tests (declared kinds, never by name,
  never secret or non-personal, the real catalogue's searched lists).
- `packages/db/src/export-catalogue.test.ts`: one test per `uuid[]` column (26), plus two.
- `apps/api/test/dsar.test.ts`: a person named only in `incident.person_ids` gets that incident
  collected (fails without the `@>` match); security review: four more (downtime pack page, staff
  lists and the `redacted_by` regression, another organisation's row, a record found twice).
- `apps/api/test/disclosures.test.ts`: a disclosure shows only the person's downtime pack page.
- `packages/domain/src/platform/dsar.test.ts`: security review, 14 more (`dsarRecordForSubject`).

## Security review

Nothing blocking on injection, tenancy or row-level security. Fixed on top of bd99eaa8:

- Medium: `downtime_pack.person_ids` made a resident's DSAR (and a disclosure, which shares the
  collector) collect every pack at their home, each holding every resident's emergency page in one
  `content` column that field redaction cannot split. `recordsOf` now takes the subject's id and
  applies `dsarRecordForSubject` (domain, pure): a downtime pack keeps only the subject's pages,
  warnings and exclusion, and counts of their own warnings, so a member of staff found through
  `generated_by` sees no pages. Same review for the other searched tables: an interview found
  through its panel drops `scores`, `notes` and `recommendation` (the applicant's assessment, not
  the panel member's data); an evidence pack holds metadata only (its id lists are cut, below); an
  evidence pack item hides other redactors in `fields`. A saved earlier version (`record_version`)
  is cut by its own table's rules.
- Low: every declared id list is cut to the subject's own id (empty when they are not in it).
- Low: API tests for a staff list (`compliment.staff_ids`), the `evidence_pack_item.redacted_by`
  regression, another organisation's incident naming the same person (not collected), the
  downtime pack page and the same through a disclosure (`apps/api/test/disclosures.test.ts`).
- Low: `collectRecords` no longer counts a record found by two columns twice against the item
  limit (each later query of a table leaves out the ids already found).
- Info: migration 0162 says why its GIN indexes are built inside the transaction, not
  `CONCURRENTLY` (small tables before go-live; a live rebuild would use `CONCURRENTLY`).
- Info: `import_commit.record_ids` describes itself precisely (people are the only import type).
- Records of processing (B13 note) and platform.md rule 3 say what a DSAR now shows of these
  records. No new human action: the projection is option (a).

