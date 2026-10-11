# Build status

Read this and the [feature register](../specs/feature-register.md) at the start of every session
(section 20 rule 9). The build is complete only when every register row is `done` and every phase
gate passes on `main` (section 19, definition of complete).

**Overall: 0% done** (0 of 233 register rows `done`; 15 `partial`, 218 `todo`). Rows become `done`
only when they link spec, code, tests and user documentation; no user guides exist yet.

| Phase | Scope | State |
| --- | --- | --- |
| 0 Foundations | Repo, CI, docs, design system, tenancy and RLS, auth, audit, notifications, forms skeleton, rate table, integrations framework, operator API, API, web and mobile skeletons, Terraform | Built and verified locally; awaiting CI on the pull request and the web shell's final checks. See [phase-0.md](phase-0.md) |
| 1 Residential MVP | People lifecycle, care plans, assessments, notes, charts, body map, tasks and handover, MCA and DoLS, incidents and classifier, downtime pack, offline Care mode, family feed | Not started |
| 2 Medicines and workforce | eMAR and CDs, recruitment, training, competence, casework, rota, pay rules, quality and governance | Not started |
| 3 Money and buildings | Funding, billing, council portals, residents' money, P&L, facilities, catering, enquiries, group reporting | Not started |
| 4 Home care and family | Packages, runs, ECM, supported living, portals, Manage mode | Not started |
| 5 Clinical depth and NHS | Delegated healthcare, PBS, end of life, CHC, pharmacy, DSCR evidence, GP Connect and PDS | Not started |
| 6 Intelligence | AI copilot, report builder, benchmarks, public API, operator billing | Not started |
| 7 Expansion | Nation packs, children's homes | Not started |

## Next items (in order)

1. Land the Phase 0 pull request with CI green; fix anything CI finds that local runs did not.
2. Phase 1 plan (`docs/plans/phase-1.md`) and specs for `care`, `safety` and the residential slice of
   `people`; then build schema and domain rules first (section 19 order of work).
3. Phase 0 follow-ups carried into Phase 1: operator console web UI and read-only impersonation
   session; invitations and MFA enrolment flow end to end; device and session management; weekly
   break-glass report; record history PDF export; device push registration; OpenFeature provider;
   user guides per role for the Phase 0 features (moves PLAT and MOB rows to `done`).
4. Open engineering decisions: certificate pinning (ADR-0028), shared-device sign-in (ADR-0025, needs
   CSO and DPO).

## Human actions outstanding

All of [human-actions.md](human-actions.md) is open (H-01 to H-57). The ones that unblock the most:
H-01 and H-02 (GitHub organisation and branch protection), H-04 (AWS dev account), H-20 (Clinical
Safety Officer), H-30 and H-31 (data protection lead and ICO registration), H-10 and H-11 (Expo,
Apple and Google accounts).

## Test totals (local, Phase 0)

| Package | Tests |
| --- | --- |
| `packages/domain` | 203 (99% line coverage) |
| `packages/db` | 78 (real Postgres: RLS coverage, isolation, scope, audit chain, seed) |
| `packages/sync` | 10 (PowerSync rules engine) |
| `packages/contracts` | 4 |
| `packages/i18n` | 14 |
| `packages/ui` | 190 (136 axe runs) |
| `packages/ui-native` | 133 |
| `apps/api` | 70 |
| `apps/mobile` | 208 |
| `apps/web` | see the web shell's report in CHANGELOG-DEV.md |
| `infra` | `terraform test` 3, TFLint, Trivy and Checkov clean |
