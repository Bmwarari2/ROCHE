# Mobile store compliance and distribution (MOB-011, MOB-012)

Branch `feat/mobile-store-compliance`.

## What changed

- API: `POST /v1/me/account-deletion-request` (any member, their own account). The account
  belongs to the care provider, so the request becomes one task for a Registered Manager (else a
  holder of `platform.user.manage`, never the person asking), due within
  `account_deletion.confirmation_days` (30, rate table), with a notification that names no one and
  an audit event. A second request while one is open returns the first. Nothing is deleted by it,
  and care records never are. No migration.
- Mobile: Settings has "Delete my account", which explains that the organisation manages the
  account and keeps care records as the law requires, asks for confirmation, sends the request and
  says each outcome in words (sent with the date to confirm by, already asked, no connection,
  session ended, refused, demo mode). New words are in the mobile catalogue; Welsh copied and
  listed as untranslated.
- Mobile config: the privacy manifest now declares exactly what the app collects (name, email,
  health, user id, the app's own device id, and the device report's counts as other diagnostic
  data), all linked, none for tracking; store builds use an EAS image with Xcode 26 (`latest`,
  to pin by name: H-563); Android targets API 36 through React Native 0.86. A test checks all three.
- Docs: [app-store-privacy.md](../compliance/app-store-privacy.md) (what the app sends, Apple's
  App Privacy answers, Google's Data safety answers, health declarations, the deletion route, SDK
  targets, and what changes the answers); [mobile-release.md](../runbooks/mobile-release.md)
  (public or private distribution, the irreversible choice, phased rollout 10%, 50%, 100% with the
  99.5% crash-free gate, halting a release); records of processing and data standards for the
  deletion request; human actions H-560 to H-569; the register's MOB-011 and MOB-012 paths.

## Clinical safety and data protection

- Not clinical: no hazard is affected (the request deletes nothing, on the device or the server).
- Personal data: the deletion request is recorded as a task with opaque ids; records of processing
  (staff user account row) and data standards updated; no new field, sub-processor or transfer.

## What is next

- A route for a manager to suspend or remove a member and erase their sign-in (H-566).
- The public account deletion web page (H-564); a per-tenant app id for private builds
  (`HARBOUR_APP_ID`, mobile-release.md section 1).

## Human actions logged

- H-560 to H-569.

## Review rounds

- Round 1 (security and accessibility reviewers): one request at a time per member (an advisory
  lock, so a double tap raises one task; a partial unique index would need a migration and is left
  for the lead); at most `ACCOUNT_DELETION_REQUESTS_PER_DAY` (3) requests a member a day, so
  managers cannot be flooded; the task no longer claims a Registered Manager when the fallback is
  someone else; the privacy page says which requests carry the device id. Each alert's title now
  matches what happened (sent, already asked, kept but not yet seen, demo mode not sent, not sent);
  a busy server is no longer called "no connection"; "your organisation" when the name is not
  known; the section is headed "Account deletion" and says the manager decides. A Maestro flow
  (`account-deletion-request.yaml`) covers the path in demo mode; it was not run here (no
  emulator), so CI's run is its first.

## Tests

- `apps/api/test/account-deletion.test.ts` (6), `apps/api/test/route-gates.test.ts` (the new route
  listed as reviewed), `apps/mobile/src/platform/account-deletion.test.ts` (18), `apps/mobile/.maestro/account-deletion-request.yaml` (not run locally),
  `apps/mobile/src/config/store-compliance.test.ts` (5).
