---
status: "accepted"
date: 2026-10-12
decision-makers: Claude Code (lead engineer), on a security finding against ADR-0002; Brian may supersede
consulted: master prompt section 4 (RBAC decides what, attribute scope decides to whom) and 5.3; ADR-0002; ADR-0033; ADR-0061; #26 review round 2 (S1, `placesHoldingPermission`)
informed: everyone working in this repository, the data protection lead, the CSO
---

# Data scope is per permission

## Context and problem statement

ADR-0002 gives every request one row-level security context (`app.scope`, `app.location_ids`).
`resolveAccess` built it by taking the widest scope across all of a user's roles, whatever each role
carried, and the API set that one merged scope for every request. Access grants added their
permissions to the same set and applied them over the merged scope. So a care worker at Harbour
House who also held a "Finance viewer" role across the organisation (carrying only
`finance.reporting.read`) read and wrote care notes for people at every home; an administrator at
one home given an acting-up grant at another used the grant's permissions at their own home and
not at the grant's. Section 4 says RBAC decides what and attribute scope decides to whom: the "to
whom" belongs to the role (or grant) that gives the "what", not to the user. How should scope be
resolved and applied so that a permission never reaches further than the roles and grants that
carry it?

## Decision drivers

- Least privilege and HZ-011: no permission may reach people its own roles and grants do not reach.
- Fail closed: a request that asks for no permission sees no one.
- Defence in depth (ADR-0002): the database enforces the same narrowing as the API, with no change
  to the policies that read `app.scope` and `app.location_ids`.
- Keep the change small: the policies, the sync streams and the permission matrix stay as they are.
- Every caller must choose the permission it acts for, so a new route cannot quietly use a merged
  scope.

## Considered options

1. Keep one merged scope per user and add per-permission checks in the API where they matter.
2. **A scope per permission, and each request runs under the scope of the permission it uses.**
3. Per-permission policies in SQL: every policy calls a function that checks the user's roles and
   grants for the permission behind the query (as `app.holds_permission_at` does for settings).

## Decision outcome

Chosen option 2, because it removes the merged scope altogether, needs no change to any row-level
security policy, and makes every caller name the permission it acts for.

### Domain (`packages/domain/src/platform/access.ts`)

- `EffectiveAccess` carries `scopes`, the scope of each held permission; `scopeFor(access,
  permission)` reads it (no one for a permission not held). The merged `scope` and `locationIds`
  are removed. `permissions` (the set) stays for the screens and `authorise`.
- A permission's scope is the union (`widestScope`) of the active, non-mixed staff roles that
  carry it (scope `tenant`, or `location` with no location: the whole organisation; `location` or
  `tenant` assigned at a location: that location; `assigned` or `self`: assigned people; `none`:
  no one) and the active, unrevoked grants that carry it (a grant at a location adds that
  location; one with no location adds the whole organisation only when marked so, review round 1).
  Portal sessions keep no person scope (ADR-0061).
- `narrowestScope` intersects the scopes of a request that needs several permissions: nothing, or
  `none` among them, is `none`; `tenant` narrows to the other; two location scopes keep the
  locations they share, with assigned people only when both include them; `assigned` with a scope
  that includes assigned people is `assigned`, with one that does not, no one (review round 1). A
  table-driven test proves the result never reaches further than any input.

### API (`apps/api/src/http/context.ts`)

- A request starts with scope `none`. `requirePermission` narrows it to `scopeFor(permission)`,
  intersected with any permission the request required before; `withTenant` uses the result.
  `requireAnyPermission` (a route that any one of several permissions opens) narrows to the union
  of the alternatives the session may use now (MFA and step-up met), so one whose checks the
  session does not meet adds nothing.
