# User guides: Care mode on the phone (MOB-001, MOB-002, MOB-005, MOB-006, MOB-009, MOB-010)

Branch `docs/guides-mobile-care-mode`, from `main` at ea6fc04d.

## What changed

- 19 new guides for the phone's Care mode, each one task, written from the screens under
  `apps/mobile/src/app` and the components they use. Labels in bold are copied from
  `packages/i18n/src/messages/mobile.en-GB.json` (and `en-GB.json` for **Save**, **Cancel** and the
  web security page), checked with a script; hard-coded strings are quoted, not bold (listed below).
- **Care worker (17)**: sign in on the phone; lock and unlock; use a shared phone or tablet; see your
  people for the shift (Today, People, what is offline and how fresh); check the person before you
  give care; write a daily note; record a chart entry; record vital signs and read NEWS2; mark the
  body map; correct an entry; do a round; read and acknowledge the handover; read the sync banner;
  deal with an entry that was not saved; send unsent entries after signing in again; sign out; keep
  the phone safe for care records (screenshots, rooted or jailbroken phones).
- **All staff (1)**: handle a lost or stolen phone (tell the person in charge, then sign the phone
  out from the web's **Where you are signed in**).
- **Registered Manager (1)**: send or delete another person's unsent entries on a phone (the held
  entries hand-over and deletion on the sign-in screen).
- Each phone guide links its web guide. The web guides for notes, charts, vital signs, the body map,
  the round, the handover and checking the person now link the phone version; the handover guide no
  longer says it is "on the web only", and the note guide no longer says writing with no signal is
  still being built.
- The role indexes (care worker, senior carer, nurse, Registered Manager, owner, HR lead, data
  protection lead, all staff), the user guides README table (new MOB-001, 002, 005, 006, 009 and 010
  rows; phone guides added to CARE-007, 009, 010, 012, 013, COMMS-006, PEOP-001 and 002) and the
  register's user docs column link every new guide. The README's "no guide yet" line now names the
  MOB rows still without one.
- Safety-critical behaviour is said in each guide's Important section, with the hazard ids: what
  "waiting to upload" and "not saved: needs attention" mean (HZ-006), never signing out, resetting or
  deleting the app with entries waiting (HZ-006, HZ-040), checking the photo and allergies (HZ-001,
  HZ-007), stale data and the banner (HZ-002), the phone's history not being the whole record
  (HZ-028), the round and the handover on the phone (HZ-018, HZ-029), the body map side (HZ-019), a
  rooted or jailbroken phone, and reporting a lost phone at once.

## No screen yet, so no guide (or only part)

- **MOB-005 kiosk mode**: only the shared-device lock exists ("Shared with colleagues" and "Lock a
  shared device after" in Settings). There is no personal PIN with the user's photo, no fast user
  switching, no automatic sign-out at shift end and no manager or MDM set-up (ADR-0025,
  `docs/compliance/kiosk.md`). So there is no `registered-manager/` kiosk set-up guide.
- **MOB-006**: no incident form on the phone (the body map guide points to the web); no conflict
  review screen (a task or handover changed first shows only under "Not saved: needs attention");
  no activity or visit form, though those tables sync and appear in the needs-attention list; no
  photo on a body map mark.
- **MOB-010**: root and jailbreak detection is a stub that always answers "unknown"
  (`apps/mobile/src/security/device-integrity.ts`), so the "may be rooted or jailbroken" warning
  never shows. A manager cannot list or withdraw a device on the web: `GET /v1/devices` and
  `POST /v1/devices/{deviceId}/revoke` have no screen. The lost-phone guide uses the person's own
  **Sign out of this device** on the web instead.
- **MOB-001**: the phone signs in with email, password and an authenticator code only; no passkey.
- MOB-003 Manage mode and MOB-004 Family mode (the mode screen says "Coming in a later release"),
  MOB-008, MOB-012 and MOB-013 have no guide. MOB-011's "Ask to delete my account" in Settings is a
  real screen but was outside this pass.

## Hard-coded strings the guides quote

Not in the catalogue, so quoted rather than bold:

- Sign-in (`app/sign-in.tsx`, `auth/auth-client.ts`): "Sign in to Thapsus Care", "Email address",
  "Password", "Sign in", "Authenticator code", "Continue", "Start again", the two help lines and the
  sign-in error messages.
- Mode choice (`app/mode.tsx`): "Choose how you will use Thapsus Care", "Care", "Manage", "Family"
  and their descriptions.
- Lock (`components/LockScreen.tsx`, `security/biometric.ts`): "Thapsus Care is locked", "Signed in
  as ...", "Unlock", "Unlocking", the unlock failure messages, the screen-lock message, and the
  system prompts "Unlock Thapsus Care", "Cancel" and "Use passcode".
- Settings (`app/(care)/settings.tsx`): "Account", "Change mode", the "Sync" section with "Download
  all data again" and its alert, "Security", "Thapsus Care locks after ... without use.", "This
  device is", "My own device", "Shared with colleagues", "Lock a shared device after", "Lock now",
  "Display", "High contrast", "Appearance", "About", "Local database:", "Encrypted (SQLCipher,
  AES-256)", "Device check:" and "Selected". The timeout words come from
  `security/auto-lock.ts` ("30 seconds" to "2 minutes").
