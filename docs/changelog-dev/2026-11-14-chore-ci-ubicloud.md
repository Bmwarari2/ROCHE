# CI on Ubicloud, not on GitHub's hosted runners (ADR-0137)

Branch `chore/ci-ubicloud`.

## What changed

- The owner asked on 14/11/2026 that CI no longer run on GitHub. Every job that needs no secret now
  runs on Ubicloud's managed runners:
  - `ci.yml`, CodeQL, the daily vulnerability-exceptions check;
  - Terraform's static checks, Trivy scan and access check;
  - the Android emulator jobs.
  The runner comes from a repository variable with an Ubicloud default (`CI_RUNNER`,
  `CI_RUNNER_SMALL`, `MOBILE_RUNNER`). Job names are unchanged, so the required checks still match.
- Jobs that hold credentials stay on GitHub's runner: the Terraform plan, apply and release (Google
  Cloud identity) and the EAS store build (`EXPO_TOKEN`).
- `scripts/check-ci-runners.mjs` (in the `checks` job and `pnpm test:scripts`) keeps it that way.
- The emulator jobs stop at once if the runner has no `/dev/kvm`, since Ubicloud's KVM support is
  unconfirmed.
- Ubicloud is recorded as a supplier that sees no personal data, not a sub-processor.

## What is next

- H-1643: the owner adds this repository to the Ubicloud GitHub App. Until then every CI job waits for
  a runner.

## Human actions logged

- H-1643.

## Tests

- `scripts/check-ci-runners.test.mjs` (9): each kind of misplaced job fails, the run's own
  `GITHUB_TOKEN` is not a secret, and the repository's workflows pass. On the workflows from before
  this change the check reports the 12 jobs that were on GitHub's runner.
