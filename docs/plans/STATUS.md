# Build status

Read this and the [feature register](../specs/feature-register.md) at the start of every session
(section 20 rule 9). The build is complete only when every register row is `done` and every phase
gate passes on `main` (section 19, definition of complete).

**Overall: 0% done** (0 of 233 register rows `done`; 24 `partial`, 209 `todo`). Rows become `done`
only when they link spec, code, tests and user documentation; no user guides exist yet.

| Phase | Scope | State |
| --- | --- | --- |
| 0 Foundations | Repo, CI, docs, design system, tenancy and RLS, auth, audit, notifications, forms skeleton, rate table, integrations framework, operator API, API, web and mobile skeletons, Terraform | Built; every CI check green on pull request #1, awaiting merge to `main`. Web copy in the catalogues, `TextArea` and `AccountMenu` in pull request #7. See [phase-0.md](phase-0.md) |
| 1 Residential MVP | People lifecycle, care plans, assessments, notes, charts, body map, tasks and handover, MCA and DoLS, incidents and classifier, downtime pack, offline Care mode, family feed | In progress: [phase-1.md](phase-1.md). Pull requests stacked in order: #2 plan and specs, #3 task and workflow engine, #4 document store and retention, #5 validated tools, #6 notes, charts, body map and care profile, #8 working days with bank holidays. Being built: slice 4b (care plans, risk assessments, assessments, advance care, activities, visits), the domain rules for slices 6 and 7 (consent, capacity, DoLS, incident classifier) and slice 8 (people lifecycle) |
| 2 Medicines and workforce | eMAR and CDs, recruitment, training, competence, casework, rota, pay rules, quality and governance | Not started |
| 3 Money and buildings | Funding, billing, council portals, residents' money, P&L, facilities, catering, enquiries, group reporting | Not started |
| 4 Home care and family | Packages, runs, ECM, supported living, portals, Manage mode | Not started |
| 5 Clinical depth and NHS | Delegated healthcare, PBS, end of life, CHC, pharmacy, DSCR evidence, GP Connect and PDS | Not started |
| 6 Intelligence | AI copilot, report builder, benchmarks, public API, operator billing | Not started |
| 7 Expansion | Nation packs, children's homes | Not started |

## Next items (in order)

1. Merge the stacked pull requests in order (#1, #7, #2, #3, #4, #5, #6, #8) once reviewed; each
   carries the CI fixes of the ones below it.
2. Phase 1 slice 4b, then the schema and API for slices 6, 7 and 8 on top of their domain rules,
   then slice 5 (care plan actions generate shift tasks, rounds, handover), slice 9 (web UI),
   slice 10 (offline Care mode), slices 11 to 14 ([phase-1.md](phase-1.md)).
3. Phase 0 follow-ups carried into Phase 1: operator console web UI and read-only impersonation
   session; invitations and MFA enrolment flow end to end; admin session revoke and idle timeouts
   per role; weekly break-glass report; record history PDF export; device push registration; OpenFeature provider;
   user guides per role for the Phase 0 features (moves PLAT and MOB rows to `done`).
4. Open engineering decisions: certificate pinning (ADR-0028), shared-device sign-in (ADR-0025, needs
   CSO and DPO).
5. `@harbour/ui` defaults without a label prop stay English in a Welsh shell: the sidebar's expand
   and collapse labels, the data table's density control and the app bar's "None selected".
6. Workflow SLAs and the rate lookup use England until workflows carry their location's nation
   (slice 7); the bank holiday calendar runs to the end of 2028 and needs the next year added when
   GOV.UK publishes it.

## Human actions outstanding

All of [human-actions.md](human-actions.md) is open (H-01 to H-57). The ones that unblock the most:
H-01 and H-02 (GitHub organisation and branch protection), H-04 (AWS dev account), H-20 (Clinical
Safety Officer), H-30 and H-31 (data protection lead and ICO registration), H-10 and H-11 (Expo,
Apple and Google accounts).

## Test totals (local)

| Package | Tests |
| --- | --- |
| `packages/domain` | 813 (99.9% line coverage) |
| `packages/db` | 112 (real Postgres: RLS coverage, isolation, scope, audit chain, seed, tasks, documents, care record, bank holidays) |
| `packages/sync` | 10 (PowerSync rules engine) |
| `packages/contracts` | 4 |
| `packages/i18n` | 14 (34 with pull request #7) |
| `packages/ui` | 190, 136 axe runs (233 and 160 with pull request #7) |
| `packages/ui-native` | 133 |
| `apps/api` | 131 (sessions, tasks, workflow, documents, care record, production config) |
| `apps/mobile` | 208 |
| `apps/web` | 101 unit (142 with pull request #7); 8 Playwright journeys with axe (WCAG 2.2 AA), passkey sign-in, nonce CSP |
| `infra` | `terraform test` 3, TFLint, Trivy and Checkov clean |
