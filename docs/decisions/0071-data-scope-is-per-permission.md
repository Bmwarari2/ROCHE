---
status: "accepted"
date: 2026-10-12
decision-makers: Claude Code (lead engineer), on a security finding against ADR-0002; Brian may supersede
consulted: master prompt section 4 (RBAC decides what, attribute scope decides to whom) and 5.3; ADR-0002; ADR-0033; ADR-0061; #26 review round 2 (S1, `placesHoldingPermission`)
informed: everyone working in this repository, the data protection lead, the CSO
---

# Data scope is per permission

## Context and problem statement

ADR-0002 gives every request one row-level security context (`app.scope`, `app.location_ids`).
`resolveAccess` built it by taking the widest scope across all of a user's roles, whatever each role
carried, and the API set that one merged scope for every request. Access grants added their
permissions to the same set and applied them over the merged scope. So a care worker at Harbour
House who also held a "Finance viewer" role across the organisation (carrying only
`finance.reporting.read`) read and wrote care notes for people at every home; an administrator at
one home given an acting-up grant at another used the grant's permissions at their own home and
not at the grant's. Section 4 says RBAC decides what and attribute scope decides to whom: the "to
whom" belongs to the role (or grant) that gives the "what", not to the user. How should scope be
resolved and applied so that a permission never reaches further than the roles and grants that
carry it?

## Decision drivers

- Least privilege and HZ-011: no permission may reach people its own roles and grants do not reach.
- Fail closed: a request that asks for no permission sees no one.
- Defence in depth (ADR-0002): the database enforces the same narrowing as the API, with no change
  to the policies that read `app.scope` and `app.location_ids`.
- Keep the change small: the policies, the sync streams and the permission matrix stay as they are.
- Every caller must choose the permission it acts for, so a new route cannot quietly use a merged
  scope.

## Considered options

1. Keep one merged scope per user and add per-permission checks in the API where they matter.
2. **A scope per permission, and each request runs under the scope of the permission it uses.**
3. Per-permission policies in SQL: every policy calls a function that checks the user's roles and
   grants for the permission behind the query (as `app.holds_permission_at` does for settings).

## Decision outcome

Chosen option 2, because it removes the merged scope altogether, needs no change to any row-level
security policy, and makes every caller name the permission it acts for.

### Domain (`packages/domain/src/platform/access.ts`)

- `EffectiveAccess` carries `scopes`, the scope of each held permission; `scopeFor(access,
  permission)` reads it (no one for a permission not held). The merged `scope` and `locationIds`
  are removed. `permissions` (the set) stays for the screens and `authorise`.
- A permission's scope is the union (`widestScope`) of the active, non-mixed staff roles that
  carry it (scope `tenant`, or `location` with no location: the whole organisation; `location` or
  `tenant` assigned at a location: that location; `assigned` or `self`: assigned people; `none`:
  no one) and the active, unrevoked grants that carry it (a grant at a location adds that
  location; one with no location adds the whole organisation). Portal sessions keep no person
  scope (ADR-0061).
- `narrowestScope` intersects the scopes of a request that needs several permissions: nothing, or
  `none` among them, is `none`; `tenant` narrows to the other; two location scopes keep the
  locations they share, and assigned people only when they share none (row-level security shows
  assigned people under both); `assigned` with anything else is `assigned`. A table-driven test
  proves the result never reaches further than any input.

### API (`apps/api/src/http/context.ts`)

- A request starts with scope `none`. `requirePermission` narrows it to `scopeFor(permission)`,
  intersected with any permission the request required before; `withTenant` uses the result.
  `requireAnyPermission` (a route that any one of several permissions opens) narrows to the union
  of the alternatives the session may use now (MFA and step-up met), so one whose checks the
  session does not meet adds nothing.
