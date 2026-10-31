---
status: accepted; partly superseded by ADR-0098
date: 2026-10-11
decision-makers: Claude Code (lead engineer), under the master prompt defaults; Brian may supersede
consulted: master prompt sections 4, 5.3, 5.5, 6 and 18; Postgres row security documentation
informed: everyone working in this repository
---

# Tenancy and row-level security

> **Partly superseded by [ADR-0098](0098-production-on-google-cloud.md) (production on Google
> Cloud), 31/10/2026**: the RDS note on `harbour_sync`: on Cloud SQL the role is given the
> `REPLICATION` attribute, with the `cloudsql.logical_decoding` flag on. The tenancy and row-level
> security decision is unchanged. The text below is kept as decided.

## Context and problem statement

One codebase serves many care providers (section 4). A leak of one provider's residents to another,
or of a resident's record to a staff member outside their scope, is a data breach and a clinical
hazard (HZ-011). Section 5.3 requires `tenant_id` on every row, Postgres row-level security with
`FORCE ROW LEVEL SECURITY`, a non-owner application role that sets `app.tenant_id` per transaction,
and tests that prove cross-tenant reads fail through the API and through the sync streams. Section 4
adds attribute-based scope (location, assignment, time window) "enforced again by Postgres row-level
security", and break-glass access.

How do we model tenancy and scope so that a bug in application code still cannot expose data?

## Decision drivers

- Fail closed: no context, or a malformed one, must return nothing.
- Defence in depth: the API checks permissions; the database enforces tenant and person scope again.
- No role in the application path may bypass RLS, including the table owner.
- Offline sync bypasses RLS (logical replication), so the sync streams need their own proof.
- Credentials and MFA secrets must be unreachable from care-data queries.
- Keep it testable: every rule has an automated test that fails if a future table forgets it.

## Considered options

1. Database per tenant: strongest isolation, but migrations, reporting and the group layer multiply;
   too heavy for a small team and hundreds of small providers.
2. Schema per tenant: similar costs, and RLS is still needed for scope within a tenant.
3. Shared tables with `tenant_id` and application-only filtering: one forgotten `WHERE` leaks data.
4. **Shared tables with `tenant_id`, forced RLS for tenant isolation, restrictive RLS for person
   scope, and per-purpose database roles.** (chosen)

## Decision outcome

Chosen option 4, implemented in `packages/db/drizzle/0000_foundation.sql` and `0002_security.sql`.

### Request context

The API runs every database access inside `withRequestContext` (`packages/db/src/client.ts`), which
sets transaction-local settings: `app.tenant_id`, `app.user_id` (tenant user), `app.scope`
(`tenant`, `locations`, `assigned`, `none`) and `app.location_ids`. Since
[ADR-0071](0071-data-scope-is-per-permission.md) the scope is that of the permission the request
uses (the narrowest of several), never the widest of the user's roles. Helper functions in the `app`
schema read them, treating empty values as NULL; a malformed UUID raises an error. Settings vanish at
commit, so a pooled connection never carries one request's tenant into the next (tested).

Column defaults use the same functions: `id` defaults to `app.uuid_v7()`, `tenant_id` to
`app.current_tenant_id()`, `created_by`/`updated_by` to `app.current_user_id()`.

### Policies

- Every table in `public` has RLS enabled and forced. A test fails the build if a table is missing
  either flag, or if a table with `tenant_id` has no policy keyed on `app.current_tenant_id()`.
- Tenant isolation is a permissive policy (`tenant_id = app.current_tenant_id()`) for all commands.
- Global reference tables (`rate_table`, `retention_class`, `form_template`) allow NULL `tenant_id`
  rows, readable by every tenant and writable only by the owner role; tenants may add overrides.
- Person scope is a restrictive policy on `person` (`app.person_in_scope`): tenant scope sees all;
  location scope sees people at `app.location_ids`; anyone may additionally see people they are
  assigned to (unexpired `person_assignment`) or hold an unexpired `break_glass_event` for; scope
  `none` sees no one. Child tables (contacts, allergies, placements, About Me) follow their person
  through `app.person_visible`. Assignment and break-glass tables are scoped by role breadth or
  ownership instead, to avoid recursive policies.
- Restrictive policies target `harbour_app` and `harbour_owner` only; service roles get narrow,
  explicitly granted policies instead.
- Child rows reference parents through composite `(tenant_id, id)` foreign keys, because referential
  checks bypass RLS: this is what stops a row pointing at another tenant's record.

### Roles (created by `pnpm db:bootstrap`, never by migrations)

