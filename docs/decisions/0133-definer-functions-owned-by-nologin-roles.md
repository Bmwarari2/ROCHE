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
3a found 32 of them owned by `harbour_owner` (34 once batch 3c merged), the migrator: a role that can log in and owns every
table. A flaw in any of those functions (a missing check, an injectable argument, a name shadowed
through `search_path`) would run with every table's rights. Most definer functions also pinned
`search_path` without `pg_temp` last, so a temporary object of the caller's could shadow a name the
function resolves. The other definer functions were already owned by single-purpose NOLOGIN roles
(`harbour_member_owner`, `harbour_silo_owner` and others).

## Decision drivers

- Least privilege: a definer function holds only what it uses.
- No definer runs as a role that can log in, or a superuser.
- No change in behaviour: each function sees the rows it saw before, and no more.
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
- Grants (migration 0154): each role gets the table privileges its functions use, the SELECT that
  the row-level policies and invoker triggers of those tables read when evaluated as that role,
  EXECUTE on the restricted helper functions they call, and INSERT on `record_version` where they
  change rows. The grants were derived from the function bodies, the tables' policies and triggers,
  then confirmed by the full database and API suites.
- Row-level security: each role joins every restrictive policy that holds `harbour_owner`, so it
  sees no more than `harbour_owner` did. Policies naming `harbour_owner` alone for maintenance stay
  as they are.
- `harbour_owner` keeps EXECUTE on the moved functions it could call as their owner (seeds,
  maintenance, policies evaluated for its own queries), granted by each new owner.
- Guards that named `harbour_owner` as the owner of a moved function (the leaver record's guard for
  `app.end_leaver_access`) now name the new owner too.
- Every definer function's `search_path` is `pg_catalog, public, pg_temp`.
- `packages/db/test/definer-acls.test.ts` fails if any definer function, trigger functions included,
  is owned by a role that can log in or a superuser, or lacks that `search_path`.

### Consequences

- Good, because a flaw in a definer function reaches only its context's tables, as a role that
  cannot log in.
- Good, because the rule is tested: a new definer function owned by `harbour_owner` fails CI.
- Bad, because a new definer function needs its owner and grants decided, and a change to a
  function that starts using a new table needs a grant (the suites find a missing one as
  "permission denied").
- Bad, because some owners read tables only for their policies (for example the silo checks on
  members), which is wider than the functions' own needs; row-level security still applies.
- Neutral, because every environment must re-run `pnpm db:bootstrap` before migration 0154 (H-1491).

## Confirmation

`packages/db/test/definer-acls.test.ts` (ADR-0133 describe) and the full `packages/db` and
`apps/api` suites on a fresh database. The security reviewer checked the migration.

## More information

Migration `packages/db/drizzle/0154_definer_owners.sql`; roles in `packages/db/src/admin/roles.ts`;
human actions H-1491 to H-1493.
