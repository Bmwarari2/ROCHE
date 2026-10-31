# Slice 19: audit programme and mock inspections (QUAL-004)

Branch `feat/quality-audit-programme`, stacked on `feat/quality-framework-library` (slice 14).

## What changed

- Database, migration 0081 (self-contained, forced RLS on every table):
  - `audit_starter_template`: global, read-only to the application. Seven starters are seeded
    (medication, care plans, IPC, environment, dignity, night visit, mock inspection; 36
    questions), mapped to statements of framework version 1. The IPC starter is the one slice 31
    uses.
  - `audit_template`: the organisation's scored templates. Needs `quality.audit.manage` anywhere.
    The framework version must be published, the key is fixed, and retiring is final.
  - `audit_schedule`: one per template and location, every 1 to 60 months.
  - `audit_record`: scoped by location. The database copies the template's questions, version and
    framework version when the audit starts, and the audit keeps them for good. The template,
    framework, place and date never change. Only completion records the self-rating, and a
    completed audit never changes.
  - `audit_action`: append-only, only on a question of a completed audit, by the person who
    completed it, due on or after the audit.
  - Export catalogue entries for all five tables.
- API, all `quality.audit.manage` and audited, refusals included:
  - Templates: starters; templates from a starter or the organisation's own, checked by
    `checkAuditTemplate`; change and retire.
  - Schedules: next due date and overdue on the UK date.
  - Audits: start; save answers; read with the score, the method in words, findings by statement,
    whether the framework version is still in force, and the self-rating with its CQC words.
  - Completion: checked by `checkAuditCompletion`, with the rating scale from the rate table.
    Each action's due date defaults to `quality.audit.action_due_days` after the audit, and each
    action raises an owner's task (`quality.audit_action`).
  - Mock inspections start only against the framework version in force (409 otherwise). Past
    audits keep the version they were scored against.
- Completed audits can be tagged as evidence (record type `audit`). OpenAPI and the client are
  regenerated.
- No web screens; those come in slice 64.

## Docs

- quality.md section 19: schema, permissions, API and tests.
- data-standards rows for the three record tables.
- Feature register: QUAL-004 paths.
- HZ-011: verification row for the location-scope test.
- Medical-device boundary re-checked and unchanged. An audit score measures the service against
  its own template. No rating is worked out from a score: the self-rating is a person's judgement.
- No personal data about people receiving care. Staff appear as user ids only. Records of
  processing are unchanged.

## Human actions logged

- H-760: review the starter templates.
- H-761: confirm the IPC starter for slice 31.
- H-762: whether action owners without `quality.audit.manage` may complete their task.
- H-763: audits in progress across a framework change.
- H-764: starters for the devolved nations.
- H-765 to H-769 are reserved for review rounds.

## Tests

- `packages/db/test/quality-audits.test.ts`: 8 tests.
- `apps/api/test/quality-audits.test.ts`: 16 tests.
- `rls-coverage.test.ts`: lists `audit_action` as append-only.
