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

## Human actions logged

- H-1624 (re-check past DSARs), H-1625 (opaque id lists in tables classed non-personal).

## Tests

- `packages/domain/src/platform/dsar.test.ts`: new block, 6 tests (declared kinds, never by name,
  never secret or non-personal, the real catalogue's searched lists).
- `packages/db/src/export-catalogue.test.ts`: one test per `uuid[]` column (26), plus two.
- `apps/api/test/dsar.test.ts`: a person named only in `incident.person_ids` gets that incident
  collected (fails without the `@>` match).