| Role | Used by | Can do |
| --- | --- | --- |
| `harbour_owner` | migrations, seeds | Owns objects; subject to RLS because every table forces it |
| `harbour_app` | API, worker tenant jobs | DML in `public` under RLS; no DELETE anywhere (soft delete); INSERT and SELECT only on append-only tables; cannot create tenants; no access to `auth` |
| `harbour_auth` | Better Auth | The `auth` schema only |
| `harbour_sync` | PowerSync replication | SELECT on the synced tables, REPLICATION |
| `harbour_operator` | Thapsus operator console | Tenant provisioning tables; never people or care data |
| `harbour_worker` | pg-boss jobs | Outbox and notifications across tenants, tenant ids and status |
| `harbour_membership_reader` | NOLOGIN owner of one function | Lists an identity's memberships before a tenant is chosen |

No Harbour role is a superuser or has BYPASSRLS (tested).

Security-definer functions run with their owner's rights, so their execute rights are their whole
access control. Each is owned by a NOLOGIN role that holds only what it needs, and its ACL is set
before the ownership changes (`REVOKE ALL ... FROM PUBLIC`, then the intended `GRANT EXECUTE`, then
`ALTER FUNCTION ... OWNER TO`), or later as the owner (`SET ROLE <owner>; ...; RESET ROLE;`,
`harbour_owner` holding the owner roles with SET only). A REVOKE run by `harbour_owner` after the
owner change does nothing, because the default PUBLIC right then belongs to the new owner (found in
#95; migration 0068 corrects 0061). `packages/db/test/definer-acls.test.ts` checks that PUBLIC can
execute no definer function and each only the roles listed there.

### Identity and tenant selection

Better Auth owns identity (users, sessions, passwords, TOTP, passkeys) in the `auth` schema. Tenant
membership lives in the domain table `tenant_user` (one identity, many tenants: agency and bank
staff), with roles in `role` and `role_assignment`. The active tenant travels in the
`x-harbour-tenant` header and is validated against the identity's memberships on every request.

This deviates from section 6, which names Better Auth's organisations plugin for tenants. Using the
plugin would create a second membership model next to `tenant_user` and `role_assignment`, whose
scoping is richer than the plugin's role strings; two sources of membership truth would drift.
Better Auth still handles invitations' credentials, MFA and sessions.

### Audit and history

`audit_event` and `record_version` are append-only: no UPDATE or DELETE grant for the application,
and triggers that raise an error if anyone else tries. Each tenant's audit events form a SHA-256
hash chain maintained by a trigger; `app.verify_audit_chain()` recomputes it and reports the first
broken position (tested by tampering as a superuser). Mutable aggregates bump `version` and copy the
previous row into `record_version` on every update.

### Offline sync

PowerSync replicates through `harbour_sync`, bypassing RLS. The sync streams
(`packages/sync/src/streams/sync-config.yaml`) pin every query to the token's `tenant_id` and scope
people to assignments or permitted locations. `packages/sync/test/streams.test.ts` runs the real
PowerSync rules engine against two tenants to prove no cross-tenant or out-of-scope row reaches a
device. Tokens last 15 minutes; expired assignments are soft-deleted by a worker job because streams
cannot read the clock.

### Group layer

`tenant_group` sits above tenants. A tenant can read its own group row. Consolidated cross-tenant
reporting (Phase 3) will use a dedicated reporting role with read-only, aggregate access, never by
widening these policies.

### Consequences

- Good: a missing `WHERE tenant_id` in application code returns nothing rather than leaking; a test
  catches any new table without RLS.
- Good: care workers cannot query people they are not assigned to even through a bug in the API.
- Bad: every query pays for policy evaluation; person scope adds sub-queries. Acceptable at care-home
  scale; revisit with indexes or materialised scope if profiling shows a problem.
- Bad: operator and worker roles need narrow, hand-written policies; each new table must decide.
- Neutral: on RDS, `harbour_sync` gets `rds_replication` instead of the REPLICATION attribute
  (handled in the bootstrap).

### Confirmation

- `packages/db/test/rls-coverage.test.ts`, `isolation.test.ts`, `scope.test.ts`,
  `audit-and-history.test.ts` run against real Postgres in CI.
- `apps/api/test/api.test.ts` repeats the refusals through HTTP.
- `packages/sync/test/streams.test.ts` covers the sync streams.

## More information

- Postgres row security: https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- [ADR-0071](0071-data-scope-is-per-permission.md): data scope is per permission; the request
  context carries the scope of the permission the request uses.
- Hazard HZ-011 in [the hazard log](../clinical-safety/hazard-log.md).
