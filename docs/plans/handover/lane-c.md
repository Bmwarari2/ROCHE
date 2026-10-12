# Lane C: mobile (slice 10, Care mode part 2)

Scope over the lane (`docs/plans/phase-1.md` slice 10; STATUS "Next items"; `docs/specs/care.md`
section 6 and the device integrity parts):

- sync streams for tasks and handovers, with offline acknowledgement;
- the escalation policy link on the phone, staff names, coded discard reasons (H-164);
- kiosk mode (ADR-0011); the stale-device check now that `device_binding` exists (H-141);
- the Maestro offline journey (a Phase 1 gate item): sign in, write notes and charts offline,
  sync, conflict review, on iOS and Android (`apps/mobile/.maestro`, run by
  `.github/workflows/mobile.yml`).

PowerSync replication bypasses RLS: every stream you add must be proven to deny cross-tenant and
out-of-scope rows in `packages/sync` tests, each stream family following its own read permission
(ADR-0071). Writes are append-only with client UUIDs and idempotent upload; mutable rows use
`expected_version`. Use only `@harbour/ui-native` components; strings in the `mobile.*` catalogues.
Run `pnpm --filter @harbour/mobile test`, `pnpm --filter @harbour/sync test` and typecheck. You
cannot run simulators here; write Maestro flows carefully against the existing ones.

If a stream needs a database change (a publication, an index, a column), do not add a migration:
say so in your report and the coordinator sequences it through Lane A.

## Your first PR now: tasks and handovers on the phone

Branch `feat/mobile-tasks-handover-sync`. Sync streams for the person's and location's open tasks
and the current and last shift's handover (scoped as the API's round and handover views are),
the round list and handover screen in Care mode reading them offline, completing a task and
acknowledging a handover offline (queued, idempotent upload against the existing API routes in
`apps/api/src/routes/tasks.ts`, `rounds.ts`, `handovers.ts`), and the stream isolation tests.
Show staff names beside staff ids where the API gives them. Split into two PRs (streams and data
layer; then screens) if it passes about 600 changed lines.
