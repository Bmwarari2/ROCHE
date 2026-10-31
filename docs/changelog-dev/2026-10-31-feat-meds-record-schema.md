# Medicines record and reconciliation: tables and API (Phase 2 slice 16)

Branch `feat/meds-record-schema`, from `main` with #135 (the slice 2 rules). MEDS-001.

## What changed

- **Migration 0111** adds six tables: `medication` (one row per version), `medication_schedule`,
  `medication_reconciliation`, `_source`, `_item` and `_decision`.
  - Forced RLS by tenant and the person's scope, and no DELETE for the application.
  - What a version says never changes. The second check, stop, replacement and withdrawal are
    set once each; a stop is replaced only by an earlier one.
  - A new version replaces an earlier one of the same medicine and dm+d product, takes the next
    number, and is born not yet checked. A unique key makes `expectedVersion` hold under
    concurrency.
  - Times are written with their entry. A completed reconciliation is frozen.
  - The export catalogue and the sample removal list include the tables.
  - The journal entry's `when` is above every entry; the 0111 snapshot is complete, so the next
    generate starts from the whole schema.
- **dm+d**: codes are stored as validated identifiers with no foreign key yet. A test fails once a
  VMP table exists, until an expand step adds the key.
- **API** (`/v1/people/{id}/medicines`, `/v1/medicines/{entryId}/...`,
  `/v1/people/{id}/mar`, `/v1/people/{id}/medicine-reconciliations/...`):
  - Every write goes through the slice 2 rules, with every version passed and the time of
    recording used.
  - A reconciliation completes only when `completeReconciliation` passes. Its plan is applied in
    one transaction at `completedAt`, and a return's `medicines_reconciled` check and task are
    completed.
  - Audit and outbox carry ids and counts only.
- **Ports**: medicines competence (workforce, slice 17) and dm+d facts (slice 10). In production
  both fail closed (nobody competent, no product known). Development and tests use a fixture of
  four invented products and a fixed competence map.
- **Clinical-safety and security review fixes**:
  - Every write for a person takes a per-person advisory lock first, so parallel requests are
    tried one after the other; database refusals map to 409 or 422 in words.
  - Product, route and unit names are dm+d's, looked up by code, never the request's; the fixture
    refuses AMPs it cannot vouch for, and completion says when dm+d does not hold a product.
  - Composite keys tie every document, source, line, decision and made entry to one person; the
    API also refuses a document that is not this person's, not available or deleted.
  - A withdrawn version gives the medicine back to the one before it: the replacement may move
    to a later version only then, and never to a later time.
  - Refused checks and completions are audited outside the refused transaction.
  - The return's `medicines_reconciled` check cannot be ticked by hand; completing the
    reconciliation locks the transfer row before marking it.
  - `MEDICINES_FIXTURES` turns the fixtures on explicitly (default on outside production);
    production refuses it.
  - Each MAR dose carries its entry's status in words.
  - Only retention (a non-app role) may mark a completed reconciliation deleted.
- **Docs**:
  - medicines.md section 12;
  - the hazard log (HZ-001 to HZ-005, HZ-121);
  - records of processing B1, and data standards (the dm+d fields);
  - the medical-device boundary, re-checked;
  - the feature register and STATUS.

## Human actions logged

- H-1020 (CSO): the unchecked policy default, the admission time, transfers without an event
  record, and production refusing checks until the competence port exists.
- H-1021 (DPO): reconciliation sources and notes naming third parties.
- H-1022 (CSO): the rollout order (dm+d and competence first, paper MAR until the eMAR, a
  reconciliation for every resident on switch-over).
- H-1023 (CSO): returns without a transfer record; the return check done only by reconciliation.
- H-1024 (CSO): when an admission needs reconciling, and escalation while outstanding.

## Tests

- `packages/db/test/medicines-record.test.ts` (19): isolation and person scope, write-once
  columns, versions, the withdrawal case, cross-person documents, schedule times, no deletion,
  frozen reconciliations, dm+d codes (VMP and AMP tripwire).
- `apps/api/test/medicines.test.ts` (25): transcription, refusals, the second check and
  competence, changes with stale and concurrent versions, dm+d names, parallel transcriptions,
  the MAR with each dose's status, stops, audit without content, reconciliation end to end
  including a stop and a return from hospital (check refused by hand, task closed), refusal
  audits kept, the ports failing closed.
- `apps/api/test/config.test.ts`: `MEDICINES_FIXTURES` refused in production.
- Database, API and domain suites; Biome and typecheck.
