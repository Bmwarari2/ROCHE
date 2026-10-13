# Platform core (`platform`) - specification

Master prompt section 9.1, with sections 4, 5 and 6. This spec covers what Phase 0 built and what
each later phase adds. Status per feature lives in [the feature register](feature-register.md).

## Purpose

The shared services every module depends on: tenancy, identity and access, audit, notifications,
forms, statutory figures, feature flags, integrations framework and the Thapsus operator console.

## Tenancy (PLAT-001)

- Hierarchy: `tenant_group` (optional) > `tenant` (one CQC provider) > `location` (CQC location ID,
  ODS code, regulator, nation, time zone) > `service` (service type). Schema:
  `packages/db/src/schema/platform.ts`.
- Isolation: forced row-level security on every table, request context set per transaction,
  composite tenant foreign keys, per-purpose database roles. Decision and details:
  [ADR-0002](../decisions/0002-tenancy-and-row-level-security.md).
- Provisioning: `app.provision_tenant` creates the tenant, the built-in roles and an invited owner
  in one step; only the operator role may call it (`POST /operator/tenants`).

Acceptance (all automated, passing): see `packages/db/test/*.test.ts` and
`apps/api/test/api.test.ts` (hazard HZ-011 groups).

## Identity, roles and scope (PLAT-004, PLAT-006)

- Identity: Better Auth in the `auth` schema (email and NCSC-compliant password, TOTP, passkeys,
  bearer tokens for mobile). Sessions last 12 hours; a sign-in counts as fresh for 10 minutes.
- Membership: `tenant_user` per tenant; one identity can belong to several tenants. The active tenant
  travels in `x-harbour-tenant`.
- Roles: per-tenant copies of the 21 built-in roles in `packages/domain/src/platform/roles.ts`;
  permission matrix: [permissions.md](permissions.md) (generated).
