# Next.js 16.4.1 and patched transitive dependencies (security)

Branch `fix/web-next-security`.

## What changed

- `apps/web`: `next` 16.4.0 to 16.4.1 (exact pin; `@next/env` and the `@next/swc-*` binaries move
  with it, and the repository uses no `eslint-config-next`). 16.4.1 fixes GHSA-2464-fhr4-w9xw
  (critical, unauthenticated remote code execution in the image optimisation API with SVG files),
  GHSA-673q-mjm6-r5xr (critical, remote code execution in `use cache` functions returning typed
  arrays) and GHSA-p3m5-59mp-jv5r (CVE-2026-94482, high, denial of service in the App Router with
  Server Actions); all three affect `>=16.0.0 <=16.4.0`. 16.4.1 was published on 14/10/2026.
  16.4.2 changes only version strings, bundled docs and development messages, and 16.4.3 is under
  two weeks old, so the smallest fixed release was taken. No ADR: a patch within the chosen stack.
- Root `package.json` `pnpm.overrides`, each scoped to the vulnerable range:
  - `node-forge@<1.4.2` to 1.4.2 (via `expo > @expo/cli` and `@expo/code-signing-certificates`):
    GHSA-7wch-p9px-956x (CVE-2026-118779), GHSA-jc66-7q78-782g (CVE-2026-118782),
    GHSA-hqq3-7jhf-c5jx (CVE-2026-119187), GHSA-8hrf-8g6f-7xwp (CVE-2026-119188) and
    GHSA-5x38-2vff-x55p (CVE-2026-119190), all high, plus the moderate and low ones. 1.4.2 rather
    than 1.4.1 because 1.4.2 restores `pem.decode` on Buffer input, which the 1.4.1 fix broke. It
    also fixes GHSA-86w9-cpqp-85rv, so that exception is removed.
  - `undici@>=7.0.0 <7.30.1` to 7.30.1 (via `jsdom`): GHSA-2m5v-pch6-74hx (CVE-2026-109383),
    GHSA-4w7w-5xrc-9h26 (CVE-2026-109829), GHSA-xjj6-f33q-929c (CVE-2026-109869) and
    GHSA-qrxm-fqhp-jwvm (CVE-2026-87018), all high, plus four moderate ones. Only undici 7 is in
    the tree, so no 6.x or 8.x pin is needed.
  - `zod@>=4.0.0 <4.6.6` to 4.6.6 (the API, `@harbour/contracts`, Better Auth and the Hono
    validators): GHSA-mrhx-c7xc-m3w5 (CVE-2023-54404, high), which `pnpm audit --prod` in CI
    reports even though Trivy does not.
- Two time-limited exceptions in [vulnerability-exceptions.md](../compliance/vulnerability-exceptions.md),
  in `pnpm.auditConfig.ignoreGhsas` and in a new `.trivyignore` (entries expire on 30/11/2026):
  `decode-uri-component` 0.2.2 under `expo-router > query-string@7` (GHSA-qr28-fpjm-wq7f,
  CVE-2026-118664), whose only fix (0.5.1) is ESM-only and cannot be loaded by `query-string` 7;
  and zod 3.25.76 under `@expo/cli` (no fixed 3.x release; build tool only). The first does not
  meet the usual rule (it can be reached in the app through a crafted link), so it waits on H-397.

## What is next

- Remove the `decode-uri-component` and zod 3 exceptions with the next Expo SDK, and drop each
  override once its dependents ask for the fixed version themselves.
- Still open in the full audit (development tools, outside the CI gates): `storybook` 10.6.1 in
  `packages/ui` (GHSA-f2ph-cmg5-wxc8 critical, GHSA-px85-f4q5-jh77 high; fixed in 10.6.2).

## Human actions logged

- H-397: accept or reject the `decode-uri-component` exception.

## Tests

- `pnpm audit --prod --audit-level high` (the CI gate) passes; `pnpm audit` reports no `next`,
  `node-forge`, `undici` or zod 4 advisory, and `pnpm why` shows only the fixed versions. Trivy
  could not run locally (no Docker daemon).
- `pnpm install --frozen-lockfile`, `node scripts/check-licences.mjs`, `pnpm lint`, typecheck for
  every package, and the API and web builds (Next.js 16.4.1).
- Unit tests: web 912, API 1159, contracts 34, mobile 984, all passing.
