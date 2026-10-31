# Lone-worker safety (SCHED-012)

Branch `feat/sched-lone-worker`, Phase 2 slice 46, migration 0113.

## What changed

- Staff working alone start a session and check in on a schedule. A missed check-in, a call for
  help or a duress check-in raises an alarm to the organisation's named on-call route: the worker
  is reminded first, the on-call person is told the moment the alarm is raised, and the Registered
  Manager follows by the route's minutes. An open alarm is sent again until a person other than
  the worker acknowledges it with what they did.
- The feature stays off until the organisation names a valid on-call route (H-539).
- The offline rule: only check-ins the server has received count, from the time they were made,
  so an on-time check-in sent late is never counted as missed; silence past the grace period always
  raises the alarm; a late check-in made before the alarm resolves it as a late check-in, flagged,
  unless the worker is overdue again.
- Duress answers exactly as a check-in and is never shown to the worker. Help is always accepted.
- Location evidence is off by default, one point per event when on, and erased after 30 days.
- New permissions `scheduling.lone_worker.check_in`, `.monitor` and `.manage`; new rate rows
  `lone_worker.*`; retention class `lone_worker`; hazard HZ-125; human actions H-1030 to H-1039.

## What is next

- Web screens (slice 61) and the mobile app's one-tap check-in with an offline queue (slice 71).
- The CSO rates HZ-125 and confirms the figures; the DPO confirms the DPIA (H-1030 to H-1033).