- `SCOPE_WITHOUT_PERMISSION` is the explicit allow-list of routes every member may use that show
  more to holders of one permission, which run in that permission's scope without requiring it
  (`useScopeOf`, which refuses any route not listed): the task list and task moves, and the
  document lookups that find a row before knowing whether it is about a person. Every other route
  that requires no permission runs with scope `none`: `/v1/me`, notifications, form templates,
  rates, sync uploads and device reports (which work in the system's view where they must).
- Checks of a second permission on one record count it only where it reaches that record:
  completing a task needs its permission where the task is; a status change, a task an entry
  completes and a return check use the permissions that reach the person
  (`permissionsReaching`); changing an incident or answering its manager questions needs
  `safety.incident.manage` where the incident is.
- Readers of the old merged scope name their permission: device lists and revocation
  (`platform.device.read`, `platform.device.revoke`), the sync token (each family of streams
  where its own read permission reaches, review round 1), handover whole views and staff views (`care.handover.manage`), urgent alert
  recipients (`people.person.read`, and `care.plan.write` where it reaches the person), the weekly
  break-glass report (`platform.audit.read`), `/v1/me`'s `scope` (`people.person.read`), audit
  defaults (the request's own scope) and per-user limits (the member's own view). A refused entry's
  copy or a hand-over is taken only about someone its author could reach with `care.note.write`
  (`personReachedBy`).

### Database

Every policy reads `app.scope` and `app.location_ids`, which now hold the permission's scope
(review round 1 adds the assigned and break-glass flags and the place checks, below). `app.holds_permission_at` was already per permission (#26 review round 2).
The handover and device policies (migrations 0028 to 0046) judge the reader by the request's
scope, now narrowed, and the staff whose devices or bindings are shown by their own role
assignments, which is the subject, not the reader. The worker and system views keep tenant scope.

### Consequences

- Good, because a permission never reaches further than the roles and grants that carry it, in the
  API, in row-level security and in the sync token.
- Good, because a route that forgets `requirePermission` sees no one instead of everything the
  user's widest role reaches.
- Good, because a grant now reaches its own location, as the person granting it intended.
- Bad, because some users see fewer people: anyone whose roles give different permissions at
  different places; and administrators, or any location role without `people.person.read`, who
  now see in the task list only the tasks given to them that are about nobody. Managers should
  check role bundles (release note).
- Bad, because a route needing several permissions sees only where all of them reach, which can
  refuse a legitimate action when one of them is held more narrowly; the fix is the role bundle.
- Neutral, because a grant reaches the whole organisation only when marked organisation-wide
  (review round 1). No route creates grants yet; row-level security already refuses one the
  member does not hold `platform.grant.manage` for wherever it reaches.

### Confirmation

- `packages/domain/src/platform/access.test.ts`: `hazard HZ-011 scopeFor: data scope is per
  permission (ADR-0071)` (two roles, grants at a location and organisation-wide, mixed, ended,
  future, revoked and portal cases), `hazard HZ-011 narrowestScope`, `widestScope`;
  `search.test.ts`: each kind of record searched in its own permission's scope.
- `apps/api/test/scope-per-permission.test.ts`: the two-role member refused at the other home for
  reads and writes and allowed at their own; the grant allowed at its home and refused at the
  role's; the sync token; tasks; incident management; the allow-list.
- `packages/db/test/scope.test.ts`: `hazard HZ-011 data scope per permission (ADR-0071)`, row-level
  security under each permission's scope refusing the other home's reads and writes.
- `apps/api/test/care-follow-ups.test.ts`: an urgent alert never reaches a nurse in charge through
  a role that cannot open records.

### Review round 1 (security and clinical safety reviews of #27)

The reviews found that two parts of the old merged scope survived: row-level security counted the
people a user is assigned to, and those they opened by break-glass, for every permission, and a
grant or location role with no location still reached the whole organisation by default. These
changes close them, with the reviewers' other findings.

**Assigned and break-glass people (S-M1).** `PermissionScope` carries `includesAssigned` (true only
when a role scoped to assigned people, or to the person themselves, carries the permission) and
`includesBreakGlass` (true only for the read permissions a break-glass record opens,
`BREAK_GLASS_PERMISSIONS`: `people.person.read`, `care.plan.read` and `care.note.read`, every
`people.person.read`, `care.*.read` and `medicines.*.read` that exists). `narrowestScope` ANDs both
flags and `widestScope` ORs them; two location scopes that share no location give no one unless
both include assigned people (the database cannot express "assigned and at this location", so it
fails closed). The request context sets them per transaction (`app.scope_assigned`,
`app.scope_break_glass`, migration 0049) in `withRequestContext`, `inScopeOf` and `staffViews`, and
`app.person_in_scope` counts assigned and break-glass people only when they are set (scope
`assigned` always counts assigned people). `app.person_in_scope` is the only function that reads
`person_assignment` or `break_glass_event` for the reader; every child table follows it through
`app.person_visible`. Search, `permissionsReaching`, `personReachedBy` (an assignment counts only
while a role scoped to assigned people carried the permission) and the sync token follow the same
rule. Break-glass never opens a write, a discharge or death, residents' money, ReSPECT or an
admission: the allow-list is a decision for the CSO and the data protection lead (H-168). Opening a
record the read scope does not reach rolls the break-glass record back, so none is kept without its
audit event and alert (L6).

**Places (L1, L2).** `access_grant` and `role_assignment` gain `organisation_wide` (migration 0048,
which marks existing rows with no location so they keep their meaning). A grant has a location or
is marked (a check); a location role assigned with no location is refused unless marked (a
trigger). Everywhere roles and grants are read (`resolveAccess`, `placesHoldingPermission`,
`permissionsAtLocation`, `app.holds_permission_at`, `holdsPermissionAt`, `permissionHolders`,
`submitHolders`, `personReachedBy`, the alert fallback's organisation tier), an unmarked role or
grant with no location reaches no one, and a role scoped to the organisation assigned at a
location reaches that location only. Every API reader that decides what a member may do from their
roles and grants goes through one loader (`services/access-rows.ts`); review round 2 names the
readers that find who holds a role by name, and where a member works. The application may give or change a grant only where its member
holds `platform.grant.manage` (a grant for the whole organisation only when they hold it there),
and assign someone to a person only when the person is in their view and they hold
`people.assignment.manage` where the person lives (L8; restrictive policies for `harbour_app`; jobs
with no member keep the organisation's view). Organisation-wide Registered Managers are kept on
purpose (the alert fallback's first tier relies on them), marked rather than implied.

**Sync (C-M1, S-M1, L3).** Each family of streams follows the one read permission it serves:
people and allergies `people.person.read`, the care reference and active plan details
`care.plan.read`, recent entries `care.note.read`. The token carries `<family>_location_ids` and
`<family>_assigned` for each; the `assigned_*` streams sync a family only when its flag is true,
and a missing claim syncs nothing. A care coordinator (no `care.note.read`) now syncs the person
and the care reference at their home, not recent entries; before, nothing synced at all. Break-glass
never syncs. A deletion record decides whether it needs a manager before its transaction opens
(L3), so the transaction runs, and is audited, in the narrowed scope; a first stage that arrives in
between is refused as a conflict.

**Documents (S-M2, L4, L5).** A document about a person is read with `people.person.read` and its
category's read permission (`person_photo` and `person_document` `people.person.read`,
`care_attachment` `care.note.read`), and found again where both reach; the list offers only the
categories whose permission the session may use, each read in its own scope. An organisation's
document (policies, procedures, the statement of purpose) stays readable by every member: it is
about no one, and staff must be able to open the escalation and other policies they follow
(HZ-014). This departs from search, which offers organisation documents to
`platform.document.manage` holders only; search finds, reading follows the policy's audience. A
new version is found again where the upload permission reaches before anything is stored; bytes
are stored only after the row is inserted, and destroyed if the transaction fails. A HEAD request
on an allow-listed route is judged as its GET route.

**Audit trail (S-M3).** `GET /v1/audit` is whole, with reasons, only for holders of
`platform.audit.read` across the organisation. Held at some locations only, it fails closed: the
member's own events, and events whose resource is a person that permission's scope reaches (the
person table read under that scope); never a reason. Audit events do not yet say where they
happened, so every other event is withheld from a location-scoped reader until they do (STATUS
follow-up: a `location_id` on audit events).

**Tasks and routing (C-M3, C-M4, L10).** A task about a person is given, or automatically routed,
only to someone who can see the person with both `people.person.read` and the task's permission
(`mayBeGiven`, `membersSeeingPerson`): assigning through the API, the overdue escalation's holders
and its fallback (a Registered Manager at another home who cannot open the record is skipped), and
a refused entry's urgent review (told only to staff in charge who hold its permission). A holder
told about a task must also reach its place with `people.person.read`, so it is in their task list.
Device-hold and flagged-entry tasks are about no person, so their assignee sees them. Hazard
HZ-073 records the hazard of safety work hidden from the person who must act; a test checks that
every role key the services route to holds `people.person.read` and the work's permission in its
built-in bundle.

**Domain checks (L7, L9).** `permissionsReaching` and the workflow, exit and admission guards count
only permissions that reach the person and that the session may use (MFA met). A permission that
needs a fresh sign-in stays in: every such check is also given the session's freshness and refuses
it as `step_up_required`, so the person is asked to sign in again rather than told they lack it.

**Allow-list (L12).** A static test reads the route sources and checks that every handler opening
a tenant transaction first calls `requirePermission`, `requireAnyPermission` or `useScopeOf`. The
routes that do not are listed with why: `/v1/me`, form templates and rates (no personal data,
scope `none`), the member's own notifications, the device report (any member reports what their
device holds; the system's view writes it), sync uploads (every operation refused) and two
operator routes (behind the operator middleware). The scan follows calls by name within the API's
own sources and orders by position, not control flow; the test states these limits.

Confirmation for round 1: `access.test.ts` (flags, places, the property test), `search.test.ts`;
`packages/db/test/scope.test.ts` (`hazard HZ-011 assigned and break-glass people count only when
the scope says so`: the flags, the place checks, the grant and assignment write policies);
`apps/api/test/scope-per-permission.test.ts` (review round 1: the two-role assigned case refused
ReSPECT and a status change at the Lodge; break-glass reading only; documents; the audit trail;
assigning and the fallback); `sync-families.test.ts` (every built-in Care mode role, per family);
`packages/sync/test/care-streams.test.ts` (families and assigned flags); `route-gates.test.ts`;
`routing-roles.test.ts` (HZ-073).

### Review round 2 (security and clinical safety reviews of #27)

No high findings. The reviews found that routing by permission had left a home run by team
leaders with no one on site told, that the screens and the phone still offered forms the API
refuses, and two writes the scope did not yet bound.

**The nurse in charge (C2-M1).** One definition serves urgent result alerts (HZ-014, HZ-016), care
plan and risk review notices and refused-entry reviews: `nurseInCharge`, the clinical leads and
team leaders whose roles, in force, reach the home (at every home; no rota is checked), else its
Registered Manager; and `nurseInChargeSeeing` keeps only those whose read permissions reach the
person (or, about no one, whose `people.person.read` reaches the home). It never filters by a
permission to act that awareness does not need. A refused entry's urgent review goes to the nurse
in charge whose `people.person.read` and `care.note.read` reach the person (to read the copy) and to
the holders of `care.plan.write` who can see the person (to act); with neither, to the fallback;
with no one at all, `care.refused_entry.unrouted` is audited, as `care.alert.unrouted` is. A home
with team leaders and no clinical lead tells its team leader.

**Read only where the API refuses writes (C2-M2, C2-M3).** `GET /v1/people/{id}` returns `access`:
`recordCare` (the caller's `care.note.write` reaches the person), `editCarePlan` (their
`care.plan.write` does) and `readOnlyReason` (`break_glass` when only break-glass opens the record,
`scope` when their roles reach it for reading only), from `permissionsReaching`. The web shows the
notes, charts and body map forms and the chart settings only when the matching flag is true, and
otherwise says, in English and Welsh (the Welsh still to be translated), that the record is
open for reading only (or its scope variant; round 3 extends this to every tab and rewords it);
the break-glass sheet says the record opens for reading only. The
sync token carries `entries_write_location_ids` and `entries_write_assigned` (where
`care.note.write` reaches, by the same rule as the families); no stream reads them. The phone
keeps the last token's claims and offers recording only for a person at a home in the list, or
assigned to the user when the flag is set, and otherwise says it can read the record but cannot
record in it. Round 3 corrects two parts of this: the phone decides per person for the clients
assigned to the user, and before its first token it offers recording only to a user whose
permissions include `care.note.write`; the server keeps a copy of a refused entry only about
someone the author could reach with `care.note.write`.

**Signing (S2-M1).** Signing a person's document is a write: it needs the category's write
permission (`people.person.update` for `person_photo` and `person_document`, `care.note.write`
for `care_attachment`) reaching the person without break-glass, then the document is found again.
An organisation's document is signed as before. An organisation's document can no longer be given
a person or a person's subject type, and a document of a person's category with no person is not
found.

**Grants with no location (S2-M2).** Before this change such a grant applied wherever the member's
roles reached; marking it organisation-wide widens it, and nothing can mark it narrower. Migration
0048 therefore stops, naming the count (`check_violation`, nothing changed), while any is live (not
deleted, not revoked, not yet ended), so someone ends each or gives it a home. The pre-deployment
access report lists every member whose reach for the four reads (the record on screen and the
phone's three families) narrows or widens, comparing with the old merged scope as it was: a role
scoped to the organisation assigned at a location reached that location only.

**Who is told, by role (C2-M4 and lows).** `roleHolders` (`services/role-holders.ts`) finds who
holds a named role where it reaches, with one rule (`roleInForce`): the assignment in force, the
role not archived, the member on the staff (invited or active), and an assignment with no location
reaching everywhere only for a role scoped to the organisation or marked organisation-wide. The
overdue task escalation, its escalation chains, Registered Manager lookups, the break-glass alert
and weekly report recipients and the fallbacks use it, and the device-hold carriers and holders
apply the same rule, so a team leader
whose role has ended is never the one told and the Registered Manager is. A fallback about no one
prefers a manager whose role reaches the location, then a holder of the permission who does, then
anyone. `personReachedBy` counts an assignment only for the time both it and a role scoped to
assigned people were in force, of a role not archived. `workLocationIds` (where a member works, for
the location switcher in `/v1/me` and the token's `location_ids`) reads roles in force the same
way. Readers that are not about access (the device list's and a hold task's places of work) read
role rows with their validity windows.

**Lows.** A person syncs only where `care.plan.read` also reaches, so the phone never shows a
resuscitation decision or IDDSI level as not recorded when it is merely absent. A new round keeps
its series' assignee only while they may still be given it, else it waits for its role. A refused
break-glass attempt is audited after the rollback, with a coded reason. `planTaskLink` and the
return check are given the session's freshness, so a step-up permission is honoured as the round 1
paragraph says. The `assignment_change` policy has the same expression for `USING` as for
`WITH CHECK`. HZ-073 has its own DCB0160 row and a proposed residual of Major / Low / 3, for the
CSO to rate (H-169).

**Not in this change** (STATUS follow-ups): bounding grant and role assignment writes by the
granter's own permissions, before any route edits them; `withTenantWideScope` restoring the scope
in a `finally`; recording a failed storage destroy for the retention sweep.

Confirmation for round 2: `device-integrity.test.ts` (`hazard HZ-073 hazard HZ-014 tells the team
leader in charge about an urgent review at a home with no nurse`, and who exactly is told);
`tasks.test.ts` (`an overdue task is never told only to someone who has left`); `jobs.test.ts`;
`scope-per-permission.test.ts` (the `access` field, signing under break-glass, organisation
documents and a person-category document with no person, the people family needing
`care.plan.read`, the write claims, work locations from roles in force, a refused break-glass
attempt audited, assignment and role windows together, a series' assignee rechecked); `sync-families.test.ts`; `packages/db/test/scope.test.ts` (migration 0048 stopping on a
live grant with no location; the `assignment_change` policy); `apps/web/src/lib/care-record.test.ts`
and `apps/web/e2e/break-glass.spec.ts` (no form under break-glass, with axe);
`apps/mobile/src/sync/write-scope.test.ts` and the connector test.

### Review round 3 (security and clinical safety reviews of #27)

Security found nothing high or medium. Clinical safety found four mediums: forms still offered on
five tabs of a record open for reading only, a coordinator who is also a carer unable to record on
the phone, and two escalations that could be marked done with no one told.

**Every tab follows `access.reaching` (C3-M1).** `GET /v1/people/{id}` adds `access.reaching`, the
permissions the caller may use whose scope reaches the person without break-glass
(`permissionsReaching(..., { withoutBreakGlass: true })`), sorted; `recordCare` and `editCarePlan`
stay as before. On the web, `writeAccess(person, permissions, permission)` decides every write on
the record: notes, charts, the body map, activities and visits (`care.note.write`), assessments
(`care.assessment.write`: MUST and the others; NEWS2 is a chart), the care plan and its drafts,
risk assessments and chart settings (`care.plan.write`), and ReSPECT and advance care records
(`care.respect.record`). A tab that hides its form says why: "You opened this record for reading
only. To record something in it, tell the person in charge of this shift or your manager, or
record it on paper and enter it when you have access." under break-glass, and "You can read this
record but cannot record in it. If something needs recording, tell the person in charge of this
shift or your manager." where roles reach for reading only (the phone uses the second). The
wording fits home care and supported living as well as care homes; the Welsh copies are listed
for translation.

**The phone decides per person (C3-M2).** The sync token adds `entries_write_person_ids`, the
people the user is assigned to now, when `entries_write_assigned` is true, up to 100
(`MAX_WRITE_PERSON_IDS`; beyond that the claim is left out and the phone lets the server decide).
The phone offers recording for a person at a home in `entries_write_location_ids`, or named in
`entries_write_person_ids`; a token that names no one while `entries_write_assigned` is true
leaves the decision to the server. Before its first token the phone offers recording only to a
user whose cached permissions include `care.note.write`, and a held session clears the write
scope so the next person never inherits it. Person assignment rows do not sync, so the token
carries the ids.

**Escalations go down their order (C3-M3, C3-M4).** An overdue task's recipients are its assignee
(while active) and the first of: the clinical leads and team leaders whose roles reach its home;
a Registered Manager whose role reaches it (there, or across the organisation); the holders of
`care.plan.write` who can see the person (or reach the location, for a task about no one). With no
one, the task is not marked escalated, the gap is audited (`task.escalation_unrouted`, reason
`no_one_sees_person` or `no_one_reaches_location`), and it is tried again after an hour (a sync
task still waits a day). An escalation chain step goes to its named member while active and the
holders of its role reaching the location; with none, a Registered Manager reaching it, else the
owner (`chainStepRecipients`); with no one, `platform.escalation.unrouted` (`no_recipient`) is
audited and the later steps still fire. Everyone told is active (`TOLD`): an invited member who
has never signed in reads nothing and is never the one told; `ON_STAFF` (invited or active)
remains for holding access and being given work.

**Lows.** A refused entry's urgent review tells the `care.plan.write` holders at the home itself
when there are any, and only otherwise those across the organisation
(`permissionHolders(..., { preferAtLocation: true })`), so an owner is not told about every home
(HZ-008). `accessRowsOf` gives nothing to a member suspended, gone or deleted, and joins roles and
members on the organisation; `roleInForce` checks the role and member are not deleted, on the
same organisation; `workLocationIds` ignores portal and mixed roles. An organisation's document
is attached only to the organisation's own records (an allow-list: `location`,
`escalation_policy`, `statement_of_purpose_version`, `letter_template_version`), a subject needs
its type, and a new version of a person-category document with no person is not found. A
refused break-glass attempt whose audit cannot be written is logged by opaque ids and still
answers 404. `seed-users` runs only with `HARBOUR_SEED_DEMO_USERS=1`. The device check gives its
cut-off in Europe/London and lists Care mode staff whose phone has never been seen; the runbook
says how to check environments that ran the round 1 version of migration 0048, and that an
organisation-wide grant is never reactivated without a new decision.

Confirmation for round 3: `apps/web/e2e/break-glass.spec.ts` (`hazard HZ-073 a record opened by
break-glass offers no form to record in on any tab`, axe on each); `care-record.test.ts`
(`writeAccess` for each write permission); `write-scope.test.ts` (per person, before a token);
`scope-per-permission.test.ts` (review round 3: the coordinator who is also a carer, the
suspended member, documents); `tasks.test.ts` (`an overdue task goes down the order until someone
active is told`); `jobs.test.ts` (the chain step fallback and its audit); `device-integrity.test.ts`
(the unrouted refused-entry audit; the owner no longer told where the home has holders).

### Review round 4 (security and clinical safety reviews of #27)

Security found nothing high or medium. Clinical safety found one medium: a general overdue task
counted its assignee alone as told, so it was marked escalated, never retried and not audited
when no one else could act.

**Escalation means someone other than the assignee (C4-M1).** Each tier of the order (first
responders, a Registered Manager reaching the home, `care.plan.write` holders) leaves out the
assignee; with no one left, the assignee is still reminded, the task stays at level 0, and
`task.escalation_unrouted` is audited with `assignee_only` (or `no_one_sees_person`,
`no_one_reaches_location` with no one at all). The audit is written on the first occurrence and
then at most once a day per task: the minute run (`due`) skips a task audited in the last day,
and an hourly run (`retry`, the worker's `task-escalation-retries` queue) tries those tasks again,
so routing is retried every hour while the audit grows by one row a day at most. A task about a
person with no location takes the person's home, and each tier keeps only those who can see the
person; `POST /v1/tasks` stores the person's home when none is given.

**The operator's daily signal.** A daily job (`unrouted-daily-report`) writes one structured log
line, `escalation.unrouted.daily`, per organisation with any unrouted audit event in the last day:
the opaque tenant id and a count for each action (`task.escalation_unrouted`,
`sync.escalation_unrouted`, `platform.escalation.unrouted`, `care.refused_entry.unrouted`,
`care.alert.unrouted`, `people.break_glass_alert.unrouted`). The on-call runbook alarms on it.
There is no operator console attention list to add it to yet. Whether the organisation also
needs a signal in the product is a decision for the CSO (H-170).

**Lows.** A break-glass alert no one active can receive is audited
(`people.break_glass_alert.unrouted`, `no_recipient`) and counted in the daily signal; CQC
notification escalations tell only active staff (`submitHolders`). Above 100 assigned people the
token names none, and the phone falls back to round 2's location rule, failing closed where the
home syncs for reading only. `access.mfaRequired` lets a tab say that a second way to sign in is
needed, rather than the scope line; the charts tab says why chart settings are hidden from
someone who holds `care.plan.write` but not `care.note.write`. The device check counts staff who
work only through a live grant and ignores deleted, portal and mixed roles; a one-off check per
environment lists organisation documents attached outside the new allow-list. A write scope the
phone cannot keep is logged (the item's name and the error's kind) and the phone records about no
one until the next token. Follow-ups in STATUS: future-dated assignments and the write claim, and
Playwright coverage of the draft plan page and the review, close, withdraw and correct controls.

Confirmation for round 4: `tasks.test.ts` (`hazard HZ-008 hazard HZ-073 escalation means someone
other than the assignee is told`: the assignee told and the gap audited once, the hourly retry,
the person's home, the daily line); `scope-per-permission.test.ts` (round 4: over 100 people, the
break-glass alert); `write-scope.test.ts` and `write-scope-store.test.ts`; `care-record.test.ts`
(the MFA line).

## Pros and cons of the options

### One merged scope, with per-permission checks where they matter

- Good, because nothing changes for most routes.
- Bad, because the database still enforces the widest scope, so every route is one forgotten check
  from the defect; it fails open.

### A scope per permission, and each request runs under the one it uses

- Good, because row-level security enforces the permission's own scope with no policy change.
- Good, because the default is `none`.
- Bad, because a few routes that show every member something need an explicit allow-list entry.

### Per-permission policies in SQL

- Good, because the database alone would decide, row by row.
- Bad, because every policy would have to know which permission a query serves, which a policy
  cannot see; it would mean rewriting every policy and the sync streams.

## More information

[ADR-0002](0002-tenancy-and-row-level-security.md) (the request context this narrows);
[ADR-0033](0033-incident-scope.md); [ADR-0061](0061-family-portal-scope-and-row-level-security.md);
[permissions.md](../specs/permissions.md); [platform.md](../specs/platform.md) PLAT-004; hazard
HZ-011. Revisit when grants become editable through the API (who may grant where) and when team
scope arrives with rotas (Phase 2).
