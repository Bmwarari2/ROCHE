---
status: proposed
date: 2026-10-31
decision-makers: Claude Code (lead engineer), taking the Phase 2 plan's default; the CSO and the DPO accept or change it (H-680, H-681)
consulted: master prompt sections 5.1, 5.2, 5.3, 9.1 (migration import wizard) and 20; docs/plans/phase-2.md (ADR table, slice 26); docs/specs/data-standards.md; ADR-0002
informed: everyone working in this repository
---

# Import wizard: staged rows in quarantine, organisation-wide importers, whole-batch commit and undo

## Context and problem statement

A provider moving to Harbour brings its people from another system (master prompt 9.1, PLAT-014).
The slice 9 rules (platform.md rules 11 to 14) check rows against data-standards.md, report a dry
run, commit a batch only when every row is valid, and undo a batch once within
`import.undo_window_days` while nothing has changed. Slice 26 needs the storage and the API: where
uploaded rows wait, who may import, how an import meets the people already in Harbour, and how a
mistaken import is taken back, without creating duplicates or wrong-person records (HZ-130), and
without the import becoming a way to learn whether a person the importer cannot see exists.

## Decision drivers

- Imported rows are personal data that are not yet anyone's record: keep them apart and briefly.
- Never merge into, update or attach to an existing person by matching (HZ-130, HZ-001).
- NHS numbers are unique within an organisation, so whether an import succeeds depends on people
  the importer may not be able to see: it must never become an existence oracle across homes or
  tenants (HZ-011).
- The application role never deletes (ADR-0002); undo and clean-up need a narrow way to delete.
- Whole batch or nothing; a retried request must never import twice.
- Never echo imported values in errors, logs or audit events.

## Considered options

1. **Quarantine tables, organisation-wide importers, whole-batch commit, undo by a definer
   function.** (chosen)
