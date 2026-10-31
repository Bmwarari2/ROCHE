# Drizzle snapshot chain rebuilt (chore/drizzle-snapshot-chain)

Main's Drizzle snapshots had several pairs sharing a parent (0073/0076/0088/0095/0099, 0074/0077,
0077/0081), and the latest (0103) lagged the schema: it was missing `employee_case`,
`auth.sso_provider` and other tables. So `drizzle-kit generate` refused to run on main.

- **The chain:** the prevIds now follow the journal from 0000 to 0103.
- **The 0103 snapshot:** it now equals the schema in code, and keeps its own id.
- **Unchanged:** no `.sql` file, journal `when` or tag. Earlier snapshots keep their content;
  only their parent changed where the chain broke.
- **New test:** `packages/db/test/drizzle-snapshots.test.ts` fails on a shared parent, a broken
  chain or a latest snapshot that differs from the schema. It uses drizzle-kit's own
  `generateDrizzleJson` and `generateMigration`.
- **How branches re-chain:** `docs/runbooks/drizzle-snapshots.md` explains how to re-chain a
  branch's new snapshots onto 0103's id.
