# The Phase 1 mobile gate: offline journeys against a real backend (MOB-002, MOB-005, MOB-006)

Branch `feat/mobile-gate`, from `feat/mobile-round-screen` (PR #50).

## What changed

- `.github/workflows/mobile.yml`: the emulator job had built a debug APK (an Expo development
  client, which waits for Metro) in demo mode (which never syncs), so the offline flows could not
  pass. Now two jobs on release builds, triggers unchanged:
  - `maestro-android-demo`: sign-in and the new `demo-round.yaml` (tags `smoke`, `demo`);
  - `maestro-android-live`: Postgres and PowerSync from `docker-compose.yml`, the demo tenant
    seeded, the API built and started, `apps/mobile/scripts/sync-smoke.mjs`, then the flows
    tagged `smoke` and `offline` on an emulator reaching the runner through `adb reverse`, and a
    check in Postgres that the task marked done offline is done on the server.
- `apps/mobile/scripts/sync-smoke.mjs`: the phone's sync path without the phone. The manager
  creates a round task due now for Ada Example; the carer signs in as the app does, takes a sync
  token and reads PowerSync's stream until a checkpoint holds the person and the task.
- `EXPO_PUBLIC_E2E_LOOPBACK` (`src/config/env.ts`): an end-to-end build may use plain http to the
  phone's own loopback only (`localhost`, `127.0.0.1`; never `10.0.2.2` or a network host).
  `HARBOUR_E2E_BUILD` lifts Android's cleartext block for that build alone (`app.config.ts`), and
  `app.config.ts` refuses it in an EAS build; `eas-profiles.test.ts` fails if any EAS profile sets
  either.
- Store builds: `eas-build` runs in the `store-release` environment, so once the owner adds
  required reviewers and moves `EXPO_TOKEN` there (H-399), a `v*-rc*` tag cannot build and submit
  store binaries without approval. The trigger is unchanged.
- The gate report (phase-1-gate.md section 1) says what is built, what is unverified and what an
  iOS job needs; the README's end-to-end section is rewritten; HZ-001 and HZ-006 Maestro rows and
  a new HZ-028 row for the sync smoke.

## What is next

- Run the workflow (H-400) and fix what the first run finds; the gate item stays open until the
  live job passes.
- An iOS job (phase-1-gate.md section 1), flows for charts and the conflict review.

## Human actions logged

- H-399: protect `store-release` (required reviewers, `v*` tags) and move `EXPO_TOKEN` into it.
- H-400: run the `mobile` workflow and record the result.

## Tests

- `node apps/mobile/scripts/sync-smoke.mjs` against Docker Compose Postgres, PowerSync 1.26.1 and
  the built API (`pnpm --filter @harbour/api start`): passed. A carer's `done` transition then read
  `done` with the workflow's Postgres query.
- `npx expo config --type introspect`: cleartext set only with `HARBOUR_E2E_BUILD=1`, and refused
  with `EAS_BUILD` set.
- `pnpm --filter @harbour/mobile test`, typecheck and Biome: see the final run below.
- Not run: the Gradle release build, the Android emulator and every Maestro flow (no Android SDK
  or KVM in the sandbox). The Maestro and workflow YAML parse; no Maestro or actionlint linter was
  available.

## Review rounds

- Security review (no High): `app.config.ts` now refuses `EXPO_PUBLIC_E2E_LOOPBACK` without
  `HARBOUR_E2E_BUILD=1`, and either under `EAS_BUILD` or `EAS_BUILD_PROFILE` (EAS evaluates the
  config on its servers, so dashboard variables are caught too); `eas-build` installs dependencies
  before the Expo token enters its environment and refuses the loopback flags. Left open: a
  network security config allowing cleartext to loopback only (today the e2e APK allows it to any
  host, Low), pinning actions to commit SHAs, `eas-version` and the Maestro installer (Low,
  existing), demo mode accepting http to any host in release (Low, existing), and whether every
  rc tag should submit the production profile (owner, with H-399).
