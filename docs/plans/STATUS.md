# Build status

Read this and the [feature register](../specs/feature-register.md) at the start of every session
(section 20 rule 9). The build is complete only when every register row is `done` and every phase
gate passes on `main` (section 19, definition of complete).

**Overall: 0% done** (0 of 233 register rows `done`; 46 `partial`, 187 `todo`). Rows become `done`
only when they link spec, code, tests and user documentation; no user guides exist yet.

| Phase | Scope | State |
| --- | --- | --- |
| 0 Foundations | Repo, CI, docs, design system, tenancy and RLS, auth, audit, notifications, forms skeleton, rate table, integrations framework, operator API, API, web and mobile skeletons, Terraform | Built; every CI check green on pull request #1, awaiting merge to `main`. Web copy in the catalogues, `TextArea` and `AccountMenu` in pull request #7. See [phase-0.md](phase-0.md) |
| 1 Residential MVP | People lifecycle, care plans, assessments, notes, charts, body map, tasks and handover, MCA and DoLS, incidents and classifier, downtime pack, offline Care mode, family feed | In progress: [phase-1.md](phase-1.md). Pull requests stacked in order: #2 plan, #3 task and workflow engine, #4 documents and retention, #5 validated tools, #6 notes, charts, body map, #8 working days, #9 handover and round rules, #10 database pool resilience, #11 people lifecycle rules, #12 care plans, risk assessments, assessments, advance care, activities and visits (schema and API), #13 consent, capacity, DoLS and incident classifier rules. Next: schema and API for slices 6 and 7, then 8, then 5; web UI (slice 9) and offline Care mode (slice 10) alongside |
| 2 Medicines and workforce | eMAR and CDs, recruitment, training, competence, casework, rota, pay rules, quality and governance | Not started |
| 3 Money and buildings | Funding, billing, council portals, residents' money, P&L, facilities, catering, enquiries, group reporting | Not started |
| 4 Home care and family | Packages, runs, ECM, supported living, portals, Manage mode | Not started |
| 5 Clinical depth and NHS | Delegated healthcare, PBS, end of life, CHC, pharmacy, DSCR evidence, GP Connect and PDS | Not started |
| 6 Intelligence | AI copilot, report builder, benchmarks, public API, operator billing | Not started |
| 7 Expansion | Nation packs, children's homes | Not started |

## Next items (in order)

1. Merge the stacked pull requests in order (#1, #7, #2, #3, #4, #5, #6, #8, #9, #10, #11, #12,
   #13) once reviewed; each carries the CI fixes of the ones below it.
2. Built and awaiting pull requests: the schema and API for slices 6 and 7
   (`feat/mca-and-incidents-api`) and the people lifecycle schema and API with its security and
   clinical review fixes, three rounds (slice 8, `feat/people-lifecycle-api`, pull request #21,
   migrations 0020 to 0024; CSO decisions H-82 to H-94 and H-130). After main is merged into it,
   export catalogue entries for the tables and columns 0020 to 0024 add, and the entry and task
   badges wired into main's chart and task views. Next: slice 5's API (care plan actions generate task series, handover
   table, round and handover routes).
3. Web UI for the record built so far (slice 9) and offline Care mode (slice 10), then slices 11 to
   14 ([phase-1.md](phase-1.md)).
4. Phase 0 follow-ups carried into Phase 1: operator console web UI and read-only impersonation
   session; invitations and MFA enrolment flow end to end; admin session revoke and idle timeouts
   per role; record history PDF export; device push registration; OpenFeature provider; user
   guides per role (moves PLAT and MOB rows to `done`).
5. Open engineering decisions: certificate pinning (ADR-0028), shared-device sign-in (ADR-0025),
   the risk rating matrix (ADR-0032, proposed).
6. `@harbour/ui` defaults without a label prop stay English in a Welsh shell (sidebar expand and
   collapse, data table density, app bar "None selected").
7. Nation coverage: `care_plan.initial_working_days` and the classifier are England-only; the bank
   holiday calendar runs to the end of 2028.
8. Role matrix question from slice 4b: care workers hold `care.assessment.write` and team leaders
   lack `care.plan.write`, while the spec says nurses and seniors assess and publish.

## Human actions outstanding

All of [human-actions.md](human-actions.md) is open (H-01 to H-94 and H-130; the slice 8 review
added the CSO decisions H-82 to H-94 and H-130). The ones that unblock the most:
H-01 and H-02 (GitHub organisation and branch protection), H-04 (AWS dev account), H-20 (Clinical
Safety Officer), H-30 and H-31 (data protection lead and ICO registration), H-10 and H-11 (Expo,
Apple and Google accounts).

## Test totals (local, top of the stack)

| Package | Tests |
| --- | --- |
| `packages/domain` | 1,944 |
| `packages/db` | 266 (real Postgres: RLS coverage, isolation, scope, audit chain, seed, tasks, documents, care record, care planning, MCA and incidents, people lifecycle, bank holidays, pools) |
| `packages/sync` | 10 (PowerSync rules engine) |
| `packages/contracts` | 16 |
| `packages/i18n` | 14 (34 with pull request #7) |
| `packages/ui` | 200, 143 axe runs (233 and 160 with pull request #7) |
| `packages/ui-native` | 134 |
| `apps/api` | 383 (sessions, tasks, workflow, documents, care record, care planning, MCA and incidents, people lifecycle, the printed pack, production config) |
| `apps/mobile` | 208 |
| `apps/web` | 114 unit (more with pull request #7); 8 Playwright journeys with axe (WCAG 2.2 AA), passkey sign-in, nonce CSP |
| `infra` | `terraform test` 3, TFLint, Trivy and Checkov clean |
