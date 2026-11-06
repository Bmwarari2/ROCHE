# Vulnerability gate lows (#169 review)

Branch `fix/vuln-gates-lows`, cut from `fix/vuln-gates-followups` (PR #169) at `aaa14b35`. It
closes the low-severity findings of the review of #169.

## What changed

- **No audit ignore outside the record**: `scripts/check-vulnerability-exceptions.mjs` read
  `pnpm.auditConfig.ignoreGhsas` only, so an `ignoreCves` list would have hidden an advisory
  unrecorded. It now fails on any `pnpm.auditConfig` key but `ignoreGhsas`, and on an
  `auditConfig` in `pnpm-workspace.yaml`, where pnpm 10 also reads it.
- **Inline Trivy ignores are compared with the record**:
  - the check reads every `#trivy:ignore:<id>` (and tfsec's older form) in the repository's
    Terraform, skipping `.terraform` and `node_modules`;
  - it fails when an inline ignore has no row in the configuration table, when a row there has no
    inline ignore, and when a configuration check is ignored in `.trivyignore` instead;
  - both existing inline ignores (AVD-GCP-0007 in `infra/modules/github_wif/main.tf`, AVD-GCP-0015
    in `infra/modules/cloud_sql_postgres/main.tf`) already had rows.
- **Review dates are capped**:
  - a row's review date may be at most 14 days after its added date for an advisory rated high or
    critical (CVSS 7 or more, section 5.3), and 90 days for any other row, unless the row cites a
    sign-off that is in `docs/plans/human-actions.md`. Advisory rows now name their severity in
    the first cell. The rule is at the top of `vulnerability-exceptions.md`;
  - configuration checks take the 90-day cap: they are checks on our own Terraform, not
    advisories, and have no CVSS score (Trivy rates both HIGH, which is why the scan reports them);
  - two rows broke the cap with no sign-off, so their dates are corrected. The zod advisory (high,
    CVSS 7.5) is now due on 14/11/2026 rather than 30/11/2026, in the record and `.trivyignore`.
    Both configuration exceptions are due on 29/01/2027 (90 days) rather than 31/01/2027;
  - the decode-uri-component row (high, 30 days) cites H-397 and keeps 30/11/2026;
  - the new `.github/workflows/vulnerability-exceptions.yml` runs the check alone every day at
    06:17 UTC and on demand, so an exception that falls due fails on main without a push. Its two
    actions are pinned by commit SHA.
- **The decoder's slowest inputs are timed**: crafted 200 KB runs of `%ED%A0%80` and
  `%F4%90%80%80`, where every sequence throws inside the built-in decoder, take about 100 ms here
  (the bound stays at one second).
- **The patched decoder is dormant on today's link path**:
  - the test header, the record and H-397 said that expo-router parses links through
    `query-string`. It does not. expo-router 57 parses a link's query with `URLSearchParams` in its
    own `getStateFromPath` (`build/fork/getStateFromPath-forks.js`), screens read parameters with
    `useLocalSearchParams` (the built-in decoder in a `try`/`catch`), and `query-string` is loaded
    only to build paths (`stringify`) and by React Navigation's own parser, which expo-router
    replaces. The patch is defence in depth, and the three places now say so;
  - a new test sends a crafted 200 KB link through expo-router's own `getStateFromPath`. The module
    loads in the mobile tests once React Navigation's `native` index, from which it takes only
    `validatePathConfig`, is replaced in Node's module cache by one holding expo-router's own
    `validatePathConfig`. The link parses in about 10 ms, and its value is all U+FFFD, which shows
    `URLSearchParams` decoded it, not `decode-uri-component`.
- **The behaviour change is pinned**:
  - results differ from 0.2.2 only when the built-in decoder throws, that is for malformed
    escapes. 0.2.2 could decode text a second time or skip an escape next to a byte order mark
    pair: `%2541%41%` gave `AA%` and now gives `%41A%`; `%41%FE%FF` and `%FF%FE%FF` change too;
  - the review's example, `%25%25%41%FE`, gives `%%A%FE` in 0.2.2 (from npm) as well as in the
    patch, so it is pinned as unchanged;
  - values shaped like the app's route parameters (UUIDs, chart kinds, ISO dates, non-ASCII names,
    `%25`, `+`) decode as 0.2.2 decodes them.
- **The patch writes U+FFFD as `�`** rather than a literal character, regenerated with
  `pnpm patch` and `pnpm patch-commit`, so the lockfile's patch hash matches.
- **The braces exception is gone**: `pnpm audit`, run with every ignore removed, reports eight
  advisories and none for braces (GHSA-vfj7-8cjw-p6xm), so it left the record, `ignoreGhsas` and
  `.trivyignore`. Trivy already hid it (no fixed version, `--ignore-unfixed`); Docker was not
  available here, so Trivy was not run locally.

## What is next

- From 15/11/2026 the check fails, daily and on every pull request, until the zod, `extract-zip`
  and `glob`/`minimatch` rows are reviewed. The zod and `extract-zip` rows are high, so they can
  only be fixed, or extended with a human-action sign-off.

## Human actions logged

- None new. H-397's action and status now say the patched copy is dormant on the link path.

## Tests

- `apps/mobile/src/platform/decode-uri-component.test.ts`: 38 tests (21 new): the two slowest
  crafted inputs, the malformed escapes that differ from 0.2.2 and three that do not, ten
  route-shaped values, and three through expo-router's own `getStateFromPath`.
- `scripts/check-vulnerability-exceptions.test.mjs`: 24 tests (15 new).
- Run here:
  - `pnpm install --frozen-lockfile` and `pnpm lint` passed (three existing warnings);
  - `pnpm typecheck` passed (10 tasks);
  - `pnpm --filter @harbour/mobile test` passed (62 files, 1,203 tests);
  - `pnpm test:scripts`, `pnpm check:vulnerability-exceptions`, the licence and Markdown link
    checks, and `pnpm audit --prod --audit-level high` passed.
