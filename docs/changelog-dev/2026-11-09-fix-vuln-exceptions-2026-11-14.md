# Clear the vulnerability exceptions due on 14/11/2026

Branch `fix/vuln-exceptions-2026-11-14`, from `main` 9cfb4c4.

## What changed

Three rows in [vulnerability-exceptions.md](../compliance/vulnerability-exceptions.md) were due
for review on 14/11/2026. Each is now fixed by an upgrade, using scoped `pnpm.overrides`. Every
row is removed from the record, `pnpm.auditConfig.ignoreGhsas` and `.trivyignore`. No exception
is re-justified, and no human action is needed.

- **GHSA-mrhx-c7xc-m3w5 (high, zod 3.25.76).**
  - The copy under `@expo/cli` 57.0.28 is pinned to the fixed zod 4.6.6 (`"@expo/cli>zod"`).
    `@expo/cli` 57.0.33 drops zod, but it was published on 05/11/2026 and is under two weeks
    old until 19/11. Expo packages also move only with `expo install` at an SDK upgrade.
  - 57.0.28 uses zod in two modules only: the development tools plugin schemas for
    `expo start`. These use `object`, `string().min`, `enum`, `union`, `literal`, `url`, `array`,
    `strict` and `describe`, and zod 4 parses them the same way.
  - `apps/mobile/src/platform/expo-cli-zod.test.ts` loads both modules by the CLI's own
    dependency path. It shows that they get zod 4.6.6 or later, and that each schema still
    accepts and refuses the same input.
  - Remove the override at the next Expo SDK upgrade, once `@expo/cli` no longer asks for zod.
  - The other copy, under `chromium-bidi` 14, went with the Lighthouse change below.
- **GHSA-jmr9-qjv8-65gv and GHSA-7pqw-9j4j-h8q3 (high, extract-zip 2.0.1).**
  - `@lhci/cli` 0.15.1 and `@lhci/utils` 0.15.1 now run on `lighthouse` 13.5.0 (published
    18/09/2026) through `"@lhci/cli>lighthouse"` and `"@lhci/utils>lighthouse"`, in place of
    12.6.1.
  - Lighthouse 13 brings `puppeteer-core` 25.16.0 and `@puppeteer/browsers` 3.2.6, which
    unpacks with `modern-tar` and has no `extract-zip`. It also brings `chromium-bidi` 157,
    which uses zod 4 (4.6.6 through the existing override).
  - `@lhci/cli` 0.16.0 moves to Lighthouse 13 itself, but it was published on 02/11/2026 and is
    under two weeks old. Take it with a routine update and drop both overrides then.
  - The Lighthouse quality gate is unchanged: the same `lighthouserc.cjs`, budgets and script.
  - `@puppeteer/browsers` 3 names `proxy-agent` >=8 as an optional peer and finds 6.5.0 (from
    `@lhci/cli`). Puppeteer uses it only to download browsers, which Lighthouse CI never does: it
    runs the Chrome already installed.
- **GHSA-g3hv-75wg-m249 and GHSA-3g3m-2fjr-6pw4 (moderate, minimatch 10.2.6 and glob 13.0.6).**
  - `"glob@>=13.0.0 <14.0.2": "14.0.2"`, as the row asked, and `"minimatch@>=10.0.0 <11.0.1":
    "11.0.1"`. The second is needed because `@expo/fingerprint` 0.20.13 asks for minimatch ^10
    itself, not only through glob.
  - glob 14.0.2, minimatch 11.0.1 and path-scurry 3.0.0 were published on 27/10/2026. They were
    taken on 11/11, once each was two weeks old. Newer 14.0.x and 11.0.x releases are still
    under two weeks old.
  - Every glob 13 and minimatch 10 copy is gone. glob 14.0.2 is now used by `@expo/cli`,
    `@expo/config`, `@expo/config-plugins`, `@expo/fingerprint`, `@expo/metro-config` and
    Storybook's docgen plugin. The minimatch 3.1.5 and 5.1.9 copies are outside GHSA-g3hv's
    range and do not change.

## What is next

- At the next Expo SDK upgrade, remove `"@expo/cli>zod"` once `@expo/cli` is 57.0.33 or later.
- With the next routine dependency update, take `@lhci/cli` 0.16.0 and remove the two
  `lighthouse` overrides.
- Drop the glob and minimatch overrides once `@expo/fingerprint` and the Storybook docgen plugin
  ask for glob 14 and minimatch 11 themselves.
- New advisories found while checking on 11/11, all on `main` too and left for their own change:
  - node-forge 1.4.2 via `@expo/cli`: GHSA-6889-vf6x-f3g5 (low), GHSA-w4xr-hqv8-ch44,
    GHSA-6cv4-p8m7-4r25 and GHSA-j8rw-jp99-435v (moderate). Fixed in 1.4.3; the existing
    `node-forge@<1.4.2` override needs raising.
  - fast-xml-parser 5.11.2 in `apps/api`: GHSA-474x-hrwr-fgx4 (low). Fixed in 5.12.0.
  - None is high, so `pnpm audit --audit-level high` and the Trivy gate still pass.

## Human actions logged

- None.

## Tests

- Supply chain:
  - Every package version this branch adds to the lockfile was published at least 14 days
    before it was taken. It was installed with `--config.minimum-release-age=20160`, and each
    version's publish date was checked against the registry.
  - `node scripts/check-licences.mjs`: 1131 packages, all allowed.
- Gates:
  - `pnpm audit --prod --audit-level high` and `pnpm audit --audit-level high` pass. The only
    ignored advisories left are decode-uri-component (H-397) and deepmerge.
  - `node scripts/check-vulnerability-exceptions.mjs` passes.
  - Trivy 0.67.2, the CI digest, passes the filesystem scan (`--severity HIGH,CRITICAL
    --ignore-unfixed`) on a database downloaded on 11/11. A scan with no ignore file reports no
    zod, extract-zip, glob or minimatch.
- Builds:
  - `expo export` for Android passes. The bundle's file name carries a content hash, and it is
    the same before and after the glob change. `expo export --platform ios --clear` and
    `expo config --type prebuild` pass.
  - `@expo/fingerprint` gives the same hash over the same 78 sources on glob 13.0.6 and on
    glob 14.0.2.
  - The `@harbour/ui` Storybook build passes, with the same 103 files, 36 docgen entries and
    121 stories as before the glob change.
  - `scripts/lighthouse-ci.sh` runs in full against the built API and web app with the seeded
    demo database. It covers 6 URLs and 18 runs, with `lighthouseVersion` 13.5.0, and every
    assertion passes. A deliberately impossible first contentful paint budget still fails
    `lhci assert`, so the gate is intact. The glob step changes no package in Lighthouse CI's
    tree.
- Code checks and tests:
  - New test `apps/mobile/src/platform/expo-cli-zod.test.ts`: 11 tests.
  - `pnpm lint`; typecheck for `@harbour/mobile`, `@harbour/web` and `@harbour/ui`.
  - Tests: mobile 1612, web 3091 and ui 362 passing; `pnpm test:scripts` 29 passing.
