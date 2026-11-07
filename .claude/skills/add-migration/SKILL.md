---
name: add-migration
description: Add a Drizzle migration safely for Thapsus Care - schema change, generated SQL, custom SQL for RLS, grants and triggers, expand-and-contract rollout, and the isolation tests. Use whenever packages/db/src/schema changes.
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
   policy; restrictive scope policies (target `harbour_app, harbour_owner` and the five context
   definers `harbour_platform_definer, harbour_care_definer, harbour_workforce_definer,
   harbour_scheduling_definer, harbour_finance_definer`; a test fails if a restrictive policy holds
   `harbour_owner` without all five, ADR-0133); grants (no DELETE for `harbour_app`; INSERT and SELECT
   only for append-only tables); `touch_mutable` and `capture_version` triggers for mutable aggregates
   or `append_only` triggers for events; publication changes if the table syncs to devices
   (`ALTER PUBLICATION powersync ADD TABLE ...`).
   A security-definer function (ADR-0133):
   - Owner: the migration that creates it sets its owner to its context's NOLOGIN definer role
     (`harbour_<context>_definer`, or a narrower NOLOGIN owner the context already uses, such as
     `harbour_member_owner`), never `harbour_owner` or any role that can log in. Grant that role only
     the table and column privileges the function needs.
   - `search_path`: fixed, starting with `pg_catalog`, keeping the schemas the body uses and ending
     in `pg_temp` (normally `SET search_path = pg_catalog, public, pg_temp`).
   - ACL: set it before changing the owner (`REVOKE ALL ON FUNCTION ... FROM PUBLIC; GRANT EXECUTE
     ... TO <roles>; ALTER FUNCTION ... OWNER TO <definer role>`) or afterwards as that owner
     (`SET ROLE <owner>; ...; RESET ROLE;`), never a REVOKE after the owner change as `harbour_owner`
     (it has no effect; ADR-0002). List its callers in `packages/db/test/definer-acls.test.ts`.
   - Changing an existing definer later (`CREATE OR REPLACE`) runs as its owner: `GRANT CREATE ON
     SCHEMA app TO <owner>; SET ROLE <owner>;` replace it; `RESET ROLE;` then revoke CREATE again, as
     migration 0151 does.
   - A new definer role, or a new owner, is created by `pnpm db:bootstrap`
     (`packages/db/src/admin/roles.ts`) with SET-only membership for `harbour_owner`; say in the PR that
     bootstrap must run before the migration in every environment.
4. Run `npx vitest run` in `packages/db`: the coverage test fails if RLS, FORCE, the tenant policy, the
   version trigger or the append-only rules are missing, and the definer test if a definer function
   is executable by PUBLIC or by a role not listed for it, is owned by a role that can log in, a
   superuser, a role that bypasses row-level security or a member of a login role, or has a
   `search_path` that does not end in `pg_temp`.
5. Renaming or dropping a column: add the new column first, backfill, ship code that writes both,
   then drop in a later release. Never in one migration.
6. Update `docs/specs/data-standards.md` and `docs/compliance/records-of-processing.md` for new personal
   data fields, and the export schema.
