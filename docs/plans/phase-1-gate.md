# Phase 1 gate: gap report

The state of each Phase 1 gate item ([phase-1.md](phase-1.md), master prompt section 19), with
evidence, taken on `main` at `5b3d238` (16 October 2026; the CI run on that commit, 38932679711,
is green in every job, Playwright and axe included). Mobile is paused by the owner, so the Maestro
item and the mobile rows are recorded but not worked. This report is the gate record's first draft:
each item says what is met, what is missing, and whether the gap is small (fixed in a follow-up pull
request of about 600 lines) or a gate item (needs its own slice).

## Summary

| Gate item | State | Gap |
| --- | --- | --- |
| Maestro offline journey (iOS and Android) | Not met | Android: a CI job that syncs against a seeded API and PowerSync is written (31/10/2026), not yet run (H-398); its sync step passed locally. iOS: no job (section 1 lists what one needs) |
| Inspector pack export renders | Met, without a snapshot | Small: a render test of the PDF on its own, beside the API test |
| WCAG scans clean | Met for every web route but two | Small: the person's history tab; gate item: choose-organisation needs a second demo tenant |
| Every hazard-log entry has a test | Met: 45 of 45 | Small: five verification statuses are stale; one planned test waits for the task screens |
| Clinical safety case v0.1 drafted | Not met | Gate item: only v0.0 (Phase 0) exists |
| Every Phase 1 register row `done` (section 19, definition of done) | Not met: 0 of 54 | Gate items: user guides for every row; web screens for 22 rows; 4 rows `todo` |
| Data-protection documents current | Mostly | Gate item: the DPIA template has no Phase 1 risks; small: data-standards coverage |

## 1. Maestro offline journey

Worked on 31/10/2026 (`feat/mobile-gate`), after mobile was unpaused. **Still not met**: the CI jobs
are written but have not run.

- `.github/workflows/mobile.yml` had built a debug APK in demo mode. A debug build of this app is an
  Expo development client, which waits for Metro, and demo mode never syncs, so the offline flows
  could not pass. It now has two jobs, both on release builds with the JavaScript bundled:
  `maestro-android-demo` (sign-in and the demo round, no API) and `maestro-android-live`.
- `maestro-android-live` runs Postgres and PowerSync from `docker-compose.yml`, seeds the demo
  tenant, starts the API, and runs `apps/mobile/scripts/sync-smoke.mjs`: the carer's sync token,
  the streams and PowerSync must deliver Ada Example and a round task created moments before. This
  step passed locally against the same stack (Docker, PowerSync 1.26.1, the built API). The
  emulator then runs a build that syncs over the phone's loopback (`adb reverse`, ports 4000 and
  8080; `EXPO_PUBLIC_E2E_LOOPBACK`, which allows http to `localhost` only), the flows tagged
  `smoke` and `offline` (people list, sync recovery, the HZ-006 note and vital signs, the HZ-028
  round), and Postgres is checked for the task the round flow marked done offline.
- Not verified: the Gradle release build, the emulator, the biometric prompt answering and every
  Maestro flow. The sandbox had no Android SDK or KVM. Human action H-398 runs the workflow.
- Not yet covered by any flow: charts beyond vital signs, and the conflict review.

**What an iOS job still needs**

1. A `macos-15` runner job: `pnpm install`, `npx expo prebuild --platform ios`, `pod install`, and a
   Release build for the simulator (`xcodebuild -workspace ios/Harbour.xcworkspace -scheme Harbour
   -configuration Release -sdk iphonesimulator -derivedDataPath build`), so no development client
   or Metro is involved. op-sqlite reads its SQLCipher switch from the repository root
   `package.json` on iOS, which must carry `"op-sqlite": { "sqlcipher": true }`; check that the
   built app reports SQLCipher before the flows run.
2. The backend on the macOS runner: Docker is not installed on GitHub's macOS runners, so either
   run Postgres and the API natively (Homebrew `postgresql@17` with `wal_level = logical`) and
   PowerSync from its npm package, or point the simulator at the Linux job's stack through a
   tunnel. The simulator shares the Mac's loopback, so `localhost` needs no `adb reverse`, and the
   cleartext switch becomes an App Transport Security exception for `localhost` in the e2e build
   only (an `app.config.ts` `ios.infoPlist` entry behind `HARBOUR_E2E_BUILD`, which does not exist
   yet).
3. Face ID in the simulator: enrol with `xcrun simctl spawn booted notifyutil -s
   com.apple.BiometricKit.enrollmentChanged 1` and `notifyutil -p
   com.apple.BiometricKit.enrollmentChanged`, and answer prompts with `notifyutil -p
   com.apple.BiometricKit_Sim.pearl.match` in a background loop; the device passcode check needs a
   simulator passcode, which `simctl` cannot set, so check how `expo-local-authentication` behaves
   there first.