- `SCOPE_WITHOUT_PERMISSION` is the explicit allow-list of routes every member may use that show
  more to holders of one permission, which run in that permission's scope without requiring it
  (`useScopeOf`, which refuses any route not listed): the task list and task moves, and the
  document lookups that find a row before knowing whether it is about a person. Every other route
  that requires no permission runs with scope `none`: `/v1/me`, notifications, form templates,
  rates, sync uploads and device reports (which work in the system's view where they must).
- Checks of a second permission on one record count it only where it reaches that record:
  completing a task needs its permission where the task is; a status change, a task an entry
  completes and a return check use the permissions that reach the person
  (`permissionsReaching`); changing an incident or answering its manager questions needs
  `safety.incident.manage` where the incident is.
- Readers of the old merged scope name their permission: device lists and revocation
  (`platform.device.read`, `platform.device.revoke`), the sync token's `people_location_ids` (the
  narrowest of `people.person.read`, `care.plan.read` and `care.note.read`, the reads the location
  streams serve), handover whole views and staff views (`care.handover.manage`), urgent alert
  recipients (`people.person.read`, and `care.plan.write` where it reaches the person), the weekly
  break-glass report (`platform.audit.read`), `/v1/me`'s `scope` (`people.person.read`), audit
  defaults (the request's own scope) and per-user limits (the member's own view). A refused entry's
  copy or a hand-over is taken only about someone its author could reach with `care.note.write`
  (`personReachedBy`).

### Database

No policy changes: every policy reads `app.scope` and `app.location_ids`, which now hold the
permission's scope. `app.holds_permission_at` was already per permission (#26 review round 2).
The handover and device policies (migrations 0028 to 0046) judge the reader by the request's
scope, now narrowed, and the staff whose devices or bindings are shown by their own role
assignments, which is the subject, not the reader. The worker and system views keep tenant scope.

### Consequences

- Good, because a permission never reaches further than the roles and grants that carry it, in the
  API, in row-level security and in the sync token.
- Good, because a route that forgets `requirePermission` sees no one instead of everything the
  user's widest role reaches.
- Good, because a grant now reaches its own location, as the person granting it intended.
- Bad, because some users see fewer people: anyone whose roles give different permissions at
  different places; and administrators, or any location role without `people.person.read`, who
  now see in the task list only the tasks given to them that are about nobody. Managers should
  check role bundles (release note).
- Bad, because a route needing several permissions sees only where all of them reach, which can
  refuse a legitimate action when one of them is held more narrowly; the fix is the role bundle.
- Neutral, because a grant with no location now reaches the whole organisation for its
  permissions. No route creates grants yet; when one does, it must check that the granter holds
  `platform.grant.manage` wherever the grant reaches.

### Confirmation

- `packages/domain/src/platform/access.test.ts`: `hazard HZ-011 scopeFor: data scope is per
  permission (ADR-0071)` (two roles, grants at a location and organisation-wide, mixed, ended,
  future, revoked and portal cases), `hazard HZ-011 narrowestScope`, `widestScope`;
  `search.test.ts`: each kind of record searched in its own permission's scope.
- `apps/api/test/scope-per-permission.test.ts`: the two-role member refused at the other home for
  reads and writes and allowed at their own; the grant allowed at its home and refused at the
  role's; the sync token; tasks; incident management; the allow-list.
- `packages/db/test/scope.test.ts`: `hazard HZ-011 data scope per permission (ADR-0071)`, row-level
  security under each permission's scope refusing the other home's reads and writes.
- `apps/api/test/care-follow-ups.test.ts`: an urgent alert never reaches a nurse in charge through
  a role that cannot open records.

## Pros and cons of the options

### One merged scope, with per-permission checks where they matter

- Good, because nothing changes for most routes.
- Bad, because the database still enforces the widest scope, so every route is one forgotten check
  from the defect; it fails open.

### A scope per permission, and each request runs under the one it uses

- Good, because row-level security enforces the permission's own scope with no policy change.
- Good, because the default is `none`.
- Bad, because a few routes that show every member something need an explicit allow-list entry.

### Per-permission policies in SQL

- Good, because the database alone would decide, row by row.
- Bad, because every policy would have to know which permission a query serves, which a policy
  cannot see; it would mean rewriting every policy and the sync streams.

## More information

[ADR-0002](0002-tenancy-and-row-level-security.md) (the request context this narrows);
[ADR-0033](0033-incident-scope.md); [ADR-0061](0061-family-portal-scope-and-row-level-security.md);
[permissions.md](../specs/permissions.md); [platform.md](../specs/platform.md) PLAT-004; hazard
HZ-011. Revisit when grants become editable through the API (who may grant where) and when team
scope arrives with rotas (Phase 2).
