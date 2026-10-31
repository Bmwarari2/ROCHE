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

## White-label branding (PLAT-002)

Master prompt 9.1: a tenant's name, logo and accent colour, with the accent auto-adjusted to at
least 4.5:1 contrast on white and on black. The columns are already on `tenant` (`brand_name`,
`brand_accent` with its hex check, `logo_document_id`); no new table or migration.

**Rules**

1. The accent is a six-digit hex colour, stored lower case. `checkAccent`
   (`packages/domain/src/platform/branding.ts`) measures it against every surface it meets in both
   themes (`BRAND_THEMES`, mirroring the `@harbour/ui` tokens): white words on the accent and the
   accent on the page (`#ffffff` light, `#000000` dark) at 4.5:1, and the accent on the secondary
   background and card of each theme at 3:1 (WCAG 1.4.11, non-text). Only a colour that passes
   every check is stored or shown. One that fails is refused (422 `brand_accent_contrast`) saying
   why in plain English: too light (white words on buttons would be hard to read) or too dark (hard
   to see on the dark theme's black). The refusal names the nearest colour of the same hue that
   passes (`adjustAccentForContrast`), and the settings screen offers it in one step and shows the
   ratios. Auto-adjusting is offered, never done silently, so the owner sees the colour their staff
   will see. No accent: Harbour's own. The focus ring keeps Harbour's own colour in both themes,
   so an accent never weakens it; status colours are fixed tokens and never take the accent.
2. The display name (`checkBrandName`: NFC-normalised, trimmed, spaces collapsed, at most 80
   characters, no control, bidirectional-override or zero-width characters, so one organisation's
   name cannot be made to look like another's; blank means none) replaces the registered name in the shell (`Me.tenant.name`
   and every page's eyebrow). The registered name stays on statutory documents, letters (the
   `tenant.name` merge field) and the audit trail.
3. The logo is a PNG or JPEG of at most 512 KB (never SVG, which can carry script), refused above
   that size before it is read (its own body limit). It is shown to every member, so EXIF, XMP,
   IPTC, comments and PNG text chunks are removed before storing (`stripImageMetadata`), and it is
   stored through the document store in its own category, `organisation_logo` (content sniffed,
   malware scanned, encrypted; retention `organisation_document`). Refusals are audited. The web
   tier caches it privately for an hour under an address bound to the current logo document
   (`/branding/logo?v=<id>`; any other id is not found), so a switch of organisation in another
   tab never leaves another organisation's logo in the cache. The general document routes neither
   accept nor serve it. It is shown at 24 px high beside the product name in the app bar's home
   link, with empty alternative text: the organisation's name is already in the organisation
   switcher beside it. Removing it asks first, saying it stops showing for all staff, then clears the reference; the document stays in the
   store under its retention class. A quarantined file is kept but never shown.
4. Every member of the organisation may read the branding and the logo (they are shown in the
   shell); only `platform.tenant.manage` changes them, with the version read (409 when stale). Each
   change is audited (`platform.branding.updated` with the fields changed and the old and new
   accent, refusals too; `platform.branding.logo` with the document id), never the logo's bytes.
5. Sign-in: the organisation is not known before sign-in (one address can belong to several), so
   the sign-in page stays Harbour's; the "choose an organisation" page shows each one's name.
   Printed packs and letters keep the registered name as they do now; adding the logo to them is
   a later slice (the PDF writer, ADR-0040, would need the image path the transfer pack uses).
6. Not clinical: no hazard is affected. No personal data: a logo and a display name are about the
   organisation.

**API** (additive): `GET /v1/branding` (any member: registered and display name, accent, logo
id and type, version), `PUT /v1/branding` (`platform.tenant.manage`; name and accent with
`expectedVersion`), `GET /v1/branding/logo` (any member; the bytes, `nosniff`, sandboxing CSP, not
audited as a view), `PUT /v1/branding/logo` (the body is the image) and `DELETE /v1/branding/logo`
(`platform.tenant.manage`); `Me.tenant.logoDocumentId`. No step-up: branding is not one of the
step-up actions (section 5.3).

**Web**: `/settings/branding` (`platform.tenant.manage`, the owner by default), in the sidebar;
the shell sets `--accent` and `--accent-hover` in both themes from a colour that passes
`checkAccent` again in the web tier, and shows the logo through the `/branding/logo` route.

**Permission matrix**

| Action | Permission |
| --- | --- |
| See the branding in the shell, fetch the logo, read `GET /v1/branding` | Any member of the organisation |
| Change the display name, accent or logo | `platform.tenant.manage` |

**Tests (written first)**: `packages/domain/src/platform/branding.test.ts` (table-driven: passing
colours normalised, failing colours refused as too light or too dark with a suggestion that passes,
every check in both themes, invalid hex, display names); `apps/api/test/branding.test.ts`
(refusal with the suggestion and nothing stored, version conflict, permission, logo type, size and
malware scan, the general document routes refusing logos, audit); `apps/web/src/lib/branding.test.ts`
(the theme surfaces match `@harbour/ui` tokens, the shell's accent style, form reading);
`apps/web/e2e/branding.spec.ts` (a failing colour refused with why, take the suggestion, the shell
shows it; upload and remove a logo; axe in light and dark).

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
  It counts only when the session itself signed in, or confirmed a code, with a passkey, an
  authenticator code or a backup code (ADR-0072); a member with a factor enrolled whose session
  did not use it gets `mfa_verification_required` and is sent to sign in with it. Sessions from
  before this rule fail closed.
- Step-up: controlled drugs, residents' money approval, data export, break-glass, statutory
  notifications, support-access approval and revoking a Care mode device need a second factor (a
  passkey, an authenticator code or a backup code) used on the session within the step-up window
  (`STEP_UP_WINDOW_SECONDS`, 10 minutes by default): a sign-in completed with one, or a code or
  passkey confirmed on the session. A password sign-in alone never counts, however recent; a member
  holding a step-up permission with no factor enrolled gets `mfa_enrolment_required` (ADR-0072
  amendment).
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
  .../weekly-report/{reportId}/review` (the actions taken, once, never by anyone the report counts:
  an opening, a search at the location or one in its organisation-wide section, flagged or not).
  A search that showed no one at any location goes in an organisation-wide section of every
  report of the week (`unplacedSearches`), never in a location's own searches; the API gives it,
  and names its searchers, only to readers whose access reaches the whole organisation. Each
  report carries `staff`, the `StaffName` of every member it counts (as far as the reader may see)
  and of its reviewer (display name and job title only), so a reader who cannot list the members
  (the quality lead, a group executive) still sees who used break-glass. A report stored before the
  organisation-wide section (no `unplacedSearches`) names to a location's reader only the members
  on its opening lines and flags, never its searchers, since its searches may include ones that
  showed no one at any location; separation of duties still counts everyone. Each view is audited
  with the ids of the reports shown and whether the organisation-wide section was. The
  organisation-wide section's warning on the alert goes only to data protection leads whose
  `platform.audit.read` reaches the whole organisation.
  - **Accepted risk (security re-review L-2).** Row-level security does not restrict
    `unplacedSearches`: it is a key in the summary of every location's row, and only the route's
    `summaryFor` withholds it (and its searchers' names) from a reader who does not reach the whole
    organisation. Any other read of `break_glass_weekly_report` under a location scope would see
    it. Moving it to an organisation-level row (`location_id` null) that row-level security limits
    to organisation-wide readers needs a migration (nullable `location_id`, its policies and the
    `break_glass_weekly_report_once` unique index); not done.
  - **Known limit (security re-review L-3).** The organisation-wide section has no review state of
    its own: it is reviewed with each location's report, and the "Actions taken" written there is
    read by that location's readers, so the form says so.
- Break-glass report screen (web, `apps/web/src/app/(shell)/break-glass/weekly-report`): "Break-glass
  report" in the side bar for `platform.audit.read` only (anyone else opening the address is told
  they do not have access). The list shows one UK week (Monday to Sunday, dd/mm/yyyy in a `<time>`
  holding the ISO week; the last complete week by default, `?week=` any date in it, with previous
  and next week, next only once it has ended), each location's report in the reader's access
  (narrowed to the location switcher's location when one is chosen, and saying so when that hides
  every report) with its totals in words and its state as icons and words ("Reviewed" or "To
  review", "n things flagged", "Could not be read"); a week with no reports says when Harbour
  builds them. For a reader across the organisation it also shows the searches that showed no one
  at any location, with who searched, why and who is flagged. The report page ("Break-glass report
  for {location}", its title naming the location and week, never a person) shows the totals, what
  it flags as sentences, one for each flag and each flagged searcher, so the count on its chip and
  the sentences always agree ("Mo Manager opened the record of Una Example 3 times. Their access
  may need changing."; "Mo Manager made 4 break-glass searches, at or above the limit of 3
  searches a week."), tables of records opened by member of staff, by person and by reason chosen
  (reasons the web does not know merged into one line), the break-glass searches by member of staff
  and by reason, and the review. People are named from the reader's own people list, each with
  their communication needs (AIS); anyone else is numbered ("Person 2 (not shown to you)"). The
  typed reasons are not on the page: the report holds counts and ids, and the screen says the
  reasons are in the audit log. A report that does not count the reader, and is not yet reviewed,
  offers "Actions taken" (3 to 2,000 characters) and "Record the review"; the review needs no
  step-up (the API asks none). A report counting the reader says someone else must review it. A
  stored summary the web cannot read in part warns rather than reading as nothing to report
  (HZ-011). The per-opening "not yet reviewed" count is not shown: nothing reviews an opening one
  by one yet. Local journeys build reports with `pnpm --filter @harbour/api break-glass-report:run`
  (`--this-week`, or `--e2e-week=yyyy-mm-dd` for an unused past week with an invented opening and
  search); the script, like `exports:run`, runs only against a local or CI database
  (`testOnlySwitchRefusal`).
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
- Idle timeouts per role: **off** unless the environment sets `SESSION_IDLE_TIMEOUT=on`, and
  production refuses to start with it on, because signing a browser out mid-entry loses the form
  (HZ-111). When on, a browser session (one using the httpOnly cookie) unused for longer than its
  member's timeout is audited (`platform.session.idle_timeout`, with the timeout), deleted at its
  next request to an organisation and refused with 401 `unauthenticated`. The timeout is
  `session.idle_timeout_minutes.<role key>` for each role the member holds now, else
  `session.idle_timeout_minutes`, from the rate table (the organisation's row first); several
  roles take the strictest, kept between `session.idle_timeout_floor_minutes` and
  `session.idle_timeout_ceiling_minutes`; a missing or invalid figure takes the default, and with
  no valid default the timeout is not enforced (`idleTimeoutMinutes`,
  `packages/domain/src/platform/sessions.ts`; 30 minutes, 15 for the owner and group executive,
  H-350). Last use is the session's `updated_at`, written at most once a minute by the tenant
  middleware (the device list shows it); the session middleware moves the expiry on hourly itself,
  with Better Auth's refresh off there. Mobile sessions (the bearer token) are never timed out by
  the server: the device auto-lock covers them (ADR-0011, HZ-110).
- **Before the idle timeout may be turned on** (the PR that turns it on closes every item; H-353):
  HZ-111's controls (a warning before expiry with "Stay signed in", WCAG 2.2.1; signing in again
  in place without losing the form, with no care text in browser storage); Better Auth's own
  `/api/auth/get-session` refresh writes `updated_at` hourly and so resets the idle clock (set
  `session.disableSessionRefresh` or keep last use in a column Better Auth never writes, with a test
  through `/api/auth/get-session`); whether the timeout applies is decided by a request header (a
  cookie plus a bogus bearer header reads as the app), so mark each session web or mobile at sign-in
  and decide by that; last use is per sign-in but the timeout comes from the requested
  organisation's roles, so a laxer organisation resets a stricter one (take the strictest across
  the sign-in's memberships, or record last use per session and organisation); background reads
  (the person record header's 2-minute refresh, `HeaderFreshness`) count as use, which also keeps a
  shared ward PC signed in as the last user (mark them as background while still checking idle);
  Harbour's global per-role rows beat an organisation's stricter default; acting-up grants add no
  role keys; an idle session still works on the identity-level routes (`/v1/memberships`,
  `/v1/me/sessions`, `revoke-others`) and on `/api/auth/*`; use is recorded before authorisation.
- Admin sign-out: `POST /v1/members/{tenantUserId}/sessions/revoke` (`platform.user.manage` with
  step-up, a coded reason) deletes every session of the member's sign-in. It is audited
  (`platform.session.revoked_for_member`: reason, sessions held, entries waiting) before the
  sessions end, since the audit trail and the sessions live under different database roles and no
  one transaction holds both; a failure to end them is audited too, and every refusal (not found
  or out of scope, another organisation, entries unconfirmed, step-up) by opaque id. A location
  role reaches only a member whose roles and grants in force are all at its locations (with none in
  force, where they last worked), never one reaching the whole organisation; anyone else reads as
  not found. A member who also has an active membership in another organisation is never signed
  out (409 `member_of_other_organisation`): their sessions are their sign-in's, so it would end
  their work there too (#40 review M1; tenant-scoped sessions are a STATUS follow-up, H-354).
  When the member's devices last reported entries waiting, it needs `confirmEntriesWaiting` (409
  `entries_waiting`, saying that signing out removes the care record from their phone until they
  sign in again and that unsent entries stay on it until then; HZ-006, HZ-110); for `staff_left`
  or `suspended`, the holds on those devices fall due at once and the manager is told, as after a
  device revocation (`hurryRevokedHold`).
- Later: SSO (PLAT-005, Phase 2; rules in [Phase 2: data rights, imports and single sign-on](#phase-2-data-rights-imports-and-single-sign-on-plat-022-plat-014-plat-005)). Invitations and MFA enrolment: the next section.

## Invitations and MFA enrolment (PLAT-004)

Status: the rules are built (`packages/domain/src/platform/invitations.ts`, table-driven tests),
the store (migration 0054, the schema below; `packages/db/test/invitations.test.ts`) and the
routes and the sweep (As built, below; `apps/api/test/invitations.test.ts`) and the accept page
(`apps/web/src/app/(auth)/invitation`, As built below), the members routes and the managers'
team and invitation screens (`apps/web/src/app/(shell)/settings/team`, As built below). Built already
and relied on: NCSC password rules at sign-up (`passwordProblem`: 12 to 128 characters, a
deny-list, no expiry, throttling not lockout), passkeys and authenticator apps (TOTP) with the
set-up screen (`/settings/security`), `mfa_enrolment_required` on every permission that touches
care records until one is enrolled, and no one-time code by SMS or email (Better Auth's
`/two-factor/send-otp` answers `OTP_NOT_CONFIGURED`; SMS only by a documented exception, none
granted). Review round 1 of #43 (security) shaped what follows.

The link: `https://app.<domain>/invitation#<token>`. The token travels only in the URL fragment,
which browsers never send to a server, so it is in no load balancer, firewall or web log; the
page reads it, removes it from the address bar and history, sends it only in POST bodies, and is
served with `Referrer-Policy: no-referrer` (#43 review M1). Nothing about an invitation is ever in
a path or a query string.

Flow:

1. **Invite.** A holder of `platform.user.manage`, with step-up, invites a member who is still
   `invited`, has no sign-in and is required to use a second factor (`inviteRefusal`; a member is
   never created with `mfa_required` false), within the admin sign-out's reach (a location role only
   members wholly at its homes), and only where it holds every permission of each of the member's
   roles where that role applies (`permissionsBeyondInviter`; #43 review M3), so no one hands out
   more than they hold. Sending revokes the member's open invitations (`invitationsToRevoke`,
   lapsed ones too) and stores a new one with the SHA-256 of a 256-bit random token
   (`INVITATION_TOKEN_BYTES`; the token itself is never stored or logged), an expiry of
   `invitation.expiry_hours` capped by `invitation.expiry_hours_max` (rate table, 72 and 168), and
   the member's address copied from their record by the database, never from the request. The
   link is emailed through the organisation's email adapter: a generic subject ("You have been
   invited to Harbour"), the organisation's name, the expiry in UK time, nothing about any person
   receiving care. Audited (`platform.invitation.sent`, opaque ids, never the address or the
   token); refused attempts too. The first owner, made by `POST /operator/tenants`, is invited by
   an operator admin (`POST /operator/tenants/{id}/owner-invitation`) through a security-definer
   function that invites only the owner of an organisation with no active member, audited in the
   organisation's chain; operators have no other way to write an invitation.
2. **Open the link.** `POST /v1/invitations/lookup` with the token in the body (no session): the
   organisation's name, the address masked, the expiry, the state, and whether to create a sign-in
   or sign in first (`acceptancePath`). Throttled per client address and per token, the token
   counted by its SHA-256 (the raw token is never stored, in `request_quota` or anywhere); an
   unknown token is 404 and a platform audit event.
3. **Accept.** `POST /v1/invitations/accept` with the token in the body, once (`acceptRefusal`:
   used, revoked, lapsed, the organisation suspended or closed, the member no longer `invited`,
   signed in with another address, already a member), throttled like the lookup. With no sign-in
   for the address, the person sets a password meeting the NCSC rules and a sign-in is created for
   the invited address (holding the link proves the address); with one, they must sign in first and
   accept while signed in, so an invitation never sets the password of an existing account. A new
   sign-in's id is then recorded on the invitation in its own committed transaction, before the
   acceptance begins (`app.record_invitation_sign_in`, `claimed_auth_user_id`, audited as
   `platform.invitation.claimed`; #48 review M1), so a record survives an acceptance that rolls
   back. Only a sign-in at the invitation's address created after the invitation, while it is open
   and unlapsed, is recorded, once (again only when the first recorded sign-in no longer exists;
   #48 review H1). The acceptance's transaction then locks the invitation (`app.claim_invitation`,
   holding the row) and `app.accept_invitation` links the member (`auth_user_id`, status
   `active`), marks the invitation accepted, clears its address and writes the audit event
   (`platform.invitation.accepted`). If anything fails after the sign-in was created, the
   transaction rolls back and the new sign-in is deleted, so no password is left on an address with
   no member linked; and should the process stop between the two, a nightly sweep deletes the
   sign-in. The sweep (`app.unlinked_invitation_sign_ins`) lists only recorded sign-ins, recorded
   more than `invitation.unlinked_sign_in_hours` ago (rate table, 24), on an invitation never
   accepted, named by no membership row in any organisation and any state
   (`app.auth_user_has_membership`, a yes-or-no security-definer function owned by
   `harbour_membership_reader`) and by no operator. A sign-in made any other way (a family portal
   user, a professional or inspector with expiring access) is never listed, nor is a member's.
4. **Enrol.** The new session is sent to `/settings/security?reason=mfa`; until a passkey or an
   authenticator app is enrolled, every care-record permission answers `mfa_enrolment_required`
   (built: `refusalOf`, `touchesCareRecords`).
5. **Revoke, list and sweep.** `POST /v1/invitations/{id}/revoke` and
   `GET /v1/invitations?tenantUserId=` (`platform.user.manage`; states and times, never tokens or
   hashes). A member suspended or removed, or whose address, MFA requirement, roles or grants
   change, loses any open link (`member_removed`, `member_changed`), each revocation audited
   (`platform.invitation.revoked` with its reason; #48 review M3). A nightly sweep revokes lapsed
   invitations as `expired` (`invitationsToSweep`, `platform.invitation.expired`), which frees the
   member for a new invitation and clears the address.

Schema, as built in migration 0054 (`packages/db/drizzle/0054_invitations.sql`):

- `invitation`: `id` (UUIDv7), `tenant_id` (forced row-level security, tenant policy),
  `tenant_user_id` (composite foreign key to `tenant_user`), `email` (copied from the member by a
  trigger; required while the invitation is open and cleared when it is accepted, revoked or swept;
  #43 review M4), `token_hash` (SHA-256 hex, unique; the app role may insert it but has no
  `SELECT` on the column, so a stored hash is never readable as a credential), `created_by`
  (`tenant_user`) or `created_by_operator` (`operator_user`; exactly one), `created_at`,
  `expires_at`, `accepted_at`, `accepted_auth_user_id`, `revoked_at`, `revoked_by`,
  `revocation_reason` (`INVITATION_REVOCATION_REASONS`). One open invitation per member (partial
  unique index on neither accepted nor revoked; lapsed rows are swept). The application role may
  insert only `tenant_user_id`, `token_hash`, `expires_at` and `created_by`, never
  `created_by_operator`.
  - **Insert** (#43 review round 2, N2): `created_by` must equal `app.current_user_id()`, never
    null, and that member (the session's, not one the request names) must hold
    `platform.user.manage` and every permission of the member's roles and grants where they apply
    (`app.may_invite`). `created_by_operator` is refused unless the insert runs inside
    `app.invite_first_owner`, recognised by `current_user = 'harbour_invitation_owner'` (the
    definer's owner); there `created_by` is null and `created_by_operator` required. The address is
    copied from the member, never taken from the request. The member must still be `invited`, not
    deleted, with no sign-in and `mfa_required`. `created_at` is set by the database to the moment
    of the insert, and `expires_at` must fall after it and no later than the global
    `invitation.expiry_hours_max` (#48 review M2): an organisation's own figure never raises the
    ceiling, and a sender that skips the rule is still refused.
  - **Update**: an invitation keeps its member, link, sender and expiry, and changes only by being
    claimed, accepted or revoked, its address cleared when it is accepted or revoked; accepted or
    revoked is final; no delete. Claimed only inside `app.record_invitation_sign_in`, while open
    and unlapsed. Accepted only inside `app.accept_invitation` (`current_user =
    'harbour_invitation_owner'`), before it lapses, for the member it is for; the application role
    has no update grant on the claim or acceptance columns, nor on the address. A member revokes
    in their own name (`revoked_by = app.current_user_id()`, not null) and only as `revoked` or
    `superseded` (#48 review, low). With `revoked_by` null, in exactly three cases, each only
    through a function owned by `harbour_invitation_owner` (round 2, N1): the nightly sweep
    (`expired`, and only once lapsed); the member-change trigger (`member_removed`,
    `member_changed`), which covers worker jobs that run with no member; and the first owner's
    re-invitation (`superseded`, inside `invite_first_owner`). A member's change made by a
    signed-in member records them as the reviser, and only as `member_removed` or
    `member_changed`.
  - Changing a member's address, MFA requirement, roles, grants, status or deletion revokes their
    open invitations, each audited. Expiry checks read the clock at the moment
    (`clock_timestamp()`), not the transaction's start.
  - Who reads and revokes (`invitation_scope`): a role across the organisation or at locations,
    and the member it is for. A location-scoped manager therefore reaches every invitation in the
    organisation in the database; the routes narrow them to the members `platform.user.manage`
    reaches (logged in STATUS item 20).
- `app.claim_invitation(token)` and `app.accept_invitation(token, auth_user_id)`: security-definer
  functions owned by their own NOLOGIN role (`harbour_invitation_owner`, as
  `memberships_for_auth_user` is owned by `harbour_membership_reader`), with
  `SET search_path = pg_catalog, public`, `REVOKE ALL ... FROM PUBLIC` and `EXECUTE` granted to
  `harbour_app` only. They take the raw token and hash it themselves; `claim_invitation` locks the
  row (`FOR UPDATE`) and refuses an invitation that is not open, has lapsed, belongs to an
  organisation that is not onboarding or active, or whose member is no longer `invited` or is
  deleted; `accept_invitation` also compares the sign-in's email (read from `auth.user`) with the
  invitation's before linking. `app.invitation_for_token(token)`, under the same owner, answers
  the lookup without changing anything. The routes pass the token only as a bound parameter.
- `app.invite_first_owner(tenant, token_hash)`: a security-definer function owned by
  `harbour_invitation_owner`, with `SET search_path = pg_catalog, public`, `REVOKE ALL ... FROM
  PUBLIC` and `EXECUTE` granted to `harbour_operator` only. It invites only the organisation's
  invited owner while the organisation is onboarding or active and has no active member, the owner
  role live (neither deleted nor archived) and its assignment in force, superseding any open
  invitation (audited as `platform.invitation.revoked`, `superseded`, naming the operator). It
  takes neither the expiry nor the operator from its caller: the expiry is
  `invitation.expiry_hours` (the organisation's figure, else the global one) capped at
  `invitation.expiry_hours_max`, both read from the rate table inside; the operator is the one the
  operator middleware set for the transaction (`app.operator_id`, as `app.user_id` is for members),
  checked inside to be an active admin in `operator_user`.
- `harbour_invitation_owner` holds only what its functions need (#48 review, low): the invitation
  table; on `tenant_user` the columns it reads (`id`, `tenant_id`, `auth_user_id`, `status`,
  `email`, `mfa_required`, `deleted_at`, `created_at`) and updates (`auth_user_id`, `status`);
  the organisation's name, status and nation; the role and assignment columns the first owner's
  check reads; the rate table; appending audit events; an active-admin check on `operator_user`;
  `EXECUTE` on `app.auth_user_has_membership`; and a column grant on `auth.user` of `id`, `email`
  and `created_at` only (ADR-0002). `harbour_owner` holds it with `SET` but not
  `INHERIT`, so the role's open policies on `invitation` and `operator_user` never apply to
  migrations and seeds (`packages/db/src/admin/roles.ts`).
- The member-change trigger function (`app.invitation_member_changed`, on `tenant_user`,
  `role_assignment` and `access_grant`) is itself a security-definer function owned by
  `harbour_invitation_owner`, so its revocations are recognised as the definer path whoever makes
  the change, and a worker job with no member (`app.user_id` unset) still revokes and clears the
  address.
- `app.record_invitation_sign_in(token, auth_user_id)` and `app.unlinked_invitation_sign_ins()`:
  the claim and the narrow sweep list above, under the same owner (`EXECUTE` to `harbour_app` and
  `harbour_worker` respectively). `app.sweep_expired_invitations()` revokes lapsed invitations
  (`EXECUTE` to `harbour_worker`).
- Every write a definer function makes is audited through `app.invitation_audit` (owned by
  `harbour_invitation_owner`, executable by no login role), in the invitation's organisation,
  naming the actor its caller passes or the system, with opaque ids only: `platform.invitation.sent`
  (first owner), `.claimed`, `.accepted`, `.revoked` (member changes; the first owner's
  re-invitation) and `.expired`. Each function gives the caller back its `app.tenant_id`,
  `app.user_id` and `app.scope`.
- `EXECUTE` on the definer functions is revoked from `PUBLIC` and granted while `harbour_owner`
  still owns them, then ownership moves: holding `harbour_invitation_owner` without `INHERIT`, it
  could not revoke or grant afterwards (a `REVOKE` would only warn and leave `PUBLIC` able to run
  them). A table-driven test checks `EXECUTE` per login role.
- `pnpm db:bootstrap` creates `harbour_invitation_owner`; an existing cluster must run it again
  before migration 0054 (`docs/runbooks/local-development.md`).
- Retention: `invitation` rows take their own class (`invitation`, retention.md); the address is
  gone once the invitation is closed, and the audit trail keeps who was given access and when.


As built, the routes (`apps/api/src/routes/invitations.ts`, `operator-invitations.ts`,
`services/invitations.ts`):

- `POST /v1/invitations` (`platform.user.manage`, step-up): only a member the permission reaches
  (`memberReached`, the admin sign-out's rule; anyone else is 404), still invited
  (`inviteRefusal`, 409 with its code) and within the sender's permissions (`app.may_invite`, 403
  `beyond_inviter`); supersedes the open invitation (audited `platform.invitation.revoked`,
  `superseded`), stores the hash with the expiry from `app.invitation_rate` through
  `invitationExpiresAt`, audits `platform.invitation.sent`, then emails the link. The token is 32
  random bytes, base64url; the SHA-256 of its UTF-8 bytes is what `app.invitation_token_hash`
  computes. Refusals are audited.
- `GET /v1/invitations?tenantUserId=` and `POST /v1/invitations/{id}/revoke`
  (`platform.user.manage`): narrowed to members the permission reaches, as sending is (#48
  review), so a location role cannot read or withdraw an invitation for another home's staff or
  the owner; states, times and the reason only. Withdrawing is in the member's own name, as
  `revoked`; a closed invitation is 409 `invitation_closed`.
- `POST /v1/invitations/lookup` and `/accept` need no session (no organisation is chosen); each is
  throttled per client address and per token's SHA-256 (`MemoryThrottle`, per API instance,
  `INVITATION_REQUESTS_PER_MINUTE_PER_ADDRESS` 20 and `_PER_TOKEN` 10; across instances needs a
  table keyed by something other than a member, a Lane A follow-up). The token goes to
  `app.invitation_for_token`, `app.claim_invitation`, `app.record_invitation_sign_in` and
  `app.accept_invitation` only as a bound parameter; it is never logged, audited or returned.
  Lookup reads the address through `claim_invitation` in a transaction rolled back at once, to
  choose `acceptancePath`. Accepting signed in links that sign-in (`next: enrol`); not signed in,
  it creates a sign-in only when none exists for the address (else 409 `sign_in_first`), with the
  NCSC rules and the address marked verified, records it, then accepts in one transaction; if the
  acceptance is refused or fails, the new sign-in is deleted (`platform.invitation.sign_in_removed`,
  a platform event) and `next: sign_in` is returned only on success. An unknown token is 404 and a
  platform audit event; refusals are audited in the organisation's chain with the client address.
- `POST /operator/tenants/{tenantId}/owner-invitation`: operator admins with a sign-in inside the
  step-up window; sets `app.operator_id` for the transaction and calls `app.invite_first_owner`;
  its refusals (`organisation_has_members`, `no_invited_owner`, `organisation_not_active`) are
  409s audited in the organisation's chain.
- The email goes straight to the organisation's `comms.email` adapter (the mock unless one is
  configured; in production none means not sent, `emailSent: false`, audited
  `platform.invitation.email_failed`; H-356), never through `notification_delivery`, which would
  store the link. Subject "You have been invited to Harbour", the link only (H-357).
- The worker's nightly `invitation-sweep` (03:17) runs `app.sweep_expired_invitations` and deletes
  each sign-in `app.unlinked_invitation_sign_ins` lists through the auth role, each audited as
  `platform.invitation.sign_in_removed`. Known gap, logged in STATUS: a sign-in linked between the
  listing and the deletion would be deleted; the window is milliseconds once a night, and only for
  a sign-in already 24 hours unlinked.

As built, members for managers (`apps/api/src/routes/members.ts`, contracts `members.ts`,
migration 0060), the routes the managers' invitation screens use:

- `GET /v1/members` (`platform.user.manage`): the invited, active and suspended members the
  permission reaches (`membersReached`, the batch form of the admin sign-out's `memberReached`: a
  location role only members whose every role and grant in force is at its locations), each with
  their roles in force or to come and where; optionally only those with a role at one location.
  With them, each role the manager may give and where (`app.may_assign_role`). Never an address.
- `POST /v1/members` (`platform.user.manage`, step-up): adds a member as invited, required to use a
  second factor, with a name, a work address (stored in lower case) and one role at a location or
  across the organisation (a location role across the organisation is marked organisation-wide).
  Refused with 403 `beyond_inviter` unless `app.may_assign_role` (the manager holds
  `platform.user.manage` and every permission of the role where it would apply through their own
  roles, never an access grant, so acting up never becomes a lasting role; never the portal role
  of a person receiving care), then checked again with `app.may_invite` on the new member;
  409 `email_in_use` for an address already in the organisation, in any case. Idempotent on the
  client's id: the same manager's retry with the same name, address and role answers 200; anything else with that
  id is 409 `member_id_conflict`. Audited as `platform.member.created` with the role and location
  ids, refusals too; never the address. The manager then invites them with `POST /v1/invitations`.
- Migration 0060 (after 0059, letter templates, #69) enforces the same in row-level security: the
  application role may insert a `tenant_user` only as invited, with no sign-in and a second factor
  required, by a member whose own roles carry `platform.user.manage` somewhere
  (`app.holds_role_permission_somewhere`),
  and a `role_assignment` only where `app.may_assign_role` allows. Changing an existing role
  assignment is not covered yet (no route does it): logged in STATUS.

As built, the managers' screens (`/settings/team`, `lib/team.ts`, `actions/team.ts`): Team is in
the navigation only for holders of `platform.user.manage`, and the pages refuse anyone else in
words. The team page lists the members the API returns for the chosen location (or all of the
manager's), each with their roles, their state and their latest invitation's state, each an icon
and a word (pending, accepted, expired, withdrawn). Invite someone asks for a full name, a work
address, a role and where it applies, offering only the roles and places the API says the manager
may give; the fields are checked with `CreateMember` from @harbour/contracts before sending, and
API refusals (`email_in_use`, `beyond_inviter` and the invitation refusals) are said in words at
the field. Sending adds the member (`POST /v1/members`, with the form's id) and then invites them;
the member's page says whether the email went. On a member's page, sending again is offered only
while the member is still invited, and withdrawing only for a pending invitation, each after a
confirmation sheet that says what happens to the link.

As built, the accept page (`apps/web/src/app/(auth)/invitation`, the route handlers
`app/api/invitations/lookup` and `/accept` (same origin and JSON only), `lib/invitation-server.ts`,
`lib/invitations.ts`):

- The page reads the token from the fragment, keeps it in the tab's session storage with the time
  (so it survives signing in first; dropped after 30 minutes, on sign-out, once accepted, once the
  link can never work, and on the create-sign-in path, which does not need it), replaces the
  address with `/invitation`, and sends it only in request bodies.
  `Referrer-Policy: no-referrer` and `noindex` on the page.
- It shows the organisation's name, the masked address and the expiry (UK time). The lookup does
  not name the inviter, so neither does the page. Then, by `path`: a form for a name and a
  password (the NCSC rules shown before typing; `passwordRuleBroken` in @harbour/domain, which the
  API's `passwordProblem` now words, so both say the same; show or hide that announces itself;
  errors at each field and in a summary that takes focus); or "sign in first" (`sign_in_first`,
  from the lookup or the accept's 409), returning to the page after signing in; or "accept" with
  the current sign-in. A new sign-in then signs in and lands on `/settings/security?reason=mfa`;
  an existing one goes there straight away. Focus moves to each view's heading; while sending, the
  button keeps focus and a polite status says "Sending". The organisation joined becomes the active one.
- Expired, withdrawn, used, already a member, another address, unknown, incomplete and throttled
  (429, the wait from Retry-After in minutes) links are each said in plain words with what to do.

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
- Approvals across modules (31/10/2026): `GET /v1/workflows` lists open workflow records in the
  reader's scope, soonest deadline first. `view=approvals` (the default) lists those waiting for the
  reader's approval and those the reader raised that wait for someone else's. `view=all` lists every
  open record the reader has a part in. Each item gives the state and the deadline state
  (`workflowSlaState`: overdue once the deadline has come, due today when later on the same UK day,
  on track, or none). It also gives who started it, the steps open to the reader
  (`workflowActorView`), the approval step marked (one the record's creator may not take), and
  whether the reader raised it so someone else must approve. The list is read only. Every step is
  still taken on the record's own route, which checks the module's rules and separation of duties
  again.
  - The listed workflows are in `LISTED_WORKFLOWS` (`packages/domain`): incident, candour,
    statutory notification, DoLS legal-change review, outage, discharge, transfer and death. The
    person lifecycle is a record's status, not work, so it is not listed.
  - An instance about nobody is listed only when its record is visible under row-level security, and
    an unknown subject type never is.
  - Any holder of a listed step's permission may read the list (MFA as for care records). Each
    permission counts for a record only when its own scope, without break-glass, both shows the
    record and reaches the record's home (`scopeReachesLocation`, as `managesAt` and
    `app.holds_permission_at` decide; ADR-0071). Visibility alone never decides, because an
    incident shows to its raiser anywhere. Managing an incident, or its candour record, also needs
    the incident seen whole (`managesIncident`). Each item returns the permissions that reach it,
    and the page offers steps from those alone. The incident review and close routes
    (`requireManagesIncident`) and the notification submit and not-required routes
    (`requireHeldAtLocation`) apply the same rule, and each refusal is audited.
  - Deadlines: a workflow may keep its deadline on the record, naming the states that carry one
    (`deadlineOnRecord`: a notification's draft and ready; candour's threshold, verbal due and
    written due). The module writes it onto the instance (`setWorkflowDeadline`,
    `syncCandourDeadline`) and the engine keeps it across moves. An instance in such a state
    without one reads `on_record`, a warning sorted first; any other state reads `none` (HZ-013).
    `pnpm --filter @harbour/api workflow-deadlines:backfill` fills instances started before the
    module wrote them. It is idempotent and is run once per environment after release.
  - The list filters by workflow and view state in SQL, reads instances in the union of the held
    permissions' scopes, and pages by keyset (missing deadline, deadline, id) until 300 visible
    records. `truncated` means only that more visible records were open, and the empty states say
    so. It leaves out removed records and is audited by view and count only. Each incident item
    carries what the page needs to offer closing (version, status, whether closing is held back),
    so the page reads no incident except the one just acted on.
  - Open (#130 review): L2, each module should own a resolver for "which of these subjects can the
    reader see", instead of this route querying module tables. L5, a holder of
    `safety.notification.submit` alone may be asked for a fresh sign-in just to read the list,
    because that permission needs step-up.
  - The web page `/approvals` ("Approvals" in the side bar for the same readers) groups the records:
    waiting for your approval, raised by you (said in words), and other open work. Each shows its
    state and deadline as an icon and words and links to its own page. An incident waiting for the
    reader can be closed or sent back to open there with the incident page's own forms, carrying the
    version the page read (HZ-013, HZ-091).
- API: `GET /v1/tasks` (views: all or mine; by person, location, status, window), `POST /v1/tasks`,
  `POST /v1/tasks/{id}/transition`, `POST /v1/tasks/{id}/assign`, `POST /v1/task-series`,
  `POST /v1/task-series/{id}/end`. Every list and change is audited.
- `GET /v1/tasks?earlier=yes` with open tasks returns the window's own tasks first, then open tasks
  due before `from`, however old, the most recent first, in the room left of 1,000; `truncated`
  says the window itself held more than 1,000 and `earlierOmitted` counts the older open tasks
  left out. `earlier` is recorded in the `platform.task.list` audit (HZ-003).
- Web (`/tasks`, Phase 1 slice 9): "Team tasks" (`view=all`, every task the session's scope
  reaches; shown first, because reviews go to a role rather than a person) and "My tasks"
  (`view=mine`) as two tabs, each by status (open or finished) and window (yesterday to tomorrow,
  or the last and next 7 days). The window's tasks and "Open from earlier" (open tasks due before
  the window, with how many older ones are not listed) are listed apart, so old open tasks never
  hide today's (HZ-003, HZ-008); each renders 20 at a time with "Show more" (its own address), so
  the page stays quick however many tasks are open; the list says when it was read. Each task shows its title, the person it is
  about by name (linked to their record, when the viewer may open people's records), the location,
  who it is assigned to, when it is due (dd/mm/yyyy, 24-hour, UK time) and where it stands as an
  icon and a word (upcoming, due, overdue, escalated, done, skipped, cancelled), with "Urgent" and
  "Review" flags in words, and the person's communication needs. A review task (one raised by the engine: a stale write, a late entry, an
  entry that did not complete its round; kind ending `_review`) shows its details with
  `TaskDetails` (missed rounds in UK time, medicines first; entries by kind, time and outcome) and
  late evidence, a catch-up or a restored round with `TaskEvidenceBadge` (HZ-003, HZ-004, HZ-006).
  "Reviews only" narrows either tab to them. Actions follow the API: Start, Mark as done, Not done
  (skip, with a reason) and Cancel (with a reason) for an open task; a task that needs evidence
  says to record it on the person's record (the API refuses completion without it). Holders of
  `platform.task.manage` also take or unassign a task and create one: a title, a due date and time
  (UK, 24-hour), urgent or routine, optionally assigned to themselves, once or repeating every day
  or every week (a task series). A stale version (`409`) says someone else changed the task and
  shows it again; no change is retried silently. Family portal sessions are not offered the page.
  Permission matrix: list, everyone in the organisation (row-level security narrows); move, the
  task's permission holder or assignee (API decides, refusals said in words); create, assign and
  schedule, `platform.task.manage`. Tests: `apps/web/src/lib/tasks.test.ts` (states, flags,
  windows, form reading), `apps/web/e2e/tasks.spec.ts` (HZ-006 review task details and late
  evidence; create, start, complete and skip with a reason; axe in light and dark).

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
- Web (Phase 1 slice 9): `/documents` lists the organisation's documents (policies, procedures;
  any member reads them) with the version, when stored, the file size, the status as an icon and a
  word (available, quarantined) and a legal hold flag; holders of `platform.document.manage`
  upload one (PDF, up to the category limit) through its own route handler,
  `/api/documents/upload` (the title and file name in percent-encoded headers, never the
  address, which reaches access logs), not a server action, so server actions keep Next's default body limit
  (ASVS L2 input limits): it takes posts from this site only (the origin configuration names, as
  the invitation routes check, never request headers), PDFs only, refuses a length over the API's
  document limit before reading and counts bytes again as it streams the body to the API with the
  person's session, and answers with the refusals the form already says and add a new version on its page. `/documents/{id}/details` (organisation documents only; any other category is
  not found there, and the tab title is a document's own only for an organisation document) shows
  the document's details, retention class, versions and signatures, and a signing form (typed full
  name, the statement, bound to the SHA-256 of the version shown, so a changed document is refused
  and the page says to read the new version). Downloads use `/documents/{id}` (audited by the
  API, never cached). Merge-field letter templates are linked from the page (`/letters`,
  COMMS-007). Documents about a person stay on the person's record. Permission matrix: read,
  everyone in the organisation (organisation documents); upload and new version,
  `platform.document.manage`; sign, anyone who may read it (the API decides). Tests:
  `apps/web/src/lib/documents.test.ts`, `apps/web/e2e/documents.spec.ts` (upload, sign, a new
  version starts unsigned and the earlier one is no longer offered for signing; axe in light and
  dark).

## Retention and legal hold (PLAT-012)

- Legal holds (`legal_hold`) on a person (every record about them) or one record; placing and
  releasing need `platform.retention.manage` with step-up, which only tenant-wide roles hold
  (owner, quality lead); RLS enforces the same.
- `GET /v1/retention/candidates`: documents past their class's period (care-record documents
  count from discharge or death; people still receiving care are never eligible) with no hold.
- `POST /v1/retention/destroy`: re-checks each id, deletes every stored version, keeps a tombstone
  row without the title, and writes an append-only `destruction_certificate` per record class
  (ids, rule, reason, method). Held, current or unknown ids are returned as skipped.
- `GET /v1/destruction-certificates` (`platform.retention.manage`, step-up): every certificate,
  newest first (audited as `platform.destruction_certificate.list`). Candidates also carry when the
  document was stored, and its title where the caller may read that category of document (a
  person's record needs its own read permissions; otherwise the page says the category alone);
  the listed ids are recorded in the audit.
- Web (`/settings/retention`, "Records retention", Phase 1 slice 9), for holders of
  `platform.retention.manage` (the data protection lead's tenant-wide roles). Every retention
  route needs a fresh step-up, so the page sends the person to confirm it is them first and comes
  back. Legal holds in force (who or what, why, since when) each with a release form (a reason of
  10 or more characters); placing a hold on a person (chosen by name) or on one record (type and
  id) with a reason; released holds with their reasons. Documents due for destruction (title,
  category, retention class, stored, due since): only what the API offers, which never includes
  anything under a legal hold or about someone still receiving care. Destroying is irreversible:
  the reviewer ticks each document, gives a reason, ticks a box saying they understand the files
  cannot be recovered, and confirms in a dialog that says so again in plain words; the page then
  says how many were destroyed, how many were skipped (a hold placed meanwhile, no longer due) and
  which certificates were issued. Destruction certificates list record class, count, reason,
  method and when. Permission matrix: every action, `platform.retention.manage` with step-up;
  everyone else is told they do not have access. Tests: `apps/web/src/lib/retention.test.ts`,
  `apps/web/e2e/retention.spec.ts` (a hold keeps a document off the list; release; destroy after
  confirming; the certificate is listed; refused for the manager; axe in light and dark).
- Later: retention of structured care records (not only documents) and crypto-shredding with
  per-tenant data keys.
- Later: the API's upload routes take the title and file name in the query string
  (`POST /v1/documents?title=`, ADR-0031), which reaches the API's access logs; move them to
  headers or a metadata part, as the web route already does.

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
  Flagsmith is used only when `FLAGSMITH_ENVIRONMENT_KEY` is set (H-13); in production its address
  must be https on the environment's own `flags.<domain>` host. It is told opaque ids only
  (organisation and location), and may set only the flags the catalogue marks `remote`
  (`remoteMaySet`, an explicit allowlist: today the workforce module and the public site; #39
  review M1): never an AI flag (only the organisation's own row turns AI on), a clinical or
  data-protection module (residential, home care, supported living, eMAR, the family portal,
  residents' money), a clinical tool, a review workflow or the language, so the clinical routes
  that read the rows directly (`flagsAt`, `flagRows`) agree with `/v1/me`. Its answers, and its
  silence, are kept for `FLAGSMITH_CACHE_SECONDS`; unreachable (`FLAGSMITH_TIMEOUT_MS`), every flag
  falls back to the catalogue and the API logs `flags.remote_unavailable` with no ids. A provider
  error answers the organisation's own rows, then the catalogue default (#39 review L1).
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

## Phase 2: data rights, imports and single sign-on (PLAT-022, PLAT-014, PLAT-005)

Phase 2 slice 9 ([phase-2.md](../plans/phase-2.md)): the rules only, as pure functions with
table-driven tests. Schema, API and screens follow in slices 15 (DSAR workbench, ADR-0090), 26
(import wizard, ADR-0092) and 33 (single sign-on, ADR-0091). Procedures:
[dsar-procedure.md](../compliance/dsar-procedure.md),
[breach-response.md](../compliance/breach-response.md),
[data-protection-complaints.md](../compliance/data-protection-complaints.md). Every period is a
rate-table row read through `resolveDataRightsRates` (`dsar.*`, `ico.breach.report_hours`,
`dp_complaint.*`, `import.undo_window_days`), never a literal. Code:
`packages/domain/src/platform/data-rights.ts`, `imports.ts`, `sso.ts`.

### Rules that are easy to get wrong

**Subject access requests** (`dsarClock`; UK GDPR Art 12 as amended by the Data (Use and Access)
Act 2025; ICO guidance on time limits):

1. The clock starts on the day the request is received (UK date), or, when identity information is
   needed, on the day it arrives: until then the request is `awaiting_identity` and has no due date.
   Received on a weekend or a bank holiday, it still starts that day.
2. The due date is the corresponding calendar date `dsar.response_months` later. A date that does
   not exist in that month (31 January plus one month) becomes the last day of the month (28 or 29
   February). Due on a Saturday, Sunday or bank holiday of the location's nation, it moves to the
   next working day.
3. While the controller waits for clarification the clock is paused: each whole UK day paused is
   added to the due date before the working-day roll in rule 2. A pause still open has no due date
   (`paused`); the request is never shown overdue while paused. Pauses may not overlap or start
   before the clock starts.
4. An extension of up to `dsar.extension_months` more (three months in total) is allowed only when
   the request is complex or the requester made several, with a reason, decided and told to the
   requester before the original due date (pauses included). A later extension is refused. The
   extended due date is the corresponding date counted from the clock's start, then pauses, then
   the working-day roll.
5. States: `awaiting_identity`, `running`, `paused`, `due_soon` (within `dsar.due_soon_days`,
   tenant default), `overdue`, `closed`. A response sent ends the clock; sent after the due date it
   is recorded as late, never rewritten as on time.

**Personal data breaches** (`breachClock`, `assessBreach`, `checkBreachDecision`; UK GDPR Arts
33 and 34):

6. The ICO clock runs `ico.breach.report_hours` from the moment the controller became aware (an
   instant, not a working-day count: weekends and nights count). A breach reported late must give
   the reasons for the delay (Art 33(1)).
7. Every breach is recorded, reportable or not (Art 33(5)). The assessment is decision support only:
   it suggests a severity from the factors in breach-response.md section 4 (special category or
   safeguarding data, the location of a person at risk, how many people, whether they can be
   identified, consequences, vulnerability, containment) and says what to consider. It never
   decides. The decision (report to the ICO or not; tell individuals or not) is a person's, with
   written reasoning of at least `BREACH_REASONING_MIN` characters; deciding not to report a breach
   suggested as medium or above, or not to tell individuals when the risk is suggested high, needs
   an explicit acknowledgement that the suggestion was considered.
8. A processor (Thapsus) notice to the controller is a separate record; the controller's clock
   starts from its own awareness, which may be the notice.

**Data protection complaints** (`complaintClock`; DPA 2018 as amended by DUAA 2025):

9. Acknowledgement is due `dp_complaint.acknowledge_days` calendar days after the day of receipt
   (the duty from 19 June 2026; complaints before that have no statutory clock). The tenant's target
   (`dp_complaint.acknowledge_target_working_days`, a working-day figure) is shown alongside, never
   instead.
10. While open, the complainant is updated at least every `dp_complaint.update_interval_months`
    (tenant default) from the last contact; the outcome letter always names the right to complain
    to the ICO.

**Imports** (`validateImportRows`, `dryRunReport`, `importUndoEligibility`; ADR-0092 in slice 26):

11. Every value is checked against [data-standards.md](data-standards.md): NHS numbers pass the
    modulus 11 check (spaces allowed, stored without); dates are dd/mm/yyyy, real, and a date of
    birth is not in the future; coded fields (sex, gender, allergy status, allergy severity) take
    only their listed codes; required fields are present; text fits its length. Errors are per row
    and column with a code and plain words, never the value itself (it may be personal data).
12. Two rows with the same NHS number in one file are both errors. `allergy_status` is never
    inferred: a blank status imports as `unknown` (HZ-007).
13. The dry run commits nothing and reports rows, valid rows and errors by code. A batch commits only
    when every row is valid (no partial import).
14. A batch may be undone only within `import.undo_window_days` of its commit, once, and only while
    none of its records has been changed or had records made about it since; otherwise undo is
    refused with the reason, and corrections are made record by record.

**Single sign-on** (`ssoSignInDecision`; ADR-0091 in slice 33):

15. SSO signs in only an existing, invited or active member of the tenant whose email domain the
    tenant has verified; it never creates a member, never links a different email, and never signs
    in a family member or an operator.
16. The tenant chooses which roles may use SSO; a member holding a role not on the list signs in
    with Harbour's own methods.
17. SSO is a first factor only: a session from SSO that reaches care records still needs Harbour's
    own second factor (passkey or authenticator), and step-up always needs it (section 5.3).

### Tests (written before the code)

- `packages/domain/src/platform/data-rights.test.ts`: `PLAT-022 the DSAR clock` (table: received on
  a weekday, a weekend, 31 January in a leap and a common year, due on a bank holiday, identity
  awaited, pauses open and closed, overlapping pauses refused, extension before and after the due
  date, without grounds, beyond three months, responded late); `PLAT-022 the breach clock and
  decision support` (72 hours across a weekend and the clock change; severity table; decisions
  without reasoning or acknowledgement refused; late report needs reasons); `PLAT-022 complaint
  clocks` (before and after 19 June 2026, the update interval, the outcome wording);
  `resolveDataRightsRates` (every key read from the table, missing ones fail loudly).
- `packages/domain/src/platform/imports.test.ts`: `PLAT-014 import validation` (table per field
  rule, duplicate NHS numbers, no value echoed in an error, blank allergy status as unknown, dry run
  counts, commit refused with errors, undo window, undo after changes refused).
- `packages/domain/src/platform/sso.test.ts`: `PLAT-005 SSO sign-in policy` (table: unverified
  domain, different email, not invited, family member, operator, role not allowed, allowed;
  second factor still required for care records and step-up).

### Breach register and data protection complaints (slice 20, PLAT-022)

Schema, API and audit for rules 6 to 10; the screens follow in slice 66. Migration 0082 (lane F;
renumbered at merge). Procedures: [breach-response.md](../compliance/breach-response.md),
[data-protection-complaints.md](../compliance/data-protection-complaints.md).

**Tables** (all with `tenant_id`, forced RLS, the tenant policy, no DELETE for the application):

| Table | Kind | What it holds |
| --- | --- | --- |
| `dp_breach` | mutable aggregate (`version`, `capture_version`) | One register entry per breach, reportable or not: what happened (no names), when the organisation became aware, its source (`tenant` or `processor_notice`), the factors and the suggested severity, the decision with reasoning, the ICO report (time, reference, reasons for delay), the notice to the people affected and when they were told, closure with lessons |
| `processor_breach_notice` | append-only | Thapsus's notice to the organisation as processor (Art 33(2); DPA clause 8.2): nature, categories and approximate numbers of people and records, likely consequences, measures, what the organisation needs to do, Thapsus contact. A later notice about the same breach follows the first (`follows_id`) |
| `processor_breach_notice_ack` | append-only | Who in the organisation acknowledged a notice, and when (one per notice) |
| `dp_complaint` | mutable aggregate | A data protection complaint: received on, channel, who complained (name and contact), the data subject when it is someone the organisation supports, what it is about, a summary, acknowledged on, last contact on, outcome, whether the outcome told them they can complain to the ICO, closed on, and a link to a breach |

**Rules**

18. Every breach is recorded (rule 7). Recording one needs `quality.dsar.manage` held across the
    whole organisation; so do reading and every change. The register is the organisation's data
    protection function, not a location's: someone who holds the permission for one home only (a
    Registered Manager or deputy) is refused by the API (403) and sees nothing through row-level
    security (`app.holds_role_permission_at(..., NULL)`; #149 security review). A location is
    recorded when there is one. Database refusals are said plainly: a check or guard (23514) is a
    422 with the guard's code, a missing reference (23503) a 422; logs carry codes, never values.
19. The ICO clock is `breachClock` over `aware_at` and `ico.breach.report_hours` from the rate table,
    worked out when read, never stored. `aware_at` may be corrected only until the ICO report is
    recorded; it may move later only before the decision, and never later than Thapsus's first
    notice for an entry Thapsus opened (Art 33(2)). Every change is in the record's history. The
    database pins the assessor, decider and closer to the person making the change, and keeps the
    creator and removal fixed (security review round 1).
20. The assessment stores the factors and `assessBreach`'s suggestion as decision support. The
    decision is refused unless `checkBreachDecision` passes against the stored suggestion (reasoning,
    the decider is the person recording it, acknowledgement when going against the suggestion). It
    is recorded once; a change of mind is a new decision with its own reasoning, kept in history.
21. Recording the ICO report needs a decision to report; a report after the deadline is refused
    without the reasons for the delay (Art 33(1)). The ICO's reference is kept as given.
22. The notice to the people affected is drafted from Harbour's plain-English template (what
    happened, what it means for them, what has been done, what they can do, who to contact), edited
    by a person, and recorded with the day they were told. It needs a decision to tell them.
23. A breach closes only once decided, with lessons of at least 20 characters; once closed nothing
    changes.
24. Thapsus records a processor notice from the operator console (an active admin with a fresh
    step-up) through `app.send_processor_breach_notice`, which in one transaction stores the notice,
    opens the organisation's register entry (`source = processor_notice`, `aware_at` the time of
    the notice; the organisation may correct it under rule 19 to its own awareness), and writes the
    organisation's audit event and an outbox event so its data protection lead and owners are told.
    A follow-up notice links to the same entry (a composite key ties it to the first notice's
    breach); a follow-up to a closed entry is refused, so new facts after closure come as a new
    first notice. The function restores the caller's tenant context. The organisation acknowledges
    each notice once.
25. A complaint's clocks are `complaintClock` with `dp_complaint.*` from the rate table and the
    location's nation's bank holidays (England when there is no location), worked out when read. It
    closes only through `checkComplaintClosure` (outcome recorded, the ICO right stated); once
    closed nothing changes. The acknowledgement and each contact are dates on or after receipt and
    not in the future.
26. Audit: every read of a list, a record or a notice draft and every change writes `audit_event`
    with ids and codes only, never the summary, names, contact details, reasoning or notice text.
    Lists return up to 1,000 entries and say `truncated` when there are more.
27. Linking a complaint to a person needs `people.person.read` too, and only someone in the
    recorder's scope can be linked (422 `person_not_found` otherwise).

**Permission matrix**

| Action | Permission | Notes |
| --- | --- | --- |
| Read the breach register, a breach, processor notices; record, assess, decide, report, tell, close a breach; acknowledge a notice | `quality.dsar.manage`, organisation-wide | RLS checks it again, binding `harbour_owner` too |
| Read, record, acknowledge, contact and close a complaint | `quality.dsar.manage`, organisation-wide | RLS checks it again |
| Send a processor breach notice | operator admin, fresh step-up | definer function, not a tenant permission |

Built-in roles holding `quality.dsar.manage` organisation-wide: owner and quality lead (a Registered
Manager or deputy holds it only for their home unless their assignment is organisation-wide, and is
refused here). Each of them already needs MFA through their care-record permissions, so the permission is not
itself marked as a care record; a custom role holding it alone would not force MFA (a decision for
slice 15, which also uses it). Row-level security counts the permission through roles
(`app.holds_role_permission_somewhere`), so a time-boxed grant of it alone reads an empty register:
grant it through a role.

**Retention**: interim `audit_event` (8 years from creation) for all four tables until the DPO sets
periods (H-670; retention.md already lists them as open).

**Tests**

- `packages/db/test/data-protection-registers.test.ts`: `hazard HZ-011` isolation (another
  organisation's breaches, notices, acknowledgements and complaints are invisible and cannot be
  written), the permission policies, append-only notices and acknowledgements, the check
  constraints (decision complete, report needs a decision, closure), and the definer function
  (admin only, opens the register entry, writes the audit and outbox events).
- `apps/api/test/data-protection-registers.test.ts`: the routes (permission refused, clock and
  suggestion returned, decision refusals from `checkBreachDecision`, late report without reasons
  refused, notice draft, closure rules, complaint clocks and closure, stale `version` refused,
  audit events without personal data, the operator notice and its acknowledgement).

## Permission matrix

Generated: [permissions.md](permissions.md).

## Retention classes

Audit events, record versions and break-glass records keep the `audit_event` class (see
[retention.md](retention.md)); deliveries and inbound data are operational and follow the class of
the record they relate to (retention engine, Phase 1). `device_binding`, `device_session` and
`handed_over_entry` keep the `audit_event` class; `request_quota` is operational (a row holds at most a day's hits and is overwritten in
place).
