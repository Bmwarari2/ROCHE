# Phase 1 gate: choose-organisation journey and Lighthouse CI

Branch `chore/e2e-second-tenant-lighthouse`.

## What changed

- E2E seed (local and CI databases only, behind `HARBOUR_DEMO_E2E_PASSKEY=1` and the existing
  guards in `apps/api/scripts/demo-seed-guard.ts`): Second Example Care, an invented organisation
  with one home and one resident (Bea Elsewhere, NHS number in the 999 range), and Rowan Shared
  (`shared.coordinator@example.invalid`), a care coordinator in both it and the demo organisation.
  Every other demo user keeps one organisation.
- Web journey `apps/web/e2e/choose-organisation.spec.ts`: `/choose-organisation` with axe in the light
  and dark themes. It then proves isolation: after choosing either organisation, the other's
  residents are not in the list, and their record opened by address is not found.
- Lighthouse CI (`@lhci/cli`, Apache-2.0): `apps/web/lighthouserc.cjs` and
  `scripts/lighthouse-ci.sh`. The budget from `docs/01-CONSTRAINTS.md` (first paint under 1.5 s) and
  layout shift under 0.1 fail the build. So does an accessibility score below 0.95. Largest
  contentful paint, blocking time and the performance score only warn. It uses the desktop preset
  and the median of three runs, on two signed-out and four signed-in pages. It runs in the e2e-web
  job after the journeys and in `scripts/ci-local.sh`. The reports are kept as an artifact.
- Licence gate: `parse-cache-control` (a Lighthouse dependency) declares only "BSD" but carries the
  BSD-3-Clause text. It is recorded as an exception in ADR-0024 and the script.
- Runbook: the e2e organisations and accounts, and how to run Lighthouse CI.

## What is next

- The lead updates `docs/plans/phase-1-gate.md` and STATUS for both gate items.
- `@lhci/cli` brings in dev-only advisories (`tmp`, `extract-zip`, `basic-ftp`). They are outside
  the `pnpm audit --prod` gate, which this branch leaves as it was on main.

## Human actions logged

- None.

## Tests

- `choose-organisation.spec.ts` (1, axe in both themes): passes against dev and production builds.
- Full web E2E suite on dev servers: 90 passed, 1 failed, 1 did not run. The failure was
  `handover.spec.ts` (a focus check timed out on the dev server); the test that did not run is
  the handover test that follows it. On a freshly seeded database with a production build, both
  handover tests pass.
- Lighthouse locally (Playwright's Chromium, production build): every page scored 1.00 for
  performance and 1.00 for accessibility. Median first contentful paint was 215 to 225 ms, largest
  contentful paint 564 to 701 ms, blocking time 0 to 2 ms and layout shift at most 0.002.
