# Harbour mobile (`@harbour/mobile`)

One Expo app for iOS and Android (master prompt section 17). **Care mode** works with no signal from
an encrypted on-device database: sign in, unlock, see the people assigned to you on Today with the
sync status, and for each person read the point-of-care header, write or correct notes, record
charts (fluids, food with IDDSI, repositioning, bowel, weight, vital signs with NEWS2), add body map
marks, and read the care plan and risk assessments. Entries upload when the device is online
(Phase 1 slice 10 part 1; tasks, handover and the conflict review come in part 2). Manage and Family
modes are stubs behind the mode chooser shown after sign-in.

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
from the 999 test range. Care records are invented too: Ada has a DNACPR decision whose review is
overdue, IDDSI levels, a care plan, risk assessments and a MUST result; Bea has a ReSPECT plan and
SpO2 scale 2; Cal has no resuscitation record, so the header reads "not recorded". Entries written in
demo mode stay on the device and say so. The sync banner shows "Offline" with the time the demo data
was seeded, and every screen says "Demo mode". A demo database seeded by an earlier version keeps its
old seed; sign out and in again to see the care records.

## How it works

| Concern | Where | Notes |
| --- | --- | --- |
| Sign-in | `src/auth/auth-client.ts` | Better Auth with the bearer plugin, implemented with `fetch` (no `@better-auth/expo`, which would bundle server packages). Token from `set-auth-token`; TOTP via `two-factor/verify-totp` carrying the pending two-factor cookie. |
| Session | `src/app-state/session.tsx` | Token and cached `/v1/me` in the keystore (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`) so the app starts offline. |
| Encryption key | `src/security/db-key.ts` | Random 32-byte key per install in expo-secure-store with `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY`, passed to SQLCipher as a raw key (`x'…'`). With strong biometrics the key also needs `requireAuthentication`: reading it shows Face ID or a fingerprint, which is the unlock. Without them expo-secure-store cannot tie the key to the device passcode (its `requireAuthentication` accepts biometrics only), so on a passcode-only device the key is readable by the app whenever the device is unlocked, and `expo-local-authentication` asks for the passcode before the database opens: a check in the app, not a lock on the key. Binding the key to the passcode needs a small native module (iOS `SecAccessControl` with `.userPresence`, Android Keystore with device-credential authentication); the decision is human action H-86 (security review S9). Devices without a screen lock are refused. |
| Lock | `src/app-state/vault.tsx`, `src/security/idle-timer.ts` | Auto-lock after 2 minutes (personal) or 30 seconds to 2 minutes (shared device, set in Settings), counting time in the background. Re-unlock uses strong biometrics with passcode fallback. |
| Sync | `src/sync/connector.ts` | `fetchCredentials` calls `POST /v1/sync/token`. `uploadData` sends each care entry (notes, observations, body-map marks, activities, visits) to its own API endpoint (`src/sync/care-upload.ts`) with its UUIDv7, `deviceTime`, and the `x-harbour-tenant`, `x-harbour-device`, `Idempotency-Key` and `x-harbour-sent-at` headers (stamped as each request leaves); other tables go to `POST /v1/sync/upload` with `deviceSentAt`. Network errors, 408, 425, 429 (honouring `Retry-After`) and 5xx retry with full-jitter backoff and stay queued. A refusal moves the entry, with its content, to the local-only `upload_issue` table and the queue moves on; Today and the record show it as "not saved: needs attention" until someone removes it with a recorded reason. Nothing is discarded silently. A 403 is read from its problem body (`src/sync/session-signals.ts`): a session code ends the session; any other API code on the sync token or a batch upload means the access Care mode needs was withdrawn, and on a single care entry refuses that entry; only a 403 with no body, an HTML page or `edge_blocked` asks `GET /v1/me` first, in the session's organisation, and ends the session when that answers 401, a session code or without `people.person.read`. A Retry-After is honoured up to 10 minutes. |
| Offline window | `src/sync/offline-window.ts`, `vault.connectSync` | The API puts the window in the signed sync token (`offline_days`, from `mobile.offline_window_days`) and the streams read it only from there, so the device cannot widen it. The device reads the same figure from `GET /v1/rates/{key}` (cached in `sync_meta`; today only until first read) only to say how many days it keeps, and reconnects when the UTC day changes so a new token moves the window. `src/sync/clock-tolerance.ts` reads `sync.clock_drift_flag_minutes` the same way: how far ahead of the device clock a typed time may be (none until read). |
| Care mode | `src/app/(care)`, `src/care`, `src/components` | Pure rules in `src/care` (notes, charts, IDDSI, NEWS2 via `@harbour/domain`, body map sides, header flags, Today's sync summary, local SQL), tested in Node. Screens: Today, the person's record, note, chart, body map, care plan and risk assessments, each starting with `CarePersonHeader`. Words come from `@harbour/i18n` (`mobile.*` keys) through `src/i18n/t.ts`. |
| Remote wipe and held entries | `vault.signOutAndWipe`, `src/app-state/held-work.ts`, `src/app-state/tombstones.ts`, `src/sync/discards.ts`, `src/sync/held-limit.ts`, `src/platform/notifications.ts` | Sign-out clears and deletes the database file and destroys its key; with entries unsent it shows the count and needs a coded reason and device authentication. A 401, or a 403 with a session code, from the sync token, an upload or `/v1/me` does the same only when nothing is waiting to upload. With entries unsent the device copies the upload queue into `held_entry`, clears everything else synced, stops uploading and asks the owner (the `tenant_user` recorded inside the database and checked before connecting) to sign in again; anyone else is refused. Nothing is deleted automatically: at `mobile.held_entries_max_days` the hold escalates to a manager, with local notifications. Deleting held entries needs the owner's or a manager's sign-in on the device, a coded reason and device authentication. Every deletion is put on record as requested first (a keystore tombstone with codes, its stage and opaque ids), then as deleted once the file and key are gone, or as failed, after which what is left is never uploaded. Each stage goes to `POST /v1/sync/discards` with the coded reason only, again at each sync until acknowledged; someone else's entries wait for the acknowledgement before anything is deleted. Words for removing one refused entry stay in the encrypted database (HZ-006, HZ-040). |
| Device report | `src/sync/device-report.ts` | Unsent, refused and held counts, the oldest age and when a hold started (no personal data) to `POST /v1/sync/device-report` after each sync when they change, and as soon as a hold starts (with the ending session, then again while the app runs, otherwise with the next session in the tenant). The server keeps a task for the Registered Manager while anything waits. |
| Schema | `src/sync/schema.ts` | Rebuilds `@harbour/sync`'s schema for PowerSync 2.x from its JSON form (the shared package still uses `@powersync/common` 1.x); a test proves both serialise identically. Remove once `@harbour/sync` moves to 2.x. |
| Sync banner | `src/components/AppSyncBanner.tsx` | On every signed-in screen: offline, syncing, up to date, or sync failed with Retry; changes waiting to upload; a "may be out of date" warning after 15 minutes without a sync (HZ-002, HZ-006). |
| People | `src/app/(care)/people` | `useQuery` over local SQLite, scoped to the signed-in tenant, virtualised `FlatList`. Rows show photo or initials, name, room, allergy flag (three states, HZ-007) and communication-needs flag. |
| Photos | `src/people/photo.ts` | `GET /v1/people/{id}/photo` with the bearer token; held in memory only as data URIs. |
| Screen capture | `src/security/use-record-protection.ts` | Record screens (Today, People, the record and every Care mode form) use Android `FLAG_SECURE` blocks screenshots and recording and blanks the app-switcher preview; on iOS expo-screen-capture hides the app's window from screenshots and screen recordings, which capture a blank screen (it relies on the secure text field layer rather than a documented iOS API, so it is checked on a device before each release), and the app-switcher snapshot is blurred while signed in. Identifiers are rendered non-selectable, so they cannot be copied. |
| Root and jailbreak | `src/security/device-integrity.ts` | Interface with a stub that reports "unknown", so eMAR stays off. A "compromised" result shows a warning on every screen. TODO before eMAR: `jail-monkey` (MIT) heuristics plus Play Integrity / App Attest verified by the API. |

### What the API must do for this client

- List `harbour://` in Better Auth's trusted origins (the app sends it as `Origin`).
- Expose `set-auth-token` on sign-in and TOTP verification responses.
- Return 401 from `/v1/me`, `/v1/sync/token` and `/v1/sync/upload` when the session is revoked (the
  device then wipes itself unless entries are waiting to upload). Every 403 the API sends carries an
  RFC 9457 problem body: `not_a_member`, `mfa_enrolment_required` or `step_up_required` end the
  session; any other code on the sync token or a batch upload withdraws Care mode, and on a care
  upload refuses the entry. A 403 without one (the edge) is checked against `/v1/me`.
- Return `tenantUserId` from `/v1/me`: it records who owns entries held on the device.
- Put the offline window in the sync token (`offline_days`, built by `offlineWindowDays` from the
  rate table); the streams read nothing from the device.
- Record each stage of a deletion of unsent entries (`POST /v1/sync/discards`, a manager's
  permission for anything but the caller's own entries, the coded reason only) and the device's
  unsent counts (`POST /v1/sync/device-report`, any member) as audit events; keep a task for the
  Registered Manager while a device holds entries, and flag an entry uploaded after its deletion was
  reported.
- Follow-ups (API): a revocation signal distinct from expiry, so a revoked or lost device wipes even
  when it holds unsent entries, and the manager hand-over upload of another member of staff's held
  entries (task #29; both go-live blockers, human action H-68); keeping a copy of every refused
  care entry with a review task; storing an unsafe IDDSI entry with an alert instead of refusing it.
- Accept `Idempotency-Key` on `/v1/sync/upload` and record business conflicts as review tasks
  rather than failing the upload.
- Serve photos with `Cache-Control: no-store` so the native HTTP cache keeps no copy.
- Accept care entries with the device's id on `POST /v1/people/{id}/notes`, `/observations`,
  `/body-map`, `/activities` and `/visits`, answer a replayed id with the saved copy, compute
  late-entry flags from `deviceTime` and clock drift from `x-harbour-sent-at`, and answer refusals
  with problem details (the device shows `detail`, else `title`).
- Serve `GET /v1/rates/mobile.offline_window_days`, `GET /v1/rates/mobile.held_entries_max_days` and
  `GET /v1/rates/sync.clock_drift_flag_minutes` to a care worker (what the device says it keeps,
  when a hold escalates, and how far ahead a typed time may be).

## Tests

```sh
pnpm --filter @harbour/mobile typecheck
pnpm --filter @harbour/mobile test      # Vitest: pure modules, and the header rendered against a react-native stand-in
cd apps/mobile && npx expo export --platform android --output-dir <tmp>   # proves Metro bundles
```

Unit tests cover the connector (credentials, care uploads with their headers, refusals moved to
"needs attention", retry and backoff, remote wipe), the care upload mapping checked against the API's
own zod schemas, UUIDv7, the offline window, the Care mode rules (notes, charts, IDDSI, NEWS2 on the
device, body map sides, the resuscitation status, Today's sync summary; named with their hazard
ids), the idle timer and auto-lock policy, staleness and banner states, the schema bridge, the
database key, the auth client, photos, environment parsing, and the People and Care SQL, which runs
against a real SQLite engine (`node:sqlite`) with tables built from the shared PowerSync schema and
the demo seed (`src/test-support/local-db.ts`). The point-of-care header is rendered with
react-test-renderer against a stand-in for `react-native` and the icons
(`src/components/person-header.render.test.ts`, aliased in `vitest.config.ts`), from the device's own
rows; so are the pinned identity bar and the form's order (`identity-bar.render.test.ts`),
sign-out with unsent entries, the NEWS2 panel and an empty chart, on a shared helper
(`src/test-support/render.ts`). The held-entry rules run against the same SQLite engine with a
stand-in for PowerSync, whose test file says exactly what it models (`src/app-state/held-work.test.ts`).
Screens are otherwise checked by typecheck, by `src/care/screens.test.ts` (wiring only: every person
screen uses the header and blocks capture) and by Maestro.

### End-to-end tests (Maestro)

Flows live in `.maestro/`: `sign-in.yaml`, `offline-people-list.yaml`, `sync-recovery.yaml` and
`hazard-HZ-006-offline-note-and-vitals.yaml` (a note and vital signs written offline, NEWS2 shown at
once, both survive a restart and upload when the network returns). They do not run in CI yet, and
they cannot run in this repository's sandbox (no simulator). The offline flows need the live API stack: a demo build never
syncs, and `.github/workflows/mobile.yml` currently builds demo mode only, so those flows need the
`preview` build in step 1 below. CI runs them like this:

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
