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
  with the domain rule, and stops a lapsed or missing one before the dose (HZ-119). The demo seed
  gives the demo owner, manager and nurse sign-offs to match the API's development port.
- Sign-out with unsent entries, from Settings or the lock screen, offers "End my session and keep
  my entries" first; deletion opens only when asked for (HZ-006, HZ-040).
- Keystore key no longer valid: the notice says how many unsent entries were lost, or that any may
  have been, and to tell the nurse in charge (HZ-006); the record at the server is H-1531.
- Round cards show the person's allergies, and Show record opens the record on a phone (HZ-001,
  HZ-007).
- Device mode (personal or shared) and a shared device's lock time need `platform.device.revoke`
  (HZ-001); per-member PIN and photo sign-in waits for ADR-0025 (H-1530).
- The on-device integrity check is logged under HZ-004 with server attestation as the residual
  risk (H-1432).

## Still open

Shared-device PIN sign-in (H-1530), the key-reset record at the server (H-1531), save
confirmation, a device-withdraw screen, phone incidents and passkeys, and the hard-coded sign-in,
lock and sync-banner strings. Maestro flows not run (no emulator).
