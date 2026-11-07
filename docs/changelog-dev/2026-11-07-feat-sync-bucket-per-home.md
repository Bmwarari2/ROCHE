# Sync buckets per home (ADR-0134, migration 0145)

Branch `feat/sync-bucket-per-home`, from `main` (no PR yet).

## What changed

- PowerSync refuses a phone over its buckets limit (1,000), and the day-windowed streams keyed
  by person and day passed it at a 60-bed home. A home's notes, charts, tasks and handovers now
  sync per home and day, from routing columns the database sets on each row (migration 0145); an
  assigned person's per person and ten-day block (`offline_blocks`). The limits are set
  explicitly in `infra/powersync/powersync.yaml`.
- When a person moves home, or leaves or returns to care, their records of the last 35 days and
  their tasks move with them (HZ-138); a person who has left care leaves every home's phones as
  before.
- The API leaves a family's assigned streams off where its whole-home streams already carry
  everyone the member is assigned to, and names the homes a limited reader's handovers come from.
- `packages/sync/test/bucket-budget.test.ts`: a 120-bed home 354 buckets, a care worker with 20
  people 392, at the 31-day window.
- Docs: ADR-0134, HZ-002, HZ-138, data standards, records of processing, H-1428 and H-1429.

## What is next

- Slice 68 (medicines on the phone) builds on this branch.
