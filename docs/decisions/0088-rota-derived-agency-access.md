---
status: "accepted"
date: 2026-10-31
decision-makers: Harbour engineering (Phase 2 lane C)
consulted: Security reviewer, clinical safety officer (HZ-011, HZ-124; rating at the Phase 2 workshop, H-543)
informed: Platform (search, access), workforce and care builders
---

# Rota-derived scope and agency access

## Context and problem statement

Master prompt section 4: "Agency access ends at shift end plus 2 hours". Section 5.3 says to enforce
every check in the API and again in Postgres row-level security. Before Phase 2 there were no rotas.
An agency or bank worker (`tenant_user.is_agency`) kept whatever their role assignment gave them for
as long as it lasted, and only search failed closed (`no_shift_recorded`,
[platform-completions.md](../specs/platform-completions.md) rule 5). Slice 21 built rotas and slice
27 builds bookings, so the shift is now known. [phase-2.md](../plans/phase-2.md) names this ADR:
"An agency or bank worker's access comes from their booked shifts and ends at shift end plus
`access.agency.post_shift_hours`; no shift, no access. Team scope from the rota (HZ-011) is a
tenant setting, off by default, until reviewed".

## Decision drivers

- No shift, no access, enforced in the database as well as the API. A route that forgets the
  check must still get nothing.
- One mechanism for every permission check. There are many `app.holds_*` functions and the API's
  `resolveAccess`; changing each one would invite a gap.
- The figure stays in the rate table (`access.agency.post_shift_hours`), never a literal.
- No recursion between row-level security policies.

## Considered options

- **A window over the member's own role rows.** A restrictive SELECT policy on `role_assignment` and
  `access_grant` hides an agency or bank member's own rows from them outside a booked shift window.
- **Bookings create time-boxed role assignments.** Each booking writes a role assignment or grant
  valid for the shift window.
- **An API-only check in access resolution.**

## Decision outcome

Chosen option: **a window over the member's own role rows** (migration 0104).

- `app.agency_access_open(p_user)` returns true unless the member is an agency or bank worker. For
  such a member, it returns true only while a confirmed booking's live shift has started and
  `access.agency.post_shift_hours` (rate table) have not yet passed since it ended.
  - It is SECURITY DEFINER. It reads bookings and shifts the member cannot read themselves, and so
    avoids recursion through the rota policies.
  - Only `harbour_app` and `harbour_owner` may execute it.
- The policy `agency_window` on `role_assignment` and on `access_grant` is restrictive, for SELECT,
  to `harbour_app`. Its condition is `tenant_user_id IS DISTINCT FROM app.current_user_id() OR
  app.agency_access_open(tenant_user_id)`.
  - Every `app.holds_*` function reads the caller's own rows with invoker rights. So does the API's
    `accessRowsOf`, which reads them under the member's own context at sign-in and on each request.
  - Outside the window, the member therefore holds nothing in the API or in Postgres.
  - Managers still see the member's roles: the condition applies only to the member's own rows.
- Search now passes the end of the current booking as `agencyShiftEndsAt`, so its window matches.
- Booking a worker onto a shift is the only way to open the window. A role assignment still says
  what they may do and to whom (`agency_worker`: point-of-care permissions, assigned people).
- Rota-derived team scope is not built. It stays off by default (a tenant setting for a later
  slice, H-929).

Rejected:

- **Time-boxed role assignments per booking.** Writing roles needs `platform.user.manage` and
  passes through the invitation triggers. It would also leave any long role assignment a manager
  made for an agency worker still open.
- **An API-only check.** It breaks section 5.3.

### Consequences

- Good: one restrictive policy covers every permission check in both layers. The window's figure
  comes from the rate table, and a cancelled booking or shift closes the window at once.
- Bad: an agency worker cannot sign in usefully before their shift starts. Early access for a
  handover before the shift is H-921.
- Bad: a manager who books themselves as bank staff is gated too, if their member row is flagged
  `is_agency`. That is intended: `is_agency` marks the member.
- Search's own `no_shift_recorded` refusal is now reached only when the role rows are visible but no
  booking is open. In practice the permission check refuses first, with `missing_permission`.

### Confirmation

`packages/db/test/agency.test.ts` covers:

- no permission for an agency member with no booking;
- permission from shift start until shift end plus the rate table's hours, and none after;
- a cancelled booking closes the window;
- other members' rows are unaffected.

`apps/api/test/agency.test.ts` covers an agency member refused outside a booked shift and allowed
during it. The definer function is listed in `packages/db/test/definer-acls.test.ts`.
