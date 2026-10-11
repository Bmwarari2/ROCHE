---
status: proposed
date: 2026-10-11
decision-makers: Claude Code (lead engineer) pending Clinical Safety Officer and DPO review
consulted: docs/compliance/kiosk.md; master prompt sections 5.3 and 17.2; WCAG 2.2 SC 3.3.8
informed: everyone working in this repository
---

# Shared and kiosk devices: sign-in factors and the database key

## Context and problem statement

Section 17.2 says shared devices sign in with "PIN or biometric plus the user's photo", with the
MDM-enrolled device as the possession factor, and that the local database key is held in the secure
store with `requireAuthentication`. Two facts complicate this. iOS and Android biometrics only report
that some enrolled face or finger matched, not which person, so on a shared tablet a biometric cannot
identify the user. And `requireAuthentication` ties the key to the device owner's biometrics, which do
not exist on a shared device.

## Decision outcome (proposed)

- Personal devices: biometric (strong) or device passcode unlocks the per-install database key, held in
  `expo-secure-store` with `requireAuthentication` and `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY`, as written.
- Shared and kiosk devices: the user signs in with their personal PIN plus the photo shown for
  confirmation; device biometrics are not offered. The database key is device-bound (secure store
  without `requireAuthentication`) and the device itself must be MDM-enrolled with a device passcode.
  Per-user NFC badges or FIDO2 keys are the preferred later option, because a PIN is a memory test
  (WCAG 2.2 SC 3.3.8 asks for an alternative).
- Compensating controls are listed in `docs/compliance/kiosk.md`.

This narrows section 17.2 for shared devices; it needs the CSO and DPO to accept the residual risk
before the first shared-device deployment (logged in docs/plans/human-actions.md).
