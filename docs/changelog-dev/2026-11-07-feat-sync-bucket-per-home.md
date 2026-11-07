# Sync buckets per home (ADR-0134, migration 0146)

Branch `feat/sync-bucket-per-home`, from `main` (no PR yet); migration 0146 (0145 is the SMS fix).

## What changed

- PowerSync refuses a phone over its buckets limit (1,000), and the day-windowed streams keyed
  by person and day passed it at a 60-bed home. A home's notes, charts, tasks and handovers now
  sync per home and day, from routing columns the database sets on each row (migration 0146); an
  assigned person's per person and ten-day block (`offline_blocks`). The limits are set
  explicitly in `infra/powersync/powersync.yaml`.
- When a person moves home, or leaves or returns to care, their records of the last 35 days and
  their tasks move with them (HZ-138); a person who has left care leaves every home's phones as
  before.
- The API leaves a family's assigned streams off where its whole-home streams already carry
  everyone the member is assigned to, and names the homes a limited reader's handovers come from.
- The API estimates each token's buckets and refuses one above the limit by name
  (`sync_scope_too_large`), so the phone shows a failed sync; narrowing with a notice is H-1430.
- `packages/sync/test/bucket-budget.test.ts`: a whole 120-bed home and a care worker with 20
  people at or under 500 at the 31-day window, on the dates with the most ten-day blocks; groups
  and large assignment counts estimated at or above the engine.
- Review fixes: an insert during a move waits for it (advisory lock); the person read in the
  organisation's view; tasks stay with their home; whole readers' handover items about people
  now at their homes (HZ-018); tasks about nobody given to the member keep their own claim.
- Docs: ADR-0134, HZ-002, HZ-011, HZ-018, HZ-138, data standards, records of processing, H-1428 to H-1430.

## What is next

- Slice 68 (medicines on the phone) builds on this branch.
