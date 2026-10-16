# Execute rights on security-definer functions (ADR-0002)

Branch `fix/db-definer-function-acls`.

## What changed

- Audit of every SECURITY DEFINER function, migrated as production is (by `harbour_owner`): PUBLIC
  could execute `app.family_can_see` and `app.family_item_shown`, because migration 0061 revoked
  PUBLIC's right after handing the functions to `harbour_family_reader`, when only the new owner
  could revoke it. Every other definer function was limited as intended; trigger functions cannot
  be called directly and are left out.
- Migration 0068 sets their rights as the owner (`SET ROLE harbour_family_reader`): PUBLIC revoked,
  `harbour_app` and `harbour_owner` granted, as 0061 meant. Numbered after #91 (0066) and #95 (0067).
- `packages/db/test/definer-acls.test.ts`, table-driven over `pg_proc`: no definer function is
  executable by PUBLIC, each only by the roles listed (besides its owner), and a new one fails
  until it is listed. It already lists #95's functions.
- ADR-0002 and the add-migration skill: set a definer function's ACL before the owner change, or as
  the owner.

## What is next

- Sample data mode (migration 0069).

## Human actions logged

- H-372: confirm Supabase's `anon` and `authenticated` roles never had USAGE on schema `app` in dev
  and staging.

## Tests

- `definer-acls.test.ts` (3), failing without 0068 and passing with it; db suite.

## Review rounds

- Round 1: `migration-journal.test.ts` (idx and `when` strictly increase, tags match their idx,
  files exist; 0068's entry given idx 68); a STATUS security note; an HZ-011 control and test row;
  H-372. After #95 lands: a check that every listed function exists and is SECURITY DEFINER, by
  full signature.
