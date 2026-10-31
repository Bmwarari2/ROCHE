# App store privacy answers (MOB-011)

What the Harbour mobile app (`apps/mobile`, bundle id `uk.co.thapsus.harbour`) collects and sends,
and the answers that follow from it for Apple's App Privacy section ("privacy nutrition label"),
Google Play's Data safety form and the two stores' health declarations. Master prompt section 17.3.

These answers describe **the code as it is on 31/10/2026** (Phase 1: Care mode, notes, charts,
body map, care plan reading, tasks and handover). They are derived from the code, not from intent:
`apps/mobile/src/config/store-compliance.test.ts` fails if the privacy manifest
(`apps/mobile/app.config.ts`) stops matching the table below. **Any change to that test, a new
permission, a new SDK or a new kind of data sent means updating this page and the store answers
before the next submission** (camera photos, location for visit verification, voice notes and
push notifications are all planned and each changes the answers: see "When the answers change").

The person entering the answers in App Store Connect and Play Console is a human action (H-560,
H-561).

## 1. What the app sends, and to whom

The app talks to two services only, both Harbour's own and in the UK (Google Cloud europe-west2, [ADR-0098](../decisions/0098-production-on-google-cloud.md)):

| Destination | What goes | Code |
| --- | --- | --- |
| Harbour API | Sign-in (email, password, TOTP code; Better Auth), `/v1/me`, care entries the member records (notes, chart readings, body map marks, activities, visits, task moves, handover acknowledgements), the device report (counts only), the account deletion request | `src/auth/`, `src/sync/connector.ts`, `src/sync/care-upload.ts`, `src/sync/round-upload.ts`, `src/sync/device-report.ts`, `src/platform/account-deletion.ts` |
| Harbour's self-hosted PowerSync service | Downloads of the people the member is assigned to and their records; uploads go through the API above | `src/sync/connector.ts` |

Requests carry the member's session token and the organisation id (`x-harbour-tenant`). Sync,
upload and device-report requests also carry the app's own per-install device id
(`x-harbour-device`), a random id made by the app and kept in the keychain or keystore. It is not the advertising identifier, the vendor identifier or a hardware id.

**Not in the app** (checked against `apps/mobile/package.json` on 31/10/2026): no analytics or
advertising SDK, no crash reporter (Sentry is server-side only, H-12), no push service (notifications
are local, for held entries, HZ-040), no EAS Update (`expo-updates` is not installed), no third-party
AI. Nothing is backed up to iCloud or Google backup: care data is in an SQLCipher database in the
app's container, Android backup is off (`allowBackup: false`) and the key is in the keychain with
`WHEN_PASSCODE_SET_THIS_DEVICE_ONLY`.

**Not collected yet**: photos or video (the app shows a person's photo; it never takes or uploads
one), location, audio, contacts, files, browsing history, purchases, financial information.

## 2. Apple: App Privacy ("nutrition label")

Apple asks about data **collected from the app's users**. Harbour's users are care staff. What they
record about the people they care for is health information and is declared as Health. Every type is
**linked to the user** (it travels with their account) and **not used for tracking**. The only purpose
is **App Functionality**.

| Apple data type | Collected | Linked | Tracking | Purpose | Why |
| --- | --- | --- | --- | --- | --- |
| Contact info: Name | Yes | Yes | No | App Functionality | The member's name, shown on their entries and the identity bar |
| Contact info: Email Address | Yes | Yes | No | App Functionality | Sign-in |
| Health & Fitness: Health | Yes | Yes | No | App Functionality | Care notes, charts (including vital signs and NEWS2), body map marks recorded by staff |
| Identifiers: User ID | Yes | Yes | No | App Functionality | The account id sent with every request and entry |
| Identifiers: Device ID | Yes | Yes | No | App Functionality | The app's own per-install id, for remote wipe and device reports |
| Diagnostics: Other Diagnostic Data | Yes | Yes | No | App Functionality | The device report: counts of unsent, refused and held entries and the oldest one's age |
| Location, Photos or Videos, Audio, Contacts, Browsing, Purchases, Financial, Sensitive Info, Usage Data, Crash Data, Performance Data | No | | | | See section 1 |

"Data used to track you": **none**. The privacy manifest says `NSPrivacyTracking: false` with no
tracking domains. The required-reason APIs (UserDefaults CA92.1, file timestamps C617.1, system boot
time 35F9.1, disk space E174.1) are declared in the same manifest.

Privacy policy URL: Thapsus's app privacy notice (H-562). The care provider is the controller of the
care records; Thapsus is its processor (section 5.1). The notice says so, and says that staff accounts
are managed by their employer.

## 3. Google Play: Data safety form

