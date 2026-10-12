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
   Review round 4: escalation means someone other than the assignee is told (else the assignee
   is told, the gap audited at most once a day and the task retried hourly); the worker writes
   one `escalation.unrouted.daily` line per organisation for the operator to alarm on (H-170 asks
   the CSO whether the organisation needs an in-product signal); a break-glass alert no one
   receives is audited; a task about a person with no location takes the person's.
   Review round 5: the operator's two alarms (`escalation.unrouted.daily`, and
   `worker.job.failed` for any failed worker job) are CloudWatch metric filters and alarms in
   `infra/modules/observability`, live once applied (H-171); the minute escalation run, the hourly
   retry and the daily report go on to the next organisation when one fails; an overdue statutory
   notification no active member of staff can submit is audited and counted; a sync task's own
   assignee and a break-glass opener are never counted as told; the hourly retry takes every
   unrouted task; the phone records about no one while its write scope is unknown, and says why;
   `access.mfaRequired` is removed.
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
   - (review round 4) future-dated assignments and the sync token's write claim: an assignment
     or role that starts later is not in `entries_write_*` until a token is issued after it
     starts (`apps/api/src/routes/sync.ts`); decide whether the phone should learn it at the start
     time while offline.
   - (review round 4) Playwright coverage of the care plan draft page (`care-plan/[planId]`) and
     of the review, close, withdraw and correct controls on the record (risk review and close,
     withdrawing an advance care record, correcting a note or chart), each with axe and with the
     read-only case.
   - (found in review round 4) the round view tests in `apps/api/test/rounds-and-handover.test.ts`
     create tasks due 5 to 15 minutes ahead and fail between 19:45 and 20:00 London time, when
     those fall in the next shift; pin the clock or the shift pattern in those tests.
   - (review round 5) cap overdue task notifications per recipient per run and send one summary
     ("N overdue tasks need you") instead, so a home with many unrouted tasks does not flood the
     person who returns; needs a notification kind, its copy in English and Welsh, and a test.
   - (review round 5) `escalateOverdueNotifications` reads 500 overdue drafts a run, and a draft no
     active member of staff can submit stays in that set; page through them as the task retry now
     does, so such drafts cannot crowd out others.
   - (review round 5) `materialiseTaskSeries` and `raiseCareReviews` still loop over organisations
     directly; put them through `eachTenant` like the other sweeps, so one organisation's failure
     cannot stop the rest.
   - (round 5 check, security L1) when the phone's keystore can neither delete nor overwrite the
     stored write scope, the older, wider scope survives a restart and a shared phone's next user
     sees it until their first token (the API still refuses); tie the stored scope to the user or
     the token's expiry and ignore it on a mismatch. Also (clinical) a first read in flight can
     install an older stored scope after a failed save sets it to `null`.
   - (round 5 check, security L2) the hourly retry pages through every unrouted task in one
     transaction per organisation; cap the pages per run or commit per page, so one organisation
     with weeks of unrouted tasks cannot delay the rest.
   - (round 5 check, clinical) the retry's page cursor is a JavaScript `Date` (milliseconds)
     against a `timestamptz` (microseconds); take the cursor from SQL as text, so 500 or more
     tasks imported with the same sub-millisecond `due_at` cannot loop.
   - (round 5 check, clinical) the phone's "Sync again to fix this" line gives an offline carer no
     way forward: add "tell the person in charge or record on paper", and avoid showing it on a
     cold start before the stored scope is read.
   - (round 5 check, clinical) name a test for HZ-073's operator signal (today the alarm checks
     sit in the stack test's `dev_defaults` run and `run-job.test.ts` names HZ-008 and HZ-013).
   - (round 5 check, clinical, not new) `runEscalations` runs one notification at a time with no
     per-row or per-organisation isolation, so one throwing notification blocks every
     organisation's escalation chain steps; run it through `eachTenant` with a per-row guard.
   - (round 5 check, clinical) the `worker-job-failed` alarm stays in ALARM while one
     organisation's sweep keeps failing every run, hiding another's first failure; consider a
     per-job metric dimension or a shorter period once the job counts are known (H-171).
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

All of [human-actions.md](human-actions.md) is open (H-01 to H-171). The project owner has
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
| `apps/api` | 710 |
| `apps/mobile` | 891 |
| `apps/web` | 360 unit; Playwright journeys with axe (WCAG 2.2 AA) in CI |
| `infra` | `terraform test` 7 runs; fmt, validate and TFLint clean locally (review round 5); the Trivy configuration scan runs in CI only |
