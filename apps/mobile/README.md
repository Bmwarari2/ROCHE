# Harbour mobile (`@harbour/mobile`)

One Expo app for iOS and Android (master prompt section 17). Phase 0 delivers **Care mode**: sign in,
unlock, and see the people assigned to you, from an encrypted on-device database that keeps working
with no signal. Manage and Family modes are stubs behind the mode chooser shown after sign-in.

Stack: Expo SDK 57 (React Native 0.86, New Architecture and Hermes, which are the only options in
this SDK), expo-router (native stack, tabs), PowerSync (`@powersync/react-native` 2.x with its
built-in op-sqlite adapter) over `@op-engineering/op-sqlite` built with SQLCipher, components from
`@harbour/ui-native`.

## Run it

A **development build** is required: op-sqlite, SQLCipher and the PowerSync SQLite extension are
native code, so Expo Go cannot run the app.

```sh
# from the repository root (other agents share the workspace, so installs are serialised)
pnpm install

cd apps/mobile
cp .env.example .env.local          # then edit EXPO_PUBLIC_API_URL
npx expo run:android                # or: npx expo run:ios  (builds and installs the dev client)
pnpm start                          # Metro for the installed dev client
```

Or build the dev client in the cloud: `eas build --profile development` (simulator) or
`--profile development-device`. `eas.json` holds no credentials; EAS manages them.

| Variable | Default | Meaning |
| --- | --- | --- |
| `EXPO_PUBLIC_API_URL` | `http://localhost:4000` | Harbour API. Release builds require `https`; plain `http` is accepted only for `localhost`, `10.0.2.2` (Android emulator) and `*.local` in development builds. |
| `EXPO_PUBLIC_DEMO_MODE` | `0` | `1` runs without the API (below). |

### SQLCipher must be switched on where op-sqlite looks

op-sqlite reads `"op-sqlite": { "sqlcipher": true }` from a `package.json` at native build time.
On Android it reads `apps/mobile/package.json` (set). On iOS its podspec walks up from its real
path, which under pnpm is inside `node_modules/.pnpm`, so it reads the **repository root
`package.json`**. The root needs the same block, or the iOS build links plain SQLite. The app fails
closed either way: before opening the database it checks `isSQLCipher()` and refuses to store care
data if encryption is missing.

## Demo mode

`EXPO_PUBLIC_DEMO_MODE=1 pnpm start` (or `pnpm start:demo`). Any email and password sign in; an
email containing `+totp` exercises the authenticator step with code `123456`. The app opens a
separate encrypted database (`harbour-demo-<id>.db`, all tables local-only so nothing is queued for
upload) and seeds three invented people: Ada Example (allergies recorded), Bea Sample (no known
allergies) and Cal Placeholder (allergies not recorded, two communication needs). NHS numbers come
from the 999 test range. The sync banner shows "Offline" with the time the demo data was seeded,
and every screen says "Demo mode".

## How it works

