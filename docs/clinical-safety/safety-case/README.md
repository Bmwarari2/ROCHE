# Clinical safety case reports

DCB0129 requires the manufacturer to produce a clinical safety case, and a clinical safety case report that summarises it, for each release of a health IT system. Harbour produces **one clinical safety case report per platform release**, kept in this folder under version control. Process: [clinical-risk-management-plan.md](../clinical-risk-management-plan.md), section 6.

## Naming and versions

| Release type | What to produce |
| --- | --- |
| Minor or major platform release (`vX.Y.0`) | A new report `safety-case-vX.Y-<label>.md`, copied from the previous report and updated |
| Patch release or EAS Update within `vX.Y` | A dated delta section appended to the `vX.Y` report. A patch that changes any hazard rating, or adds a hazard, needs a new minor report instead |
| Phase milestones before general availability | `v0.0` Phase 0 foundations, `v0.1` Phase 1 residential MVP, and so on |

## What every report contains

1. **Identification**: release version, Git tag and commit, date, modules enabled by default, intended use and the medical-device boundary statement.
2. **Claim**: the release is acceptably safe for its intended use when deployed and used as described, subject to the stated deployer controls.
3. **Argument and evidence**: hazard log state at the tag (every hazard, its rating and status); verification evidence (CI run links, test counts, the hazard-ID test report); outstanding defects with clinical relevance; residual risks at level 3 with the CSO's acceptance.
4. **Changes since the previous report**: hazards opened, changed, closed; controls added or removed; clinical PRs merged (labelled `clinical`).
5. **Deployer information**: deployer controls the tenant must put in place for this release, for the tenant's [DCB0160 assessment](../dcb0160-deployment-template.md).
6. **Known limitations**.
7. **Sign-off**: CSO name, registration, date and signature `[human action]`; top management acknowledgement.

## Rules

- The autonomous build may tag and deploy a release to `dev` and `staging` with a draft (unsigned) report.
- No release is enabled for a live tenant until its report is signed by the CSO. Brian checks the signature as part of the production approval. Each signature is logged in [docs/plans/human-actions.md](../../plans/human-actions.md).
- Signed reports are also exported to PDF and supplied to tenants with the release notes.

## Reports

| Version | Release | Status |
| --- | --- | --- |
| [v0.0](safety-case-v0.0-phase0.md) | Phase 0 foundations | Draft, awaiting CSO review |
| [v0.1](safety-case-v0.1-phase1.md) | Phase 1 residential MVP | Draft, awaiting CSO review and sign-off (H-381) |
| [v0.2](safety-case-v0.2-phase2.md) | Phase 2 medicines, workforce and safety | First draft while Phase 2 is built; awaiting CSO review and sign-off (H-840) |
