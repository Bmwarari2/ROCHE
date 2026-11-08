# Phone safety fixes from the guides review

Branch `feat/mobile-device-safety`, from main after #193. No migration. Findings from the guides
session's reading of the phone after #188, taken highest risk first, each with a hazard-log entry
(H-1604 is the CSO's stop-gap until they are fixed).

## What changed

- PRN: the amount typed is compared with what is left of the 24-hour maximum before the dose is
  given, not only "none left" (HZ-004).
- Correct: offered only on the member's own records, or anyone's with `medicines.record.manage`;
  `recorded_by` now syncs to the phone (HZ-004).
- Competence: the phone judges the member's own medicines competence from their synced sign-offs
  and withdrawals with `competenceDecision`, before any outcome (rule 22), and stops a lapsed,
  withdrawn or missing one before the record (HZ-119). The API's port does not read sign-offs yet
  (H-1532, blocking the phone medicines release).
- Amount: checked against the prescribed amount or range before it is given (HZ-004). The demo seed
  gives the demo owner, manager and nurse sign-offs to match the API's development port.
- Sign-out with unsent entries, from Settings or the lock screen, offers "Sign out and keep my
  entries" first, confirmed with the count, with "Stay signed in" at every step; deletion opens
  only when asked for; the server session ends at once (HZ-006, HZ-040).
- Keystore key no longer valid: the notice says how many unsent entries were lost, or that any may
  have been, and to tell the nurse in charge (HZ-006); the record at the server is H-1531.
- Round cards show the person's allergies, and Show record opens the record on a phone (HZ-001,
  HZ-007).
- Device mode: any member may make the phone safer (shared, a shorter lock); only a holder of
  `platform.device.revoke` makes it less safe (HZ-001); per-member PIN and photo sign-in waits for ADR-0025 (H-1530).
- The on-device integrity check is logged under HZ-004 with server attestation as the residual
  risk (H-1432).

## Still open

Shared-device PIN sign-in (H-1530), the key-reset record at the server (H-1531), the API's
competence port (H-1532), save
confirmation, a device-withdraw screen, phone incidents and passkeys, and the hard-coded sign-in,
lock and sync-banner strings. Maestro flows not run (no emulator).
