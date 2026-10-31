# Phase 1 slice 9, tasks, documents and records retention screens (PLAT-009, PLAT-011, PLAT-012)

Branch `feat/web-documents-tasks`.

## What changed

- Web: `/tasks` ("Tasks" in the side bar for staff, not family portal sessions): "My tasks" and
  "Team tasks", open or finished, yesterday to tomorrow or 7 days either side, "Reviews only".
  Each task says where it stands as an icon and a word (upcoming, due, started, overdue, overdue:
  escalated, done, not done, cancelled; an unknown state warns), who it is about (linked when the
  viewer may open the record), where, who has it and when it is due in UK time. Review tasks show
  their entries and missed rounds (`TaskDetails`) and tasks their late evidence, catch-up or
  restored state (`TaskEvidenceBadge`), closing HZ-006's planned on-screen row. Start, mark as
  done (not offered when evidence is needed: it comes from the person's record), not done or
  cancel with a reason; managers take, unassign and create a task (once, every day or every week)
  at one of their locations. A stale version is refused and the task shown again.
- Web: `/documents` ("Documents"): the organisation's documents, latest version first, with status,
  legal hold, size and signatures; upload (PDF, 25 MB, through a server action whose body limit
  now matches); `/documents/{id}/details` with the retention class, fingerprint, versions,
  signatures, signing bound to the version's SHA-256, and a new version. An earlier version says it
  has been replaced and is not offered for signing. Letter templates are linked.
- Web: `/settings/retention` ("Records retention", `platform.retention.manage`, step-up): legal
  holds in force and released, placing (a person by name, or one record) and releasing with
  reasons; documents due for destruction (only what the API offers: never held, never someone
  still receiving care), destroyed only after choosing, a reason, an acknowledgement and a
  confirmation dialog that says it cannot be undone; the page says what was destroyed and skipped;
  destruction certificates.
- API: `GET /v1/destruction-certificates` (audited); retention candidates carry the document's
  title and when it was stored. The demo seed adds Rhys Example, who left care nine years ago, for
  the retention journey.
- Docs: platform.md (the three web slices, permission matrices and tests), HZ-006, the register.

## What is next

- Workflow approvals and SLAs have no generic screen yet: each module shows its own (incidents,
  statutory notifications); a cross-module "awaiting my approval" list needs a workflow list API.
- Documents about a person on the person's record (upload and signing there); crypto-shredding.
- Welsh for the new strings.
- The task list does not yet re-read on its own or say that tasks about people are hidden from a
  session without MFA (H-450).

## Human actions logged

- None.

## Tests

- `apps/web/src/lib/tasks.test.ts`, `documents.test.ts`, `retention.test.ts`;
  `apps/api/test/documents.test.ts` (certificates listed, candidates named, refusals);
  `apps/web/e2e/tasks.spec.ts` (4, HZ-006), `documents.spec.ts` (2), `retention.spec.ts` (3), axe in
  light and dark on every state.

## Review rounds

- Round 1 (security, accessibility and clinical safety reviewers): the retention candidate list is
  audited (`platform.retention_candidate.list`), as titles of documents about people show there;
  the proxy's body limit matches the server action's, and the file is passed on as it is (a 12 MB
  upload checked by hand); open task lists include every older open task (`earlier=yes`) and say
  when they are incomplete (`truncated`), and open on "Team tasks" so reviews assigned to a role
  show (HZ-003, HZ-008); communication needs beside each person on tasks and holds; action buttons
  described by their task, "Record as not done", "Unassign task", "Keep task"; the document list's
  error link focuses its group; the acknowledgement box is required; each document page is named
  after the document; a stale task closes its dialog; a repeating task cannot start in the past;
  clock-change tests (HZ-009). H-450 asks the CSO about the missed-rounds evidence.
