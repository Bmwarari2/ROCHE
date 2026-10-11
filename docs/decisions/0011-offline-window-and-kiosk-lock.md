---
status: accepted
date: 2026-10-11
decision-makers: Brian (Thapsus Cargo Ltd, Appendix default); recorded by Claude Code
---

# Offline window of 7 days and a 30-second kiosk lock

## Context and problem statement

The mobile app keeps an encrypted local copy of records so carers can work without signal. How many
days of records does a device keep, and how quickly do shared (kiosk) devices lock?

## Decision drivers

- Offline-first at the point of care; connectivity is a barrier for 40% of providers.
- Data minimisation: a lost device should hold as little personal data as possible.
- Shared tablets are used by many staff; an unlocked tablet exposes records.

## Considered options

- Offline window: 3, 7 or 14 days.
- Shared-device lock: 30 seconds, 1 minute or 2 minutes.

## Decision outcome

Chosen option: "7-day offline window; kiosk lock 30 seconds by default", because it is the Appendix
default and matches section 17.2.

- Events older than the tenant's offline window are evicted from the device. Reference data for
  assigned people (care plan summary, allergies, medicines, photo, communication needs) is never
  evicted while the assignment stands. Sync streams cover the user's assignments and the next 7 days of
  schedule.
- Auto-lock: 2 minutes idle on personal devices; 30 seconds by default on shared and kiosk devices,
  configurable per tenant from 30 seconds to 2 minutes. On shared devices the MDM-enrolled device is the
  possession factor and sign-in is PIN or biometric plus the user's photo.

### Consequences

- Good, because a week without connectivity (or a regional outage, ADR-0001) does not stop care.
- Bad, because a lost device may hold up to 7 days of notes for assigned people; mitigated by SQLCipher
  (AES-256), a secure-store key requiring device authentication, biometric lock and remote wipe.
- The values are tenant defaults stored in the rate table (`mobile.offline_window_days`,
  `mobile.auto_lock_seconds.*` in `docs/specs/rates.md`), not literals in the app.
- Compensating controls for shared devices are documented in `docs/compliance/kiosk.md`.

## More information

- Takes effect: Phase 1.
- How to change: supersede this ADR or change the tenant setting within the allowed range.
