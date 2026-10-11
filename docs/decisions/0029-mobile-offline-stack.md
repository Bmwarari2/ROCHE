---
status: accepted
date: 2026-10-11
decision-makers: Claude Code (lead engineer)
consulted: master prompt sections 6, 17; apps/mobile/README.md
informed: everyone working on the mobile app
---

# Mobile offline stack and app identity

## Context and problem statement

Section 17.2 names Expo SDK 57+, op-sqlite with SQLCipher, PowerSync and expo-secure-store. Building the
Phase 0 skeleton showed version facts the section could not know.

## Decision outcome

- **Expo SDK 57 ships React Native 0.86.3** (not 0.87). The new architecture and Hermes are the only
  options, so `newArchEnabled` and `jsEngine` are no longer configured.
- **PowerSync React Native SDK 2.x** (`@powersync/react-native`), which bundles the op-sqlite adapter.
  `@powersync/op-sqlite` works only with the 1.x SDK and op-sqlite 15 or older, built against
  React Native 0.82. `@harbour/sync` therefore depends on `@powersync/common` 2.x.
- **SQLCipher**: `"op-sqlite": { "sqlcipher": true }` is set in both `apps/mobile/package.json` (Android
  build) and the root `package.json` (the iOS podspec reads the workspace root under pnpm). The app
  checks `isSQLCipher()` at start-up and refuses to store data if the build is not encrypted.
- **Database key**: one random 32-byte key per install, passed to SQLCipher raw (no key derivation on
  every open); database files are named per key; sign-out and remote wipe delete both. Shared devices:
  ADR-0025.
- **Better Auth on mobile** is called with plain `fetch` (`/api/auth/sign-in/email`, then
  `/api/auth/two-factor/verify-totp`) rather than `@better-auth/expo`, which would pull server packages
  into the bundle. The API trusts the `harbour://` origin and exposes `set-auth-token`.
- **Bundle identifier and Android package**: `uk.co.thapsus.harbour` (public listing, ADR-0010).
- **Tabs** use expo-router's JavaScript tabs with Lucide icons. Native tabs (Liquid Glass) are still
  marked unstable in expo-router and assume SF Symbols; `apps/mobile/README.md` records the migration.
- **Stale data** (HZ-002): data is labelled as possibly out of date after 15 minutes without a sync;
  to become a tenant setting in Phase 1. An unknown device mode is treated as shared (stricter lock).
- **Root and jailbreak detection** is an interface with a stub in Phase 0; recommendation for eMAR
  (Phase 2): `jail-monkey` (MIT) plus Play Integrity and App Attest verified by the API.

### Consequences

- Native builds, Maestro flows and device checks run only in CI on emulators (`.github/workflows/mobile.yml`)
  or on developers' machines; this cloud environment has no simulator.
