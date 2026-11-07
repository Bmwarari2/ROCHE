# The add-migration skill states the definer-owner rules (H-1495)

Branch `docs/add-migration-definer-owners`.

## What changed

- `.claude/skills/add-migration/SKILL.md` now says what ADR-0133 requires of a migration:
  - restrictive scope policies name `harbour_app, harbour_owner` and the five context definers;
  - a security-definer function is owned by its context's NOLOGIN definer role (or a narrower NOLOGIN
    owner such as `harbour_member_owner`), never a role that can log in;
  - its `search_path` starts with `pg_catalog` and ends in `pg_temp`;
  - a later `CREATE OR REPLACE` runs as the owner, as migration 0151 does;
  - a new definer role comes from `pnpm db:bootstrap`, which must run before the migration.
- ADR-0133 now names the migration by its number on `main` (0151, renumbered in batch 4).
- H-1495 is done.

## What is next

Nothing for this item. `definer-acls.test.ts` already enforces each rule.
