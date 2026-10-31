# Phase 2 slice 14: compliance framework and evidence library (QUAL-001, QUAL-002)

Branch `feat/quality-framework-library`, stacked on #138 (slice 8). Lane E. Migration 0076 (the
file number the plan gives slice 14; the lead renumbers at merge if needed).

## What changed

- Spec: [quality.md](../specs/quality.md) section 18 (schema, permissions, API, tests), before the
  code; [ADR-0096](../decisions/0096-compliance-framework-content.md) for the framework content.
- Schema (`packages/db/src/schema/quality-framework.ts`, migration 0076, one self-contained file):
  global `framework_version`, `framework_key_question`, `framework_statement` and
  `framework_evidence_category` (no tenant; forced RLS, read by every role, written only in
  migrations; a published version's content never changes, even for the owner role); tenant
  `framework_mapping` (append-only, numbered next, naming only the version's statements and
  categories) and `evidence_link` (statements of a published version, in the tagger's name, then
  only removable once with a reason; no delete), both for holders of `quality.evidence.manage`.
  Seeds version 1: CQC's single assessment framework, 5 key questions, 34 quality statements and 6
  evidence categories, with the CQC page as source.
- API (`apps/api/src/routes/quality-framework.ts`): framework versions and content; the
  organisation's mapping by version and by moment; evidence links (tag in the tagger's scope, list
  by record or statement, remove with a reason); coverage with gaps. Audited, refusals included.
  The evidence pack now takes its statement ids from the CQC version in force (key question or
  statement ids; unknown ids refused with the ids named), so the #113 screens keep working.
  Contracts in `packages/contracts/src/quality-framework.ts`; OpenAPI and the client regenerated.
- Export catalogue entries for the six tables; data standards rows.
- Domain unchanged apart from the export catalogue; the rules are slice 8's.

## What is next

- Slice 64 (web: framework, mapping editor, evidence tagging). Slices 18, 19, 25 and Phase 3 add
  compliments, audits, policies and surveys to the taggable record types.

## Human actions logged

- H-606 (check version 1 against CQC's page and record the date), H-607 (the KLOE version when
  CQC publishes it).

## Tests

- `packages/db/test/quality-framework.test.ts` (13; HZ-011), `apps/api/test/quality-framework.test.ts`
  (17), the evidence pack API tests on version 1's statement ids (44 with the PDF and statement of
  purpose tests); `rls-coverage.test.ts` lists `framework_mapping` as append-only.
