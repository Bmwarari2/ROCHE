# A task completed directly cites real evidence about its own person (HZ-029)

Branch `fix/api-task-transition-evidence`.

## What changed

- `POST /v1/tasks/{id}/transition` completed a task that asks for evidence with any
  `evidenceType` and `evidenceId`: nothing checked that the record existed, was about the task's
  person, or was the evidence the task asks for. This predates #123.
- Domain (`packages/domain/src/platform/tasks.ts`): `TASK_CHART_KINDS`, `EntryEvidence` and
  `isEvidenceFor`, copied verbatim from #123 (`feat/mobile-round-screen`), not yet merged, so the
  two merge cleanly. Reconcile when #123 lands: keep one copy. New `checkTaskEvidence`: a type and
  an id together, a type Harbour accepts as evidence (a note, observation, body map mark, activity,
  visit or assessment), a record the caller's read found, about the task's own person, and the
  evidence the task asks for (never a note for a task that needs evidence; a chart's task only its
  own chart).
- API: the transition reads the cited record under the caller's row-level security (another
  organisation's, another home's or a missing id are not found) and refuses with one 422, "That
  record cannot stand as evidence for this task.", audited as denied (`AuditedRefusal`) with the
  task's id, the cited type and id and the reason (`evidence_incomplete`, `evidence_not_accepted`,
  `evidence_not_found`, `evidence_wrong_person`, `evidence_without_completion`). Evidence goes only
  with completing; "not done" takes a reason, as before.
- Hazard log: an HZ-029 control and its tests.

## What is next

- NEWS2 response tasks are raised without `evidence_required`, so a note about the same person
  still completes one directly. Whether they should ask for evidence is a clinical decision with
  #123's H-423.

## Human actions logged

- None.

## Tests

- `packages/domain/src/platform/tasks.test.ts`: `checkTaskEvidence` (12 cases).
- `apps/api/test/tasks.test.ts`: five `hazard HZ-029` tests. The existing "needs evidence"
  test now cites a real reading of the person instead of an id that names nothing.