2. Import straight into people, marked "imported", fixed up afterwards.
3. Allow importers scoped to some homes, refusing a hidden NHS number match with a neutral message
   and a rate limit (as PATCH /v1/people/{id}/details does after #119).
4. Match and merge: update an existing person when the NHS number matches.

## Decision outcome

Chosen option 1, because it is the only one that keeps unvalidated rows out of the care record,
never merges, and leaks nothing about people the importer cannot see.

- **Quarantine.** An upload becomes an `import_batch` and its rows `import_row` (the matched
  columns' text, keyed by field). Rows are insert-only, never shown back, and deleted in the
  transaction that commits, discards or expires the batch (`app.import_batch_closed`), or within
  the hour after `import.staging_expiry_days` (a new rate-table default, 7 days). The batch row and
  `import_commit` (the ids of the people created) stay as the record of what happened.
- **Organisation-wide importers.** Every route needs `platform.import.run` (the catalogue's
  existing permission, now a care-record permission), `people.person.create` and
  `people.person.read`, all across the whole organisation. Anyone holding them only at some homes gets one refusal,
  `organisation_wide_required`, before the request is read, whatever the file holds; the importer
  can see everyone matching could find, so the dry run only ever reports people they can see.
  Another organisation's people are never read: a number used by another provider imports as new.
  Row-level security in migration 0088 holds the same rule.
- **Matching, never merging.** A row whose NHS number or local identifier is already on a record
  is an error naming that record; the same date of birth with agreeing names (the same, swapped,
  the same family name, or the same given name, compared as letters and by the first given name)
  where either has no NHS number is a warning naming the other row or record. Warnings are
  bounded so each can be read: once a pair of rows, at most three records a row, and a file with
  more than 50 rows on one date of birth or more than 500 warnings is refused. Changes to existing
  people are made on their records.
- **Whole-batch commit, idempotent.** The dry run is repeated inside the commit with the batch
  locked; the commit lists exactly the warnings found now, by key; the whole batch commits or
  nothing does, never past its expiry; committing a committed batch returns the same commit.
  Commit and undo need a fresh step-up. People wait while sample data is in place (HZ-072).
- **Allergy status not recorded.** Every imported person's allergy status is `unknown`, confirmed
  by no one, whatever the file states: an imported "no known allergies" must never read as freshly
  confirmed by the person who committed it (HZ-007). The dry run and the commit say which people
  the file stated a status for, and the commit raises a task for each, carrying what the file
  said and paired by NHS number or local identifier, so staff check and record those first.
- **Undo.** `app.undo_import_batch`, owned by the new no-login role `harbour_import_owner`, removes
  only the people the batch created (`person.import_batch_id`, set as the batch commits and never
  changed) and exactly the commit's record ids, whole or nothing, once, within
  `import.undo_window_days` (read from the rate table in the database as well as the API), only
  while none has been saved since (version 1, not soft-deleted) and nothing refers to any of them
  by a foreign key, and only until a phone may hold them: once a sync token carrying people was
  issued in the organisation from one token's lifetime before the commit, a phone may have
  recorded care for them offline, which an undo would strand. Holding imported people off phones
  until the importer confirms was the other way; it was rejected as more complex (a sync stream
  change, a confirmation step) and because new residents must be visible at the point of care at
  once. A soft delete was rejected because a deleted person keeps their NHS number, so the
  corrected file could never be imported again, and the mistaken data would stay in the record's
  history. A batch says whether its undo is still available. Where phones are in use (a people
  sync token within the offline window), the commit needs the importer to accept that the import
  cannot be relied on to be undone.
- **People first.** Slice 26 imports people (demographics), status `active`, at the batch's
  location, with no room, placement or admission record. Contacts, allergies, staff, the JSON
  round trip with the full export (HZ-071) and medicines "not yet checked" (HZ-005) follow in
  slices 26 (later part), 51 and 67.

### Consequences

- Good, because nothing reaches a person's record until every row is valid and a person has read
  the dry run; a mistaken import can be taken back cleanly while nothing depends on it.
- Good, because no import tells anyone about a person they cannot see, by design rather than by a
  rate limit.
- Bad, because only someone with organisation-wide access can import: a registered manager of one
  home asks the owner, or the owner gives a role scoped to the organisation (rule 18).
- Bad, because undo is refused as soon as anything refers to an imported person, including a task a
  job raised, and as soon as phones may hold the people (within minutes where phones are in use);
  after that a person's details can be corrected, but a person imported in error cannot be removed
  or marked as created in error until the people lifecycle has such a status (a follow-up; the CSO
  decides whether it must come first, H-680). Undo is most useful at onboarding, before devices
  are in use.
- Bad, because every imported allergy status has to be checked and recorded by staff before
  go-live, even where the previous system held a reliable one.
- Bad, because a new no-login role means running `pnpm db:bootstrap` in each environment before
  migration 0088 (H-684).
- Neutral, because month-first dates whose days are all 12 or under still pass validation: the
  wizard's side-by-side check (slice 67) and the tenant's sample sign-off carry that (HZ-130,
  H-682).

### Confirmation

- `packages/domain/src/platform/imports.test.ts` (`hazard HZ-130 ...`, `hazard HZ-007 ...`),
  `packages/db/test/imports.test.ts` (`hazard HZ-130 hazard HZ-011 the import tables`, the undo
  function), `apps/api/test/imports.test.ts` (the refusal identical whatever the file holds; another
  organisation's number imported as new; idempotent commit; undo; nothing echoed), and
  `packages/db/test/definer-acls.test.ts` (the undo function executable by `harbour_app` only).
- The medical-device boundary was re-checked: the import stores and validates data and matches
  identifiers; it makes no clinical inference, score or recommendation.

## Pros and cons of the options

### Quarantine tables, organisation-wide importers, whole-batch commit, undo by a definer

- Good, because validation and the dry run happen before anything is anyone's record.
- Good, because no oracle and no merge.
- Bad, because of the organisation-wide requirement and the new role (above).

### Import straight into people, fixed up afterwards

- Good, because simplest.
- Bad, because invalid or duplicate records reach staff at once (HZ-130), and a partial import is
  hard to take back.

### Home-scoped importers with a neutral refusal and a rate limit

- Good, because a home's manager could import their own people.
- Bad, because whether an import succeeds still says whether a number is used at another home; a
  rate limit slows probing but does not stop it, and matching must never become an existence
  oracle across homes or organisations (platform.md rule 18).

### Match and merge

- Good, because a re-import could correct existing records.
- Bad, because a wrong match overwrites the wrong person's record (HZ-001, HZ-130), and merging
  needs a person's judgement that a dry run cannot give.

## More information

- Spec: [platform.md](../specs/platform.md), Phase 2 rules 11 to 26; data:
  [data-standards.md](../specs/data-standards.md) (the import contract),
  [records-of-processing.md](../compliance/records-of-processing.md) (B1 to B3 as imported),
  [retention.md](../specs/retention.md) (staged rows).
- Hazards HZ-130, HZ-007, HZ-072, HZ-011, HZ-071 in the [hazard log](../clinical-safety/hazard-log.md).
- Amended on 31/10/2026 after the #150 security and clinical review round 1 (before acceptance):
  the allergy status, the warnings naming rows and records with an acknowledgement by key, the
  batch tie and the undo refused once phones may hold the people.
- Amended again on 31/10/2026 after round 2 (before acceptance): importers need
  `people.person.read` across the organisation too; possible duplicates are clustered and bounded
  (a file with too many is refused); each person whose file stated an allergy status gets a task
  carrying it; where phones are in use the commit needs the importer to accept that it cannot be
  relied on to be undone; and a batch says whether its undo is still available. A "created in
  error" status for a person is a follow-up the CSO rules on (H-680).
- Revisit when contacts, allergies and staff are imported (slice 51), when the JSON round trip with
  the full export lands (HZ-071), or if providers need home-scoped importing (it would need the
  NHS number to stop being unique per organisation, or a review queue that answers every
  home-scoped import the same way).