| Question | Answer |
| --- | --- |
| Does your app collect or share any of the required user data types? | Yes (collects; does not share) |
| Is all of the user data collected by your app encrypted in transit? | Yes (TLS 1.2+; release builds refuse plain http: `src/config/env.ts`) |
| Do you provide a way for users to request that their data is deleted? | Yes: in the app (Settings, "Delete my account") and on the web (H-564) |
| Personal info: Name | Collected, not shared, required, App functionality |
| Personal info: Email address | Collected, not shared, required, App functionality, Account management |
| Personal info: User IDs | Collected, not shared, required, App functionality, Account management |
| Health and fitness: Health info | Collected, not shared, required, App functionality |
| App info and performance: Other app performance data | Collected (the device report counts), not shared, required, App functionality |
| Device or other IDs | Collected (the app's own install id), not shared, required, App functionality, Fraud prevention, security and compliance |
| Location, Photos and videos, Audio, Files and docs, Calendar, Contacts, App activity, Web browsing, Messages, Financial info | Not collected |
| Is data processed ephemerally? | No: records are kept by the care provider |

"Shared" in Google's sense excludes service providers acting for Harbour (Google Cloud hosting, Harbour's own
PowerSync), so nothing is shared.

## 4. Health declarations

- **Google Play Health apps declaration**: the app is a care record and care management app for
  health and social care professionals (not consumers); it is **not a medical device** and makes no
  diagnosis, prognosis or treatment recommendation (docs/compliance/medical-device-boundary.md); it
  does not use Health Connect. Category: medical / health record management. The listing carries the
  sentence "Harbour is not a medical device", as the About section in the app does.
- **Apple**: category Medical; App Review notes say the app is for registered care providers' staff,
  accounts are created by the care provider, and a demo account is supplied for review (H-565). No
  HealthKit, no CareKit, no regulated medical device claim. Health data is never written to iCloud.
- Both stores: no AI feature is in the mobile app. Before any data reaches an AI provider the app
  must disclose it and ask (master prompt 17.3); that changes these answers.

## 5. Account deletion

Apple guideline 5.1.1(v) and Google Play's account deletion policy require an in-app way to start
deleting an account. A Harbour staff account belongs to the care provider that created it, and the
records written with it are the provider's care records (retained under the retention schedule,
docs/specs/retention.md). So:

1. **In the app**: Settings, "Delete my account", explains that the organisation manages the account
   and keeps care records as the law requires, then sends `POST /v1/me/account-deletion-request`.
2. The API raises one task for the organisation's Registered Manager (else whoever holds
   `platform.user.manage`), never the person asking, due within `account_deletion.confirmation_days`
   (30, rate table), notifies them, and audits the request. A second request while one is open
   returns the first.
3. The manager decides with the member and the data protection lead and ends the account's access:
   today by revoking its sessions (`POST /v1/members/{tenantUserId}/sessions/revoke`, which signs
   them out of every device); suspending or removing a member and erasing the sign-in identity has no route
   yet (a gap, H-566). **Nothing is deleted by the request itself, and care records are never deleted
   this way.**
4. **On the web** (Google requires a link usable without the app): a public page explaining the same
   route and the provider's contact process (H-564).

Code and tests: `apps/api/src/services/account-deletion.ts`, `apps/api/test/account-deletion.test.ts`,
`apps/mobile/src/platform/account-deletion.ts` and its test.

## 6. SDK targets

| Store rule | How the app meets it | Checked by |
| --- | --- | --- |
| Google Play: target API 36 (Android 16) for submissions from 31/08/2026 | React Native 0.86 sets `targetSdk` and `compileSdk` 36 (min 24) | `store-compliance.test.ts` reads React Native's `gradle/libs.versions.toml` |
| Apple: Xcode 26 and the iOS 26 SDK for submissions from 28/04/2026 | The `production` EAS profile builds on the `latest` image, which carries Xcode 26; pin the named Xcode 26 image once confirmed in the EAS console (H-563) | `store-compliance.test.ts` reads `eas.json` |

## 7. When the answers change

| Planned feature | Changes |
| --- | --- |
| Camera photos (person photo, wound photos), medicine barcode scanning | Apple: Photos or Videos (App Functionality, linked); Google: Photos (collected). Unblock `CAMERA` |
| Visit verification by location (domiciliary, foreground only) | Apple: Precise Location; Google: Approximate and precise location, with the prominent disclosure. No background location in v1 |
| Voice notes | Apple: Audio Data; Google: Voice or sound recordings |
| Push notifications | Push token as an identifier; a push provider becomes a sub-processor (docs/compliance/sub-processors.md) |
| Crash reporting in the app | Apple: Crash Data; Google: Crash logs; the provider joins the sub-processor register and DPIA |
| Family mode (relatives) | Users who are not staff: the label and the deletion route change for them (a relative's account is theirs) |