- Vault notices (`app-state/vault.tsx`): the remote sign-out notice, the reset notice, the "changes
  have not uploaded yet" refusal of "Download all data again", and "Dismiss" (`components/Screen.tsx`).
- People tab (`app/(care)/people/index.tsx`): "1 person" or "12 people", "No people on this device
  yet", its empty text and its read error; `PersonListItem`'s hint "Opens this person's record".
- The sync banner (`packages/ui-native/src/logic/sync-banner.ts`, `time.ts`): "Offline",
  "Syncing", "Up to date", "Sync failed", "Not all saved", "This phone cannot sync" and its reason,
  "Retry", "Last synced ...", the queued and refused counts, and both stale-data warnings.
- The point-of-care header (`packages/ui-native/src/logic/person.ts`, `PersonHeader.tsx`): "Allergies
  (2)", "No known allergies", "Allergies not recorded", "Allergies (details not on device)", "Born
  ...", "NHS number ...", the communication needs chip.
- `@harbour/domain`: body area names, pressure ulcer categories, Bristol stool descriptions and
  IDDSI level names; the stub's "Device integrity checks are not available in this version."

## Found on screen, not fixed here (for the builders)

- **Shared devices unlock with the device's own biometrics or passcode** (ADR-0025 says biometrics
  are not accepted as the user factor on shared devices). Anyone who can unlock the tablet opens the
  signed-in person's session. The device mode is a per-device choice any signed-in user can change,
  not a tenant or MDM setting (`docs/compliance/kiosk.md` section 2).
- **Handing a shared device to the next person while offline deletes the first person's unsent
  entries**: sign-out is the only way to switch user, and with entries waiting it offers only "Sign
  out and delete" (with a reason and device authentication). There is no way to keep them for their
  owner, as there is when a session ends (HZ-006, HZ-040).
- **Sign out on the lock screen** is a path past the lock that deletes unsent work, guarded only by
  a coded reason and device authentication; after a cold start it cannot count the entries and
  offers "Sign out and delete any unsent entries" (HZ-040).
- **On a phone in portrait, a round task card has no photo or allergies and no way to open the
  person's record** unless the task asks for evidence ("Show record" is tablet only). A carer can
  mark **Done** without the point-of-care header in sight (HZ-001). The guide tells them to check the
  person first.
- **When the phone's keystore key is invalidated** (screen lock or biometrics changed), the vault
  makes a new key and deletes the old database file, which appears to delete unsent entries too; the
  notice says only that the data "was reset" and "will download again" (HZ-006). The safety guide
  warns staff to send everything first.
- Saving a note, chart entry or mark gives no visible confirmation: **Saved on this device. It
  uploads when you are online.** is only announced to screen readers. The guides point to the
  entry's **Waiting to upload** chip.
- Removing one refused entry asks the system prompt "Confirm it is you to delete unsent entries".
- The round says **Later** where the web round says "Still to come".
- The Settings "Sync" heading and "Selected" are hard-coded though `mobile.sync.title` and
  `mobile.common.selected` exist; the People tab's empty text differs from Today's catalogue text;
  `mobile.today.yourPeople` is unused; `PersonListItem` hard-codes its hint beside
  `mobile.today.openHint`.
- Today shows the people and sync only: tasks, alerts and the handover are not on it (the screen's
  own comment says they join later).

## What is next

- Write the kiosk, incident, conflict review, device withdrawal and activity or visit guides with
  their screens; MOB-011's account deletion request.
