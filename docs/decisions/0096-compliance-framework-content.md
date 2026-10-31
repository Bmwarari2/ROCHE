---
status: "accepted"
date: 2026-10-31
decision-makers: Claude Code (build), Brian (product owner, informed)
consulted: Quality lead at the design partner to review the content and mapping (H-533, H-606)
informed: Brian
---

# Compliance framework content: CQC's single assessment framework as data, version 1

## Context and problem statement

Master prompt 11.2 asks for a data-driven compliance framework: CQC's 5 key questions and 34
quality statements with 6 evidence categories now, a second version for the KLOE-based model when
CQC publishes it (consulted on for end-2026, go-live unconfirmed), and the CIW, Care Inspectorate
and RQIA frameworks for the nation packs. Every mapping is editable by the tenant's quality lead and
versioned so historical audits keep the framework they were scored against. How is the framework
content held, seeded and changed? (Phase 2 plan, slice 14; quality.md sections 17 and 18.)

## Decision drivers

- The framework will change within a year of launch; hard-coding it would date the product.
- A past audit, evidence pack or mapping must be read against the framework of its time.
- The same content for every tenant, so evidence and benchmarking mean the same thing; each
  tenant's own wording and owners on top.
- No personal data in reference tables; nothing a tenant can quietly edit in the shared content.

## Considered options

- Global versioned tables seeded by migration, read-only to the application, with tenant mappings
  as append-only versions on top.
- A copy of the framework per tenant, editable by each tenant.
- The framework as code (constants in `packages/domain`).

## Decision outcome

Chosen option: "global versioned tables seeded by migration, with tenant mappings on top", because
it is the only option where a past audit keeps its framework, every tenant shares the regulator's
content, and a new framework is a data change.

1. **Tables.** `framework_version` (key, regulator, version number, state `draft`, `published`,
   `retired`, published and retired dates, the source name, provision and https link),
   `framework_key_question`, `framework_statement` and `framework_evidence_category`, all keyed by
   the version. No tenant column: global reference data with forced RLS, a read policy for every
   role and writes only by the owner role in migrations (as `bank_holiday`).
2. **Version 1.** CQC's single assessment framework as published, seeded by migration 0076: the
   key questions `safe`, `effective`, `caring`, `responsive`, `well-led` (the ids the evidence pack
   screens already send), 34 quality statements with ids `<key question>.<statement in
   snake case>` and the 6 evidence categories, with the CQC page as the source. Titles and the
   published date are checked against the CQC page before a live tenant relies on them (H-606).
3. **Immutable once published.** A published version's content never changes (a database guard
   refuses it even for the owner role); a version only moves draft to published to retired. A
   KLOE-based model, a CQC revision or a devolved framework is a new version, published by a
   migration, and the old one retired on the day the new one takes effect.
4. **Tenant mappings.** `framework_mapping`, append-only, one row per mapping version per framework
   version (the next number, checked by the database), naming only that version's statements and
   evidence categories: the tenant's own title, the owner role, the evidence expected. The quality
   lead (`quality.evidence.manage`) makes them; `mappingAt` reads the mapping of any moment.
5. **Evidence links.** `evidence_link` tags any record (by type and id, never its content) against
   statements of a published version, read in the tagger's scope, removed with a reason rather than
   deleted. The evidence pack takes its statement ids (statements or key questions) from the
   version in force.

### Consequences

- Good, because the KLOE change is a migration with new rows, not a code change, and every past
  audit, mapping and link still points at the version it used.
- Good, because tenants cannot alter the regulator's words; their own wording lives in the mapping.
- Bad, because a framework change needs a release (a migration), not a screen; acceptable, as CQC
  changes its framework rarely and publicly.
- Neutral, because statement ids are Harbour's (snake case of the title); a later CQC numbering can
  be added as another column without changing them.

### Confirmation

`packages/db/test/quality-framework.test.ts` (the seeded counts; read-only global tables; a
published version's content fixed; mappings append-only and numbered next; links naming real
statements; cross-tenant denial), `apps/api/test/quality-framework.test.ts` (the API and the evidence
pack taking ids from the framework), `packages/domain/src/quality/quality-framework.test.ts`.

## More information

Related: [quality.md](../specs/quality.md) sections 17 and 18, ADR-0050 (evidence pack links),
ADR-0002 (row-level security). Revisit when CQC publishes the KLOE-based framework (a version 2) or
the Phase 7 nation packs load CIW, Care Inspectorate and RQIA frameworks.
