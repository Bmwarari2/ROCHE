---
name: release
description: Prepare a Harbour release - changesets, version, plain-English release notes, clinical safety case delta, SBOM and provenance, staging rollback test, mobile build rules. Use at the end of each two-week train or when cutting a release candidate.
---

# Release

1. `pnpm changeset version` to apply changesets; the platform version `vMAJOR.MINOR.PATCH` drives
   mobile build numbers.
2. Write plain-English release notes for tenants (`docs/releases/vX.Y.Z.md`): what changed for each
   role, nothing technical, British English.
3. Write the clinical safety case delta: `docs/clinical-safety/safety-case/safety-case-vX.Y.md` listing
   hazards added, changed or closed, with their tests. Log the CSO signature as a human action.
4. Confirm CI is green on the release commit, including the SBOM and provenance attestation.
5. Tag `vX.Y.Z-rcN`: deploys to staging, builds mobile binaries to TestFlight and Play internal
   testing (when credentials exist). Test the rollback on staging.
6. Production needs Brian's approval on the signed tag (human action, never awaited by the build).
7. Mobile: EAS Update only for JavaScript and asset fixes within the published binary's native
   capabilities; anything touching permissions, SDKs or native modules is a new binary through review.
   Phased rollout 10%, 50%, 100% while crash-free sessions stay above 99.5%.
