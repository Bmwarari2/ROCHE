---
status: "accepted"
date: 2026-11-07
decision-makers: lead engineer (Claude Code lead session), for the owner
consulted: clinical safety officer (HZ-002, HZ-138; H-1429), data protection officer (H-1428)
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

Option 3, with the limits set explicitly at their default (1,000).
- **Routing columns, set by the database (migration 0145)**: `sync_location_id` on the five
  point-of-care entry tables, assessments, administrations and tasks: the person's home while they
  receive care (active, on leave or in hospital), none once they have left care (so their record
  leaves the home's phones as before, L1); a task about nobody keeps its own home. On a handover's
  items, notes and acknowledgements: the handover's home and `shift_end`, and on items and notes
  `at_home`, whether they are about nobody or someone who still lives at that home (as the person
  join did, with no care-status rule, so a death in the shift reaches the handover, HZ-018). Set on
  insert whatever a client sends; `location_id` keeps where an entry was made.
- **Moves (HZ-138)**: when a person's home changes, or they leave or return to care, their records
  of the last 35 days (the longest window, the medicines administrations; ADR-0130) and their tasks
  due from then follow, in the same transaction, as `harbour_owner` with the organisation in view
  (`app.move_sync_location`). Only the routing columns change: the append-only guard, the version
  and the history triggers let that, and nothing else, through (`app.is_sync_location_move`); a
  task's version does not change, so a phone's next write is not refused as stale.
- **Whole-home streams**: filter on the row's own `sync_location_id` (or the handover's home) and
  the UTC day: one bucket per home and day.
- **Assigned streams**: by person and ten-day block (`offline_blocks`, the first nine characters
  of the window's days: at most five for 31 days). The phone may hold up to nine days before the
  window's first day of its own people's entries, tasks and handover items, and shows only the
  window (H-1428). A limited reader's handovers, and those handovers' own notes, go by the homes
  where their assigned people live (`handover_assigned_location_ids`, in the token) and block; their
  own acknowledgements by member and block.
- **Assigned streams left off where a whole home covers them**: the API sets a family's
  `*_assigned` to false when its whole-home claims already carry every person the member is
  assigned to (each lives at such a home and receives care), so the same rows never count twice.
- **Budget**: `packages/sync/test/bucket-budget.test.ts` measures the worst cases on the real
  engine at the 31-day window: the whole of a 120-bed home (354 buckets) and a care worker with 20
  people at two homes (392) at or under 500, half the limit; a whole home with 20 people at two
  other homes (834) and 40 assigned people (752) under the limit itself.

### Consequences

- Good: a full-size home syncs; the limits are explicit and tested; the record follows the person.
- Good: no new job; the rules for people who have left care and for handovers keep their effect.
- Bad: assigned people's phones may hold up to nine extra days (H-1428).
- Bad: the homes a limited reader opens, and whether a whole home covers their assignments, come
  from the token, so an assignment change reaches the phone within the token's 15 minutes rather
  than at the next sync.
- Bad: in a handover at a home the person has left, an item about them is no longer shown to the
  whole home's readers; a reader limited to them sees it only where the person still lives there,
  as the API shows it (L1); a whole reader assigned to them still sees it (L3).
- Bad: about 21 buckets per assigned person at the 31-day window; a member assigned to more than
  about 40 people at once, or reaching a whole home and many people elsewhere, approaches the limit.

## More information

Questions for people: H-1428 (DPO), H-1429 (CSO). Migration 0145; HZ-002, HZ-138.
