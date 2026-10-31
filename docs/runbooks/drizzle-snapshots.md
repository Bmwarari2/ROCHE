# Drizzle snapshots: keeping the chain whole

Drizzle keeps one snapshot per migration in `packages/db/drizzle/meta/NNNN_snapshot.json`. Each
snapshot names the one before it (`prevId`). `drizzle-kit generate` compares the schema in code
with the **latest** snapshot, and it refuses to run if two snapshots name the same parent.
`packages/db/test/drizzle-snapshots.test.ts` fails when:

- two snapshots share a parent;
- the chain does not follow the journal's order;
- the latest snapshot differs from the schema in code.

## After main's chain was rebuilt (chore/drizzle-snapshot-chain, 31 October 2026)

Main's snapshots 0000 to 0103 now form one chain in journal order. The 0103 snapshot equals main's
schema, including `employee_case` and `auth.sso_provider`. Its id is unchanged:
`34af3497-983d-4d10-9875-eeac0345a989`. No `.sql` file, journal `when` or tag changed.

A branch that adds migrations after 0103 re-chains its own snapshots when it merges main:

1. **Merge main.** Main's journal entries win for 0000 to 0103. Add the branch's entries after
   them, sorted by idx, with `when` strictly increasing. Never change a `when` that is on main.
2. **Point the first new snapshot at 0103.** Set its `prevId` to `34af3497-983d-4d10-9875-eeac0345a989`. Each later snapshot of
   the branch points to the one before it, in journal order.
3. **Rebuild the latest snapshot from the schema.** The simplest way is to copy only the latest
   snapshot and the journal into an empty folder, then run `drizzle-kit generate` with a config
   whose `out` is that folder (a path relative to `packages/db`). Take the generated
   snapshot's content, keep the latest snapshot's own `id` and `prevId`, and write it back.
   Earlier snapshots of the branch may keep their content: only the latest is diffed.
4. **Check.** Run `pnpm --filter @harbour/db exec drizzle-kit generate --name=check`. It must say
   "No schema changes". Then run `vitest run test/drizzle-snapshots.test.ts` in `packages/db`.