4. Going offline: Maestro's `setAirplaneMode` is Android only. On a simulator, stop the API and
   PowerSync (or block their ports with `pfctl`) from a step between flows, so each offline flow
   is split into an online part, a network-off step outside Maestro and an offline part; or run the
   offline flows on a device farm with network control.
5. Minutes: macOS runners cost ten times Linux minutes; keep the job on demand and on release
   candidates.

## 2. Inspector pack export renders

- `apps/api/test/evidence-link.test.ts`: `hazard HZ-050 the rendered pack is watermarked and holds
  no third party's name` opens a released pack through the recipient link and checks the PDF's text:
  the watermark line, an included record, withheld free text, the release time in UK time and no
  third party's name.
- `apps/api/test/evidence-packs.test.ts` (composing, minimising, release, revocation, sweep),
  `packages/domain/src/quality/evidence-pack.test.ts`, `packages/db/test/evidence-pack.test.ts`.
- **Gap (small)**: the gate asks for snapshot and PDF render tests. The only render test goes
  through the API and database. A unit test of `renderEvidencePackPdf` on a fixed manifest
  (the watermark on every page, page count, a withheld field, a long record that wraps onto a second
  page) makes the render itself a fast, stable check. Follow-up pull request.

## 3. WCAG scans clean

Every page under `apps/web/src/app` against the Playwright specs in `apps/web/e2e` (each of the 23
specs calls `expectAccessible`, which fails on any serious or critical axe result). Reached by
`goto` or by following a link in the journey:

