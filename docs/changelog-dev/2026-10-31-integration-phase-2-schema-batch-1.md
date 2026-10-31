# Phase 2 schema batch 1: integration fixes

Branch `integration/phase-2-schema-batch-1`, PR #161 (#151, #153, #155, #148, #149, #152, #156,
#154 and #150, merged in migration order, then main with #120).

## What changed

- Main (#120, incident follow-up) merged in: the worker's unrouted actions keep both the overdue
  safeguarding referral (#155) and the incident the duty of candour holds open (#120). The API
  contract was regenerated.
- Migration journal: the branches were generated in parallel, so 0076, 0080, 0082, 0087 and 0088
  had a `when` earlier than the entry before them, and Drizzle would have skipped them without a
  word. Each is raised just above its predecessor, so the journal strictly increases. None had been
  applied to a shared database.
- Sample data removal (HZ-072): migration 0075 (#155) redefined `app.sample_removal_tables()` from
  migration 0069's list and dropped `dependency_assessment`, which 0074 (#153) had added and
  granted. 0075 now keeps it, so the list and the `harbour_sample_owner` grants agree again.
- DSAR collector check: the database test that finds member-dependent read policies now counts
  `app.is_system()` (no member, organisation scope: the context the collector reads in) as an
  organisation-wide alternative. The staff file and HR document policies (#151, 0073) use it, so
  the collector sees them whole; the subject map and `DSAR_MEMBER_SCOPED_TABLES` do not change.

## What is next

- Merge PR #161 once CI is green.

## Human actions logged

- None.

## Tests

- `packages/db/test/migration-journal.test.ts` (80 passed, no database needed); domain tests
  (5,506 passed); lint and typecheck clean. The database tests (`data-rights`, `sample-data`) need
  `HARBOUR_TEST_ADMIN_URL` and run in CI.
