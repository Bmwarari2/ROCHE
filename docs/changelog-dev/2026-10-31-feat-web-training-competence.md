# Training, competence, supervision and revalidation screens (WORK-005, WORK-008, WORK-009, WORK-012, plan slice 57)

Branch `feat/web-training-competence`, cut from `feat/work-training-competence` (slice 17).

## What changed

- Web screens under `/training`:
  - the organisation's training matrix by location and role, each state an icon and a word, with
    those needing attention and a name search;
  - each role's training requirements;
  - each member's training record: training (record, correct), observed competence (sign off in
    one's own name, withdraw with a reason), supervision and appraisal with notes, and the NMC
    revalidation planner.
  - No form is offered on one's own record. Navigation: "Training", for the workforce read
    permissions.
- API:
  - `GET /v1/workforce/training-matrix`: every member's required training today, filtered by
    location, role or attention, at most 2,000 members, audited without names.
  - `POST /v1/workforce/members/{memberId}/supervisions/{supervisionId}/notes`: add or correct a
    note.
  - The supervision POST takes an optional note. OpenAPI and the client are regenerated.
- Supervision notes (H-692's default, [ADR-0114](../decisions/0114-supervision-notes-kept-in-harbour.md),
  proposed; migration 0114):
  - Notes are kept in `supervision_note` and read by the writer, the member and a supervisor for
    the member (organisation-wide HR, or a holder where the member works, through the definer
    `app.supervises_member`). Training, competence and staff file readers and tenant-wide roles do
    not read them.
  - Whoever held the supervision writes the note. It is append-only: a correction supersedes the
    note in force, and the earlier one is shown struck through.
  - Notes never appear in audit, the outbox, search or sync. Retention is with the staff file. The
    export catalogue, records of processing (special category likely), data standards and retention
    are updated.
- Large homes: every row of the matrix stays in the page, and the browser skips drawing rows out of
  view (`content-visibility`), so screen readers and find-in-page reach everyone.
- Spec: [workforce.md](../specs/workforce.md) section 2b (`supervision_note`), section 5 (screens)
  and section 11 (known gaps). Feature register: the four rows are now partial.
- Strings: en-GB catalogue entries checked against the domain's code lists; Welsh marked
  untranslated.

## Human actions logged

- H-1040 to H-1049:
  - trying the screens with providers, a clinical lead and a nurse;
  - the DPIA and appropriate policy document for notes;
  - whether notes need a permission of their own;
  - the record's page title;
  - a screen reader check on a large matrix;
  - the copy;
  - Welsh.
- H-692 stays open for the DPO to accept or change ADR-0114.

## Tests

- `packages/db/test/supervision-notes.test.ts` (new):
  - who reads, and the seven readers refused;
  - written by whoever held the supervision;
  - corrections, once each;
  - never changed;
  - another organisation.
- Also: the RLS coverage, definer ACL, migration journal and export catalogue tests.
- `apps/api/test/training-competence.test.ts`:
  - notes and corrections;
  - refusals;
  - the matrix by role, location and attention, without portal accounts, audited without names.
- `apps/web/src/lib/development.test.ts`: every code has words; who is offered what; status chips;
  the name search.
- `apps/web/e2e/training.spec.ts`: 7 journeys with axe on every state, including the HZ-119
  sign-off and withdrawal.

## Review rounds

- Security reviewer. Fixed:
  - ADR, records of processing, data standards and retention written for the notes;
  - notes narrowed from every supervision holder to supervisors for the member;
  - corrections by supersession;
  - the writer tied to whoever held the supervision;
  - the matrix capped before reading records, grouped in one pass, joined on composite keys;
  - tests added.
- Accessibility reviewer. Fixed:
  - the windowed matrix replaced, so every row is reachable and focus is never lost;
  - a name search added;
  - the sticky header no longer hides focus;
  - every required field has its own message;
  - clearer labels and copy;
  - "not needed" given its own icon;
  - journeys with axe.
  Logged: the record's page title (H-1046) and custom role names (known gap).

## Follow-up: notes of a deleted supervision (01/11/2026)

- A supervision note is hidden from every reader, the system and so exports and subject access included, once its supervision record is soft-deleted (recorded in error, or about the wrong person).
- The read policy in migration 0114 (edited in place; not on main) now needs `app.supervision_in_force`. That is a definer answering yes or no, executable by `harbour_app` only and listed in the definer test.
- Test: `packages/db/test/supervision-notes.test.ts`.
