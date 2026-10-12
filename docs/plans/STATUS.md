# Build status

Read this and the [feature register](../specs/feature-register.md) at the start of every session
(section 20 rule 9). The build is complete only when every register row is `done` and every phase
gate passes on `main` (section 19, definition of complete).

**Overall: 0% done** (0 of 233 register rows `done`; 60 `partial`, 173 `todo`). Rows become `done`
only when they link spec, code, tests and user documentation; no user guides exist yet.

| Phase | Scope | State |
| --- | --- | --- |
| 0 Foundations | Repo, CI, docs, design system, tenancy and RLS, auth, audit, notifications, forms skeleton, rate table, integrations framework, operator API, API, web and mobile skeletons, Terraform | Merged to `main` (#1, with web copy, `TextArea` and `AccountMenu` in #7). See [phase-0.md](phase-0.md) |
| 1 Residential MVP | People lifecycle, care plans, assessments, notes, charts, body map, tasks and handover, MCA and DoLS, incidents and classifier, downtime pack, offline Care mode, family feed | In progress: [phase-1.md](phase-1.md). On `main`: plan (#2), task and workflow engine (#3), documents and retention (#4), validated tools (#5), notes, charts, body map and care profile (#6), working days (#8), handover and round rules (#9), database pool resilience (#10), people lifecycle rules (#11), care planning schema and API (#12), consent, capacity, DoLS and incident rules (#13) and their schema and API (#14), one rule for event times typed during a clock change (#16), the web person record (#17), and the spec and rules for slice 11 packs and governance (#18), slice 12 family feed (#19) and slice 13 search, export, onboarding and DPIA (#20), offline Care mode with device holds (#15), local CI while Actions minutes are exhausted (#23), the people lifecycle schema and API (#21), the slice 5 tasks, rounds and handover API (#24), sync and device integrity (#25) and the care API follow-ups from the #15 reviews (#26). Open: data scope per permission, a security fix (`fix/platform-scope-per-permission`, ADR-0071) |
| 2 Medicines and workforce | eMAR and CDs, recruitment, training, competence, casework, rota, pay rules, quality and governance | Not started |
| 3 Money and buildings | Funding, billing, council portals, residents' money, P&L, facilities, catering, enquiries, group reporting | Not started |
| 4 Home care and family | Packages, runs, ECM, supported living, portals, Manage mode | Not started |
| 5 Clinical depth and NHS | Delegated healthcare, PBS, end of life, CHC, pharmacy, DSCR evidence, GP Connect and PDS | Not started |
| 6 Intelligence | AI copilot, report builder, benchmarks, public API, operator billing | Not started |
| 7 Expansion | Nation packs, children's homes | Not started |

## Next items (in order)

1. Review and merge data scope per permission (`fix/platform-scope-per-permission`;
   [ADR-0071](../decisions/0071-data-scope-is-per-permission.md); hazard HZ-011; PLAT-004): each
   permission reaches only the people its own roles and grants reach (`scopeFor`), and each
   request runs under the scope of the permission it uses (the narrowest of several, `none` when
   it requires none; the task list, task moves and document lookups run in `people.person.read`'s
   scope from an explicit allow-list). The sync token, device reach, handover and alert views, the
   break-glass report, task completion, incident management, status changes, return checks and
   the task an entry completes all follow the permission they act for. Review round 1 (security
   and clinical): assigned and break-glass people count only for the permissions that reach them
   (break-glass reads only, H-168), grants and location roles with no location reach the whole
   organisation only when marked (migrations 0048 and 0049), each family of sync streams follows
   its own read permission, documents follow their category's read permission, the audit trail is
   whole only across the organisation, person tasks go only to people who can see the person, and
   hazard HZ-073 (H-169). Review round 2: one definition of the nurse in charge, filtered only by
   what the recipient can see (a team leader in charge is told of an urgent refused-entry review),
   and an unrouted review audited; the web and the phone offer no form the API would refuse
   (`access` on the person, `entries_write_*` on the sync token); signing a person's document
   needs its write permission; migration 0048 stops on a live grant with no location; everyone
   told by role holds the role now (`roleHolders`); the access report lists narrows and widens.
   Review round 3: every tab of the record follows `access.reaching` (no form under break-glass
   on any tab); the phone decides per person for a coordinator who is also a carer
   (`entries_write_person_ids`); an overdue task and an escalation chain step go down their order
   until someone active is told, else the gap is audited and nothing is marked done; only active
   staff are told; document subjects are an allow-list; `seed-users` needs an explicit opt-in.
   Before deploying to a live tenant: sync every device (checked on Today, in the device list and
   with the device check), run the pre-deployment access report
   ([runbook](../runbooks/data-scope-per-permission-access-report.md)), end or place any grant
   with no location, and have the Registered Manager review role bundles (release note).
2. Follow-ups from data scope per permission:
   - (S-M3) give audit events a `location_id` (from the person, record or location they are
     about), so a reader holding `platform.audit.read` at some homes sees those homes' events;
     until then they see only their own events and events about people they reach, without
     reasons.
   - (review round 2) bound grant and role assignment writes by the granter's own permissions
     (a granter may give only permissions they hold, where they hold them), before any route
     edits grants or role assignments.
   - (review round 2) `withTenantWideScope` restores the request's scope in a `finally`, so an
     error inside it cannot leave the wider scope set for the rest of the transaction.
   - (review round 2) when `destroyingOnFailure` cannot destroy the bytes stored for a
     transaction that then failed, record the storage key (today the failure is swallowed), so the
     retention sweep finds and destroys them.
3. The screens the care API follow-ups (#26) wait on (slice 9 and slice 10 part 2): the
   escalation policy link on the phone, staff names on the web and phone (H-73); the settings for
   escalation policies and coded reasons; the phone offering the organisation's coded reasons (H-164);
   devices and revocation, and refused copies on the review task (which H-134 waits on), in the
   web record; the round and handover screens in the web record and Care mode (with sync streams
   for tasks and handovers and offline acknowledgement). Still open from the #15 reviews: the
   stale-device check now that `device_binding` exists (H-141), and client ids on create routes
   outside care (care.md section 10, for the `people` and `platform` owners).
4. Slice 5 follow-ups: move a person's care plan rounds with them when they move location
   (people transfers); a worded summary per handover item so screens need not read each source;
   rota-defined shifts and incoming staff (Phase 2, H-153).
5. Schema and API for slices 11 to 13 on the rules now on `main` (downtime pack, outages and
   back-entry, evidence packs, statement of purpose, templates and letters; the family feed,
   channels, notifications, visit booking and the family portal policy of ADR-0061; search, the
   full export, DPIA, onboarding and sample data), then slice 14; the rest of the web record
   (slice 9) and Care mode part 2 (slice 10) alongside ([phase-1.md](phase-1.md)).
6. Phase 0 follow-ups carried into Phase 1: operator console web UI and read-only impersonation
   session; invitations and MFA enrolment flow end to end; admin session revoke and idle timeouts
   per role; record history PDF export; device push registration; OpenFeature provider; user
   guides per role (moves PLAT and MOB rows to `done`).
7. Open engineering decisions: certificate pinning (ADR-0028), shared-device sign-in (ADR-0025,
   needs CSO and DPO), the risk rating matrix (ADR-0032, proposed).
8. `@harbour/ui` defaults without a label prop stay English in a Welsh shell: the sidebar's expand
   and collapse labels, the data table's density control ("Row density", "Comfortable", "Compact")
   and the app bar's "None selected"; add label props before Welsh tenants (Phase 7).
9. Nation coverage: `care_plan.initial_working_days` and the classifier are England-only; the bank
   holiday calendar runs to the end of 2028.
10. Role matrix question from slice 4b: care workers hold `care.assessment.write` and team leaders
   lack `care.plan.write`, while the spec says nurses and seniors assess and publish.
11. Dependencies: the two high advisories are recorded exceptions (build tooling, no fixed
    version; [vulnerability-exceptions.md](../compliance/vulnerability-exceptions.md)). Still to
    do: esbuild in `apps/api` to 0.28.1, and a tracked note for the moderate ones
    (decode-uri-component in the app waits for the next Expo SDK; the rest are build tools).
12. Urgent alert fallback cost (#26 review round 4): when no nurse in charge can open the record,
    `alertFallback` reads every Registered Manager's and care plan holder's view of the person in
    two `staffViews` calls (one for `people.person.read`, one for `care.plan.write`, ADR-0071),
    each running two statements per candidate (the person scope is row-level security, evaluated
    under each member's settings) inside the entry's transaction.
    Measure it against the 100 ms point-of-care budget on a large organisation; if it is slow,
    evaluate the scope for all candidates at once in a database function.

## Human actions outstanding

All of [human-actions.md](human-actions.md) is open (H-01 to H-169). The project owner has
scheduled the accounts (H-01, H-02, H-04, H-10, H-11) and the named roles (H-20 Clinical Safety
Officer, H-30 data protection lead, H-31 ICO registration) for after the build, and is choosing
the UK SMS provider (H-09, which also settles H-105). Until then the build continues against the
mocks and contract tests (section 20 rule 2).

## Test totals (local, the data-scope-per-permission branch on the current `main`)

| Package | Tests |
| --- | --- |
| `packages/domain` | 4,069 |
| `packages/db` | 393 (real Postgres: RLS coverage, isolation, scope, audit chain, seed, tasks, documents, care record, care planning, MCA and incidents, people lifecycle, bank holidays, pools, export catalogue, handovers, device integrity, the care API follow-ups, scope per permission) |
| `packages/sync` | 62 (PowerSync rules engine) |
| `packages/contracts` | 34 |
| `packages/i18n` | 48 |
| `packages/ui` | 342 (231 axe runs) |
| `packages/ui-native` | 141 |
| `apps/api` | 684 |
| `apps/mobile` | 882 |
| `apps/web` | 349 unit; Playwright journeys with axe (WCAG 2.2 AA) in CI |
| `infra` | `terraform test` 3, TFLint, Trivy and Checkov clean |
