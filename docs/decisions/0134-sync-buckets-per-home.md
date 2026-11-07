---
status: "accepted"
date: 2026-11-07
decision-makers: lead engineer (Claude Code lead session), for the owner
consulted: clinical safety officer (HZ-002, HZ-018, HZ-138; H-1429), data protection officer (H-1428); security and clinical-safety reviews of 07/11/2026
informed: engineering
---

# Sync buckets per home and day, not per person and day

## Context and problem statement

PowerSync refuses a connection whose buckets, or whose parameter query results, pass its limits
(1,000 each by default; `PSYNC_S2305`). A refused phone gets no fresh data at all: no care record,
no round, no handover (HZ-002). Every day-windowed stream joined to `person` or `person_assignment`
for its scope, so its buckets were per person and day, and the handover streams per person and
handover. Measured on the real stream engine (the sync simulator): a nurse at a 60-bed home on the
default 7-day window held about 1,170 buckets before any medicines stream, 6,198 on the 31-day
window, and over 8,000 once handovers exist; a care worker with 20 people, over 28,000.

## Decision drivers

- Safety of the person (HZ-002): a phone at a full-size home must sync, at the longest window.
- Least privilege: no phone receives more than its scope, as the streams' isolation tests prove;
  the rules for people who have left care (L1) and for handovers (L1, L3, HZ-018) keep their effect.
- Fewer buckets, as PowerSync recommends, rather than a higher limit.
- Continuity of care: a person who moves home keeps their recent record on the new home's phones.

## Considered options

1. Raise `max_buckets_per_connection`.
2. Key by calendar month for every scope.
3. Key a whole home's rows by home and day, from columns on the row itself, and an assigned
   person's by person and ten-day block.

## Decision outcome

Option 3, with the limits set explicitly at their default (1,000), an estimate in the API, and the
rules of the security and clinical-safety reviews.
- **Routing columns, set by the database (migration 0145), never by a client, never synced**:
  - `sync_location_id` on the five point-of-care entry tables, assessments and administrations:
    the person's home while they receive care (active, on leave or in hospital), none once they
    have left care, so their record leaves the home's phones as before (L1). (Assessments carry it
    for when their streams key by home; none does yet.)
  - on a task: its own home while the person it is about receives care, none once they have left
    care; a task about nobody, its own home. A task stays with its home on a move, as the round,
    the handover and escalations on the server do; recomputed on every change of the task.
  - on a handover's items, notes and acknowledgements: the handover's home and `shift_end`; on
    items and notes `person_location_id`, the home of the person they are about now, and `at_home`,
    whether that is the handover's home (about nobody: yes). No care-status rule, so a death in the
    shift reaches the handover (HZ-018).
  - The person is read in the organisation's view (`app.sync_person`, a definer), so an inserter
    whose scope does not reach the person never leaves the column empty, and under a per-person
    advisory lock that a move takes too, so an entry written during a move never keeps the old home.
- **Moves (HZ-138)**: when a person's home changes, or they leave or return to care, their entries,
  assessments and administrations of the last 35 days follow (more than the longest offline
  window, 31 days and tomorrow; a test keeps the two in step), in the same transaction, as
  `harbour_owner` with the organisation in view (`app.move_sync_location`). Their tasks leave the
  phones when they leave care and come back on return. Items and notes about them in the window's
  handovers carry their new home. Only the routing columns change: the append-only guard and the
  version and history triggers let that, and nothing else, through (`app.is_sync_location_move`); a
  task's version does not change, so a phone's next write is not refused as stale.
- **Whole-home streams**: filter on the row's own `sync_location_id` (or the handover's home) and
  the UTC day: one bucket per home and day. A whole reader's handover items and notes are those
  about nobody in their homes' handovers and those about anyone who now lives at their homes, as
  the API shows them (`staffCanSee`), including from a handover at another home (such an item
  reaches the phone without its handover's header).
- **Assigned streams**: by person and ten-day block (`offline_blocks`, the first nine characters of
  the window's days: blocks of 9, 10, 10 and 1 or 2 days, at most six for 32 days across
  February). The phone may hold up to nine days before the window's first day, and up to nine after
  its last, of its own people's entries, tasks and handover items, and shows only the window
  (H-1428). A limited reader's handovers, and those handovers' own notes, go by the homes where
  their assigned people live (`handover_assigned_location_ids`, in the token) and block; their own
  acknowledgements by member and block.
- **Assigned streams left off where a whole home covers them**: the API sets a family's
  `*_assigned` to false when its whole-home claims already carry every person the member is
  assigned to (each lives at such a home and receives care). Tasks about nobody given to the
  member have their own claim (`care_own_tasks`), which this never turns off.
- **Estimate and narrowing**: the API estimates the token's buckets (`estimateBuckets`, an upper
  bound tested against the engine) and, above the limit, narrows the whole-home reach to the homes
  the member works at, says so in the token (`sync_narrowed`), the audit and the log (counts and
  opaque ids). The phone's notice for it is H-1430.
- **Budget**: `packages/sync/test/bucket-budget.test.ts` measures, at the 31-day window and on
  the dates whose windows span the most blocks: a whole 120-bed home and a care worker with 20
  people at two homes at or under 500; groups of up to five homes and up to 100 assigned people
  estimated at or above what the engine makes.

### Consequences

- Good: a full-size home syncs; the limits are explicit and tested; the record follows the person.
- Good: no new job; the rules for people who have left care and for handovers keep their effect.
- Bad: assigned people's phones may hold up to nine days either side of the window (H-1428).
- Bad: the homes a limited reader opens, and whether a whole home covers their assignments, come
  from the token, so an assignment change, or an assigned person's move, reaches the phone within
  the token's 15 minutes rather than at the next sync (H-1428, H-1429).
- Bad: a member reaching many homes may be narrowed to the homes they work at; until H-1430 the
  phone does not say so.
- Bad: the server's handover and round source rows by where they were made, so an event at the old
  home earlier in the shift of a move is in the old home's handover, which the old home's whole
  readers no longer see on the phone (the API agrees), and not in the new home's (H-1429).
- Bad: handovers are never soft-deleted today; if they are, their items, notes and
  acknowledgements keep syncing to the end of the window, without the header.
- Bad: `app.sync_person` and `app.move_sync_location` are owned by `harbour_owner`, a login role,
  rather than a narrow NOLOGIN owner (ADR-0002); both are trigger-only or granted to `harbour_app`
  only, and pinned to the caller's organisation.
- Bad: the backfill rewrites every row of eleven tables; PowerSync replicates them again.

## More information

Questions for people: H-1428 (DPO), H-1429 (CSO), H-1430 (the phone's notice). Migration 0145; HZ-002, HZ-011, HZ-018, HZ-138.
