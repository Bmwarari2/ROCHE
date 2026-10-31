---
status: "accepted"
date: 2026-10-31
decision-makers: Engineering (Phase 2 slice 24), on the Appendix default in docs/plans/phase-2.md
consulted: DPO and solicitor to review (H-528, H-720)
informed: Lead session, tenants' Freedom to Speak Up leads
---

# Restricted silos: whistleblowing and speak-up (and casework later)

## Context and problem statement

Speaking up only works when people trust that what they raise reaches the right person and nobody
else, and that an anonymous concern cannot be traced back to them (safety.md Phase 2 rule 3;
SAFE-012; National Guardian's Office guidance on Freedom to Speak Up). Harbour's owner and
Registered Manager roles are built as "every permission except a few", and the shared workflow,
audit and outbox tables are readable by wide roles. A speak-up concern placed in those tables
would be visible to the very managers it may be about, and an anonymous one could be traced by its
timing, IP address or device. Phase 2 slice 24 must decide how the silo works. Employee relations
casework (slice 39) needs the same pattern.

## Decision drivers

- No wider role reaches a concern: not the owner, not the Registered Manager, not the quality lead,
  not break-glass, not a grant.
- An anonymous concern stores nothing that identifies who raised it, anywhere: the record, audit,
  outbox, logs, IP addresses or devices. Two-way contact still works.
- A confidential concern is known only to the Freedom to Speak Up lead.
- Casework is visible only to the people named on the case.
- Row-level security enforces it, not only the API.

## Considered options

- Ordinary tables with an API-level filter.
- A separate database or schema per tenant for restricted data.
- Restricted tables inside the tenant database, with a silo permission that no wider role holds,
  silo-only RLS policies, no use of the shared workflow tables, and an unauthenticated route for
  anonymous concerns (the Appendix default).

## Decision outcome

Chosen: the Appendix default (option 3).

- **Silo permission.** `safety.speak_up.manage` (the Freedom to Speak Up lead) is a silo permission
  (`SILO_PERMISSIONS`). Built-in roles built from "every permission" leave it out, and only the
  built-in `speak_up_guardian` role carries it. The database refuses the following:
  - a role that mixes a silo permission with any other permission;
  - an access grant carrying a silo permission;
  - a member appointing themselves to a silo role;
  - holding a silo role together with a role that manages users or roles.

  So the owner cannot take the lead's view by editing roles.
- **Silo tables** (migration 0086): `speak_up_concern`, `speak_up_reporter`, `speak_up_case_member`
  and `speak_up_message`. Their RLS policies open them to three groups only:
  - holders of the silo permission;
  - members named on the case (the concern and its messages);
  - the reporter of a named or confidential concern (their own concern and messages).

  A confidential reporter's identity is readable only by the lead and the reporter, and a named one
  also by the case's members. Concerns do not use the shared `workflow_instance` table, which wider
  roles can read: the state lives on the concern, checked with the domain's `SPEAK_UP_WORKFLOW`. The
  silo is not in the free full export; the lead exports it separately (H-721).
- **Anonymous concerns** arrive on a public route (`/p/speak-up/{tenantId}`), with no session, so no
  device binding, session or per-user limit records the request. The concern stores no reporter,
  no creator and no IP address. Its audit event names no actor, IP or device. No outbox event is
  published for it.
  - A reporter who wants replies receives a reply token once: 256 random bits, base64url. It is
    stored only as its SHA-256 hash, sent only in request bodies and never in a URL.
  - Row-level security opens the one concern and its messages to a public request carrying that
    token's hash.
  - Throttling is in memory, by address, and never stored.
- **Raising a named or confidential concern** is audited with no actor, IP or device either. The
  concern's creator columns stay empty, and the reporter is linked only through `speak_up_reporter`.
- **Casework** is visible only to the people the lead names on the case.

### Consequences

- Good: wider roles cannot see a concern even with direct database access through the application
  role, and an anonymous reporter leaves no stored trace beyond what they wrote.
- Bad: speak-up concerns do not appear on the approvals list or dashboards. The lead sees them on
  their own list.
- Residual risk: an authenticated (named or confidential) reporter's session activity elsewhere could
  line up in time with a concern only for someone who can already read the concern. What an
  anonymous reporter writes may itself identify them; the guidance to reporters says so (H-722).
- Residual risk: someone who manages users could appoint an account they control as the lead. Every
  appointment is audited, and the DPO reviews who holds the role (H-720).

### Confirmation

`packages/db/test/speak-up.test.ts` proves that the owner, the Registered Manager, the quality lead,
a member and another organisation read nothing. It also proves the role, grant and appointment
guards and the token rules. `apps/api/test/speak-up.test.ts` proves that nothing identifying an
anonymous reporter reaches audit or outbox, and that the reply token works only hashed and only in
a body.

## More information

ADR-0050 (public evidence links: the model for an unauthenticated, token-bound session),
ADR-0071 (scope per permission). Employee relations casework (slice 39) reuses this pattern with
its own silo permission.
