---
status: "proposed"
date: 2026-10-31
decision-makers: Harbour engineering (Phase 2, plan slice 57), on the Appendix default for H-692
consulted: Security reviewer and accessibility reviewer (slice 57 review round 1)
informed: Brian and the DPO (H-692 stays open for their sign-off), the workforce screens builders
---

# Supervision and appraisal notes are kept in Harbour, read by few

## Context and problem statement

The master prompt (section 12.2, "Supervision and appraisal") asks for templates, actions and a
wellbeing check-in. Slice 17 recorded supervisions, appraisals and spot checks with no notes,
because what is said at a supervision is likely to include health and wellbeing: special category
data under UK GDPR Article 9. H-692 asked Brian and the DPO whether notes are kept in Harbour and, if
so, under which permission and retention. Under the working agreement (section 20 rule 2) an open
item takes its default as an ADR: the default is that notes are kept in Harbour, with their own
permission rule and retention. Since providers already keep supervision notes, on paper or in
other systems, keeping them here also brings them under Harbour's audit, retention and export.

## Decision drivers

- Regulation 18 (staffing): providers must show supervision and appraisal happen and what they
  cover.
- Data minimisation and least privilege: people who need to know a supervision happened (training
  leads, staff file readers, tenant-wide roles) do not need to know what was said.
- The member of staff's rights: access to their own notes, and correction of a wrong one.
- Harbour's append-only rule for records like this: corrections are new entries, shown struck
  through.

## Considered options

- Keep no notes (slice 17's position).
- Notes as a column on `supervision_record`.
- Notes in a table of their own, with a narrower read rule.

## Decision outcome

Chosen option: "Notes in a table of their own, with a narrower read rule". Row-level security works
per row, not per column, so only a separate table can be read by fewer people than the
supervision itself.

- **Table:** `supervision_note` (migration 0114) holds what was discussed (10 to 4,000 characters)
  and the actions agreed (optional). Each note belongs to one supervision.
- **Read by:**
  - its writer;
  - the member of staff it is about, with `workforce.self.read`;
  - a supervisor for the member (`app.supervises_member`). That means a holder of
    `workforce.supervision.manage` through a role with no person scope (organisation-wide HR), or
    through a location role at a location where the member holds a role in force.
- **Not read by:**
  - a training lead;
  - a competence observer;
  - a staff file reader;
  - a supervision holder at another location;
  - a tenant-wide role (owner, group executive) on that alone.
- **Written by:** whoever held the supervision, in their own name, never about themselves. A
  database trigger checks this, as well as row-level security and the API.
- **Corrections:** the table is append-only. A correction is a new note that supersedes the one in
  force, and the earlier one is shown struck through. There is one original per supervision, and
  each note is corrected at most once.
- **Lawful basis (proposed, for the DPO):**
  - Article 6(1)(c) legal obligation (Regulation 18) and 6(1)(b) contract of employment.
  - Article 9(2)(b) employment, social security and social protection, with DPA 2018 Schedule 1
    paragraph 1 and the provider's appropriate policy document.
  - Never consent.
- **Retention:** with the staff file (`staff_file`, the tenant's chosen row), like `supervision_record`.
- **Never in:**
  - audit events (the supervision event records only that a note was written, and a correction
    event only that it corrected one);
  - outbox payloads;
  - search;
  - the PowerSync publication.
- **Export:** included in the provider's free full export (`supervision_note`, personal and likely
  special category).

### Consequences

- Good, because supervisions can record what Regulation 18 expects, with the actions agreed, in one
  place under audit and retention.
- Good, because fewer people read the notes than the fact of the supervision: the read rule is
  tested to deny every other reader (`packages/db/test/supervision-notes.test.ts`).
- Good, because a wrong note is corrected without losing the history (rectification, and the
  append-only rule).
- Bad, because the owner and group executives, who hold `workforce.supervision.manage` through
  tenant-wide roles, do not read notes for that alone (H-1044 asks whether a separate note permission
  is wanted).
- Bad, because special category content is now stored. The DPIA, the records of processing and the
  appropriate policy document need the DPO's review (H-692, H-1043).
- Neutral, because a note cannot be removed once written; it is destroyed only with the staff file
  under the retention engine (crypto-shred with a certificate).

### Confirmation

- `packages/db/test/supervision-notes.test.ts`:
  - the readers and the denied readers;
  - written only by whoever held the supervision;
  - one original per supervision, each note corrected once, never changed or removed;
  - another organisation sees nothing.
- `packages/db/test/rls-coverage.test.ts` (append-only) and `packages/db/test/definer-acls.test.ts`
  (`app.supervises_member` executable by `harbour_app` only).
- `apps/api/test/training-competence.test.ts`:
  - the member reads their note;
  - a training lead reads the supervision but not the note;
  - corrections keep the earlier note;
  - someone who did not hold the supervision, and the member themselves, are refused;
  - audit without note content.

## Pros and cons of the options

### Keep no notes

- Good, because no special category content is stored.
- Bad, because supervision content and actions live elsewhere, outside audit, retention and export,
  and the master prompt's supervision feature is not met.

### Notes as a column on `supervision_record`

- Good, because it is the simplest change.
- Bad, because everyone who reads supervisions (training leads, staff file readers) would read the
  notes: row-level security cannot hide one column.

### Notes in a table of their own

- Good, because the read rule can be narrower than the supervision's, and corrections can be
  append-only.
- Bad, because there is one more table and one more definer function to keep.

## More information

- Spec: [workforce.md](../specs/workforce.md) sections 2b, 3, 5 (screens) and 8.
- Data protection: [records of processing](../compliance/records-of-processing.md) and
  [data standards](../specs/data-standards.md).
- Human actions:
  - H-692: the DPO and Brian accept or change this default;
  - H-1043: the appropriate policy document and the DPIA;
  - H-1044: whether a separate note permission is wanted.
- The number 0114 matches the slice's reserved migration number, so it cannot collide with ADRs
  other builders are writing at the same time.
- Revisit when the supervision templates and wellbeing check-in arrive. If the DPO decides notes are
  not kept, a new ADR supersedes this one and a migration stops new notes.
