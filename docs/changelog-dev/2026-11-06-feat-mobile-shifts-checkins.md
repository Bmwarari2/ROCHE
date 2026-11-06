# Shifts, the clock and lone working on the phone (MOB-007, SCHED-002, SCHED-004, SCHED-012)

Branch `feat/mobile-shifts-checkins`, slice 71 (no PR yet).

## What changed

- Sync: the member's own published shifts and clock events reach their phone (`my_shifts`,
  `my_clock_events`), for the token's shift days, which only holders of
  `scheduling.timesheet.self` get; migration 0139 publishes the tables. No lone-worker table syncs.
- Phone: a Shifts tab with "needs attention" first, the clock (in, breaks, out), my shifts and lone
  working (start, check in, help, finish). Everything is saved on the phone with a client UUID and
  sent to its own API route when there is a connection; a refusal shows in the API's words.
- Duress is a long press on Check in and looks exactly like a check-in everywhere on the phone; a
  refused duress press is kept as a check-in. Help offline says it has not reached anyone, and to
  call 999.
- The shared native button takes an optional long press with the same feedback as a press.
- Tests: sync streams, the token's shift days, the phone's logic, SQL, connector and rendering; a
  Maestro flow for the demo build (written, not yet run on a device). Demo shifts added.
- Docs: scheduling.md section 18; HZ-010, HZ-124 and HZ-125 (and the two sections untangled after
  the slice 46 merge); data standards and records of processing for data on the device; H-1310 to
  H-1319.

## Review round 1

- Accessibility: answers, help and an overdue check-in are said aloud on iOS too (a duress press
  exactly as a check-in); warnings carry an icon; finishing asks first; help is never held up by
  another press; whole sentences instead of a fragment; dates as "11/10/2026, 08:00 to 16:00".
- Clinical safety: help says when it was refused and reached nobody; a session known only on the
  phone, or a refused start, says nobody is told; the last answer from Harbour is kept, with its
  time, across a restart; the server's due time is used when nothing waits; help stays while a
  finish waits; duress acts on release; clock-change tests. An API accepting help and duress for an
  unknown session is H-1317.
- Security: held clock and lone-working actions go back into the queue at sign-in; a duress press
  is kept as a check-in wherever it is parked; queued ids must match the idempotency key; queued
  actions count only for the signed-in organisation.

## What is next

- Run the Maestro flow on an emulator; a local reminder when a check-in falls due offline
  (H-1313); Welsh strings (H-1319).
