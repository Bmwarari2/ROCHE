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

## Security review (#149)

- H1: only an organisation-wide role runs a case (API, and RLS with
  `holds_role_permission_at(..., NULL)`); a location-scoped manager is refused.
- H2: step-up on the item view, the bundle and the response.
- M3: each decision stores the SHA-256 of the record as opened (`dsar_item.content_sha256`); a
  record changed since goes back to pending; the issued bundle is kept in the exports bucket
  (`dsar_case.bundle_storage_key`, ids-only key) and fetched again at
  `GET /v1/dsar-cases/{id}/bundle/issued` (step-up). A streaming route rather than a signed URL, as
  for the full export: the storage port signs nothing.
- M4: identity enforced before the bundle or a "done" response, in the API and by the check
  `dsar_case_identity_first`.
- M5: highlights cover every person, contact and member of staff except the subject, and JSON
  fields.
- M6: the request shape is refused by the contract and the domain check before the database, and a
  check violation is answered with a 422; main's `loggableError` keeps query values out of logs.
- L7: the closed-case guard ignores only housekeeping columns; an item never moves case. L8: the
  restrictive policies cover `harbour_owner`. L9: organisation-wide reads say so in audit, and item
  views are also recorded against the subject.

## After the review

- Tables not searched are named with a reason (`no_subject_column`, `member_scoped`) and what to do,
  on the case view, the collect result and the bundle's cover. `DSAR_MEMBER_SCOPED_TABLES` names
  searched tables whose read policy depends on the member; a database test derives them from
  `pg_policies` and fails if one enters the subject map undeclared (none today). Follow-up: a
  definer-based collector (ADR-0090).
- The organisation's own system context reads DSAR cases and items, so the free full export
  includes them (export test); it writes none.

## Tests

- `packages/domain/src/platform/dsar.test.ts` (37).
- `packages/db/test/data-rights.test.ts` (17): cross-tenant denial, permission, shape, closed case.
- `apps/api/test/dsar.test.ts` (16): refusals, clock, collection across modules, highlights,
  decisions, bundle, respond, contacts and staff, rectification, erasure, audit without names.

## Not in this slice

The screens (slice 66), the breach register and data-protection complaints.
