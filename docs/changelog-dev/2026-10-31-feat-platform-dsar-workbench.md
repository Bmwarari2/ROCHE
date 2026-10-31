# The DSAR workbench (Phase 2 slice 15)

Branch `feat/platform-dsar-workbench`. PLAT-022 and WORK-011 (partial); [ADR-0090](../decisions/0090-dsar-workbench-and-disclosure-collector.md).

## What changed

- Spec: [platform.md](../specs/platform.md) "Phase 2: the DSAR workbench" (data, nine rules,
  permission matrix, test list).
- Schema: `dsar_case` and `dsar_item` (`packages/db/src/schema/data-rights.ts`, migration 0077,
  one SQL file and one journal entry). Forced RLS, the tenant policy and a restrictive policy for
  `quality.dsar.manage` on both tables; composite foreign keys to the person, contact or member of
  staff; checks for one subject of its kind, a representative's authority, the extension, the
  outcome and the redaction; no DELETE; a closed or withdrawn case never changes and takes no new
  items (guard triggers); versions captured. Both tables are in the export catalogue.
- Rules: `packages/domain/src/platform/dsar.ts`: the subject map over the export catalogue, third-party
  name highlights, item decision checks, bundle readiness and redaction, the erasure assessment on
  the retention schedule, portability and new case checks. The clock stays `dsarClock` (slice 9).
- API: `/v1/dsar-cases` (list, create, detail with the clock worked out on read), identity, pauses,
  extension, collect, items, item view with highlights, item decision, bundle (`access` or
  `portable`), respond (records the bundle's SHA-256), rectification and erasure. All need
  `quality.dsar.manage`, now a care-record permission (MFA). Every read and write is audited with
  the case id, counts and opaque ids. OpenAPI document and client regenerated.
- Retention: new class `data_rights_case` (3 years from closure; DPO to confirm, H-613).
- Data protection: records-of-processing.md (new category, B5, note), data-standards.md (new
  section), dsar-procedure.md step 6 (tables not searched), permissions.md regenerated.
- Sample data: a DSAR case stops a sample removal (`BLOCKS_REMOVAL`).
- Human actions H-612 to H-615.

## Tests

- `packages/domain/src/platform/dsar.test.ts` (37).
- `packages/db/test/data-rights.test.ts` (17): cross-tenant denial, permission, shape, closed case.
- `apps/api/test/dsar.test.ts` (16): refusals, clock, collection across modules, highlights,
  decisions, bundle, respond, contacts and staff, rectification, erasure, audit without names.

## Not in this slice

The screens (slice 66), the breach register and data-protection complaints.
