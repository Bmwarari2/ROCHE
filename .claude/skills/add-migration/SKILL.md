---
name: add-migration
description: Add a Drizzle migration safely for Harbour - schema change, generated SQL, custom SQL for RLS, grants and triggers, expand-and-contract rollout, and the isolation tests. Use whenever packages/db/src/schema changes.
---

# Add a database migration

Migrations are forward-only; a mistake is fixed by a new migration (section 7). Changes are
expand-and-contract so the previous app version and the mobile app one schema version behind keep
working.

1. Edit the schema in `packages/db/src/schema/`. New tenant tables use `tenantId()` and composite
   foreign keys (ADR-0002).
2. Generate: `cd packages/db && npx drizzle-kit generate --name=<what_changed>`. Read the SQL.
3. If the table needs anything Drizzle cannot express, add a custom migration:
   `npx drizzle-kit generate --custom --name=<what>_security` and write, in this order:
   `ALTER TABLE ... ENABLE ROW LEVEL SECURITY; ... FORCE ROW LEVEL SECURITY;` the `tenant_isolation`
   policy; restrictive scope policies (target `harbour_app, harbour_owner`); grants (no DELETE for
   `harbour_app`; INSERT and SELECT only for append-only tables); `touch_mutable` and
   `capture_version` triggers for mutable aggregates or `append_only` triggers for events; publication
   changes if the table syncs to devices (`ALTER PUBLICATION powersync ADD TABLE ...`).
   A security-definer function: give it a fixed `search_path`, set its ACL before changing its owner
   (`REVOKE ALL ON FUNCTION ... FROM PUBLIC; GRANT EXECUTE ... TO <roles>; ALTER FUNCTION ... OWNER TO
   <nologin role>`) or afterwards as that owner (`SET ROLE <owner>; ...; RESET ROLE;`), never a REVOKE
   after the owner change as `harbour_owner` (it has no effect; ADR-0002), and list its callers in
   `packages/db/test/definer-acls.test.ts`.
4. Run `npx vitest run` in `packages/db`: the coverage test fails if RLS, FORCE, the tenant policy, the
   version trigger or the append-only rules are missing, and the definer test if a definer function
   is executable by PUBLIC or by a role not listed for it.
5. Renaming or dropping a column: add the new column first, backfill, ship code that writes both,
   then drop in a later release. Never in one migration.
6. Update `docs/specs/data-standards.md` and `docs/compliance/records-of-processing.md` for new personal
   data fields, and the export schema.
