# Bank and agency workers (SCHED-009, Phase 2 slice 27)

Branch `feat/sched-bank-agency`, cut from `feat/sched-rota-builder`. Rules, schema, migration and
API. The screens are slice 59 and the clock-in check is slice 30.

## What changed

- `docs/specs/scheduling.md` section 15 (spec first) and
  [ADR-0088](../decisions/0088-rota-derived-agency-access.md) (rota-derived agency access).
- Domain:
  - `packages/domain/src/workforce/agency-checks.ts`: `agencyRosterChecks`, the agency's written
    confirmation on a day.
  - `packages/domain/src/scheduling/agency.ts`:
    - `bookingCostPence`;
    - `awrWeeksFromShifts`, which feeds slice 6's `awrClock`;
    - `agencyAccessWindow`.
- Migration `0104_bank_agency.sql`:
  - Tables `agency`, `agency_worker`, `agency_booking`, `location_induction` (append-only) and
    `agency_worker_feedback` (append-only), all with forced row-level security.
  - Guards:
    - only a member with no other role can be registered;
    - registering flags the member `is_agency` and holds them to the `agency_worker` role;
    - bookings are guarded, and a cancelled booking stays cancelled;
    - a worker marked do not book is refused.
  - The ADR-0088 window. A restrictive policy on `role_assignment` and `access_grant` hides an
    agency or bank member's own rows outside a booked shift plus `access.agency.post_shift_hours`.
    `app.agency_access_open` is a security-definer function.
- API (`apps/api/src/routes/agency.ts`):
  - agencies, workers and the agency's confirmation;
  - booking an open shift under the rostering rule, with the cost;
  - cancelling a booking, which closes access;
  - the AWR clock, inductions, feedback with do not rebook, and cost per agency.
- Other API changes:
  - Rota eligibility reads the agency's confirmation for agency workers.
  - The rota's check warns of missing inductions.
  - Search uses the booked shift's end.
  - A search test now expects `missing_permission` for an agency member with no booking.
- Hazards:
  - HZ-011 gains the access window.
  - HZ-124 gains bookings. The clock-in check moves to slice 30 (H-920).
- Data protection: records of processing (B3), data standards, retention, and the export catalogue
  (five tables).
- Human actions H-920 to H-929.

## Review round 1 (security and clinical safety)

- **Access window**:
  - per location;
  - applied when others ask about an agency member;
  - closed for a worker marked do not book;
  - the sync token is capped at its end;
  - the policy also covers owner-run functions;
  - a missing member row is closed.
- **`is_agency`** is set only by registering, which now needs member management as well, and
  nothing clears it.
- **Booking**:
  - bank and agency members go on shifts only by booking (deferred database guard; the assign
    route answers `book_instead`);
  - cancelling the shift or taking the worker off it cancels the booking;
  - a worked booking cannot be cancelled;
  - an archived agency is refused.
- **Agency checks**:
  - an agency worker's DBS is never overridden;
  - confirmations are dated no later than today;
  - do not book, or a changed confirmation, re-checks future bookings and cancels the ones that
    are now blocked.
- **Safeguarding**: a concern or do not rebook must say whether it is a safeguarding matter; if it
  is, an urgent task goes to the Registered Manager. Bookings show the number of concerns.
- **AWR clock**: weeks of seven days from the first shift's day; only started shifts with live
  assignments count.
- **Cost**: totals leave out cancelled shifts and cover at most 93 days.
- **Who can read what**:
  - agency workers' confirmations are read by rota managers only;
  - feedback must match its booking.
- **Docs**: ADR-0088, the spec, HZ-011, HZ-124, H-921, H-923 and H-928 updated.
