---
status: "accepted"
date: 2026-10-31
decision-makers: Harbour engineering (Phase 2 lane B)
consulted: Clinical safety officer (HZ-119, HZ-124; rating at the Phase 2 workshop, H-543), security reviewer
informed: Medicines (lane A) and scheduling (lane C) builders
---

# Competence gating across modules

## Context and problem statement

Master prompt sections 10.2 and 12.2: a worker without a valid observed competence must not give
medicines, and a worker without a required check or competence must not be rostered to a shift
that needs it (HZ-119, HZ-124). Workforce owns training and competence (slice 17); medicines
(slices 3, 16 and 22) and scheduling (slices 21 and 27) must apply it. Bounded contexts may not
join each other's tables (section 6), and a competence must never be taken from the client.
[phase-2.md](../plans/phase-2.md) sets this decision as the default for slice 17.

## Decision drivers

- Safety: an expired or missing competence blocks the action (HZ-119), on the server, whatever
  the device says.
- No cross-module joins; modules talk through published ports and outbox events.
- Offline administration (section 17.1) needs the member's own competence on the device.
- An override must exist for exceptional cover, but be rare, justified, logged and reported.

## Considered options

- A published port in the API plus outbox events (workforce owns the rows).
- Medicines and scheduling read `competence_sign_off` directly.
- The client sends the worker's competence with each administration.

## Decision outcome

Chosen option: "a published port in the API plus outbox events", because it is the only one that
keeps the module boundary and never trusts a client-supplied value.

- Workforce owns `competence_sign_off` and `competence_withdrawal` (migration 0079). Every
  sign-off and withdrawal publishes `workforce.competence.changed` on the outbox (opaque ids, the
  competence code and the new valid-until date only).
- The port is `competencePort` in `apps/api/src/services/competence-port.ts`: given a member, a
  competence code and an instant, it reads that member's acceptable, unwithdrawn sign-offs with the
  system's rights for that one question (the caller may not see the member's training file) and
  returns `competenceDecisionAt` from `packages/domain/src/workforce/competence-port.ts`: allowed
  with the valid-until date, or blocked with the reason (`missing`, `expired`, `withdrawn`).
  Medicines and scheduling call it on the server with a member id the server knows (the member
  acting, never one from the request body); their APIs never accept a competence from the client.
- Time: the server's clock decides. A caller may also pass the time the device says the action
  happened (an administration recorded offline); the port then decides at both and blocks if
  either blocks, so a device's earlier or later time can only block, never allow.
- A withdrawal is about the member: from the day of the latest withdrawal only a sign-off
  observed on or after that day counts, and the database refuses one dated before it.
- On the device, the member's own sign-offs sync for offline administration (slice 71); the
  server checks again when the administration arrives, and a mismatch becomes a review task
  (section 17.1).
- An override is the calling module's: in medicines, a holder of `medicines.override.approve`
  records it with a justification, and it is logged and reported (slice 22); in scheduling, the
  rostering rule's override (workforce.md rule 10). The port itself never overrides.

### Consequences

- Good, because the rule is decided in one place, on the server, with the same UK dates for every
  caller.
- Good, because medicines and scheduling can be built against the port's contract before this
  slice merges (a contract-tested mock).
- Bad, because the port reads with the system's rights for one member and one competence; it is a
  narrow exception to the caller's own row-level security, returns dates only, and the calling
  module records the check with its own audited action.

### Confirmation

`apps/api/test/training-competence.test.ts` (the port: allowed, expired, withdrawn, missing, a
device's earlier time blocking, another member whatever the caller can read), `packages/domain/src/workforce/competence-port.test.ts`, and the HZ-119 and
HZ-124 verification rows.
