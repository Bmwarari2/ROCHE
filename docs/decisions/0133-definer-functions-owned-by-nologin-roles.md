---
status: accepted
date: 2026-11-07
decision-makers: Claude Code (for Brian, under the owner instruction of 31/10/2026)
consulted: security reviewer agent
informed: Brian, DPO lead
---

# Security-definer functions are owned by NOLOGIN roles, one per bounded context

## Context and problem statement

A `SECURITY DEFINER` function runs with its owner's rights (ADR-0002). The security review of batch
3a found 32 of them owned by `harbour_owner` (34 once batch 3c merged), the migrator: a role that
can log in and owns every table. A flaw in any of those functions (a missing check, an injectable argument, a name shadowed
through `search_path`) would run with every table's rights. Most definer functions also pinned
`search_path` without `pg_temp` last, so a temporary object of the caller's could shadow a name the
function resolves. The other definer functions were already owned by single-purpose NOLOGIN roles
(`harbour_member_owner`, `harbour_silo_owner` and others).

## Decision drivers

- Least privilege: a definer function holds only what it uses.
- No definer runs as a role that can log in, or a superuser.
- No wider access: each function sees no more rows than it saw before (two narrow, see below).
- A rule that a test enforces, so a new definer function cannot slip back.

## Considered options

- Leave them with `harbour_owner` and rely on review.
- One NOLOGIN owner for all of them.
- One NOLOGIN owner per bounded context, each with only the grants its functions need.
- One NOLOGIN owner per function.

## Decision outcome

Chosen option: one NOLOGIN owner per bounded context, because it limits a flaw to one context's
tables while keeping the number of roles manageable (one per function would add 34 roles for little
gain; one for all would put payroll, casework and care rounds in one blast radius).

- Roles (created by `pnpm db:bootstrap`, as every role is; `harbour_owner` may `SET ROLE` to them,
  never inherit them): `harbour_platform_definer` (provisioning an organisation, the audit chain),
  `harbour_care_definer` (handed-over entries, the earlier-plan round data, discard reasons),
  `harbour_workforce_definer` (casework, leavers, induction, supervision, absence, equality
  monitoring), `harbour_scheduling_definer` (agency workers, cover needs, reading worker time),
  `harbour_finance_definer` (pay run state).
- Grants (migration 0151): each role gets the table privileges its functions use, the SELECT that
  the row-level policies and invoker triggers of those tables read when evaluated as that role,
  EXECUTE on the restricted helper functions they call, and INSERT on `record_version` where they
  change rows. The grants were derived from the function bodies, the tables' policies and triggers,
  then confirmed by the full database and API suites and trimmed after the security review;
  `definer-acls.test.ts` pins each role's table privileges, so a new grant is a visible decision.
- Row-level security: each role joins every restrictive policy that holds `harbour_owner`, so it
  sees no more than `harbour_owner` did; a test fails if a restrictive policy holds
  `harbour_owner` without all five. Policies naming `harbour_owner` alone for maintenance stay as
  they are, and two things now bind the definers where they did not bind `harbour_owner`, which
  narrows access and must not be "fixed" by adding the definers back: the permissive
  `membership_lookup` policies on `tenant` and `tenant_user` (granted to `harbour_owner` through
  `harbour_membership_reader`) let a function owned by `harbour_owner` read every organisation's
  rows, and the member state guard (migration 0129) let `harbour_owner` skip its transitions, which
  `app.end_leaver_access` and `app.end_relinked_leaver_access` now pass through (to `left` is
  allowed). Every moved function filters by the organisation in context.
- `harbour_owner` keeps EXECUTE only on the moved functions that row-level policies call, so the
  policies on its own queries still evaluate, and on `app.seed_discard_reasons` and
  `app.refresh_earlier_plan`, which backfills run as the migrator; granted by each new owner. The actions stay with their API callers alone.
- Guards that named `harbour_owner` as the owner of a moved function (the leaver record's guard for
  `app.end_leaver_access`) now name the new owner too. That guard now trusts every
  `harbour_workforce_definer` function, not only `app.end_leaver_access`; today only that function
  marks a leaver's access ended.
- Every Harbour definer function's `search_path` keeps the schemas it named and ends in `pg_temp`
  (today `pg_catalog, public, pg_temp` for all of them). Functions that belong to an extension
  (pgAudit's event-trigger functions on Cloud SQL, a hosting platform's own on Supabase) and
  functions outside `app`, `public` and `auth` are not Harbour's: migration 0151 and the test leave
  them alone, since their owners are not roles `harbour_owner` may act as.
- `packages/db/test/definer-acls.test.ts` fails if any Harbour definer function, trigger functions
  included, is owned by a role that can log in, a superuser, a role that bypasses row-level security
  or a member of a login role, or lacks a `search_path` ending in `pg_temp`.
- Changing a moved function later (`CREATE OR REPLACE`) runs as its owner: `GRANT CREATE ON SCHEMA
  app` to the owner, `SET ROLE` to it, replace the function, `RESET ROLE`, then revoke CREATE, as
  migration 0151 moves them.

From migration 0151 on, each migration that creates a definer function sets its owner itself, to
its context's definer role (or a narrower NOLOGIN owner it already uses), with only the grants the
function needs, before any execute rights change (the add-migration skill's order). Migration 0151
also took over the definers batch 4 had added: the sync routing functions of 0146 went to
`harbour_platform_definer` with column grants on the routing columns only (and
`app.is_sync_location_move` now names that role; with its UPDATE grants limited to the routing
columns, a move is let through only inside `app.move_sync_location`, though `harbour_owner` may
still act as the role), and `app.request_sign_in_erasure` of 0149 to `harbour_member_owner`,
which owns the rest of the member lifecycle.
A later backfill of the routing columns cannot follow 0146's pattern (`harbour_owner` with row-level
security not forced): it runs as `harbour_platform_definer` under a tenant context, since forced
row-level security applies to that role.

### Consequences

- Good, because a flaw in a definer function reaches only its context's tables, as a role that
  cannot log in.
- Good, because the rule is tested: a new definer function owned by `harbour_owner` fails CI.
- Bad, because a new definer function needs its owner and grants decided, and a change to a
  function that starts using a new table needs a grant (the suites find a missing one as
  "permission denied").
- Bad, because some owners read tables only for their policies (for example the silo checks on
  members), which is wider than the functions' own needs; row-level security still applies.
- Neutral, because every environment must re-run `pnpm db:bootstrap` before migration 0151 (H-1491).
- Neutral, follow-ups from the security review, not built here: CI has no pgAudit database, so the
  extension case is proved only by a local stand-in extension (H-1494); the add-migration skill
  still names `harbour_app, harbour_owner` for restrictive policies and does not say `pg_temp` last
  (H-1495; the new test catches the first); invoker helpers called from definers pin
  `pg_catalog, public` without `pg_temp`, low risk as they qualify every table (H-1496);
  `harbour_platform_definer` both provisions organisations from operator input and writes the
  audit chain head, which a dedicated owner would separate (H-1497).

## Confirmation

`packages/db/test/definer-acls.test.ts` (ADR-0133 describe) and the full `packages/db` and
`apps/api` suites on a fresh database. The security reviewer checked the migration.

## More information

Migration `packages/db/drizzle/0151_definer_owners.sql`; roles in `packages/db/src/admin/roles.ts`;
human actions H-1491 to H-1497.
