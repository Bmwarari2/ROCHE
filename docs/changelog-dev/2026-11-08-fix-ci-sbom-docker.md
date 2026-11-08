# CI: the bill of materials no longer depends on GitHub releases

Branch `fix/ci-sbom-docker`, from `main` d4c81025.

## What changed

- The "Software bill of materials (Syft)" step in `.github/workflows/ci.yml` ran `anchore/sbom-action@v0`, which
  downloads Syft from GitHub releases at the start of every run. On 08/11/2026 those downloads answered
  504 Gateway Timeout from about 08:45 UTC onwards, and the step failed the "Lint, types, API contract, builds and
  security" job on every pull request (#188, #197, #204, #205).
- Syft now runs from its Docker Hub image, pinned by digest like Trivy (`SYFT_IMAGE`,
  `anchore/syft:v1.42.3@sha256:5999d209…`), with its update check off, so the step makes no other network call. It
  writes the same SPDX 2.3 file, `harbour-sbom.spdx.json`, to the runner's temporary directory (outside the
  checkout, so Biome and gitleaks never read it, as with the action), and keeps it as a workflow artifact of the same name with
  `actions/upload-artifact` pinned by commit. The step fails if the file is empty.
- `node_modules` is excluded, as before: the bill of materials describes the repository and the lockfile.

## Checks

- The step's command, run locally on `main` with the pinned image: SPDX 2.3, 1,489 packages.
