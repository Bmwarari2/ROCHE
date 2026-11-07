---
status: "accepted"
date: 2026-11-07
decision-makers: engineering (Claude Code sessions), for the lead of Phase 2
consulted: clinical safety officer (HZ-115, HZ-116, HZ-119; H-1439), security (H-1440), reviews of slice 70
informed: Registered Managers in the pilot
---

# Witnesses and second signatures

## Context and problem statement

Phase 2 reserved this ADR for the second signature on controlled drugs and witnessed doses
(phase-2.md, decisions table). The web has used it since slices 22 and 34 as phase-2.md recorded
it: the witness signs in their own session with a fresh step-up, before the recorder's entry
names that signature (medicines.md 13.5 and 14.2). Slice 70 brings controlled drugs to the phone,
where there is often no connection, two people stand at one phone, and a server step-up is
impossible.

## Decision drivers

- Separation of duties: one person never records a controlled drug alone (master prompt 4; HZ-116).
- The witness must be who they say, and must have seen this dose: the signature binds the person,
  the medicine, the amount and this record's id.
- Offline-first at the point of care; the server still decides.

## Considered options

1. Controlled drugs only online, on the web or the phone.
2. A witness's typed name or tick box on the phone, reviewed later.
3. Per-member signing keys on the phone, unlocked by each member's own PIN, verified by the server.

## Decision outcome

Option 3.
- **Web** (unchanged): the witness's own session and fresh step-up (`step_up`).
- **Phone** (`device_factor`): each member who may record or witness controlled drugs sets a
  medicines PIN on the phone while online, signing in for this alone with their second factor
  (the step-up); the phone makes an ECDSA P-256 key, keeps the private half sealed by the PIN
  (scrypt, AES-256-GCM) in its encrypted database and enrols the public half
  (`POST /v1/me/device-keys`, migration 0153, `member_device_key`, append-only). A key belongs to
  one member and one phone database; the newest one for them signs.
- A controlled drug given offline carries two signatures over one fixed statement
  (`cdDoseStatementText`, `harbour-cd-dose-v2`: organisation, phone, role, signer, recorder, person,
  chart entry, record id, movement, medicine (VMP), time given, amount, unit, time signed). The
  witness signs first, at their own step, as they see the dose given; that fixes the record's id,
  amount and time. Where the policy allows it, a lone worker gives why no one could witness with
  their own signature instead. The recorder's own signature stands for their step-up; the witness signs on
  the same phone with theirs. On upload the API verifies both; judges the phone and the key on arrival, never by the phone's
  clock; takes no signature older than the offline window; checks the witness signed before the
  recorder and within `medicines.cd.witness_assertion_minutes`, the recorder's time against the
  record's own UUIDv7 time, the witness's reach (`medicines.cd.witness`) and competence both when
  they signed and on arrival, and that the witness is not the recorder. A refused dose is copied to
  the server with an urgent review (HZ-115). The witness's signature then becomes the register's own assertion, used at
  once by the entry, so the register's rules are the web's.
- Wrong PINs are throttled (doubling waits after five), never a lockout (NCSC).
- Corrections of a controlled drug's record, and stock checks, stay on the web.

### Consequences

- Good: two people, each proven, offline; the server checks everything again; no new register path.
- Bad: a witness types their password and code into another member's phone once to set a PIN; a
  copy of the phone's database can be attacked offline against the PIN (scrypt slows it; H-1440);
  a refused offline dose has already been given (HZ-116 control and H-1439).

### Confirmation

`packages/domain/src/medicines/device-signature.test.ts`, `packages/db/test/device-keys.test.ts`,
`apps/api/test/device-signatures.test.ts`, `apps/mobile/src/medicines/device-key.test.ts`,
`cd-sign.test.ts`; Maestro `medicines-gate-journey.yaml` (written, not run).
