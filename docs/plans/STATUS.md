# Build status

Read this and the [feature register](../specs/feature-register.md) at the start of every session
(section 20 rule 9). The build is complete only when every register row is `done` and every phase
gate passes on `main` (section 19, definition of complete).

**Overall: 0% done** (0 of 233 register rows `done`; 60 `partial`, 173 `todo`). Rows become `done`
only when they link spec, code, tests and user documentation; no user guides exist yet.

| Phase | Scope | State |
| --- | --- | --- |
| 0 Foundations | Repo, CI, docs, design system, tenancy and RLS, auth, audit, notifications, forms skeleton, rate table, integrations framework, operator API, API, web and mobile skeletons, Terraform | Merged to `main` (#1, with web copy, `TextArea` and `AccountMenu` in #7). See [phase-0.md](phase-0.md) |
| 1 Residential MVP | People lifecycle, care plans, assessments, notes, charts, body map, tasks and handover, MCA and DoLS, incidents and classifier, downtime pack, offline Care mode, family feed | In progress: [phase-1.md](phase-1.md). On `main`: plan (#2), task and workflow engine (#3), documents and retention (#4), validated tools (#5), notes, charts, body map and care profile (#6), working days (#8), handover and round rules (#9), database pool resilience (#10), people lifecycle rules (#11), care planning schema and API (#12), consent, capacity, DoLS and incident rules (#13) and their schema and API (#14), one rule for event times typed during a clock change (#16), the web person record (#17), and the spec and rules for slice 11 packs and governance (#18), slice 12 family feed (#19) and slice 13 search, export, onboarding and DPIA (#20), offline Care mode with device holds (#15), local CI while Actions minutes are exhausted (#23), the people lifecycle schema and API (#21), the slice 5 tasks, rounds and handover API (#24), sync and device integrity (#25), the care API follow-ups from the #15 reviews (#26) and data scope per permission, a security fix (#27, ADR-0071). Hosted CI runs again from 12/10/2026 (the repository is public) |
| 2 Medicines and workforce | eMAR and CDs, recruitment, training, competence, casework, rota, pay rules, quality and governance | Not started |
| 3 Money and buildings | Funding, billing, council portals, residents' money, P&L, facilities, catering, enquiries, group reporting | Not started |
| 4 Home care and family | Packages, runs, ECM, supported living, portals, Manage mode | Not started |
| 5 Clinical depth and NHS | Delegated healthcare, PBS, end of life, CHC, pharmacy, DSCR evidence, GP Connect and PDS | Not started |
| 6 Intelligence | AI copilot, report builder, benchmarks, public API, operator billing | Not started |
| 7 Expansion | Nation packs, children's homes | Not started |

## Next items (in order)

1. Data scope per permission is merged (#27, with the round 5 check's alarm fix;
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
   - (review round 5) cap overdue task notifications per recipient per run and send one summary
     ("N overdue tasks need you") instead, so a home with many unrouted tasks does not flood the
     person who returns; needs a notification kind, its copy in English and Welsh, and a test.
   - (review round 5) `escalateOverdueNotifications` reads 500 overdue drafts a run, and a draft no
     active member of staff can submit stays in that set; page through them as the task retry now
     does, so such drafts cannot crowd out others.
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
   - (round 2 check of `fce5211`, clinical) one alarm notification can cover several
     organisations from the same daily run: the on-call runbook's action should say to read every
     `escalation.unrouted.daily` line from that run, not just the first.
   - (#30 reviews, lows) add `hazard HZ-001 shows the shift running now by default...` to
     HZ-001's evidence row in the hazard log; that test reads the shift twice and can fail if run
     exactly across a shift change; list the task series and care review sweeps in the on-call
     runbook's `worker.job.failed` row (a failed organisation now waits for the next run, 15
     minutes or an hour, rather than a pg-boss retry).
   - (#31 review, low) GitHub's own "Code scanning results / CodeQL" check now reports on pull
     requests and can fail on new error-level quality alerts our gate passes; keep it optional in
     branch protection, or set its failure threshold in Settings, Advanced Security.
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
   - Slice 11 part 1, downtime pack and outage schema (`feat/operations-downtime-schema`,
     migrations 0050 and 0051; operations.md section 12): in review. Next, part 2: the
     expand-only back-entry columns on `care_note`, `observation`, `body_map_mark`,
     `activity_record` and `visit_log` (with `outage_id`), the cancel refusal once a back-entry
     cites an outage and the reconciler check; then part 3, the API, nightly job and PDF.
   - Follow-ups from #32 review round 1 (security and clinical):
     - bound outage and pack times: no far-future `back_entry_due_at`, `closed_at` or
       `generated_at`, and a start or end in the future (beyond the clock tolerance) refused in
       the database as the domain refuses it;
     - `downtime_pack.warnings` holds counts and opaque ids only: a CHECK or a write-side mapping
       test (the domain's `DowntimeWarning` carries a message, which must not be stored there);
     - outage free text (description, reconciliation statement, cancellation and correction
       reasons) reaches assigned care workers: guidance on the forms not to write names;
     - `outage.workflow_instance_id` is not checked to be an `operations.outage` workflow for an
       outage at this location;
     - a kiosk-built pack is inserted under its builder's permission when uploaded, so it is
       refused if their role or grant has ended by then;
     - a location-scoped Registered Manager cannot review a pre-move pack later (H-200);
     - an open outage with no end blocks the next declaration at the location until it is closed
       or corrected;
     - part 3 emits the `operations.*` audit and outbox events of section 5;
     - store an outage's start as typed with the occurrence chosen in a repeated hour (needs the
       domain's declaration to carry the written form, as `resolvePaperTime` does);
     - who may change the other `location` columns is still enforced only by the API.
   - Follow-ups from #32 review round 2:
     - a missing `care_note.late_entry_hours` rate marks every outage late without saying why:
       audit it as a configuration gap;
     - the database does not refuse a corrected start in the future;
     - `rate_table` writes have no permission check, so any member could override
       `care_note.late_entry_hours` (an existing gap).
6. Phase 0 follow-ups carried into Phase 1: operator console web UI and read-only impersonation
   session; invitations and MFA enrolment flow end to end; record history PDF export; device push
   registration; user guides per role (moves PLAT and MOB rows to `done`). The OpenFeature
   provider is in feat/platform-flags-and-sessions, the admin sign-out and idle timeouts per role
   in feat/platform-session-controls (items 16 and 17).
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
    version; [vulnerability-exceptions.md](../compliance/vulnerability-exceptions.md)). esbuild in
    `apps/api` is on 0.28. Still to do: a tracked note for the moderate ones
    (decode-uri-component in the app waits for the next Expo SDK; the rest are build tools).
12. Urgent alert fallback cost (#26 review round 4): when no nurse in charge can open the record,
    `alertFallback` reads every Registered Manager's and care plan holder's view of the person in
    two `staffViews` calls (one for `people.person.read`, one for `care.plan.write`, ADR-0071),
    each running two statements per candidate (the person scope is row-level security, evaluated
    under each member's settings) inside the entry's transaction.
    Measure it against the 100 ms point-of-care budget on a large organisation; if it is slow,
    evaluate the scope for all candidates at once in a database function.
13. The consent, capacity and DoLS tab, the rest (slice 9, CARE-021 and CARE-022; consent by
    decision and the DoLS register are on `main` (#34); the capacity assessment, best-interests and
    consent record views are on `feat/web-mca-records`): the forms, each offered only
    where `access.reaching` lists its permission and with the read-only line otherwise (ADR-0071),
    each with a client UUIDv7 kept across retries (HZ-029) and its refusals mapped in
    `refusals.ts`: record a consent or refusal (the representative and their authority, the
    restraint conditions for bed rails, the best-interests decision for covert medicines) and
    withdraw one (`care.capacity.write`); a two-stage capacity assessment and its correction; a
    best-interests decision; record a DoLS request or authorisation and update its outcome, dates,
    extension or end (`care.dols.manage`), deciding with the CSO how a typed end date maps to the
    API's exclusive `grantedTo` (HZ-020); and the legal-change review screen
    (`/v1/dols/legal-change-review`). Also: consents and DoLS in the history tab's list of records
    with earlier versions, and the API gaps in care.md section 10 (English-only reasons; an
    expired authorisation that a later one followed reads as expired).
14. Follow-ups from review round 1 of the consent, capacity and DoLS tab (#34; H-250 to H-253 ask
    the CSO): a drafted CQC notification past its due time has no overdue cue on the tab; the
    expiry reminder lines do not say whether the reminder was sent or acted on; check the timing
    of "Today is the last day in force" against the API's `daysLeft` and the expiry job once the
    CSO answers H-250; the empty DoLS register gives no next step (who to ask, or the form once it
    exists); the legal-change review warning does not follow the tenant flag (H-253) and shows for
    homes in Wales although its text points to DHSC guidance for England. From review round 2: an
    unknown outcome or type reads as plain text, not the warning chip the hazard log describes; an
    authorisation not yet started with a midnight end reads "In force until the end of ...".
15. Slice 10 part 2 on the phone (Lane C), the round and the handover: the sync streams, the
    token's handover claims and the client tables are on `main` (#33,
    [care.md](../specs/care.md) section 6), with migration
    0052, which adds `task`, `handover`, `handover_item`, `handover_note` and
    `handover_acknowledgement` to the `powersync` publication with the `sync_replication_read`
    policy and `SELECT` for `harbour_sync`, and a database test that every table the streams read
    is published. Then: completing or skipping a task and acknowledging a handover offline
    (queued, idempotent, the task's version and the seen token over the items shown; a refusal to
    "needs attention"), then the round and handover screens in Care mode (staff names where the
    API gives them, the window and last sync said on the round, HZ-028).
    - Screens gate (#33 review round 1, clinical M2 and M3): the round and handover screens do not
      ship until (a) each handover item carries a worded summary (item 4) or its source
      (incidents, alerts, skipped-task reasons) is on the device (H-300); (b) the "From an earlier
      plan" notice reaches the phone, through the plan action reference or a computed flag
      (HZ-024, H-303); (c) the publication migration has landed (0052, in #33); (d) an empty list
      on the phone never reads as "nothing due" when the streams have no data; (e) the phone can
      say "the outgoing handover is not compiled yet" or "not final", which needs the shift
      pattern or the expected shift on the device, decided in the screens PR (#33 review round 2;
      H-303); (f) a task whose evidence entry is saved on the phone shows "evidence recorded,
      waiting to upload" until it uploads, so it is not recorded twice (#36 review round 1,
      clinical M3; HZ-029).
    - Follow-up: whether the round on the phone should also hold unfinished tasks due before the
      window (H-301).
    - Follow-up (#33 review round 1): the streams ignore `person_assignment.valid_from`, so a
      future-dated assignment syncs early; the existing pattern is now in seven more queries. Sync
      rules cannot read the clock: decide between a token claim naming the assignments in force
      and keeping a future assignment out of replication until it starts.
    - Follow-up (#33 review round 1): the window tests check the query text only; add tests at
      UTC midnight and across the clock changes on `task.due_at` and `handover.shift_end`.
    - Follow-up (#33 review round 1): `location_open_tasks` keeps tasks about people active, on
      leave or in hospital, while the web round has no status filter, so tasks about someone at
      pre-admission are on the web round only.
    - Offline writes for the round and the handover: the local writes (a task done or not
      done, a handover acknowledged) on `feat/mobile-offline-round-writes`, and their upload
      (each to its own route, a refusal to "needs attention") on
      `feat/mobile-offline-round-upload`, after #33; then the screens, behind the gate.
    - Follow-up (#33 review round 2, low): no test yet of a carer assigned to two people at
      different homes where the person who opens a handover differs from the item's person (the
      two `person_assignment` joins in the `assigned_handovers` item and note queries).
    - Follow-up (migration 0052 security check, low): `task` is published with every column,
      including `details` and `status_reason`, which no stream sends; a publication column list
      (Postgres 15 and later) would keep them out of PowerSync's storage. A forward migration
      that sets the list must keep every column a stream reads.
    - Follow-up (#36 review round 1): the seen token trusts the `shown` list it is given; the
      handover screen must pass only the items it rendered, with a test.
    - Follow-up (#36 review round 1): the HZ-018 seen-token test compares the phone's token with
      a copy of the API's code; test `platform/digest.ts` and the API's own function instead.
    - Follow-up (#36 review round 1): `handover_acknowledgement.acknowledged_at` holds the device
      time on an acknowledgement made on the phone, until the server's copy replaces it, where
      data standards say server time; record it apart or say so in the screen.
    - Follow-up (#36 review round 1): `writeTaskMove` throws `TaskMoveNotWritten`; return it as
      a result, as `writeAcknowledgement` does.
    - Follow-up (#36 review round 1): on #36 alone a queued move goes to `POST /v1/sync/upload`
      with every column it carries (data minimisation); gone once the upload (#37) lands.
    - Follow-up (#36 review round 1; #41 closed): a task's time of care from the phone. The
      API records a move's completion when it arrives, and the phone keeps its device time in
      its own row only. The full design: a migration for task columns (time of care, time
      received, late flag); a late label wherever a task shows (web round, handover, phone);
      a lower bound at the task's creation or its window; and a rule for which shift's
      handover a late-synced outcome belongs to. Then the move sends its time of care
      (`round-upload.ts`). CSO decision H-309.
    - Follow-up (#36 review round 2, low): `useMoveTask` takes the person's home
      (`personLocationId`) from the caller; while it is null (the person row still loading)
      and the token lists no person ids, `mayRecordFor` lets the move through. Look the home
      up in the database inside the hook.
    - Follow-up (#36 review round 2, low): `putBackMove` runs before the phone reconnects,
      when the session's end has cleared the task row, so it inserts a bare row (no title,
      due time, version or evidence flag) and queues a PUT, not a PATCH; the upload (#37)
      sends it (`toRoundUpload` takes a PUT). On a later hold `resendable` re-queues only
      PATCHes, so such a move is parked. The update branch skips the version check and does
      not require `queued_transition IS NULL`. The screens must handle the bare row until
      the server's copy replaces it.
    - Follow-up (#36 review round 2, low): held moves and acknowledgements go back into the
      queue only when their owner opens their own database; the manager hand-over
      (`handover.ts`) leaves them on the device as needing attention. Neither path checks
      the write scope again; the API still decides.
    - Follow-up (#36 review round 2, low): after an acknowledgement is refused, the phone can
      say it is "already waiting to upload" (`mobile.handover.alreadyQueued`) until the next
      sync clears its row.
    - Follow-up (#36 review round 2, low): "Tell the person in charge of this shift" is shown
      to nurses too, including when they are the person in charge; word it by role in the
      screens PR.
16. Follow-ups from review round 1 of the capacity assessment, best-interests and consent record
    views (#35; H-254 and H-255 ask the CSO): every section 4 checklist label carries its statute
    citation, which is jargon on a staff screen; an unanswered checklist item gets no warning; the
    IMCA warning stays on a decision whose advocate was instructed or that is finished; the
    corrections list ignores `supersededOutsideList` and `correctsHidden`; the journey's
    best-interests decision (a move) follows a bed-rails assessment, which H-255 asks about.
17. Flags follow-ups (feat/platform-flags-and-sessions; PLAT-003): the clinical routes' flags
    (`flagsAt`, `flagRows`, `legalChangeReviewEnabled`) through the provider once per-role flags
    exist (today they read the organisation's rows directly, which Flagsmith may not set, so they
    agree with `/v1/me`); an operator kill switch for AI in Flagsmith, if wanted (today Flagsmith
    never reads AI flags); Flagsmith wiring in the API task (H-352); the OpenFeature SDK's own
    error log goes to the console, not the API's logger, so it bypasses pino's redaction. From
    #39 review round 1: an AI flag is recognised only by its `ai: true` marker (consider deriving
    it from a category of flag); the OpenFeature provider is global and set by each `createApp`,
    so in one process the last app created wins.
18. Session follow-ups (feat/platform-session-controls; PLAT-004, HZ-110, HZ-111): the browser
    idle timeout ships **off** (`SESSION_IDLE_TIMEOUT`; production refuses it); the PR that turns
    it on must close every prerequisite in platform.md (Identity): HZ-111's warning with "Stay
    signed in" and signing in again without losing the form, Better Auth's `get-session` refresh
    resetting idle, sessions marked web or mobile at sign-in instead of by a request header, the
    strictest timeout across the sign-in's memberships, background reads (the 2-minute header
    refresh, which also keeps a shared ward PC signed in as the last user) not counting as use,
    global role rows beating an organisation's stricter default, acting-up grants adding no role
    keys, idle sessions still working on the identity-level routes and `/api/auth/*`, and use
    recorded before authorisation; the CSO and DPO decide the figures and when (H-353). Also from
    #40 review round 1: timeout rates are looked up by UTC date with the nation fixed to England;
    the 15-minute owner timeout against drafting a statutory notification; the `entries_waiting`
    confirmation should say how old the devices' last report is; check the NIST figures in
    rates.md against the current SP 800-63B revision; tenant-scoped sessions, so a member who works
    for two organisations can be signed out of one (H-354). Still to build: the sign-in page saying
    the person was signed out after a period of inactivity, and the admin sign-out screen in staff
    management (with the member's devices). From #40 review round 2 (lows): the 409
    `member_of_other_organisation` tells the calling organisation that the person is active
    elsewhere (consider a generic refusal), and its advice to ask them to sign out is wrong for a
    suspended member or suspected misuse (point to suspending the membership or withdrawing the
    device); a member of several organisations can be signed out remotely only through Harbour
    support, which needs a documented procedure; holds are chased only after the sessions end and
    the audit is written, so a failure there leaves the tasks unhurried; `suspected_misuse` is not
    in `CHASE_HELD`; `platform.user.manage` holders can now bring device holds due at once (before,
    only `platform.device.revoke`); with nothing waiting there is no warning that the phone loses
    its care record mid-shift (H-351); organisations can override the timeout floor and ceiling
    (harmless while the timeout is off).

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
