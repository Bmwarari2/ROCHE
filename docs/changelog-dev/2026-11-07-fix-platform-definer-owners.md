# Definer functions owned by NOLOGIN roles (ADR-0133)

Branch `fix/platform-definer-owners`, from `main` at `5eac43fb`. The security follow-up from batch
3a's review.

## What changed

- **Inventory**: 32 SECURITY DEFINER functions were owned by `harbour_owner`, the migrator (a role
  that can log in and owns every table); most definer functions pinned `search_path` without
  `pg_temp` last. Every other definer was already owned by a NOLOGIN role.
- **Migration 0154**: five NOLOGIN owners, one per bounded context (`harbour_platform_definer`,
  `harbour_care_definer`, `harbour_workforce_definer`, `harbour_scheduling_definer`,
  `harbour_finance_definer`), created by `pnpm db:bootstrap`, each with only what its functions,
  and the policies and triggers they meet, use; each joins every restrictive policy that holds
  `harbour_owner`. The 32 functions moved to them; `harbour_owner` keeps EXECUTE on those it called.
  The leaver record's guard names the new owner of `app.end_leaver_access`. Every definer's
  `search_path` is `pg_catalog, public, pg_temp`.
- **Test**: `definer-acls.test.ts` fails if a definer function is owned by a role that can log in or
  a superuser, or lacks that `search_path`; its ACL map names the new grantees.
- **Docs**: ADR-0133, human actions H-1491 to H-1493.

## Left

- Batch 3c and later branches add definer functions owned by `harbour_owner`; the test fails on
  them once merged, and each gets an owner then (this branch merges batch 3c when it lands).
