# Definer functions owned by NOLOGIN roles (ADR-0133)

Branch `fix/platform-definer-owners`, from `main` at `5eac43fb`, with batch 3c (`0ffb24ae`) merged.
The security follow-up from batch 3a's review.

## What changed

- **Inventory**: 34 SECURITY DEFINER functions (32 on main, 2 from batch 3c) were owned by
  `harbour_owner`, the migrator (a role that can log in and owns every table); most definer
  functions pinned `search_path` without `pg_temp` last. Every other definer was already owned by a
  NOLOGIN role.
- **Migration 0151**: five NOLOGIN owners, one per bounded context (`harbour_platform_definer`,
  `harbour_care_definer`, `harbour_workforce_definer`, `harbour_scheduling_definer`,
  `harbour_finance_definer`), created by `pnpm db:bootstrap`, each with only what its functions,
  and the policies and triggers they meet, use; each joins every restrictive policy that holds
  `harbour_owner`. The 34 functions moved to them; `harbour_owner` keeps EXECUTE only on those
  row-level policies call. The leaver record's guard names the new owner of `app.end_leaver_access`.
  Every Harbour definer's `search_path` keeps its schemas and ends in `pg_temp`; extension members
  (pgAudit's on Cloud SQL) and other schemas are left alone.
- **Tests**: `definer-acls.test.ts` fails if a Harbour definer function is owned by a role that can
  log in, a superuser, a role that bypasses row-level security or a member of a login role; if one
  lacks a `search_path` ending in `pg_temp`; if a restrictive policy holds `harbour_owner` without
  the five definers; or if a definer role's table privileges change.
- **Security review**: one blocker fixed (the `search_path` step tried to act as pgAudit's owner and
  failed wherever pgAudit is installed; proved with a stand-in extension), grants trimmed, the
  owner's extra EXECUTE grants dropped, SET ROLE and RESET ROLE paired; the rest recorded.
- **Docs**: ADR-0133, human actions H-1491 to H-1497.