- Effective access: `resolveAccess` unions the permissions of active role assignments and
  time-boxed grants, and gives each permission its own scope (`scopeFor`,
  [ADR-0071](../decisions/0071-data-scope-is-per-permission.md)): the union of the roles that carry
  it (`tenant` > `locations` > `assigned` > `none`) and the grants that carry it (at the grant's
  location, or the whole organisation when marked `organisation_wide`), never the scope of another
  role. A location role assigned with no location reaches the whole organisation only when marked
  `organisation_wide` (a trigger refuses it otherwise), and a grant has a location or the mark (a
  check). The people a user is assigned to count for a permission only when a role scoped to
  assigned people carries it (`includesAssigned`), and the people they opened by break-glass only
  for the read permissions break-glass opens (`includesBreakGlass`, `BREAK_GLASS_PERMISSIONS`:
  `people.person.read`, `care.plan.read`, `care.note.read`; H-168); row-level security reads both
  from `app.scope_assigned` and `app.scope_break_glass` (ADR-0071 review round 1). A request
  starts with scope `none`; `requirePermission` narrows its row-level security context to the
  permission's scope (the narrowest of several, `narrowestScope`), `requireAnyPermission` to the
  union of the alternatives the session may use, and only the routes in
  `SCOPE_WITHOUT_PERMISSION` (the task list and task moves, document lookups) run in a
  permission's scope without requiring it; a static test checks every other route asks for a scope
  before opening a transaction. A document about a person is read with its category's permission
  (`care_attachment` `care.note.read`, the others `people.person.read`); an organisation's document
  by any member. `GET /v1/me` reports `scope` as that of
  `people.person.read`. Staff and portal sessions never mix
  (ADR-0061): a staff session (the default) skips portal roles and drops portal-only permissions
  (`PORTAL_ONLY_PERMISSIONS`) from grants; a portal session (`resolveAccess(..., "portal")`, for
  family members and later the person's own portal) takes portal roles only, with no grants and
  scope `none`. `checkRoleDefinition` refuses a role mixing portal and staff permissions,
  `checkGrantPermissions` refuses portal permissions in grants, and a stored mixed role is ignored.
  The API passes `"portal"` from the family portal step onwards.
- MFA: required for every permission that touches care records (`mfa_enrolment_required` otherwise).
- Step-up: controlled drugs, residents' money approval, data export, break-glass, statutory
  notifications, support-access approval and revoking a Care mode device need a sign-in within 10
  minutes.
- Break-glass: `POST /v1/people/break-glass` with a justification of at least 20 characters and an
  optional `reasonCode`; access lapses after 60 minutes; the Registered Manager for the location and
  quality leads are notified; the reason is audited. It opens the record for reading only
  (`people.person.read`, `care.plan.read`, `care.note.read`), never a write, a discharge or death,
  money, ReSPECT or an admission, and never syncs; a record the read scope does not open rolls the
  break-glass record back. Weekly break-glass report: the aggregation by
  user, person and reason with repeated-use flags is `breakGlassWeeklyReport`
  (`packages/domain/src/people/break-glass-report.ts`, [people.md](people.md) rule 14). Built in
  slice 8: a daily worker job stores the report for the UK week before once per location
  (`break_glass_weekly_report`, counts and opaque ids only; a missed Monday catches up) and alerts
  the location's Registered Manager and the data protection lead (holders of the quality lead role
  until the DPO confirms, H-80) with a generic title; `GET /v1/break-glass/weekly-report?week=`
  (`platform.audit.read`, the locations in the reader's access) and `POST
  .../weekly-report/{reportId}/review` (the actions taken, once). The screen comes with the web work.
- Devices: `GET /v1/me/sessions` lists where the person is signed in (this device marked);
  `POST /v1/me/sessions/{id}/revoke` and `POST /v1/me/sessions/revoke-others` sign devices out.
  Identity-level, so no organisation header. Session tokens reach only the mobile app (`Origin:
  harbour://`); browsers rely on the httpOnly cookie ([ADR-0030](../decisions/0030-web-session-and-browser-security.md)).
- Care mode devices ([care.md](care.md) section 6, Device integrity): `device_binding` records
  which member of staff has used which device (the PowerSync client id), first and last seen,
  written by the sync token and device report routes in the system's view, with the session that
  did so (`device_session`); any other request naming the device binds the session too
  (#25 review round 3, M2). `GET /v1/devices` (`platform.device.read`) lists them with the
  entries each last reported waiting and when (`lastReportedAt`); `POST /v1/devices/{deviceId}/revoke`
  (`platform.device.revoke`, step-up) revokes a lost or withdrawn device with a coded reason,
  audited, once the manager has confirmed any entries it reported waiting. Owner, Registered
  Manager and deputy hold both; a location role sees only devices used by staff working at its
  locations, and revokes one only when every member bound to it is such staff. The revocation
  does not end the sessions bound to the device (a device given a 401 could not tell it was
  revoked); the tenant middleware refuses every request from one with 403 `device_revoked`,
  whatever device it names, except its device report, which may raise or hurry the hold's task
  but never close it (#25 review rounds 2 and 3, M1 and M2). Mobile sessions live at the deploy
  that brings this in are ended then, so every live session is bound. A new
  sign-in naming a revoked device is refused with 403 `device_revoked` on the sync token and
  uploads, and the device wipes, keeping unsent entries under the hold rules. The member's
  sessions on other devices are not ended (identity-level; a manager ends them with the admin
  sign-out below).
- Per-user limits (`PerUserQuota`, `RateLimiter` in `apps/api/src/http`) keep their recent hits in
  Postgres (`request_quota`: one row per member and limit, updated under a row lock), so a limit
  holds across API instances. A row is read and written only in a view acting as its member (a
  hand-over's copies count against their owner). A refusal is 429 with Retry-After.
- Web: sign-in (password then TOTP, or a passkey), TOTP and passkey set-up and the device list are
  in `apps/web` (`/sign-in`, `/settings/security`).
- Idle timeouts per role: a browser session (one using the httpOnly cookie) unused for longer
  than its member's timeout is deleted at its next request to an organisation, audited
  (`platform.session.idle_timeout`, with the timeout) and refused with 401 `unauthenticated`. The
  timeout is `session.idle_timeout_minutes.<role key>` for each role the member holds now, else
  `session.idle_timeout_minutes`, from the rate table (the organisation's row first); several
  roles take the strictest (`idleTimeoutMinutes`, `packages/domain/src/platform/sessions.ts`;
  30 minutes, 15 for the owner and group executive, H-350). Last use is the session's
  `updated_at`, written at most once a minute by the tenant middleware (the device list shows it);
  the session middleware moves the expiry on hourly itself, with Better Auth's refresh off there,
  so a refresh never counts as use (Better Auth's own `/api/auth` calls still refresh as before).
  Mobile sessions (the bearer token) are never timed out by the server: the device auto-lock
  covers them (ADR-0011) and unsent entries must upload after a shift without signal (HZ-110).
  The identity-level routes (`/v1/memberships`, `/v1/me/sessions`) neither check nor record use.
  Known gap: the person record's header refreshes itself every 2 minutes while the page is
  visible, so an open record counts as use (STATUS follow-up).
- Admin sign-out: `POST /v1/members/{tenantUserId}/sessions/revoke` (`platform.user.manage` with
  step-up, a coded reason) deletes every session of the member's identity, so they are signed out
  of every device and every organisation they belong to (sessions are identity-level), and is
  audited (`platform.session.revoked_for_member`: reason, sessions ended, entries waiting). A
  location role reaches only a member whose roles and grants in force are all at its locations
  (with none in force, where they last worked), never one reaching the whole organisation; anyone
  else reads as not found. When the member's devices last reported entries waiting, it needs
  `confirmEntriesWaiting` (409 `entries_waiting`): a signed-out device keeps unsent entries,
  protected, for the member to send after signing in again (HZ-006, HZ-110).
- Later: invitations and enrolment by email (Phase 1), SSO (PLAT-005, Phase 2).

## Audit trail and history (PLAT-007)

- `audit_event`: append-only (no UPDATE or DELETE for the app; triggers refuse anyone else),
  SHA-256 hash chain per tenant maintained by a trigger, `app.verify_audit_chain()` for checking.
- Written for: person list, view and history; break-glass; refusals (missing permission, step-up,
  not a member); notification acknowledgement; sync token issue and uploads; integration settings
  and quarantine decisions; operator requests and tenant decisions.
- `record_version`: every update of a mutable aggregate stores the previous row; `GET
  /v1/people/{id}/history`.
- `GET /v1/audit` (platform.audit.read) lists events with chain verification: whole, with reasons,
  only for holders across the organisation; held at some locations, the member's own events and
  events about people that permission reaches, never a reason (ADR-0071 review round 1; a
  `location_id` on audit events is a STATUS follow-up).
- Later: signed PDF export of a record's history for inspectors and coroners (Phase 1); pgAudit is
  configured at the database level in RDS (infra).

## Notification centre (PLAT-008)

- `notification` (in-app), `notification_delivery` (one row per other channel, queued by trigger),
  `escalation_chain` (ordered steps by role or user), `notification_preference` (quiet hours).
- Rules (`packages/domain/src/platform/notifications.ts`): urgent notifications ignore quiet hours;
  escalation steps fire until someone acknowledges.
- Worker jobs (pg-boss, every minute): escalations, deliveries (email through the tenant's adapter;
  SMS and push skipped until phone numbers and device registration exist), outbox relay.
- Outbound titles are generic and checked by `outboundTitleProblem` before any send.
- Lock-screen push text stays generic: no person's name and no location name. An in-app title
  may name the home (the urgent result alert does, "An observation at Harbour Lodge needs a
  response now"; #26 review round 3), so push delivery, when built, sends a generic title of its
  own ("An observation needs a response now"), never the in-app title (#26 review round 4).
- API: `GET /v1/notifications`, `POST /v1/notifications/{id}/read`, `.../acknowledge`.
- Later: preferences UI and device push registration (Phase 1), SMS gateway choice (human action).

## Forms and assessment engine (PLAT-010, skeleton)

- `form_template` (global locked templates or tenant templates, versioned) and `form_submission`
  (pins the template version, stores the result and its workings).
- Domain: `validateDefinition`, `validateAnswers` (types, required, ranges, options, conditional
  fields), `scoreAnswers` (additive scores with bands and workings) in
  `packages/domain/src/platform/forms.ts`. Validated clinical tools are coded calculators added in
  Phase 1, never tenant formulas (medical-device boundary).
- API: `GET /v1/forms/templates`. Authoring UI and submissions: Phase 1.

## Task and workflow engine (PLAT-011)

- Tasks (`task`): kind (`module.what`), generic title, optional person and location, assignee,
  due time and window, priority, status, the reason for a skip or cancellation, evidence (the note,
  observation or document that shows it was done), escalation state. A task about a person follows
  the person's scope (in the task list and task moves, the scope of `people.person.read`,
  ADR-0071; completing one needs its permission where the task is, or being its assignee); other
  tasks are visible to tenant-wide roles, the assignee and staff at the location
  (`app.task_visible`).
- Recurring tasks (`task_series`): daily, weekly or monthly at UK local times, or every N hours of
  elapsed time (`packages/domain/src/platform/tasks.ts`). The worker materialises the next 48 hours
  every 15 minutes, idempotently; a worker outage never backfills more than an hour.
- Rules: skip and cancel need a reason; tasks that ask for evidence cannot be completed without it;
  finished tasks never change; two devices cannot overwrite each other (version check). Anyone
  holding the permission the task names where the task is (ADR-0071) completes it, and so does its
  assignee while they could
  still be given it; managers with `platform.task.manage` create, assign and schedule. Because the
  assignee may complete it, a task that names a permission other than `platform.task.manage` (a
  clinical check, a medicines round) is given, on creation, on scheduling or by assignment, only
  to someone who holds that permission at the task's location, the person assigning included; and
  once that grant or role has ended the assignee may no longer complete it (by the task route, an
  entry or a return check). For an entry, the permission is judged when the care was recorded, so
  a grant that ended before the device uploaded still counts and a revoked one never does (H-138). An investigation action is the exception: its owner completes it
  without the permission; so is a Care mode sync task the escalation gives to a Registered Manager
  elsewhere when no one at its location can act (H-142). Every refusal is audited (HZ-004, HZ-005).
  A one-off task about a person is placed at the person's home: given no location it takes it, and
  given another it is refused (422; ADR-0071 review rounds 4 and 5).
- Overdue: once a task's window closes it is overdue; after `task.overdue_escalation_minutes` (rate
  table) the worker notifies the assignee and, once, the first of these with anyone other than the
  assignee, each active and able to see the person: the clinical leads and team leaders at the
  location, a Registered Manager whose role reaches it, the holders of `care.plan.write` (HZ-008;
  ADR-0071 review rounds 3 and 4). A task about a person takes the person's home when it has
  none. With no one other than the assignee, the assignee is still reminded, the task is not
  marked escalated, `task.escalation_unrouted` is audited at most once a day per reason, and an
  hourly run tries again, taking every such task, oldest first, in pages (review round 5). A Care
  mode sync task follows the same rule: its own assignee is never counted as told
  (`sync.escalation_unrouted`, `assignee_only`). Each run goes on to the next organisation when
  one organisation's part fails (`platform.job.tenant_failed`). Once a day the worker logs
  `escalation.unrouted.daily` per organisation with any unrouted safety work in the last 25 hours,
  and a CloudWatch alarm defined in Terraform fires on it for the operator, as another does on any
  failed worker job (`worker.job.failed`), once applied (H-171; [on-call](../runbooks/on-call.md)).
- Workflows (`workflow_instance`, append-only `workflow_transition`): each module declares its
  states, transitions (permission, reason, step-up, separation of duties) and SLAs in code with
  `defineWorkflow`; `startWorkflow` and `moveWorkflow` (`apps/api/src/services/workflow.ts`) check
  the rules, record every move and set the next deadline (fixed hours or a rate-table figure).
- API: `GET /v1/tasks` (views: all or mine; by person, location, status, window), `POST /v1/tasks`,
  `POST /v1/tasks/{id}/transition`, `POST /v1/tasks/{id}/assign`, `POST /v1/task-series`,
  `POST /v1/task-series/{id}/end`. Every list and change is audited.

## Document store (PLAT-009)

- `document`: category, title, safe display file name, content type, size, SHA-256, version and the
  previous version, person (documents about a person follow the person's scope), subject (the
  record it belongs to), status (`available`, `quarantined`, `destroyed`), scan result, retention
  class from the category. Categories and limits (`packages/domain/src/platform/documents.ts`):
  person photo (images, 10 MB), care attachment (images or PDF, 15 MB), document about a person
  (images or PDF, 25 MB), organisation document (PDF, 25 MB).
- Uploads: the request body is the file; content is sniffed and must match the declared type;
  ClamAV scans it (an infected file is refused and nothing is stored; an unscannable one is
  quarantined); bytes go to S3 (SSE-KMS) or local disk under an opaque key
  ([ADR-0031](../decisions/0031-document-storage-scanning-and-destruction.md)).
- Serving: `GET /v1/documents/{id}/content` (audited) and `GET /v1/people/{id}/photo`, with
  `nosniff`, a sandboxing CSP, `no-store`, and `attachment` disposition except for photos.
- Versions: `POST /v1/documents/{id}/versions` adds a version; earlier ones stay. Signatures:
  `POST /v1/documents/{id}/signatures` with a typed name, a statement and the SHA-256 of the
  version read; append-only, refused if the document changed since it was read.
- Permissions: person photos and documents need `people.person.update` (care attachments
  `care.note.write`); organisation documents `platform.document.manage`; reading a person's
  documents needs `people.person.read` and MFA.
- Merge-field templates: letter and email templates with typed merge fields, approval by someone
  other than the author and fixed approved versions are specified in [comms.md](comms.md)
  (COMMS-007, rules in `packages/domain/src/comms/templates.ts`); a rendered letter is stored here
  as a document about the person.

## Retention and legal hold (PLAT-012)

- Legal holds (`legal_hold`) on a person (every record about them) or one record; placing and
  releasing need `platform.retention.manage` with step-up, which only tenant-wide roles hold
  (owner, quality lead); RLS enforces the same.
- `GET /v1/retention/candidates`: documents past their class's period (care-record documents
  count from discharge or death; people still receiving care are never eligible) with no hold.
- `POST /v1/retention/destroy`: re-checks each id, deletes every stored version, keeps a tombstone
  row without the title, and writes an append-only `destruction_certificate` per record class
  (ids, rule, reason, method). Held, current or unknown ids are returned as skipped.
- Later: retention of structured care records (not only documents), crypto-shredding with
  per-tenant data keys, and the destruction review screen (Phase 1 web slice).

## Statutory figures (PLAT-021)

- `rate_table` seeded from [rates.md](rates.md), `retention_class` from
  [retention.md](retention.md). Overlapping periods are refused by an exclusion constraint.
- Lookup: tenant override, then nation, then `uk`, then `all` (`resolveRate`); unverified figures
  are flagged. `GET /v1/rates/{key}?nation&on`.

## Working days and bank holidays

Clocks set in working days (the first care plan, written candour notifications, sponsor change
reports) count Monday to Friday in UK local time and skip the bank holidays of the location's
nation, from the global `bank_holiday` table seeded from [calendar.md](calendar.md) (GOV.UK). The
due time is midnight at the end of the Nth working day after the event's day
(`packages/domain/src/shared/working-days.ts`); workflow SLAs accept a `working_days` unit. Bank
holidays have no tenant column: every role reads them and only the owner role writes them. Past the
last year the calendar covers, no holiday is skipped, so a deadline can only fall early.

## Feature flags and licensing (PLAT-003)

- Catalogue and defaults in `packages/domain/src/platform/feature-flags.ts` (AI off by default);
  `feature_flag` rows per tenant or location override the default; `/v1/me` returns evaluated flags
  for the organisation as a whole.
- Evaluation goes through OpenFeature (`@openfeature/server-sdk`, Apache-2.0;
  `apps/api/src/flags/provider.ts`). The caller reads the organisation's rows that are not deleted
  in its transaction and passes them in the evaluation context; the provider applies
  `resolveFlag`: the location row, then the tenant row, then Flagsmith, then the catalogue default.
  Flagsmith is used only when `FLAGSMITH_ENVIRONMENT_KEY` is set (H-13), is told opaque ids only
  (organisation and location), and may set only licensed modules (`remoteMaySet`): never an AI
  flag (only the organisation's own row turns AI on), a clinical tool, a review workflow or the
  language, so the clinical routes that read the rows directly (`flagsAt`, `flagRows`) agree with
  `/v1/me`. Its answers, and its silence, are kept for `FLAGSMITH_CACHE_SECONDS`; unreachable
  (`FLAGSMITH_TIMEOUT_MS`), every flag falls back to the catalogue and the API logs
  `flags.remote_unavailable` with no ids. A provider error answers the catalogue default.
- Later: per-role flags, the clinical routes through the provider, billing visibility (Phase 6).

## Localisation (PLAT-017)

- `packages/i18n`: ICU catalogues for en-GB and cy with key parity, British spelling and no-emoji
  tests; Welsh falls back to English until professionally translated (Phase 7). Per-tenant
  terminology (resident, client, person we support) drives navigation labels.
- Every Welsh entry still in English is listed in `cy.status.json` (a test fails otherwise), and
  English messages keep sentence case.
- The web app reads every word from the catalogues through `apps/web/src/lib/i18n.ts`; plurals,
  terminology and regulator names are ICU `plural` and `select` messages, never strings built in
  code. `apps/web/src/copy.test.ts` fails on literal copy in JSX text or in attributes people read
  or hear. Default copy inside `@harbour/ui` components is the English fallback; the web shell passes
  translated words through component props (skip link, switcher menus, sidebar, account menu,
  sheet close, character count).

## Integrations framework (INTG-001)

- Ports (`comms.email`, `comms.sms`, `comms.push`) in `packages/domain/src/integrations/ports.ts`;
  adapters in `apps/api/src/integrations/adapters.ts` (mock, SES London, Expo push). Every adapter
  is wrapped by a guard (personal-data check, idempotency) and must pass the port contract tests
  (`apps/api/test/adapters.test.ts`).
- `integration_connection` chooses a provider per tenant (credentials stay in Secrets Manager);
  production without a provider fails clearly, never silently.
- Inbound data is validated with Zod and quarantined with its problems
  (`apps/api/src/integrations/inbound.ts`); `GET /v1/integrations/quarantine` and resolve.

## Operator console (PLAT-019)

- Operators are Better Auth identities in `operator_user` (support or admin), always with MFA.
- `GET /operator/tenants` (no people data), `POST /operator/tenants` (admins), `POST
  /operator/tenants/{id}/support-access`, `GET /operator/health`.
- Support access: the tenant's owners are notified; an owner approves for 1 to 24 hours with step-up
  (`POST /v1/support-access/{id}/decision`). Requests and decisions are in the tenant's audit chain.
- Later: read-only impersonation session using an approved request, operator web UI (Phase 1);
  metering and invoices (PLAT-020, Phase 6).

## Offline sync

- Streams: `packages/sync/src/streams/sync-config.yaml`; claims: `sub`, `tenant_id`,
  `location_ids`, `people_location_ids`, `care_location_ids` and `entries_location_ids` with
  `people_assigned`, `care_assigned` and `entries_assigned` (each family of streams where its own
  read permissions reach: `people.person.read` with `care.plan.read`, `care.plan.read`,
  `care.note.read`; ADR-0071 review rounds 1 and 2), `entries_write_location_ids` and
  `entries_write_assigned` (where the phone may record, `care.note.write`; no stream reads them)
  with `entries_write_person_ids` (the people the user is assigned to, when recording reaches
  them, up to 100; review round 3), `offline_days`; `location_ids` is where the member's roles in force work (`workLocationIds`,
  the same list as the location switcher in `/v1/me`); 15-minute ES256 tokens from `POST
  /v1/sync/token`, JWKS at `GET /v1/sync/jwks`. The token route binds the device to the member
  (`device_binding`) and refuses a revoked device (403 `device_revoked`). Uploads (`POST
  /v1/sync/upload`) reject every table until modules add writable tables; care entries go to their
  own routes ([care.md](care.md) section 6).

## Search, export, onboarding and DPIA (PLAT-013, PLAT-015, PLAT-018, PLAT-023)

Specified in [platform-completions.md](platform-completions.md): permission-aware search with
break-glass search and query-free audit ([ADR-0070](../decisions/0070-search-on-postgres-full-text.md)),
the free full tenant export with its manifest and documented schema, the onboarding checklist and
sample data mode, and the DPIA prefill and sign-off with the records-of-processing and
sub-processor registers. Domain rules are built; schema and API follow.

## Permission matrix

Generated: [permissions.md](permissions.md).

## Retention classes

Audit events, record versions and break-glass records keep the `audit_event` class (see
[retention.md](retention.md)); deliveries and inbound data are operational and follow the class of
the record they relate to (retention engine, Phase 1). `device_binding`, `device_session` and
`handed_over_entry` keep the `audit_event` class; `request_quota` is operational (a row holds at most a day's hits and is overwritten in
place).
