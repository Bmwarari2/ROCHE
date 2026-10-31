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

## Review rounds

- Round 1 (security reviewer agent):
  - Schedules and audits now have foreign keys to the organisation's own locations. Actions have
    a foreign key to the organisation's members. The task points back to the audit through its
    source rather than a key, so removing sample data can still delete tasks.
  - Action owners must be active members who hold `quality.audit.manage` at the audit's location,
    the rule the task engine applies to any assignee. Otherwise the request is refused and the
    refusal audited.
  - The database ties the stored score to the answers: no score while in progress, answers fixed
    in the completing statement, every question answered, points worked out by the database.
  - A duplicate schedule gets its own message. A foreign key race is audited and returns 409.
  - The self-rating's scale stays in the API, from the rate table, so it is not a literal in SQL.

## Human actions logged

- H-760: review the starter templates.
- H-761: confirm the IPC starter for slice 31.
- H-762: whether action owners without `quality.audit.manage` may complete their task.
- H-763: audits in progress across a framework change.
- H-764: starters for the devolved nations.
- H-765 to H-769 went to slice 31.

## Tests

- `packages/db/test/quality-audits.test.ts`: 9 tests.
- `apps/api/test/quality-audits.test.ts`: 16 tests (an owner who cannot take the task is refused).
- `rls-coverage.test.ts`: lists `audit_action` as append-only.