| Concern | Where | Notes |
| --- | --- | --- |
| Sign-in | `src/auth/auth-client.ts` | Better Auth with the bearer plugin, implemented with `fetch` (no `@better-auth/expo`, which would bundle server packages). Token from `set-auth-token`; TOTP via `two-factor/verify-totp` carrying the pending two-factor cookie. |
| Session | `src/app-state/session.tsx` | Token and cached `/v1/me` in the keystore (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`) so the app starts offline. |
| Encryption key | `src/security/db-key.ts` | Random 32-byte key per install in expo-secure-store with `requireAuthentication` and `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY`: reading it shows Face ID or fingerprint, which is the unlock. Passed to SQLCipher as a raw key (`x'…'`). If biometrics are not available the key is passcode-gated and `expo-local-authentication` asks for the passcode. Devices without a screen lock are refused. |
| Lock | `src/app-state/vault.tsx`, `src/security/idle-timer.ts` | Auto-lock after 2 minutes (personal) or 30 seconds to 2 minutes (shared device, set in Settings), counting time in the background. Re-unlock uses strong biometrics with passcode fallback. |
| Sync | `src/sync/connector.ts` | `fetchCredentials` calls `POST /v1/sync/token`; `uploadData` posts `{ operations }` to `POST /v1/sync/upload` with an `Idempotency-Key`, retrying network errors, 408, 425, 429 (honouring `Retry-After`) and 5xx with full-jitter backoff. Rejected writes stay queued and surface as "Sync failed"; they are never discarded. |
| Remote wipe | `vault.signOutAndWipe` | Sign-out, or a 401/403 from the sync token or upload endpoints, clears and deletes the database file and destroys its key. |
| Schema | `src/sync/schema.ts` | Rebuilds `@harbour/sync`'s schema for PowerSync 2.x from its JSON form (the shared package still uses `@powersync/common` 1.x); a test proves both serialise identically. Remove once `@harbour/sync` moves to 2.x. |
| Sync banner | `src/components/AppSyncBanner.tsx` | On every signed-in screen: offline, syncing, up to date, or sync failed with Retry; changes waiting to upload; a "may be out of date" warning after 15 minutes without a sync (HZ-002, HZ-006). |
| People | `src/app/(care)/people` | `useQuery` over local SQLite, scoped to the signed-in tenant, virtualised `FlatList`. Rows show photo or initials, name, room, allergy flag (three states, HZ-007) and communication-needs flag. |
| Photos | `src/people/photo.ts` | `GET /v1/people/{id}/photo` with the bearer token; held in memory only as data URIs. |
| Screen capture | `src/security/use-record-protection.ts` | Record screens block screenshots and recording (Android `FLAG_SECURE`, iOS capture prevention); the iOS app-switcher snapshot is blurred while signed in. Identifiers are rendered non-selectable, so they cannot be copied. |
| Root and jailbreak | `src/security/device-integrity.ts` | Interface with a stub that reports "unknown", so eMAR stays off. TODO before eMAR: `jail-monkey` (MIT) heuristics plus Play Integrity / App Attest verified by the API. |

### What the API must do for this client

- List `harbour://` in Better Auth's trusted origins (the app sends it as `Origin`).
- Expose `set-auth-token` on sign-in and TOTP verification responses.
- Return 401 from `/v1/me`, `/v1/sync/token` and `/v1/sync/upload` when the session is revoked (the
  device then wipes itself); 403 is treated the same way.
- Accept `Idempotency-Key` on `/v1/sync/upload` and record business conflicts as review tasks
  rather than failing the upload.
- Serve photos with `Cache-Control: no-store` so the native HTTP cache keeps no copy.

## Tests

```sh
pnpm --filter @harbour/mobile typecheck
pnpm --filter @harbour/mobile test      # Vitest: pure modules only (no React Native runtime)
cd apps/mobile && npx expo export --platform android --output-dir <tmp>   # proves Metro bundles
```

Unit tests cover the connector (credentials, upload mapping, retry and backoff, remote wipe), the
idle timer and auto-lock policy, staleness and banner states, the schema bridge, the database key,
the auth client, photos, environment parsing, and the People SQL, which runs against a real SQLite
engine (`node:sqlite`) with the demo seed.

### End-to-end tests (Maestro)

Flows live in `.maestro/`: `sign-in.yaml`, `offline-people-list.yaml`, `sync-recovery.yaml`. They
cannot run in this repository's sandbox (no simulator). CI runs them like this:

1. Build a release-like binary: `eas build --profile e2e --platform android` (APK, demo mode for the
   sign-in smoke test) and a `preview` build pointed at the CI API for the offline flows; or
   `npx expo run:android --variant release` on the runner.
2. Start the API stack (Docker Compose: Postgres, API, PowerSync) and seed the test tenant, whose
   care worker is assigned "Ada Example".
3. Android emulator (API 36, Google APIs image): set a screen lock and enrol a fingerprint with
   `adb shell locksettings set-pin 1111` and `adb -e emu finger touch 1`; a background step repeats
   `adb -e emu finger touch 1` while flows run to answer biometric prompts.
4. iOS simulator: enrol Face ID (`xcrun simctl spawn booted notifyutil -s com.apple.BiometricKit.enrollmentChanged 1`
   then `notifyutil -p com.apple.BiometricKit.enrollmentChanged`) and answer prompts with
   `notifyutil -p com.apple.BiometricKit_Sim.pearl.match`. Maestro's `setAirplaneMode` is Android
   only, so the offline flows run on Android in CI and on a device farm for iOS.
5. `maestro test .maestro --env HARBOUR_EMAIL=… --env HARBOUR_PASSWORD=… --env HARBOUR_TOTP=…`
   (CI computes the TOTP from the seeded secret immediately before the run).

## Store compliance notes for later phases

- Publisher Thapsus Cargo Ltd on both stores; bundle ID and application ID `uk.co.thapsus.harbour`
  cannot change after first submission. Decide public versus private distribution before first
  approval.
- iOS: the privacy manifest (`ios.privacyManifests` in `app.config.ts`) declares required-reason APIs
  and collected data (health, name, email address; linked, not tracking). Keep it in step with new
  modules (precise location for visit verification, photos, audio). Answer export compliance
  (`ITSAppUsesNonExemptEncryption`) once the encryption review is done. Build with the Xcode and iOS
  SDK Apple requires at submission. Exclude the database directory from iCloud and device backups
  (the key is device-only, so a backup is unreadable, but nothing should leave the device).
- Google Play: Data safety form (health info, photos, location when used), Health apps declaration,
  "not a medical device" statement, foreground-only location with prominent disclosure, target API
  level 36, account deletion web link and in-app path. `android.allowBackup` is off.
- Permissions are requested at first use with an explanation. Camera, microphone and location are
  blocked on Android until the modules that need them ship; their iOS usage strings are ready.
- EAS Update only for JavaScript and asset fixes within the published native capabilities.
- App icon, splash screen and store artwork are still to come.
- Native tabs: Care mode uses expo-router's JavaScript tabs with Lucide icons. Move to
  `NativeTabs` (Liquid Glass on iOS 26, Material 3 on Android) when it leaves
  `expo-router/unstable-native-tabs`, rendering Lucide glyphs from the `lucide-static` font through
  `expo-font`'s `renderToImageAsync`, never SF Symbols.
