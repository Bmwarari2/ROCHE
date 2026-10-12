# Build status

Read this and the [feature register](../specs/feature-register.md) at the start of every session
(section 20 rule 9). The build is complete only when every register row is `done` and every phase
gate passes on `main` (section 19, definition of complete).

**Overall: 0% done** (0 of 233 register rows `done`; 60 `partial`, 173 `todo`). Rows become `done`
only when they link spec, code, tests and user documentation; no user guides exist yet.

| Phase | Scope | State |
| --- | --- | --- |
| 0 Foundations | Repo, CI, docs, design system, tenancy and RLS, auth, audit, notifications, forms skeleton, rate table, integrations framework, operator API, API, web and mobile skeletons, Terraform | Merged to `main` (#1, with web copy, `TextArea` and `AccountMenu` in #7). See [phase-0.md](phase-0.md) |
| 1 Residential MVP | People lifecycle, care plans, assessments, notes, charts, body map, tasks and handover, MCA and DoLS, incidents and classifier, downtime pack, offline Care mode, family feed | In progress: [phase-1.md](phase-1.md). On `main`: plan (#2), task and workflow engine (#3), documents and retention (#4), validated tools (#5), notes, charts, body map and care profile (#6), working days (#8), handover and round rules (#9), database pool resilience (#10), people lifecycle rules (#11), care planning schema and API (#12), consent, capacity, DoLS and incident rules (#13) and their schema and API (#14), one rule for event times typed during a clock change (#16), the web person record (#17), and the spec and rules for slice 11 packs and governance (#18), slice 12 family feed (#19) and slice 13 search, export, onboarding and DPIA (#20), offline Care mode with device holds (#15), local CI while Actions minutes are exhausted (#23), the people lifecycle schema and API (#21) and the slice 5 tasks, rounds and handover API (#24). Open: sync and device integrity, the #15 follow-ups (`feat/sync-device-integrity`) |
| 2 Medicines and workforce | eMAR and CDs, recruitment, training, competence, casework, rota, pay rules, quality and governance | Not started |
| 3 Money and buildings | Funding, billing, council portals, residents' money, P&L, facilities, catering, enquiries, group reporting | Not started |
| 4 Home care and family | Packages, runs, ECM, supported living, portals, Manage mode | Not started |
| 5 Clinical depth and NHS | Delegated healthcare, PBS, end of life, CHC, pharmacy, DSCR evidence, GP Connect and PDS | Not started |
| 6 Intelligence | AI copilot, report builder, benchmarks, public API, operator billing | Not started |
| 7 Expansion | Nation packs, children's homes | Not started |

## Next items (in order)

1. Review and merge sync and device integrity (`feat/sync-device-integrity`; [care.md](../specs/care.md)
   section 6, Device integrity): device bindings (`device_binding`), revocation with
   `device_revoked` and the app's wipe or hold, deletion lists (`device_discard_entry`, closing the
   HZ-040 index blocker), one open sync task per source, the server copy of every refused entry
   with a review task (HZ-006), the manager hand-over of held entries, and per-user limits in
   Postgres (migrations 0029 to 0042; hazards HZ-004, HZ-006, HZ-008, HZ-010, HZ-011, HZ-023,
   HZ-040; human actions H-156 to H-159). Review round 2 answered: hand-overs tied to the
   device's reported hold, the owner's time on the device and their care, with "Sent by" on the
   entry; a hand-over that is not taken keeps the entry held, and the device keeps its database
   while any refused entry waits; revocation ends the device's sessions and hurries its hold;
   copies checked against their contracts and the author's care. Then the screens: devices and
   revocation, and refused copies on the review task (which H-134 waits on), in the web record
   (slice 9); the round and handover screens in the web record and Care mode (slice 10 part 2,
   with sync streams for tasks and handovers and offline acknowledgement).
2. API follow-ups from the #15 reviews still open: the stale-device check now that
   `device_binding` exists (H-141); the IDDSI drink level required when prescribed; client ids on
   the four remaining create routes; the escalation-policy link on validated-tool results; the
   drawn body-map side derived on the server; staff names; a tenant table for discard reasons,
   the discard replay unique index and a server-side discarded-id flag.
3. Slice 5 follow-ups: move a person's care plan rounds with them when they move location
   (people transfers); a worded summary per handover item so screens need not read each source;
   rota-defined shifts and incoming staff (Phase 2, H-153).
4. Schema and API for slices 11 to 13 on the rules now on `main` (downtime pack, outages and
   back-entry, evidence packs, statement of purpose, templates and letters; the family feed,
   channels, notifications, visit booking and the family portal policy of ADR-0061; search, the
   full export, DPIA, onboarding and sample data), then slice 14; the rest of the web record
   (slice 9) and Care mode part 2 (slice 10) alongside ([phase-1.md](phase-1.md)).
5. Phase 0 follow-ups carried into Phase 1: operator console web UI and read-only impersonation
   session; invitations and MFA enrolment flow end to end; admin session revoke and idle timeouts
   per role; record history PDF export; device push registration; OpenFeature provider; user
   guides per role (moves PLAT and MOB rows to `done`).
6. Open engineering decisions: certificate pinning (ADR-0028), shared-device sign-in (ADR-0025,
   needs CSO and DPO), the risk rating matrix (ADR-0032, proposed).
7. `@harbour/ui` defaults without a label prop stay English in a Welsh shell: the sidebar's expand
   and collapse labels, the data table's density control ("Row density", "Comfortable", "Compact")
   and the app bar's "None selected"; add label props before Welsh tenants (Phase 7).
8. Nation coverage: `care_plan.initial_working_days` and the classifier are England-only; the bank
   holiday calendar runs to the end of 2028.
9. Role matrix question from slice 4b: care workers hold `care.assessment.write` and team leaders
   lack `care.plan.write`, while the spec says nurses and seniors assess and publish.
10. Dependencies: the two high advisories are recorded exceptions (build tooling, no fixed
    version; [vulnerability-exceptions.md](../compliance/vulnerability-exceptions.md)). Still to
    do: esbuild in `apps/api` to 0.28.1, and a tracked note for the moderate ones
    (decode-uri-component in the app waits for the next Expo SDK; the rest are build tools).

## Human actions outstanding

All of [human-actions.md](human-actions.md) is open (H-01 to H-159). The project owner has
scheduled the accounts (H-01, H-02, H-04, H-10, H-11) and the named roles (H-20 Clinical Safety
Officer, H-30 data protection lead, H-31 ICO registration) for after the build, and is choosing
the UK SMS provider (H-09, which also settles H-105). Until then the build continues against the
mocks and contract tests (section 20 rule 2).

## Test totals (local, the sync and device integrity branch on the current `main`)

| Package | Tests |
| --- | --- |
| `packages/domain` | 3,914 |
| `packages/db` | 338 (real Postgres: RLS coverage, isolation, scope, audit chain, seed, tasks, documents, care record, care planning, MCA and incidents, people lifecycle, bank holidays, pools, export catalogue, handovers, device integrity) |
| `packages/sync` | 59 (PowerSync rules engine) |
| `packages/contracts` | 30 |
| `packages/i18n` | 48 |
| `packages/ui` | 342 (231 axe runs) |
| `packages/ui-native` | 141 |
| `apps/api` | 553 |
| `apps/mobile` | 861 |
| `apps/web` | 306 unit; Playwright journeys with axe (WCAG 2.2 AA) in CI |
| `infra` | `terraform test` 3, TFLint, Trivy and Checkov clean |