| Route | Spec |
| --- | --- |
| `/`, `/notifications`, `/people`, `/people/[id]` | `smoke`, `care-record`, `round` and others |
| Person tabs: activities, advance care, assessments, body map, care plan and a plan version, charts, notes, risk assessments | `care-record`, `back-entry` |
| Person tabs: capacity, DoLS and a record's history page | `capacity` |
| Person tabs: family updates, letters | `family-updates`, `letters` |
| `/round`, `/round/[locationId]` | `round` |
| `/handover`, `/handover/[locationId]`, a handover | `handover` |
| `/incidents`, `/incidents/new`, `/incidents/[id]` | `incidents`, `incident-forms`, `incident-review` |
| `/notifications/statutory`, `/notifications/statutory/[id]` | `statutory-notifications`, `incident-review` |
| `/downtime` and its location, pack and outage pages | `downtime` |
| `/letters`, `/letters/new`, `/letters/[id]` | `letter-templates` |
| `/search` | `search`, `break-glass-search` (on #99) |
| `/updates` | `family-feed` |
| `/settings/security`, `/settings/team` and a member, `/settings/export`, `/settings/onboarding`, `/settings/data-protection` | `security`, `team`, `export`, `onboarding`, `dpia` |
| `/sign-in`, `/invitation` | `smoke`, `security`, `invitation` |

Storybook: `packages/ui/src/test/stories.a11y.test.tsx` runs axe on every story in the unit test
job, and `build-storybook` runs in CI.

- **Gap (small)**: `/people/[id]/history` (the history tab: earlier versions of the person's
  details and the way into each record's history) has no journey. Follow-up pull request.
- **Gate item**: `/choose-organisation` is shown only to someone in more than one organisation, and
  the demo seed has one. A journey needs a second demo tenant with a shared user in the e2e seed.
- Not part of this gate, but a section 7 quality gate: Lighthouse CI is not in `ci.yml`.

## 4. Every hazard-log entry has a test

Method: every `HZ-0nn` and `HZ-1nn` heading in
[hazard-log.md](../clinical-safety/hazard-log.md) against test and spec files under `apps` and
`packages` that name it (the gate's `grep -rn "HZ-0" apps packages`), then each hazard's
verification rows read for their status and for test files that do not exist.

- **45 hazards, 45 with at least one automated test that names them**: HZ-001 to HZ-029, HZ-040,
  HZ-050, HZ-051, HZ-060, HZ-061, HZ-070 to HZ-073, HZ-080, HZ-090 to HZ-092 and HZ-110 to HZ-112.
  The gaps in the numbering (HZ-030 to HZ-039, HZ-041 to HZ-049, HZ-052 to HZ-059, HZ-062 to
  HZ-069) are reserved blocks, as the log says; no hazard was removed.
- Thinnest coverage, worth a look at the CSO review rather than a gap: HZ-072 (one domain test),
  HZ-080 and HZ-110 (one API test each), HZ-025 (two tests).
- **Gap (small), stale statuses**: the web journeys run on every pull request and on `main`, but
  five verification rows still read "Written" or "Hosted CI": HZ-017 and HZ-092
  (`apps/web/e2e/downtime.spec.ts`), HZ-090 (`incident-forms.spec.ts`), HZ-091
  (`incident-review.spec.ts`) and HZ-013 (the same spec). Follow-up pull request: mark them
  "Passing" with the CI run.
- **Planned test with no file**: HZ-006's design row for review-task details names
  `apps/web/e2e/tasks.spec.ts` (planned). The `TaskDetails` and `TaskEvidenceBadge` components are
  built and unit-tested, but no screen shows them. **Gate item**: it comes with the web task views
  (PLAT-011, CARE-013).
- HZ-001 and HZ-006 also name the Maestro flow, "Written; not run in CI" (mobile, paused).

## 5. Clinical safety case v0.1

`docs/clinical-safety/safety-case/` holds `README.md` and `safety-case-v0.0-phase0.md` only.
**Gate item**: draft v0.1 for Phase 1. It needs:
- the Phase 1 scope;
- the 45 hazards with their controls and test evidence (sections 4 and 2 above);
- the medical-device boundary statement for the validated tools (Waterlow, Braden, MUST, NEWS2,
  NG249 falls);
- residual risks;
- the open human actions (CSO review, H-21 and H-24; Waterlow licence, H-25).

It is a document of its own and should not be squeezed into a fix pull request.

## 6. Feature register: Phase 1 rows against the definition of done

There are 54 Phase 1 rows: 50 `partial`, 4 `todo`, none `done`. Every `partial` row links a spec,
code and tests. The definition of done (section 19) also asks for a user guide, a Playwright or
Maestro journey, offline behaviour where section 17 needs it, audit, a retention class, permissions,
hazard review and a data-protection check. What each row lacks:

**Every row: user documentation.** The user-docs column is `-` on all 54, and there is no
`docs/user-guides/` (nor `docs/demo/` for the end-of-phase walkthrough). **Gate item**: a user guide
per role (care worker, nurse, Registered Manager, data protection lead, family member) covering the
Phase 1 screens, then each row links its section.

Audit, retention class and permissions are in place for every built row. Every Phase 1 table is
classified in the export catalogue, with its retention class (`packages/db/src/export-catalogue.test.ts`
fails otherwise), and every route checks a `module.resource.action` permission
(`apps/api/test/route-gates.test.ts`). They are not listed per row below.

| Row | Feature | Missing for done (besides the user guide) |
| --- | --- | --- |
| PLAT-002 | White-label branding | `todo`: spec, code, tests (slice 9) |
| PLAT-006 | Break-glass and weekly report | Web: the weekly report screen; the register's tests column omits `apps/web/e2e/break-glass.spec.ts` |
| PLAT-009 | Document store | Web: document list, upload and signing screens, and their journey |
| PLAT-011 | Task and workflow engine | Web: task views (and HZ-006's planned `tasks.spec.ts`) |
| PLAT-012 | Retention and legal hold | Web: holds, destruction candidates and certificates |
| PLAT-013 | Search | Offline search on mobile (paused); break-glass search in review (#99) |
| PLAT-015 | Full export | None beyond the user guide |
| PLAT-018 | Help and onboarding | Welsh keys and English reasons are open before a pilot (register note) |
| PLAT-023 | DPIA and registers | The typed name is not checked against the account (register note); the DPIA template's Phase 1 risks (section 7) |
| PEOP-001 | Person record | Web: editing demographics, contacts and representatives; the register lists no journey |
| PEOP-002 | Communication needs | Register lists no journey (the needs show on round, incidents and search journeys: add them) |
| PEOP-003 | About Me | Web: authoring and share links |
| PEOP-005 | Pre-admission | Web: the assessment and decision |
| PEOP-007 | Admission, rooms, property | Web: admission, room moves, property inventory, welcome checklist |
| PEOP-008 | Review scheduling | Web: the review list and recording a review |
| PEOP-009 | Hospital transfer pack | Web: generating and printing the pack |
| PEOP-010 | Discharge, transfer, death | Web: the exit workflows and the read-only archive state |
| PEOP-013 | Sharing rules | Web: managing sharing decisions (the feed honours them; no screen records them) |
| CARE-001 to CARE-003, CARE-007, CARE-009, CARE-010, CARE-012, CARE-014, CARE-015 | Care record | None beyond the user guide; offline parts with mobile |
| CARE-006 | NG249 falls assessment | Register lists no journey; check the assessments journey covers it |
| CARE-013 | Tasks, rounds, handover | Web task views; the register's tests column omits `round.spec.ts` and `handover.spec.ts` |
| CARE-021, CARE-022 | Consent, capacity, DoLS | None beyond the user guide |
| SAFE-001, SAFE-002 | Incidents and classifier | None beyond the user guide |
| SAFE-003 | CQC notifications | Register's tests column omits `statutory-notifications.spec.ts` |
| SAFE-004, SAFE-005 | RIDDOR, s.42 drafts | Shown on the notification pages; the register lists no journey |
| SAFE-007 | Duty of candour | Web: the candour log and letters (API only) |
| SAFE-008 | Medical examiner and LeDeR | Web: the pack and notification screens (API only) |
| SAFE-009 | Falls and pressure-ulcer protocols | The post-fall checklist shows in `incident-forms.spec.ts`; the register lists no journey |
| SAFE-010 | Investigations and lessons | Web: investigation, actions and bulletins (API only) |
| QUAL-003 | Inspector evidence pack | Web: composing, redacting and releasing (API and recipient PDF only) |
| QUAL-009 | Statement of purpose | Web: the statement and its change tracking (API only) |
| OPS-028 | Downtime pack | Register's tests column omits `back-entry.spec.ts` |
| COMMS-001 | Family feed | Family app mode on mobile (paused) |
| COMMS-006, COMMS-007 | Handover acknowledgement, letter templates | None beyond the user guide |
| INSI-001 | Role dashboards | `todo`: spec, code, tests (slice 9) |
| INTG-011 | Communications | SMS and push run against mocks (human actions); the register lists no tests |
| MOB-002, MOB-005, MOB-006, MOB-010 | Mobile | Paused: Maestro journeys, conflict review demonstration |
| MOB-011, MOB-012 | Store readiness | `todo`, paused with mobile |

**Gate items from this section**:
- User guides per role.
- Web screens for the 22 rows marked "Web:".
- PLAT-002 and INSI-001.

These are slices, not fixes. The register's tests-column corrections are small and go in the hazard
follow-up pull request.

## 7. Data-protection documents

- [records-of-processing.md](../compliance/records-of-processing.md): updated through Phase 1. It
  has category rows for every Phase 1 data set (search, export, evidence packs, downtime packs,
  letters, family feed, break-glass search on #99). `processing-register.test.ts` keeps purposes B1
  to B10 in step with the in-app register. **Current.**
- [data-standards.md](../specs/data-standards.md): 104 of the 118 tables in `packages/db/src/schema`
  are named. Of the 14 that are not, eight hold personal or care data: `admission_condition`,
  `document_signature`, `key_issue`, `legal_hold`, `letter_template_version`,
  `notification_preference`, `welcome_checklist_item` and `workflow_instance`. The rest are
  reference or operator tables. **Small**: add their coded fields, or a line saying they have
  none. Follow-up pull request.
- [retention.md](../specs/retention.md) and the export catalogue: every table has a retention class
  in the catalogue, enforced by test. retention.md names classes rather than every table.
  **Current.**
- [dpia-template.md](../compliance/dpia-template.md): last changed 11 October 2026 (Phase 0 and the
  DPIA prefill). Its risks (R1 to R12) predate the Phase 1 processing.
  - It has no risk or measure for disclosure to an inspector (evidence pack), bulk copies (the full
    export, the downtime pack, printed transfer packs), search showing a person outside scope,
    letters to the wrong recipient, or statutory notifications to regulators.
  - **Gate item**: add them, kept in step with `packages/domain/src/platform/dpia.ts` and its test.
    It needs the data-protection label, so it is its own pull request.
- [sub-processors.md](../compliance/sub-processors.md): last reviewed 11 October 2026, with SES, the
  SMS gateway and push for the family feed added that day. **Current** for Phase 1.

## Follow-up pull requests (small gaps)

1. Hazard verification statuses and register test columns:
   - the five stale "Written" and "Hosted CI" rows marked "Passing" with the CI run;
   - the register's tests columns given the journeys they omit (PLAT-006, CARE-013, SAFE-003,
     OPS-028, PEOP-002, SAFE-009).
2. Evidence pack render test: a unit test of `renderEvidencePackPdf` on a fixed manifest.
3. The person's history tab journey, with axe, in light and dark themes.
4. data-standards rows for the eight tables in section 7.

## Gate items (larger)

1. Maestro offline journey on iOS and Android, charts and conflict review included (paused with
   mobile).
2. Clinical safety case v0.1.
3. User guides per role, and `docs/demo/` with the Phase 1 walkthrough.
4. Web screens for the API-only Phase 1 features:
   - people lifecycle (PEOP-001, 003, 005, 007 to 010, 013);
   - documents, tasks and retention (PLAT-009, 011, 012; HZ-006's `tasks.spec.ts`);
   - the weekly break-glass report (PLAT-006);
   - candour, medical examiner and investigations (SAFE-007, 008, 010);
   - evidence pack composing and statement of purpose (QUAL-003, QUAL-009).
5. Branding (PLAT-002) and role dashboards (INSI-001).
6. The DPIA template's Phase 1 risks and measures.
7. A second demo tenant with a shared user, for the choose-organisation journey.
