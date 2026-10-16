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
   - Slice 12 part 1, the family feed schema and API (`feat/comms-family-feed` and the stacked `feat/comms-family-feed-api`, migration 0061,
     after #71's 0060; COMMS-001, ADR-0061, HZ-022): in review. `family_portal_user`, `feed_item`,
     `feed_item_withdrawal`, `feed_view`; portal sessions resolved from the links (`app.family`,
     scope `none`); `app.family_can_see` (definer, `harbour_family_reader`, a new NOLOGIN role:
     run `pnpm db:bootstrap` before migrating) mirrors `checkFeedItemVisibility`, with a parity
     test; `GET /v1/family/feed`, the portal link routes, `GET /v1/people/{id}/feed` and
     `POST /v1/feed-items/{id}/withdraw`. Next, part 1b: publishing from source records
     (`POST /v1/people/{id}/feed` with `composeFeedItem`, `care_note_share`, the publishing holds
     and the photo basis, which the feed reads as missing until then, so photos stay closed);
     then part 2, the web feed and staff screens; then channels, notifications and visit
     booking. Open: the portal feed names no person (a family session cannot read `person`), so
     part 2 needs a name the decision allows (HZ-001); tables with only the tenant policy
     (`tenant_user`, `location`, roles) are readable by any member including a portal session,
     as for staff with scope `none`, and need a review before the portal goes live.

   - Slice 13 part 1, the free full export's record and routes (`feat/platform-full-export`,
     migration 0062 after 0060 and 0061; platform-completions.md section 10a): `tenant_export`
     with forced RLS (owner and the worker only), one at a time, a forward-only status guard and
     the single download; the `platform.data.export` rename in role copies and grants; request,
     list, cancel and the one-time download, step-up and audited. Part 2 (`feat/platform-full-export-worker`, stacked on #77): the worker builds
     each queued export in one snapshot into a streamed ZIP in the exports bucket (tables,
     documents, current summary, schema, manifest), tells the requester, and the sweep deletes
     archives past expiry; platform-completions.md section 10b. Part 3 (`feat/web-full-export`, stacked): the export page
     (section 10c) with a Playwright journey that runs the worker's job once (`exports:run`) and
     downloads with the owner's end-to-end passkey;
     sample data rows join the export when the sample flag exists. The archive lives in the
     exports bucket (`S3_EXPORTS_BUCKET`), streamed both ways; the worker deletes it after the
     download or a cancel (outbox, retried). Interim: the tenant has no `data_purged_at` yet, so
     `checkExportRequest` is given none.
   - Slice 12 part 1, the family feed schema (`feat/comms-family-feed`, migration 0061, after
     #71's 0060; COMMS-001, ADR-0061, HZ-022): in review. `family_portal_user`, `feed_item`,
     `feed_item_withdrawal`, `feed_view`; family sessions (`app.family`, scope `none`);
     `app.family_can_see` (definer, `harbour_family_reader`, a new NOLOGIN role: run
     `pnpm db:bootstrap` before migrating) mirrors `checkFeedItemVisibility`, with a parity test.
     Next, the API part stacked on it (`feat/comms-family-feed-api`), then part 1b, publishing
     from source records, then part 2, the web.
   - Follow-ups from the #75 and #76 review (no code yet):
     - linking a family account rests on a verified email matching the contact's; replace it with
       an invitation sent to the contact that the family member accepts (the invitation store of
       0054 with a family kind);
     - the feed's checks are spread over three transactions (the family read, the system's view of
       the decisions, the view writes); a decision changed between them is judged on the earlier
       read; fold them into one or re-check on write;
     - a family session reads withdrawal rows for every section of its own people, not only the
       sections a decision opens (ids and reason codes only); narrow the policy;
     - `feed_view.sharing_decision_id` is not checked against the decision that opened the update
       (the API supplies it); a definer check that it names the caller's contact and covers the
       section;
     - the "as at" time on an empty open feed (HZ-061, for the web part);
     - closing message after next of kin are told: for the CSO (H-110).
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
   - Slice 11 part 2, back-entry columns (`feat/operations-back-entry-columns`, stacked on #32,
     migration 0053; operations.md section 12): built, PR to follow #32. Next, part 3: the API,
     nightly job and PDF, with the round 1 part 3 requirements.
   - Follow-ups from #38 review round 1 (security and clinical):
     - an entry takes the person's current location, so after a move the old home's outage
       cannot be cited: a paper record about someone who has since moved cannot be entered;
     - rule 13 (the normal route) depends on the API applying it on every care route and on the
       sync upload (hazard HZ-017 and operations.md section 12);
     - entries with `not_from_paper_reason` do not block cancelling, and are left pointing at a
       cancelled outage;
     - a failed outage correction tells a holder of `operations.downtime.manage` whether a
       back-entry about someone outside their scope falls outside the new window (by design, so
       the check counts every entry);
     - the guard trusts the entry's `location_id`; nothing checks it is the person's location
       (an existing gap).
   - Follow-ups from #38 review round 2:
     - `sync.clock_drift_flag_minutes` is read with the organisation's own override first, and
       any member can write `rate_table` (the existing gap), so an override could stretch an open
       outage's window;
     - part 3 must ask for an outside-the-outage reason when someone corrects a reviewed
       back-entry whose time is after the true end, because the database refuses such a correction
       without one (wording H-208).
   - Slice 11 part 3a-1, downtime pack API (`feat/operations-downtime-pack-read`, stacked on
     part 2; operations.md section 13): built, PR to follow part 2. Then part 3a-2, the printed
     pack (`feat/operations-downtime-pack-api`), part 3b, the nightly job, rebuilds after moves
     and the places route (`feat/operations-downtime-api`), and part 3c, outages and back-entry
     through the API. Follow-ups: the kiosk fetch route and photos on
     the printed pages (mobile step).
   - Follow-ups from #45 review round 1 (security and clinical):
     - opening a pack is audited once for the pack, not once per person on it (per-person audit
       rows for care-record views);
     - the HZ-001 withhold check does not run for the sections the builder stamps with the
       person's own id (the medicines and evacuation places);
     - a risk prints its residual band, or its initial band when no residual one is set, without
       saying which;
     - the pack does not leave out sample people (HZ-072) until sample data mode exists;
     - "nothing changed since" compares change times with the information's time on the database
       clock: a change in a transaction that began before the build and committed after it reads
       as older than the pack, so is caught only by the next rebuild (a fingerprint column is the
       fuller fix).
   - Slice 11 part 3a-2, the printed downtime pack (`feat/operations-downtime-pack-api`, stacked
     on part 3a-1; operations.md section 13): built, PR to follow part 3a-1.
   - Follow-ups from #46 review round 1:
     - render the PDF in a worker thread, so a large home's pack does not hold the API's event
       loop;
     - the CPR wording and its emphasis for the CSO (H-100, H-212);
     - unconfirmed places on the front sheet (H-201, H-213);
     - double-sided printing would put two people's pages on one sheet: a deployer control to print
       single-sided (H-214);
     - an out-of-date pack's header is words only; whether it needs more emphasis (H-209).
   - Slice 11 part 3b, nightly packs, rebuilds after moves and the places route
     (`feat/operations-downtime-api`, stacked on part 3a-2, migration 0055; operations.md section
     13): built, PR to follow part 3a-2.
   - Slice 11 part 3c, the outages API (`feat/operations-outages-api`, stacked on part 3b;
     operations.md section 13): built, PR open. Carries the #32 round 1 requirement that part 3
     emits the `operations.outage.*` audit and outbox events of section 5 (plus
     `.reconciliation_viewed` and `.corrected` audits). Next, part 3d: back-entry on the care
     routes and the sync upload, with rule 13, the refusal after reconciliation, a second offline
     correction of a back-entry going to the refused-entry review (HZ-006), and the #38 round 2
     outside-the-outage reason when correcting a reviewed back-entry after the true end (H-208),
     which belongs to the care correction routes. Follow-ups: the late flag still reads the
     rate in the database without saying when `care_note.late_entry_hours` is missing (#32
     round 2); the back-entry task's title is English only.
   - Slice 11 part 3d, back-entry through the care routes (`feat/operations-back-entry-api`;
     operations.md section 14): built, PR open. Back-entry and rule 13 on the five care write
     routes, the refusal after reconciliation (H-204), one correction per paper record with a
     device's second going to the refused-entry review (HZ-006), and the outside-the-outage
     reason on a correction after the true end (H-208). The sync upload writes no care tables,
     so needs no change. Also a test that a closed outage's end cannot be corrected past its
     closure plus `sync.clock_drift_flag_minutes` (#51 round 2). Follow-ups:
     - back-entry fields in the sync streams and on the phone (mobile step, Lane C), and the web
       forms (rule 12 label on the record);
     - paper found after reconciliation, and an entry not from paper inside a reconciled outage,
       are refused and kept for the refused-entry review (#54 round 1); the final path waits for
       the CSO (H-216), as does whether old readings from paper should alert at all;
     - the paper time must equal `occurredAt`: a client sending a different instant is refused,
       never moved;
     - a correction of a back-entry about someone who has since moved is refused by the database
       (the outage is at the old location; existing #38 follow-up).
   - Follow-ups from #51 review round 1:
     - a declared outage left open has no SLA or reminder (CSO to decide, H-215);
     - prove by a test that the reconciliation's output about people outside the reconciler's
       scope is ids and counts only (it is by construction: `outageEntries` selects ids, people,
       kinds and times);
     - an outage declared after it ended is closed at once, so it can no longer be cancelled,
       only corrected.
   - Follow-ups from #47 review round 1:
     - rebuilds run in the outbox handlers; a queue of their own, deduplicated per location, would
       keep a slow home's rebuild from delaying other events;
     - the nightly job covers active locations only;
     - the kiosk route needs a location-bound branch for reads with no member before it is built;
     - the seeded places wording still needs the CSO's confirmation (H-201).
   - Slice 11, evidence pack and statement of purpose part 1, schema (`feat/quality-evidence-pack`,
     migration 0057; quality.md section 12): six tables with forced RLS, the workflow guards,
     separation of duties in the database, hashed tokens and codes, bundle deletion and the
     definer token lookup (new NOLOGIN role `harbour_evidence_link_reader`: run `pnpm
     db:bootstrap` first, H-220, numbered H-216 until #60 review round 1; storage split for the DPO, H-217). Next, part 2, the API: the
     routes, public link routes and audit and outbox events of section 5, the PDF through the
     downtime pack writer (ADR-0040), the bundle deletion sweep at link end and the
     notification-overdue job. Follow-ups: an inspector with a Harbour account
     (`quality.evidence.read`, scope `none`) opening a pack released to their address needs its
     own policy; the migration number 0057 follows 0056 (#50), so its journal `when` must stay
     after #50's at merge.
   - Requirements for part 2 from #56 security review round 1 (the schema fixes are in #56: bundle
     editors are contributors, no redacted copies or long free text in the manifest, the token
     lookup takes the hex digest, cross-tenant tests for every table):
     - (Medium) a pg-boss sweep deletes bundles when a link ends or expires, with a test; part 2
       does not ship without it;
     - (Low) the public routes run as `app.is_system()`: set a per-transaction `app.link_id` and a
       restrictive policy for system sessions so they reach that link alone;
     - (Low) the API increments `failed_code_attempts` on a wrong code (tested), stores codes as an
       HMAC with a server key rather than an unsalted SHA-256, and caps live codes per link.
   - Slice 11, evidence pack and statement of purpose part 2a, the evidence pack routes and the
     bundle sweep (`feat/quality-evidence-pack-api`; quality.md section 13): compose, add records
     (care notes, observations, incidents), hand redaction, release with the link, re-issue,
     revoke and discard, with audit and outbox events; the `evidence-bundle-sweep` job (the #56
     Medium requirement, tested). Next: part 2b, the statement of purpose routes and the
     notification-overdue job (stacked); part 2c, the public link routes (`app.link_id` and a
     link-session policy in migration 0058, codes as an HMAC with a server key, the failed-attempt
     count, a cap on live codes, the session cookie) and the PDF through the ADR-0040 writer.
     Follow-ups: the other seven record types of the field map; staff shown as their role from the
     closed list (as built every staff name prints "[member of staff]", H-218); a superseded
     incident version cannot be added after it changes, only a new pack.
   - Slice 11 part 2b, the statement of purpose routes and the notification-overdue job
     (`feat/quality-statement-of-purpose-api`, stacked on part 2a; quality.md section 14): built,
     PR open. Follow-ups: the overdue alert's words and who receives it (every active holder of
     `safety.notification.submit` anywhere, H-219); the CQC notification wording or template
     itself is not generated (the record holds the reference or how it was sent).
   - #61 review round 1, fixed in #61: the overdue alert names the version and the due date; the
     28 UK days are tested across the October clock change; step-up on recording the notification
     is tested; HZ-080 logged (DCB0129 scope for the CSO, H-224); H-219 asks about a "due soon"
     reminder.
   - #60 review round 1 (clinical and security), fixed in #60: release re-reads every record and
     is refused, saying which, when one was corrected or changed since it was added; corrections,
     back-entries from paper (paper time, outage, reference), the recording time and a wrong
     device clock are labelled in the pack; observation readings have a label and unit per chart
     field and only the chart schema's own values count as codes; care-note tags are free text;
     times carry GMT or BST; the token responses say `no-store` (the API logs no request bodies).
     For the CSO and DPO: H-221 to H-223. Follow-up: reason codes in audit rows (H-223).
   - Slice 11 part 2c, the public link routes and the PDF (`feat/quality-evidence-pack-public`,
     stacked on #60, migration 0058; quality.md section 15): the #56 Low requirements (the link
     session with `app.link_id`, codes as an HMAC under `EVIDENCE_LINK_SECRET`, the failed count
     in the same transaction, a cap on open codes) and the PDF; built, PR open. Follow-ups: the web
     page that reads the token from the link's fragment and posts it (web step); throttles are per
     API instance (a shared table, as for invitations); the code email has a generic subject and the code in its body
     (built in part 2a of the letter templates, H-225); an inspector with a Harbour account
     (`quality.evidence.read`) still needs its own route.
   - #66 review round 1 (security and clinical), fixed in #66: the printed pack says when it was
     composed and released (GMT or BST) and that it shows the records as they stood at release
     (H-222 stays open for the CSO); a field with no value prints "Withheld: not available in this
     pack"; link sessions read none of the audit trail, staff, alerts, tasks, documents, roles,
     grants or outbox, and cannot revoke their link (0058); the per-address throttle falls back to
     one shared bucket when no address is known; audit rows take the address from the trusted hop;
     the session cookie is `__Host-`, path `/`, encrypted (AES-256-GCM) and signed.
     Logged, not blocking this merge: the code email's subject and body need an email port with a
     body (H-225; blocks a live tenant); the SES body's "Open Harbour..." line would confuse an
     external recipient.
   - Slice 11, letter and email templates part 1, schema (`feat/comms-letter-templates`,
     migration 0059, stacked on #66 for the migration order; comms.md section 11): the three
     tables with forced RLS, the version workflow and separation of duties in the database, and
     letters only from approved versions to the person or their own contacts. Next, part 2, the
     API: template and version routes, merge fields, preview and sending with the PDF writer, the
     email port's body (H-225; the evidence pack code email moves its guidance into the body),
     audit and outbox events.
   - #69 security review round 1 (no High or blocking Medium); fixed in #69: the incident and its
     grade come from the incident (about the letter's own person, on incident and candour letters
     only) and set the retention class; link sessions reach none of the template and letter tables.
     For part 2 and the retention slice:
     - letters are readable by anyone with the person in scope: gate reads on a comms permission
       in the API (or the SELECT policy);
     - no crypto-shred path for `letter` yet (the retention slice);
     - audit events come from the API (the tables have no audit triggers of their own);
     - part 2 must: require `comms.letter.manage` (and `safety.incident.manage` for the
       `incident.*` and `candour.*` fields), MFA on reads, store `delivery_reference` as the
       provider's opaque id only, `personal_fields` as keys only, never an email's content, and
       log no personal data.
   - Slice 11, letter and email templates part 2a, the template routes and the email body
     (`feat/comms-letter-templates-api`, stacked on #69; comms.md section 11): merge fields,
     templates and versions with approval, retirement and discarding; the email port's body,
     which closes the item 5 note on the evidence pack code email (generic subject, the code and
     guidance in the body, H-225). Next, part 2b: preview, sending and the letters list with the
     PDF writer and the part 2 must-dos above.
   - #70 review round 1 (security and clinical), fixed in #70: every version write matches the
     version the caller loaded (an edit landing between the read and an approval is refused with
     409, audited); the letter-only refusal is audited. For part 2b: check an email's body before
     it leaves (no link, and no personal field beyond the approved, rendered template), as
     `guarded` checks the title in `adapters.ts`; run the ADR-0051 check on the rendered body too.
   - Slice 11, letters part 2b, preview, sending and the list (`feat/comms-letters-api`, stacked
     on #70; comms.md section 11): built, PR open, with the part 2 must-dos (comms.letter.manage
     with MFA on every route including reads, safety.incident.manage for incident letters, values
     from the record except typed admission and fee details, the provider's message id only, field
     keys only, no email content stored), the body guard and ADR-0051 on the rendered output.
     Follow-ups: duty of candour letters need the relevant person on the candour record; a letter's
     PDF document keeps `care_record` retention even when the letter is `serious_incident` (the
     retention slice); letter PDFs carry no letterhead or address block layout yet (H-228).
   - #72 review round 1 (security and clinical), fixed in #72: the send must match the preview
     (version and text hash, 409 otherwise); only current contacts; an incident involving anyone
     else is refused; email sending refused (422) until the worker-based send; the preview shows the
     person (name, room, photo); people who have died are refused; the list shows incidents only to
     holders of `safety.incident.manage`; the body guard catches hyphenated NHS numbers and
     `mailto:`. Follow-ups:
     - the worker-based email send: insert a pending `letter` row (an expand change: a status
       column), a pg-boss job keyed on the letter id sends once (the port's idempotency key is the
       letter id), then the provider's message id is recorded; an email is never sent twice or
       unrecorded (HZ-051);
     - a family-facing incident summary, written for the family and approved, so incidents
       involving several people can be written about without the internal account;
     - letters after a death (to the next of kin or the estate), with the template kinds they need.
   - Slice 11, letters web part 1, template management (`feat/web-letters`; COMMS-007, HZ-051):
     in review. `/letters` (list), `/letters/new`, `/letters/{id}` (draft with each problem at its
     field, approval by someone else with the reason shown to the author or an editor, a new draft,
     discard and retire with a reason, earlier versions). Next, part 2 stacked on it: the person's
     letters tab (preview showing name, room and photo; send with the preview's version and hash;
     409 `letter_changed` shows the new preview; the list).
   - Slice 11, letters web part 2, the letters tab (`feat/web-letters-send`, stacked on part 1;
     COMMS-007, HZ-051, HZ-001): in review. Follow-ups: letters to a contact need the contacts on
     the record (the API has no contacts list for the web yet); an incident follow-up offers the
     person's incidents only to holders of `safety.incident.manage`.
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
      clinical M3; HZ-029); (g) the needs-attention screen ships with the round screen or before
      it, since "no care left without a prompt" depends on it (#37 confirmation check).
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
    - Follow-up (offline writes): a refused move or acknowledgement is removed from "needs
      attention" through the deletion record built for unsent entries (a coded reason, device
      authentication, audited as `refused_removed`); decide with the screens whether these need
      a lighter dismissal, and whether the device report should count them apart from entries.
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
    - Follow-up (#37 review round 1): a refused task move or handover acknowledgement does
      not call `onRefused`, so nothing asks for a server copy at once; refused copies cover
      care tables only (`REFUSED_COPY_TABLES`) until H-307 decides.
    - Follow-up (#37 review round 2): a task's version moves with assignment and escalation as
      well as with its details, so a move refused with a 409 is never sent again. A
      server-side content version that assignment and escalation leave alone would let a
      later change resend safely (a migration and the transition route; CSO decision H-310).
    - Follow-up (#37 review round 2, low): a task change whose move cannot be read at all (not
      JSON) is kept under the task's id, with the tenant the row carries, if any: no id of its
      own can be read, so a second such change for the same task replaces the first.
    - Follow-up (#37 confirmation check): a 403 whose session cannot be checked (an edge or
      firewall page with `/v1/me` unreachable) counts towards the cap on the task read, while
      the upload path keeps it queued; treat it as a network failure there too.
    - Follow-up (#37 confirmation check): `task_unchecked` says "check the task on the
      round", but a closed task no longer shows there; point to the task's history, or word
      it differently, in the screens PR.
    - Follow-up (#37 confirmation check): with no resend, every move made offline on a task
      that escalated during an outage becomes a needs-attention item, an alert-fatigue risk;
      it waits on H-305, H-310 and the lighter way to dismiss a refused move.
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
19. The incident screens, the rest (slice 9, SAFE-001 to SAFE-003; the incidents list and an
    incident's read view are on `feat/web-incidents`, the notifications with their clocks on the
    incident page on `feat/web-incident-notifications`): the statutory notification pages
    (`/notifications/statutory` with every draft's clock
    for `safety.incident.manage`, and `/notifications/statutory/{id}` with its deadlines, required
    content and sources, which the overdue alert already links to; the sidebar's `/notifications`
    section must not claim that path); then the forms, each offered only where `access.reaching`
    lists its permission (ADR-0071), with a client UUIDv7 kept across retries and refusals mapped
    in `refusals.ts`: record an incident (`safety.incident.report`), answer the classifier's
    questions in the catalogue's words, review and close (`safety.incident.manage`, never the
    person who raised it), prepare a notification, and submit it or mark it not required with
    step-up (`safety.notification.submit`). API gaps ([safety.md](../specs/safety.md) section 5):
    no staff names (H-73); the list has no paging past 500; a draft stays `provisional` after the
    answer that made it changes; the questions, exclusions, reasoning and tasks are English only.
    - Follow-ups from #42 review round 1 (H-256 asks the CSO whether part 1 may ship before part
      2): `emergencyServicesCalled` and `gpContacted` default to false in `CreateIncident`, so
      "No" may mean nobody was asked; the sidebar's Incidents icon (a warning triangle) reads as
      an alert when the sidebar is folded to its icons; a reader without `people.person.read`
      sees several "A person we support" with nothing to tell them apart; no demo account lacks
      `safety.incident.read`, so the hidden Incidents item is unit tested only.
    - Follow-ups from #42 review round 2: `INCIDENT_LIST_LIMIT` repeats the API's 500 (the API
      should return a `truncated` flag, or the limit should be a shared contract constant);
      communication needs for people outside the reader's people list are left out silently
      (say "not shown to you"); the list gives no sign that an incident's notifications have not
      been checked yet; the "What happened" field repeats its section's heading; the breadcrumb
      link has no 44 px target; the journey neither opens nor scans the closed incident's page
      with axe; when needs are recorded the incident page says "Communication needs" twice (the
      label and the flag), so drop the flag's label there or hide the label visually.
    - Follow-ups from #49 review round 1 (H-256 to H-260 ask the CSO): the clocks are worked out
      when the page is drawn, with no "as of" time and no refresh; a submitted death notification
      for a death later recorded in error shows as submitted on the incident (the correction task
      is the only cue); the local warning line (`SafetyWarning`) belongs in `@harbour/ui`; the
      reviewers' copy suggestions go to the CSO's wording review (H-258); the open questions are
      counted twice, in the header chip and the section's notice; the classifier's tasks carry no
      done state, so "RIDDOR may be needed: check on ..." stays after the check until the
      incident is classified again (H-259).
    - Follow-ups from #49 review round 2: the outbreak line "Needed, and drafted on another
      record" neither names nor links that record, nor shows its status; "person N" on a
      notification has nothing to match in the people section; there is no cue at the top of the
      page for the "not checked yet" and "outside England" notices; the reviewers' optional copy
      points go to H-258.
    - Built on `feat/web-statutory-notifications` (read only): `/notifications/statutory` (still
      to do, then submitted or not required, each with its clock, status, who it is about, due
      time, location, recipient and warnings) and `/notifications/statutory/{id}` (clock, status,
      warnings, every deadline, the record it was drafted on named and linked with its status,
      reasons, required content, sources and how it ended), for `safety.incident.manage` as the
      API requires; the sidebar keeps Incidents current there. Done from the #49 follow-ups on
      these pages: an "as of" line on every clock list (and the incident page), a hidden person
      unnumbered on their own page and numbered consistently across the list with a line saying
      so, and the source record named and linked with its status; the incident page links each
      notification to its page for managers. Still open: the forms (next PR); the outbreak line on
      the incident page still neither names nor links its record (the API gives no link from an
      output to a draft on another incident); the list's limit of 1,000 repeats the API's; a
      holder of `safety.notification.submit` without `safety.incident.manage` (no built-in role,
      but a custom one) reaches the overdue alert's page and is told it is not for them (the API
      reads need `manage`; H-260); the prepared form (`content`), the DoLS 18(4B) statement and
      `noLongerIndicatedReason` are not shown, and reasons, required content and sources are the
      API's English (marked `lang="en-GB"`); RIDDOR's threshold is read for the label only on a
      notification's page (from its incident's date), so the list says "the reporting
      threshold".
    - Review round 1 of #52 (fixed): the list reads draft, ready, submitted and not-required
      notifications separately, so a recent overdue draft is never pushed off by old finished
      ones, and warns when an unfinished read is cut; communication needs beside who a
      notification is about; an unreadable due time sorts first; deadlines on a finished
      notification are headed as history; the page title names the kind. H-260: a holder of
      `safety.notification.submit` without `safety.incident.manage` (whom the overdue alert sends
      to the notification's page) now sees who can act (the Registered Manager or whoever manages
      incidents there) on the forbidden page; letting them read it needs the API to accept
      `submit` on the reads. For the CSO (with H-257 and H-258): accept the deadlines on a
      finished notification shown as "Deadlines it had to meet", and "Clocks worked out at ...
      Reload the page to bring them up to date." with no automatic refresh.
    - Built on `feat/web-incident-forms` (part 4a): `/incidents/new` records an incident
      (`safety.incident.report`) from the incidents list (the reporter's locations) or from a
      person's record (offered only where `access.reaching` lists it; about them at their home),
      with emergency services, GP and death asked every time, never assumed no (the #42
      follow-up, HZ-090), the falls questions on a fall (HZ-027) and a UUIDv7 kept across retries;
      the incident page offers its open questions in the catalogue's words (every one to a
      manager, the falls questions to whoever raised it). Still to do: part 4b (review and close,
      prepare, submit or mark not required with step-up). Gaps logged, no API change: `/v1/me`
      gives no per-permission locations, and `IncidentDetail` has no `access` block, so the
      location choice lists where the member works and the questions form follows the held
      permissions (the API refuses where the scope does not reach, ADR-0071); classifier answers
      carry no client id (a retry stores the same answer again, harmlessly); the form does not
      yet ask when the person was found (H-262), nor add other people, staff or visitors,
      body-map marks, infection details, the family told or LeDeR facts.
    - Follow-ups from #55 review round 1 (H-263, H-264): per-permission locations on `/v1/me`
      (so the location choice lists only where `safety.incident.report` reaches); with no person
      on the incident `died` is sent as false and the form cannot add a person; incident-specific
      tests for a future time and the hour the clocks change; the Welsh wording of the questions
      is not checked against the domain (only English is); "not sure" for emergency services
      and GP needs a contract change (API follow-up).
    - Built on `feat/web-incident-review-submit` (part 4b, stacked on #55; HZ-091, H-265,
      H-266): the incident page's "Review and close" for `safety.incident.manage` (start the
      review; send it back to open or close, each with a reason; never close for the person who
      raised it; what to do first, linked, while a notification or question is open); the
      notification page prepares it (an answer per line of required content, ready only when
      all are answered), records it as submitted once ready (time chosen every time, the
      regulator's reference) and decides "not required" with a reason, each where its
      permission reaches the person (`access.reaching`), with step-up as break-glass does it
      (sign in again, back to the page). Every write sends the page's version, so a stale page
      is refused in words. Gaps logged, no API change: no client id on these writes (the version
      stands in: a retry after a lost connection is refused as changed, and says it may be the
      person's own attempt); `IncidentDetail` has no `access` block, so review and close follow
      the held permission (the API decides scope); the candour record is not on the incident, so
      an open one is said only by the API's refusal; the web cannot attach the submitted form
      (uploads), so the reference is required; what was typed is lost at the step-up sign-in;
      the prepared answers are keyed by the API's English line (cut to 80 characters), so a
      reworded line leaves an earlier answer under the old words (shown only in the API's
      content; a `requiredContent` key in the contract would fix it); "Who submitted" names
      the member only as "you" or "another member" (H-73).
    - #58 review round 1 (built): "not required" on a notification Harbour found needed says
      so and takes a 20-character reason and a confirmation (H-265); the forms leave success to
      the page, which announces only a matching status and drops `?done=`; no future tolerance
      on the submission time. Left: "just now" still sends the server's time, since
      `SubmitNotification.submittedAt` is required (an API change would let the API stamp it);
      the step-up notice and the separation-of-duties refusal are checked with axe in component
      tests only, since the journey cannot force a stale sign-in (needs a test hook) and close is
      never offered to the person who raised the incident.
20. Invitations and MFA enrolment (PLAT-004): the spec and rules are on `main` (#43); the store is
    in feat/platform-invitations-schema: migration 0054 (the `invitation` table, the
    `harbour_invitation_owner` role and its definer functions for lookup, claim, acceptance, the
    first owner's invitation, the member-change trigger and the two sweeps), with database tests.
    Next: the invite, lookup, accept, revoke, list and sweep routes (the worker deletes unlinked
    sign-ins through the auth pool); the operator's owner invitation (setting `app.operator_id`)
    and the invitation email; the web accept page with the password rules and the redirect to
    enrolment, with Playwright and axe (H-355). Then `fix/platform-mfa-session-factor` (#43 review
    M5): MFA counts only when the session used a passkey or a verified TOTP code, not merely when
    one is enrolled. Follow-up: `harbour_membership_reader` is granted to `harbour_owner` with
    `INHERIT`, so its open policies reach the owner's own queries; make it `SET` only as
    `harbour_invitation_owner` is. Logged from #48 review round 1: `invitation_scope` lets a
    locations-scoped role read and revoke every invitation in the organisation, so the routes must
    narrow both to the members `platform.user.manage` reaches (as `app.may_invite` does for
    sending), with a test; and the routes pass the token to the definer functions only as a bound
    parameter, never interpolated into SQL or logged. Existing clusters run `pnpm db:bootstrap`
    before migration 0054 (it creates `harbour_invitation_owner`).
    Web part (`feat/web-invitation-accept-page`): `/invitation` reads the token from the fragment,
    keeps it in the tab's session storage while the person signs in first, strips it from the
    address bar and sends it only in request bodies to same-origin route handlers (`Referrer-Policy: no-referrer` on the
    page); shows the organisation, the masked address and the expiry, then creates a sign-in (name,
    password with the NCSC rules up front, shared as `passwordRuleBroken` in @harbour/domain), or
    asks the person to sign in first, or joins with the current sign-in; then sign-in and
    `/settings/security` enrolment. Expired, withdrawn, used, unknown and throttled links in plain
    words. Follow-ups: the managers' side (pending invitations with withdraw, the invite form with
    step-up) needs a members list route and a team page, neither of which exists yet; an e2e hook
    to read the API's email outbox so the journey can create a sign-in end to end; the lookup does
    not name the inviter, so the page names only the organisation.
    - Members routes (`feat/platform-members-api`): `GET /v1/members` (members within the reach
      of `platform.user.manage`, their roles, and the roles the manager may give and where) and
      `POST /v1/members` (an invited member with one role, step-up, `app.may_assign_role` then
      `app.may_invite`, idempotent on the client id, 409 `email_in_use`), with migration 0060
      (row-level security on adding members and role assignments; numbered after #69's 0059, so
      it merges after #69). Web part (`feat/web-invitation-screens`, stacked on it): Team in the
      navigation for holders of `platform.user.manage` (`/settings/team`): the members it reaches
      at the chosen location, each with their state and their latest invitation's as an icon and
      a word; invite someone (name, work address, a role and where, checked with `CreateMember`
      and the roles the manager may give); a member's page with their invitations, sending again
      only while they are still invited and withdrawing only an open one, each after a
      confirmation; Playwright with axe on every state (`team.spec.ts`). Accepted and expired
      invitations are not reached in the journey (they need the emailed link or a day to pass);
      their chips are unit tested. #71 security review: (M1, fixed) giving a role
      counts only the giver's own roles, never an access grant (`app.holds_role_permission_at`),
      so acting up never becomes a lasting role. Follow-ups: (1) the members list is narrowed in
      the application only (`membersReached`), as the invitation routes are; the database lets
      any `tenant_user` row be read in the organisation's view; (2) within one organisation, 409
      `email_in_use` tells a manager an address belongs to someone they cannot see (an
      organisation-wide probe; accepted, as the address must be unique, but logged); (3) no
      restrictive UPDATE policy yet on `tenant_user` or `role_assignment` for the application
      role (no route changes either); add them, with `app.may_assign_role`, before any role or
      member editing route; (4) a giver whose own role assignment ends (`valid_to`) can still give
      a role with no end; decide whether a given role may outlive the giver's.
    - Routes built in feat/platform-invitation-routes: send, list, withdraw (narrowed to the
      members `platform.user.manage` reaches, with tests), lookup and accept with no session
      (token only as a bound parameter, throttled per address and per token), the operator's
      first-owner invitation (`app.operator_id`), the email through the organisation's
      `comms.email` adapter, and the nightly `invitation-sweep` job (lapsed invitations, then
      unlinked sign-ins deleted through the auth role). Next: the web accept page with the
      password rules and the redirect to enrolment, Playwright and axe (H-355, H-357).
      Follow-ups: count the link throttle across API instances (a Postgres table keyed by
      address or token hash, not by member: a Lane A migration); re-check each sign-in just before
      the sweep deletes it (a sign-in linked between the listing and the deletion would go); give
      the email port a body so the email can carry the organisation's name and the expiry
      (H-357).
    - Follow-ups from #53 security review: (L1) the sweep deletes an auth user without
      re-checking, in the same transaction, that it is still unlinked; fix with one definer
      function, or a lock that re-checks `app.auth_user_has_membership` just before the delete.
      (L4) a throttled 429 on the invitation link routes is not audited; audit `rate_limited`
      with the client address and a prefix of the token's hash only.
    - `fix/platform-mfa-session-factor` (#43 review M5, ADR-0072, HZ-112, H-358): built. MFA counts only
      when the session signed in or confirmed a code with a passkey, TOTP or backup code (a record in
      `auth.verification`, no migration); a member with a factor whose session did not use it gets
      `mfa_verification_required` and the web sends them to `/sign-in?reason=mfa`; the operator
      console uses the same rule; sessions from before the deploy fail closed. Follow-ups: the mobile
      app must add `mfa_verification_required` to `SESSION_PROBLEM_CODES` (mobile lane); step-up
      permissions outside care records still need only a fresh sign-in, not a second factor;
      Lane A may move the record to an `auth.session` column. Still open for Lane A (a migration):
      `harbour_membership_reader` granted to `harbour_owner` `WITH INHERIT TRUE`; make it `SET` only.
    - #57 security review round 1: a password-only session could enrol its own factor or remove the
      member's; adding, showing or removing a factor now needs a session that used one once one is
      enrolled (a first enrolment goes ahead), and a session gets five wrong codes. Next PR: step-up
      outside care records (controlled drugs, residents' money, export, break-glass, notifications)
      should need a session factor recorded within `STEP_UP_WINDOW_SECONDS`, not only a recent
      password sign-in. When mobile resumes: add `mfa_verification_required` to
      `SESSION_PROBLEM_CODES` (`apps/mobile/src/sync/session-signals.ts`).
    - `fix/platform-step-up-factor` (ADR-0072 amendment, HZ-112, H-359): built. Step-up counts from
      the second factor the session last used (its `auth.verification` row's `created_at`, no
      migration) within `STEP_UP_WINDOW_SECONDS`, never from a password sign-in; a holder with no
      factor enrolled gets `mfa_enrolment_required`; an in-session code or a passkey sign-in
      refreshes it. Covers every `requirePermission` of a step-up permission, workflow moves
      (notification submit, exits), `requireStepUp` (downtime pack, invitations, session revoke,
      About me links), task links and the operator's owner invitation; table-driven tests over
      every step-up permission and route family. Follow-ups: the domain checks that take
      `lastMfaSignInAt` (export, DPIA sign-off, sub-processor notices, break-glass search) must be
      given `stepUpAt` when their routes are built; the web could offer an in-place code prompt
      instead of a full sign-in; mobile (paused) must send step-up actions through the same
      confirmation.
    - #63 security review round 1: the code completing a first enrolment records no factor (M1);
      step-up freshness is judged in SQL on the database's clock (L1); the domain inputs are
      `stepUpAt` and a source test checks every `authorise` call (L2); more HTTP tests (L3).

21. Slice 11 web, the downtime screens (OPS-028; HZ-017, HZ-021, HZ-092; `feat/web-downtime`).
    PR A built: `/downtime` (Downtime in the navigation for holders of `operations.downtime.read`
    or `.manage`) and a location's page: the pack opened on its own page (freshness in an icon and
    words, the header lines, when it was made, how many pages and warnings) and printed as a PDF
    streamed from the API and never stored, both with a fresh sign-in and never prefetched, over
    the hourly limit or with no pack the page says what to use instead; the outages with their
    state; declare (only while none is open), close, correct, cancel and reconcile, with the
    reasons and version the API needs, nothing chosen by default, and the reconciliation's counts,
    blockers in the API's words, and a box to tick for each possible duplicate group and each
    back-entry outside the window (H-267). A back-entered entry shows its label wherever its badges
    are shown. PR B built (`feat/web-back-entry-forms`, stacked on #62): "From a paper downtime
    form" on the notes, chart, body map, activity and visit forms while the person's location has
    an open or closed outage (the outage, the date and time as written with nothing filled in, the
    reference, the outside-the-outage reason), the not-from-paper reason when the API asks, the
    H-208 reason on correcting a paper note, and the API's refusals in its words (H-268).
    Follow-ups: the paper choice on corrections of chart entries, marks, activities and visits (no
    web correction form for them yet). API gaps logged here, for Lane A:
    - No read of the MAR and PEEP places (`GET /v1/locations/{id}/downtime-places` returning
      `DowntimePlaces` with the location's `version`), so the web cannot show or confirm them: the
      `PUT` needs the version. The places form waits on it (H-201 still met by the task and the
      pack's wording).
    - No per-location `reaching` (`/v1/me` has the permissions and work locations only), so the
      location page offers an action where the permission is held anywhere and the person works at
      the location; the API refuses it in words where it does not reach (ADR-0071). Add a
      `reaching` list per location to `/v1/me` or a `GET /v1/locations/{id}` with `access`.
    - The reconciliation returns entry ids only, so the screen lists short references, which
      every record list now shows beside "Entered from a paper record" (#62 review round 1). Lane
      A: return the person, the entry's kind and time and a link per entry in
      `duplicateGroups` and `outsideWindowEntryIds`, so each can be opened from the screen
      (HZ-092); the CSO decides whether reconciling may go live before then (H-267).
22. Slice 5 web, the round and handover screens (CARE-013, COMMS-006; HZ-001, HZ-018;
    `feat/web-rounds-handover`). Part 1 built: Handover in the navigation for holders of
    `care.handover.manage`; a location's page with the shift running now (compiled, or compile
    it) and the last week's; one handover's items by person (name, room and communication needs),
    each kind in an icon and words with a link to its record, notes on items and on the whole
    handover, who has read it, and "I have read this handover" with the token of the handover as
    shown (H-269). Part 2 built (`feat/web-round-view`, stacked on part 1): the round by area and
    room, each person's name, room and communication needs, each task's time state in an icon
    and words, start, done and not done with a reason (H-270), one person's tasks on request.
    Gap: the round view does not say which permission each task names, so the actions are
    offered to those who record care (`care.note.write`) and the API refuses the rest in words.
    Gaps: the handover items are references only, so the reader opens each record; the location
    page offers compiling for the permission held anywhere (no per-location `reaching`).

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
