---
status: "accepted"
date: 2026-10-11
decision-makers: Claude Code (lead engineer); the security reviewer's findings on the family feed
consulted: ADR-0002, comms.md, people.md rule 13
informed: Brian, the data protection lead, the CSO
---

# Family portal scope: portal sessions, no person assignment, and a sharing-decision policy

## Context and problem statement

ADR-0002 scopes people for staff: tenant, location, assignment or break-glass, enforced by
`app.person_in_scope` on `person` and, through `app.person_visible`, on every child table. The
built-in "Family or representative" role has scope `assigned`. If family members were given
`person_assignment` rows to see "their" person, every child table (contacts, allergies, care
notes, incidents) would open to them through `app.person_visible`, and the only thing standing
between a family member and the whole record would be the API. Master prompt sections 4 and 15.1
say a family member sees one person's updates, consented care plan sections and what their
authority covers, and that every check is enforced again in Postgres. How should a family session
be scoped so that the database itself shows only what a sharing decision opens?

## Decision drivers

- Fail closed in the database, not only in the API (ADR-0002, HZ-011, HZ-022).
- One rule for visibility: the sharing decision (people.md rule 13), not a second scope model.
- Staff and portal access never mix in one session or one role.
- The family app mode (Phase 4) syncs through PowerSync, which bypasses RLS.

## Considered options

- Family members get `person_assignment` rows, and the API filters by sharing decision.
- Family sessions get no person scope; feed tables carry a restrictive policy that calls a
  sharing-decision function; family-owned rows are keyed on the family member's contact.
- A separate schema or views per family member.

## Decision outcome

Chosen option: "no person scope, a sharing-decision policy", because it keeps every staff table
closed to a family session by the existing person scope and opens only the feed, through the same
rule the domain applies.

- A portal session is resolved from portal roles only: `resolveAccess(assignments, grants, at,
  "portal")` returns only portal-only permissions, no grants, and scope `none`; a staff session
  never carries a portal-only permission, and a role or grant mixing the two is refused
  (`checkRoleDefinition`, `checkGrantPermissions`) and ignored if stored
  (`packages/domain/src/platform/access.ts`).
- Family members get no `person_assignment`. The request context gains `app.family_contact_ids`
  from a `family_portal_user` link between the tenant user and their contact record.
- Feed tables carry a restrictive policy: staff sessions through `app.person_visible`, family
  sessions through `app.family_can_see(person_id, section, care_plan_domain, occurred_at)`, a
  `SECURITY DEFINER` function owned by a NOLOGIN role with a fixed search path that mirrors
  `checkFeedItemVisibility` (decision for one of the caller's contacts, section and domain covered,
  in force and not suspended both when the thing happened and now, authority not lapsed, the
  capacity rule, person receiving care, same tenant).
- Family-owned rows (`family_channel`, `family_notification_setting`, `visit_booking`) are keyed on
  `contact_id = ANY (app.family_contact_ids())`, with WITH CHECK on writes.
- The policy sketch and the isolation test list are in [comms.md](../specs/comms.md) section 2.1.

### Consequences

- Good, because a family session reaches no staff table even if an API route forgets a check.
- Good, because the database and the domain apply one visibility rule.
- Bad, because `app.family_can_see` duplicates the domain rule in SQL; drift is caught only by
  tests that run both against the same fixtures.
- Bad, because a `SECURITY DEFINER` function is a privilege boundary that needs careful review.
- Neutral, because the person's own portal (COMMS-003, Phase 4) needs its own `self` policy on the
  same pattern.

### Confirmation

Domain: `packages/domain/src/platform/access-portal.test.ts`. Schema step: the isolation tests in
comms.md section 2.1 in `packages/db/test`, including a test that enumerates every table with a
person column and finds no rows for a family session, and a test that runs the domain rule and
`app.family_can_see` over the same fixtures. Phase 4: family sync stream tests.

## Pros and cons of the options

### Person assignments for family members

- Good, because nothing new is needed in the database.
- Bad, because every child table opens to the family through `app.person_visible`.
- Bad, because the API becomes the only control, against section 4 and ADR-0002.

### No person scope and a sharing-decision policy

- Good, because it fails closed and reuses the sharing rule.
- Bad, because of the SQL copy of the rule and the definer function.

### A schema or views per family member

- Good, because isolation is easy to see.
- Bad, because it multiplies objects per family member and breaks migrations and sync.

## More information

[ADR-0002](0002-tenancy-and-row-level-security.md); [comms.md](../specs/comms.md) sections 2.1
and 3; [people.md](../specs/people.md) rule 13; hazard HZ-022. Revisit with the person's own
portal (COMMS-003) and the family app mode (MOB-004).
