# Vulnerability gate follow-ups (#166 security review)

Branch `fix/vuln-gates-followups`, cut from `origin/fix/deps-and-image-scan` (PR #166). It closes
the findings of the security review of #166: three Mediums and four Lows.

## What changed

- **M1, the image scan gates the release**:
  - `release-dev` in `.github/workflows/terraform.yml` rebuilt and pushed both images without a
    scan, and cannot depend on the `images` job in `ci.yml`.
  - It now runs the same Trivy gate between the build and the push, before it signs in: the same
    pinned digest, `--severity HIGH,CRITICAL --ignore-unfixed --exit-code 1` and ignore file.
  - Both stages of `apps/api/Dockerfile` and `apps/web/Dockerfile` pin `node:22-bookworm-slim` by
    its digest (`sha256:5ec23b7c…`, looked up on Docker Hub on 06/11/2026). Renovate raises digest
    updates, and the image scan checks them.
  - `main` has no branch protection or required checks yet. H-02 already covers this (required
    checks from `ci.yml` and `codeql.yml`, linear history, signed commits), so no new human action
    is added.
- **M2, overdue exceptions fail CI**:
  - Both Trivy steps use `--ignore-unfixed`, so an advisory with no fix never reaches its `exp:`
    date, and `pnpm.auditConfig.ignoreGhsas` has no expiry.
  - The new `scripts/check-vulnerability-exceptions.mjs` (`pnpm check:vulnerability-exceptions`)
    runs in the CI security job and in `scripts/ci-local.sh`. It fails:
    - once any review date in `vulnerability-exceptions.md` has passed, in either table;
    - when the record, `ignoreGhsas` and `.trivyignore` list different advisories (CVE ids are
      compared with `.trivyignore` too);
    - when a `.trivyignore` date differs from its review date;
    - when `.trivyignore-images` holds an id that is not in the record.
  - The braces advisory (GHSA-vfj7-8cjw-p6xm) was in the record and `ignoreGhsas` but not in
    `.trivyignore`; it is added there with its review date, 11/11/2026. `pnpm audit` no longer
    reports it (checked 06/11/2026), so it can probably go at that review.
- **M3, decode-uri-component patched rather than excepted**:
  - `patches/decode-uri-component@0.2.2.patch` (`pnpm patch`) replaces 0.2.2's `index.js` with a
    CommonJS port of 0.5.1's linear-time decoder. 0.5.1 fixes GHSA-qr28-fpjm-wq7f and
    GHSA-vcc3-ghjq-m6fr but is ESM-only, and `query-string` 7 loads the package with `require()`.
  - The port keeps 0.2.2's export, `+` decoded to a space, and its type check and message.
  - Unpatched, 0.2.2 took 1.4 seconds on 900 bytes of `%80` and about 20 seconds on 3 KB. Patched,
    a 200 KB input takes about 25 milliseconds.
  - `pnpm audit` and Trivy still report 0.2.2 by its version number, so both ids stay in the three
    lists. The record now says the code is patched, with the test as evidence. H-397's status says
    the patch replaced the exception.
- **L1, actions pinned**: in the `images` job, `actions/checkout` (v5.1.0),
  `github/codeql-action/upload-sarif` (v3.39.3) and `actions/upload-artifact` (v4.6.2) are pinned by
  commit SHA, with the tag in a comment. The filesystem scan now uses `$TRIVY_IMAGE`, which is set
  once for the workflow, instead of the unpinned `aquasec/trivy:0.67.2`.
- **L2, a separate ignore file for images**: the image scan and the release gate read
  `.trivyignore-images`, which holds only a header comment. Every entry in `.trivyignore` is for a
  package in no image, so an advisory that reaches an image now fails at once.
- **L3, what the api image scan covers**: `apps/api/build.mjs` bundles the API's npm dependencies
  into `dist`, so Trivy sees no `node_modules` in the api image. The image scan therefore covers
  its operating-system packages only. The API's npm dependencies are covered by `pnpm audit
  --prod`, which fails on high and critical advisories. The `images` job comment says so.
- **L4, exception records corrected**:
  - GHSA-g3hv-75wg-m249 affects `minimatch` `>=7.0.0 <11.0.1`, so the 3.1.5 and 5.1.9 copies are
    not affected. The record now names the affected copy, 10.2.6, loaded by `glob` 13.0.6, and
    every path to it. That includes `packages/ui`'s Storybook docgen plugin, which the record had
    missed.
  - `zod` 3.25.76 also arrives through Lighthouse CI (`@lhci/cli > … > chromium-bidi` 14), which
    the record had missed.
  - `pnpm update -r @expo/cli` to 57.0.33, within `expo`'s range, was tried and not kept. It
    clears none of the exceptions: `chromium-bidi` 14 still needs zod 3, and every
    `@expo/fingerprint` 0.20 release and the Storybook plugin stay on `glob` 13. It also
    re-resolved about 1,350 lockfile lines, and 57.0.33 was one day old.
  - Renovate leaves Expo packages alone, so the policy no longer says that Renovate raises their
    fixes.

## What is next

- The first `release-dev` and `images` runs on CI are the first scans with the pinned base image
  and the empty image ignore file. Docker was not available here, so neither image was built or
  scanned locally.
- The braces, `extract-zip` and `minimatch`/`glob` exceptions are due for review on 11/11 and
  14/11/2026. From those dates the new check fails every pull request until they are reviewed.

## Human actions logged

- None new. H-02 (branch protection and required checks on `main`) already covers M1's last point.
  H-397's status is updated.

## Tests

- **New** `apps/mobile/src/platform/decode-uri-component.test.ts` (17 tests). It loads the copy
  `expo-router` loads, through `query-string`. It checks:
  - 0.2.2's nine README examples;
  - `+` decoded to a space, and the 0.2.2 type error;
  - four crafted 200 KB inputs, each decoded in under a second;
  - a crafted 200 KB link value parsed by `query-string` in under a second.
- **New** `scripts/check-vulnerability-exceptions.test.mjs` (9 tests, `pnpm test:scripts`, Node's
  test runner).
- Run here:
  - `pnpm install --frozen-lockfile` and `pnpm lint` passed (three existing warnings);
  - `pnpm typecheck` passed (10 tasks);
  - `pnpm --filter @harbour/mobile test` passed (62 files, 1,182 tests);
  - `pnpm test:scripts`, `pnpm check:vulnerability-exceptions`, the licence and Markdown link
    checks, and `pnpm audit --prod --audit-level high` passed.
