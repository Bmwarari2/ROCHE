---
status: "accepted"
date: 2026-11-01
decision-makers: Thapsus engineering (Claude Code, under the working agreement)
consulted: DPO and CSO (to confirm, H-1254, H-1255)
informed: Design partner
---

# Learning platform imports: staged, dry run first, matched by stable id

## Context and problem statement

Many providers train staff on an external learning platform. Their completions belong in Harbour's
training records (workforce.md rule 5; WORK-005, WORK-006) so the matrix and the rota's training
checks (HZ-124) see them. Plan slice 78 asks for imports behind a port with a mock. How should
completions come in, how are they tied to members of staff, and who is the platform in data
protection terms?

## Decision drivers

- A completion put on the wrong member makes someone look trained who is not (HZ-124).
- Names and emails are not stable and are not needed: data minimisation.
- An import must never overwrite what a manager recorded in Harbour.
- No vendor call may leave Harbour until a platform is chosen and assessed (H-520).
- The training matrix already forbids recording one's own training (slice 17).

## Considered options

- Match learners by name or email, importing straight away.
- Reuse the platform import wizard (PLAT-014) for training records.
- Workforce's own staged import: learners linked by the platform's stable id by a person, a dry
  run first, and a commit tied to that dry run.

## Decision outcome

Chosen option: "Workforce's own staged import". It is the only option that never attributes a
completion by name, and it lets a person see what will be recorded before anything is.

- A source is a file source or an API source. An API source's credentials live in the managed
  secret store under a name the database makes; the integration is off by default, and production
  refuses anything but off until a live client exists (H-1250).
- Only the learner id, course code, dates, record id and provider are read; other columns are
  ignored and never stored.
- Each learner id is linked to one member by a person, never to themselves. Course codes map to
  training topics.
- A dry run classifies every row. A commit names the latest dry run and is refused if what it
  would import changed since. Only ready rows are imported; the rest wait for a person.
- An imported completion is a new training record marked with its source, and its fields are
  fixed. An import never changes a record made in Harbour. Nobody imports their own record.
- Certificates are documents of their own category, scanned for malware, read as their training
  record is.
- The learning platform is the organisation's own processor, not a Thapsus sub-processor, unless
  the DPO decides otherwise. This is H-520's recommended answer, confirmed by H-1254.

### Consequences

- Good: no completion is attributed by name, and every import is checked before it counts.
- Good: re-importing the same export is safe; completions already recorded are recognised.
- Bad: someone must link each learner once per platform before their rows import.
- Bad: the platform wizard's mapping screen is not reused; workforce has its own routes.

### Confirmation

`packages/domain/src/workforce/lms-import.test.ts`, `packages/db/test/lms-import.test.ts` and
`apps/api/test/lms-import.test.ts`, including the `hazard HZ-124` cases; the configuration test
refusing `LMS_API` other than `off` in production.

## Pros and cons of the options

### Match learners by name or email

- Good: no linking step.
- Bad: names are shared and change, emails change; a wrong match makes someone look trained.

### Reuse the platform import wizard

- Good: one import user interface.
- Bad: the wizard is platform's, for people and their records at a location; training records are
  workforce's, organisation-wide, and need matching and idempotency it does not have.
