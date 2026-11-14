---
status: "accepted"
date: 2026-11-14
decision-makers: owner (14/11/2026: "Do not run CI on GitHub, move it to Ubicloud"); lead engineer (Claude Code lead session)
consulted: Thapsus-HR ADR-0271 (the same move for PROJECT_KAREN, 09/11/2026)
informed: engineering
---

# CI runs on Ubicloud, not on GitHub's hosted runners

## Context and problem statement

Every workflow ran on GitHub's hosted runners (`ubuntu-24.04`, `ubuntu-latest`), billed per minute
against the account's Actions budget. That budget stopped Thapsus-HR's jobs several times between 7
and 9 November, and Thapsus-HR moved its quality gates to Ubicloud's managed runners (its ADR-0271).
On 14 November the owner asked for the same here: CI must not run on GitHub.

## Decision drivers

- No CI minutes on GitHub's hosted runners.
- Nothing sensitive on a third-party runner: no secret, no cloud identity.
- One setting to move the jobs again, with no workflow change.
- The required check names on `main` must not change.

## Decision outcome

- **Every job that needs no secret runs on Ubicloud.** The heavy jobs (`checks`, `test`, `e2e-web`,
  `images`, CodeQL's `analyse`) use `${{ vars.CI_RUNNER || 'ubicloud-standard-4' }}`. The quick ones
  (`changes`, the daily vulnerability-exceptions check, and Terraform's `static`, `security` and
  `gcp-gate`) use `${{ vars.CI_RUNNER_SMALL || 'ubicloud-standard-2' }}`. The Android emulator jobs
  use `${{ vars.MOBILE_RUNNER || vars.CI_RUNNER || 'ubicloud-standard-4' }}`. Job names are unchanged,
  so the required checks still match.
- **Jobs that hold credentials stay on GitHub's runner**, named literally:
  - Terraform's `plan-dev`, `apply-dev` and `release-dev`, which ask for a Google Cloud identity
    (`id-token: write`, Workload Identity Federation);
  - the mobile `eas-build`, which reads `EXPO_TOKEN`. It runs only on release tags, and not at all
    while the safety case excludes the app (H-381).
  They run only when infrastructure changes on `main`, on a pull request that touches `infra/` (the
  plan), or on a release, and only once Google Cloud or Expo is set up.
- **Guarded.** `scripts/check-ci-runners.mjs` runs in the `checks` job and in `pnpm test:scripts`. It
  fails when:
  - a job without secrets names a non-Ubicloud runner;
  - a job that reads a secret (other than the run's own `GITHUB_TOKEN`) or asks for `id-token: write`
    names anything but a GitHub-hosted runner;
  - any job in `ci.yml` reads a secret.
- **The Android emulator needs KVM.** No Ubicloud documentation found on 14/11/2026 says its runners
  expose `/dev/kvm`. The emulator jobs therefore stop at once, with the reason, on a runner without it,
  rather than crawl to the timeout. If the first weekly run shows no KVM, set `MOBILE_RUNNER` to a
  runner with KVM; the owner decides which (H-1643).
- **Going back.** Setting `CI_RUNNER` and `CI_RUNNER_SMALL` to `ubuntu-24.04` returns the jobs to
  GitHub's runner with no change here. The guard will then fail on the next pull request, which is
  intended: it records that a decision changed, and this ADR is superseded.
- **Supplier, not sub-processor.** Ubicloud sees the source code and the fictional test data only
  (invented people, `example.invalid` email addresses, NHS numbers in the 999 range). It is recorded
  in the sub-processor register's list of components that are not sub-processors.

### Consequences

- Good, because CI no longer spends GitHub's hosted minutes and keeps running when that budget is
  exhausted (self-hosted runners, which Ubicloud's are to GitHub, are not charged against it).
- Good, because no secret or cloud identity reaches the third-party runner, and a test keeps it so.
- Bad, because until the owner adds this repository to the Ubicloud GitHub App (H-1643), every
  Ubicloud job waits in the queue for a runner and no check reports. That includes the required
  checks on `main`, so nothing can merge until then.
- Bad, because a new supplier can read the source code at the tested commit.
- Neutral: Dependabot's own update jobs are run by GitHub and are not affected by this setting.

### Confirmation

- `node scripts/check-ci-runners.mjs` passes, and `scripts/check-ci-runners.test.mjs` shows it fails
  on each kind of misplaced job. On the workflows as they were before this change it reports all 12
  jobs that were on GitHub's runner without needing to be.
- The first pull request after H-1643 runs its checks on Ubicloud runners: the job logs name the
  runner.

## Pros and cons of the options

### Ubicloud managed runners (chosen)

- Good, because it is what the owner asked for, and Thapsus-HR already runs on it (ADR-0271), with
  the same account and pricing.
- Good, because Ubicloud's runner images follow GitHub's, so Docker, service containers and
  Playwright work as before.
- Bad, because Android emulator support (KVM) is unconfirmed.

### Keep GitHub's hosted runners

- Bad, because the owner asked not to, and the shared budget has stopped CI before.
