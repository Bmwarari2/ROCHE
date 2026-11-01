# Dependency advisories triaged, and container images scanned in CI (security)

Branch `fix/deps-and-image-scan`, cut from `main`.

## Dependency advisories (H-1178)

`pnpm audit` at every level reported 24 findings on `main`: 7 high, 12 moderate and 5 low, under
17 advisories. GitHub reported 19 alerts, counted per package. After this change, every advisory is
either fixed or recorded as an exception, and `pnpm audit --prod --audit-level high` passes.

**Fixed, by upgrading:**

| Advisory | Package | How |
| --- | --- | --- |
| GHSA-ph9p-34f9-6g65 (high), GHSA-52f5-9888-hmc6 (low) | `tmp` 0.0.33 and 0.1.0 (via `@lhci/cli` and `external-editor`) | `pnpm.overrides` `tmp@<0.2.6` to 0.2.7. The parents call `tmp.fileSync` only, which 0.2.7 keeps; `@lhci/cli` 0.15.1 is the latest release |
| GHSA-c475-qrg2-pj4r (high) | `basic-ftp` 5.3.1 (via `@lhci/cli > proxy-agent > get-uri`) | Override `basic-ftp@<6.2.1` to 6.2.3. `get-uri` calls `Client.list`, which 6.x keeps |
| GHSA-w5hq-g745-h8pq (moderate) | `uuid` 7.0.3 and 8.3.2 (via `expo > @expo/config-plugins > xcode` and `@lhci/cli`) | Override `uuid@<11.1.1` to 11.1.1. Both parents call `uuid.v4()`, which 11.1.1 keeps (checked) |
| GHSA-w74x-v6f9-j3xg, GHSA-wjr9-j795-jxcr (moderate), GHSA-xhq7-xmqj-769h, GHSA-333x-w4r6-6crp (low) | `fast-uri` 3.1.8 (via `@commitlint/cli > ajv`) | Override `fast-uri@>=3.0.0 <3.1.9` to 3.1.9, the only fixed 3.x release. It is 12 days old: taken because it is a patch release fixing four advisories |
| GHSA-qxg6-89mg-rqv8, GHSA-xp26-3454-mjgp (moderate) | `@vitest/mocker` 4.1.11 | `vitest` and `@vitest/coverage-v8` to 4.1.12 in every package |
| GHSA-67mh-4wv8-2f99 (moderate) | `esbuild` 0.18.20 (via `drizzle-kit > @esbuild-kit/core-utils`) | Override `@esbuild-kit/core-utils>esbuild` to 0.25.12, already in the tree. `drizzle-kit check` still loads the TypeScript config |

**Excepted** ([vulnerability-exceptions.md](../compliance/vulnerability-exceptions.md), each in
`pnpm.auditConfig.ignoreGhsas` and in `.trivyignore` with an expiry):

- **GHSA-jmr9-qjv8-65gv, GHSA-7pqw-9j4j-h8q3 (high, CVSS 8.1): `extract-zip`.** It comes in only
  through the web app's Lighthouse CI devDependency, and no fixed version exists. It unpacks
  browser downloads, which Lighthouse CI does not perform. Review by 14/11/2026, within 14 days.
- **GHSA-vcc3-ghjq-m6fr (moderate): `decode-uri-component`.** This is the same copy as the H-397
  exception, with the same constraint: the fixed release is ESM-only. Review by 30/11/2026.
- **GHSA-gcqx-w48m-w2h4 (low): `deepmerge`.** It is in `@expo/config`, a build tool that merges our
  own configuration. No fix is published. Review by 30/11/2026.
- **GHSA-g3hv-75wg-m249 and GHSA-3g3m-2fjr-6pw4 (moderate): `minimatch` and `glob`.** They are in
  build tools that match only our own patterns. The fix for `@expo/cli`'s copy, glob 14.0.2, is
  under two weeks old. Review by 14/11/2026, then override glob.

## Container image scanning (H-1170, the CI half)

The `images` job in `.github/workflows/ci.yml` now builds the api and web images and scans each
one with Trivy 0.67.2, pinned by digest.

- The full findings go to the Security tab as SARIF, as CodeQL's do. A fork's or Dependabot's
  pull request keeps them in an artifact instead.
- High and critical findings with a fix fail the job, honouring `.trivyignore`. This is the same
  rule as the filesystem scan.
- It runs on `main`, on demand, and on any pull request that changes what goes into an image: a
  Dockerfile, the dependencies, `.trivyignore` or the workflow.

**Artifact Registry scanning:** with the Google Cloud integration (#164) merged into this branch,
`containerscanning.googleapis.com` is now enabled in `infra/modules/project_baseline`, so Artifact
Registry also scans every image it receives. The module gains a `services` output, and the
`harbour_stack` plan test gains the run `images_scanned`. All 17 `terraform test` runs pass.

**Merged with `main` after #164.** `vulnerability-exceptions.md` keeps both sides: these rows, and
`main`'s new configuration exceptions. The lockfile is regenerated from `main`'s with `pnpm
install`, not edited by hand. After the merge, `pnpm audit` shows no advisory that is not excepted.

**Not run here:** both images build locally (through the sandbox proxy, with its CA added to a
scratch copy of the build stage only). Running the Trivy container against the local Docker
daemon was not permitted in this environment, so the job's first run on CI is the first scan.
