# Hazard log

| Item | Value |
| --- | --- |
| Product | Harbour |
| Manufacturer | Thapsus Cargo Ltd |
| Standard | [DCB0129](https://adultsocialcare.standards.nhs.uk/published-standards/clinical-risk-management-its-application-in-the-manufacture-of-health-it-systems) |
| Process | [clinical-risk-management-plan.md](clinical-risk-management-plan.md) (risk matrix in section 3.2, acceptability in 3.3) |
| Opened | 11 October 2026, Phase 0, with the day-one hazards from master prompt section 5.2 and the rules in section 10.3 |
| Clinical approval | Not yet reviewed. All ratings below are engineering proposals awaiting `[CSO name - human action]` |

## How to read and maintain this log

- IDs are permanent and referenced from code and tests. Never renumber or reuse an ID. Add new hazards at the end with the next number, using the `hazard` skill.
- **Initial risk** is the risk with no Harbour-specific controls (a generic digital record built without these mitigations). **Target residual risk** is the rating expected once every listed control is implemented and verified. A hazard moves to `controlled` only when the CSO has seen the verification evidence and accepted the residual risk.
- Ratings use severity (Minor, Significant, Considerable, Major, Catastrophic), likelihood (Very low, Low, Medium, High, Very high) and the resulting risk level 1 to 5 from the DCB0129 matrix in the plan.
- **Controls** are grouped as Design, Test and Training/user documentation. Each control says when it lands. "Built in Phase 0" means the control exists in the Phase 0 foundations release; everything else is planned.
- **Verification** lists the automated tests that prove the controls. Every test name contains the hazard ID so `grep -rn "HZ-004" apps packages` finds the evidence. Test names below are the planned titles; keep them when the test is written. Maestro flow files are named `hazard-HZ-NNN-<slug>.yaml`.
- A PR labelled `clinical` that adds, changes or removes a control must update the relevant entry here in the same PR (the CI docs gate enforces this).
- "Deployer control" marks a control that the tenant must put in place; these are carried into the [DCB0160 deployment template](dcb0160-deployment-template.md).

## Summary

| ID | Hazard | Initial risk (S / L / R) | Target residual risk (S / L / R) | Status | Controls built in Phase 0 | Verification lands |
| --- | --- | --- | --- | --- | --- | --- |
| [HZ-001](#hz-001-wrong-person-record-selection) | Wrong-person record selection | Major / Medium / 3 | Major / Very low / 2 | Open | Point-of-care header with photo, name, date of birth, allergies and communication needs | Phase 1, Phase 2 |
| [HZ-002](#hz-002-stale-offline-data-shown-as-current) | Stale offline data shown as current | Major / Medium / 3 | Major / Low / 3 | Open | Sync status banner with last-sync time; stale-data warning; never-evict reference data | Phase 1, Phase 2 |
| [HZ-003](#hz-003-missed-medication-administration) | Missed medication administration | Major / Medium / 3 | Major / Low / 3 | Open | Notification centre (escalation chains) | Phase 2 |
| [HZ-004](#hz-004-duplicated-medication-administration) | Duplicated medication administration | Major / Medium / 3 | Major / Very low / 2 | Open | Append-only events with client UUIDs (conflict model) | Phase 2 |
| [HZ-005](#hz-005-unit-or-dose-transcription-error) | Unit or dose transcription error | Major / Medium / 3 | Major / Low / 3 (re-assess at Phase 5) | Open | None | Phase 2 |
| [HZ-006](#hz-006-silent-sync-failure) | Silent sync failure | Major / Medium / 3 | Major / Very low / 2 | Open | Sync status banner with last-sync time and queued changes; stale-data warning | Phase 1 |
| [HZ-007](#hz-007-incorrect-or-missing-allergy-display) | Incorrect or missing allergy display | Major / Medium / 3 | Major / Very low / 2 | Open | Allergies in the point-of-care header; allergies never evicted offline | Phase 1, Phase 2 |
| [HZ-008](#hz-008-alert-fatigue) | Alert fatigue | Major / Medium / 3 | Major / Low / 3 | Open | Notification centre; status shown by icon and word | Phase 1, Phase 2 |
| [HZ-009](#hz-009-time-zone-and-daylight-saving-errors-on-time-critical-medicines) | Time-zone and daylight-saving errors on time-critical medicines | Major / Medium / 3 | Major / Very low / 2 | Open | UTC storage with local offset; date-only fields stored as dates | Phase 1, Phase 2 |
| [HZ-010](#hz-010-device-clock-drift-producing-wrong-recorded-times) | Device clock drift producing wrong recorded times | Major / Medium / 3 | Major / Very low / 2 | Open | Server-received time recorded alongside device time | Phase 1, Phase 2 |
| [HZ-011](#hz-011-cross-tenant-or-out-of-scope-record-exposure) | Cross-tenant or out-of-scope record exposure | Major / Medium / 3 | Major / Very low / 2 | Open | `tenant_id` everywhere; RLS with FORCE; non-owner app role; isolation tests | Phase 0 gate, Phase 1, Phase 2 |
| [HZ-012](#hz-012-validated-assessment-tool-calculated-incorrectly) | Validated assessment tool calculated incorrectly (NEWS2, MUST, Waterlow) | Major / Medium / 3 | Major / Very low / 2 | Open | None (tools arrive in Phase 1) | Phase 1 |
| [HZ-013](#hz-013-statutory-notification-missed-or-late) | Statutory notification missed or late | Major / Medium / 3 | Major / Low / 3 | Open | Notification centre | Phase 1, Phase 2 |
| [HZ-014](#hz-014-deterioration-score-or-screening-trigger-not-acted-on) | Deterioration score or screening trigger not acted on | Major / Medium / 3 | Major / Low / 3 | Open | None (Phase 1) | Phase 1 |
| [HZ-015](#hz-015-resuscitation-decision-missing-out-of-date-or-not-visible) | Resuscitation decision missing, out of date or not visible | Major / Low / 3 | Major / Very low / 2 | Open | None (Phase 1) | Phase 1 |
| [HZ-016](#hz-016-wrong-iddsi-diet-or-fluid-texture-displayed-or-recorded) | Wrong IDDSI diet or fluid texture displayed or recorded | Major / Low / 3 | Major / Very low / 2 | Open | None (Phase 1) | Phase 1 |
| [HZ-017](#hz-017-late-or-retrospective-entry-mistaken-for-a-contemporaneous-record) | Late or retrospective entry mistaken for a contemporaneous record | Considerable / Medium / 3 | Considerable / Low / 2 | Open | Append-only design (Phase 0 audit and versioning) | Phase 1 |
| [HZ-018](#hz-018-safety-critical-item-omitted-from-shift-handover) | Safety-critical item omitted from shift handover | Major / Medium / 3 | Major / Very low / 2 | Open | None (Phase 1) | Phase 1 |
| [HZ-019](#hz-019-body-map-side-or-site-recorded-wrongly) | Body-map side or site recorded wrongly | Considerable / Medium / 3 | Considerable / Low / 2 | Open | None (Phase 1) | Phase 1 |
| [HZ-020](#hz-020-deprivation-of-liberty-authorisation-lapses-unnoticed) | Deprivation-of-liberty authorisation lapses unnoticed | Considerable / Medium / 3 | Considerable / Low / 2 | Open | None (Phase 1) | Phase 1 |
| [HZ-021](#hz-021-no-access-to-essential-information-during-an-it-outage) | No access to essential information during an IT outage | Major / Low / 3 | Major / Very low / 2 | Open | None (Phase 1) | Phase 1 |
| [HZ-022](#hz-022-a-persons-information-shown-to-a-family-member-or-professional-without-a-sharing-decision) | A person's information shown to a family member or professional without a sharing decision | Major / Medium / 3 | Major / Very low / 2 | Open | None (Phase 1) | Phase 1 |
| [HZ-023](#hz-023-essential-information-missing-from-the-hospital-transfer-pack) | Essential information missing from the hospital transfer pack | Major / Medium / 3 | Major / Low / 3 | Open | None (Phase 1) | Phase 1 |
| [HZ-024](#hz-024-care-plan-or-risk-assessment-out-of-date-or-a-draft-or-superseded-version-followed) | Care plan or risk assessment out of date, or a draft or superseded version followed | Considerable / Medium / 3 | Considerable / Low / 2 | Open | None (Phase 1) | Phase 1 |
| [HZ-025](#hz-025-bed-rail-entrapment-risk-not-identified) | Bed rail entrapment risk not identified | Major / Low / 3 | Major / Very low / 2 | Open | None (Phase 1) | Phase 1 |
| [HZ-026](#hz-026-restrictive-or-covert-care-under-consent-or-authority-that-is-not-valid) | Restrictive or covert care under consent or authority that is not valid | Considerable / Medium / 3 | Considerable / Low / 2 | Open | None (Phase 1) | Phase 1 |
| [HZ-027](#hz-027-head-injury-after-a-fall-not-observed-or-escalated) | Head injury after a fall not observed or escalated | Major / Medium / 3 | Major / Low / 3 | Open | None (Phase 1) | Phase 1 |
| [HZ-028](#hz-028-point-of-care-history-on-a-device-mistaken-for-the-complete-record) | Point-of-care history on a device mistaken for the complete record | Considerable / Medium / 3 | Considerable / Low / 2 | Open | None (Phase 1) | Phase 1 |
| [HZ-029](#hz-029-an-entry-recorded-twice-when-a-save-is-tried-again) | An entry recorded twice when a save is tried again | Considerable / Medium / 3 | Considerable / Low / 2 | Open | Append-only entries with client UUIDs (Phase 0 conflict model) | Phase 1 |
| [HZ-040](#hz-040-held-entries-deleted-to-get-past-the-lockout) | Held entries deleted to get past the lockout | Major / Medium / 3 | Major / Low / 3 | Open | None (Phase 1) | Phase 1 |
| [HZ-050](#hz-050-an-inspector-evidence-pack-exposes-a-third-party-or-a-person-outside-its-scope) | An inspector evidence pack exposes a third party or a person outside its scope | Considerable / Medium / 3 | Considerable / Very low / 2 | Open | None (Phase 1) | Phase 1 |
| [HZ-051](#hz-051-a-letter-or-email-carries-another-persons-details-or-wording-that-was-not-approved) | A letter or email carries another person's details, or wording that was not approved | Considerable / Medium / 3 | Considerable / Low / 2 | Open | None (Phase 1) | Phase 1 |
| [HZ-060](#hz-060-health-details-in-an-email-sms-or-push-notification-to-a-family-member) | Health details in an email, SMS or push notification to a family member | Considerable / Medium / 3 | Considerable / Very low / 2 | Open | Outbound title guard on every adapter (Phase 0) | Phase 1 |
| [HZ-061](#hz-061-family-reassured-by-a-stale-or-misleading-update) | Family reassured by a stale or misleading update | Considerable / Medium / 3 | Considerable / Medium / 3 (until the CSO reviews it) | Open | None (Phase 1) | Phase 1 |
| [HZ-070](#hz-070-full-tenant-export-disclosed-beyond-the-organisation) | Full tenant export disclosed beyond the organisation | Major / Low / 3 | Major / Very low / 2 | Open | None (Phase 1) | Phase 1 |
| [HZ-071](#hz-071-full-tenant-export-incomplete-or-misread-when-a-provider-changes-system) | Full tenant export incomplete or misread when a provider changes system | Catastrophic / Medium / 4 | Catastrophic / Very low / 3 (4 until the CSO accepts, H-119) | Open | None (Phase 1) | Phase 1, Phase 2 |
| [HZ-072](#hz-072-sample-data-mistaken-for-or-mixed-with-real-records) | Sample data mistaken for, or mixed with, real records | Considerable / Medium / 3 | Considerable / Low / 2 | Open | None (Phase 1) | Phase 1 |

Eleven hazards (HZ-002, HZ-003, HZ-005, HZ-008, HZ-013, HZ-014, HZ-023, HZ-027, HZ-040, HZ-061, HZ-071) have a target residual risk of 3, which the plan allows only when further reduction is impractical. Each entry gives the justification; the CSO must accept or reject it `[CSO decision - human action]`.

Gaps in the IDs (HZ-030 to HZ-039, HZ-041 to HZ-049, HZ-052 to HZ-059 and HZ-062 to HZ-069) are blocks that were reserved for branches built at the same time; no hazard has been removed.

---

## HZ-001 Wrong-person record selection

| Field | Value |
| --- | --- |
| ID | HZ-001 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `people` module (lead engineer); `medicines` module from Phase 2 |
| Source | Master prompt 5.2 (day-one hazard), 10 (header on every screen), 10.2 (wristband or photo confirm) |

**Description**: a user opens, reads or writes to the wrong person's record. They record a note, chart entry or medication administration against the wrong person, or act on the wrong person's care plan, allergies, diet or resuscitation status.

**Causes**

- Same or similar names at one location (for example a couple sharing a family name).
- Mis-tap on a list on a small screen; the list re-orders while scrolling because sync delivers changes.
- The app advances automatically to the next person after a save.
- Missing, old or poor-quality photo.
- A shared device left open on the previous user's or previous person's screen.
- A room move not yet recorded.
- A notification deep link that opens a different person from the one named in the notification.
- Duplicate person records created by data entry or import.
- Choosing from search results a person with the same name, a former resident, or the near match for a mistyped NHS number.

**Effects**

- Medication given to the wrong person: overdose for one person, omission for the other.
- Care given contrary to the person's allergies, resuscitation decision, IDDSI diet level or moving and handling plan.
- An inaccurate legal record; a confidentiality breach.

**Initial risk**: severity Major, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Point-of-care header on every person screen shows photo, full and preferred name, date of birth, room, allergies and communication needs (master prompt 10). The offline person table carries photo and communication needs (`packages/sync`) | Built in Phase 0 |
| Design | Every Care mode form pins a compact identity bar (photo, name, allergies, communication needs, resuscitation status) while it scrolls, names the person in its title, and shows Save only once the person has loaded | Built in Phase 1 (mobile, clinical reviews C7 and round 3 M4) |
| Design | The web record shows the point-of-care header above every tab of the person's record (overview, care plan, assessments, risk assessments, notes, charts, body map, advance care, activities and visits, history), with the resuscitation status and IDDSI levels (HZ-015, HZ-016). Each tab renders the header itself, so every tab move reads it again (HZ-002); its data is checked against the API's schema when it arrives, and a person who cannot be read safely shows a warning instead of details that may be wrong | Built in Phase 1 slice 9 (web) |
| Design | A missing photo shows a labelled placeholder ("No photo on record", icon plus words), never a silhouette that could be mistaken for a photo; the photo's date is shown and an old photo prompts an update | Phase 1 |
| Design | "Similar name" flag (icon plus words) in the header of every active person at a location who shares a family name or has a similar name with another | Phase 1 |
| Design | No automatic advance after saving: the app confirms the save naming the person and returns to that person or the list | Phase 1 |
| Design | Lists do not re-order under the user's finger while sync applies changes | Phase 1 |
| Design | Notification deep links carry tenant and person IDs; the target screen re-validates both before rendering | Phase 1 |
| Design | Probable duplicate check on create and import (same NHS number, or same date of birth and similar name) | Phase 1 |
| Design | eMAR requires positive identification for each administration: wristband barcode scan or photo confirmation | Phase 2 |
| Design | Shared and kiosk devices lock after 30 seconds by default and return to user sign-in, not to the last person ([kiosk.md](../compliance/kiosk.md)) | Phase 1 |
| Design | Search results show care roles the photo, name, preferred name, date of birth, NHS number, location, room and status (icon and word); names-and-rooms roles (such as the administrator) see the photo and age instead of the date of birth and NHS number, so two people of the same name can still be told apart. People come first, whole-word matches before prefix matches, then people receiving care before those being assessed or who have left, then name and date of birth; two people of the same name in the results are each flagged with a same-name warning. People who have left are hidden unless the user may and does ask for them; an NHS number is matched exactly, and a mistyped, 9- or 11-digit or dotted one is refused, never matched approximately ([platform-completions.md](../specs/platform-completions.md) rules 1, 3, 6 and 7; ADR-0070 keeps fuzzy name matching out) | Phase 1 (domain rules built) |
| Design | The room on the header comes from the dated bed history, which never puts two people in one bed; a death or discharge recorded against the wrong person is corrected with a reason (and a fresh sign-in for a death), cancelling the exit workflow and the death notification drafts ([people.md](../specs/people.md) rules 2 and 6) | Phase 1 (domain rules built) |
| Design | Go-live waits until every current person has a photo on record and every active shared or kiosk device is enrolled in device management (onboarding items `people_ready` and `shared_devices_enrolled`, [platform-completions.md](../specs/platform-completions.md) rule 26) | Phase 1 (domain rules built) |
| Test | See Verification | Phase 1, Phase 2 |
| Training and user documentation | Care worker guide: check photo and date of birth before every administration and entry. Deployer control: photos taken at admission and refreshed under the tenant's policy | Phase 1 |

**Target residual risk**: severity Major, likelihood Very low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/ui-native/src/logic/person.test.ts`: names, initials fallback and NHS number formatting for the point-of-care header (photo or initials, preferred and full name) | Passing (Phase 0) |
| `apps/mobile/src/components/person-header.render.test.ts`: `hazard HZ-001 the point-of-care header renders who this is` (the header drawn with react-test-renderer from the device's own rows: name, date of birth, NHS number, allergies, resuscitation status and IDDSI levels, identifiers not selectable) | Passing (Phase 1, mobile) |
| `apps/mobile/src/components/identity-bar.render.test.ts`: `hazard HZ-001 draws the photo, name, allergies, communication needs and resuscitation status`, `hazard HZ-001 shows no communication flag for someone with none recorded`, `hazard HZ-001 falls back to initials when there is no photo`, `hazard HZ-001 pins the identity bar outside the scrolling form, with the header first inside it`, `hazard HZ-001 hides Save until the person has loaded` (the bar and the form layout drawn from the device's own rows; clinical review round 3, M4) | Passing (Phase 1, mobile) |
| `apps/mobile/src/care/screens.test.ts`: wiring checks only, not evidence that anything renders: every screen about a person uses the header; the form screen hands the identity bar, the header and the loaded person to the layout | Passing (Phase 1, mobile) |
| `apps/mobile/.maestro/hazard-HZ-006-offline-note-and-vitals.yaml`: the header shows on the record, note and chart screens with no signal | Written; not run in CI (the nightly workflow builds demo mode, which never syncs); run by hand on a live-API build before release |
| `apps/api/test/api.test.ts`: person summaries carry allergies and communication needs for the header | Passing (Phase 0) |
| `packages/ui-native`: `hazard HZ-001 person header renders photo, full name, preferred name, date of birth and room` | Planned, Phase 1 |
| `packages/ui-native`: `hazard HZ-001 person header shows a labelled placeholder when no photo is on record` | Planned, Phase 1 |
| `packages/ui`: `hazard HZ-001 web person header renders photo, name, date of birth and room` | Planned, Phase 1 |
| `packages/domain` (people): `hazard HZ-001 flags similar names among active people at the same location` (table-driven) | Planned, Phase 1 |
| `packages/domain` (people): `hazard HZ-001 detects a probable duplicate person on create and import` | Planned, Phase 1 |
| `apps/api`: `hazard HZ-001 rejects a write whose person is outside the tenant or the user's scope` | Planned, Phase 1 |
| `apps/mobile` Maestro `hazard-HZ-001-no-auto-advance.yaml`: after saving a note the next screen names the same person | Planned, Phase 1 |
| `packages/domain` (medicines): `hazard HZ-001 refuses an administration without wristband scan or photo confirmation` | Planned, Phase 2 |
| `packages/domain/src/people/occupancy.test.ts`: `hazard HZ-001 two people in one bed on the same day`, `a bed someone else occupies`, `labels the room shown on the header from the history` | Passing (Phase 1) |
| `packages/domain/src/people/lifecycle.test.ts` and `exit.test.ts`: `hazard HZ-001 a death recorded in error is corrected only with a reason and a fresh sign-in`, `cancels a death recorded in error only with a reason and step-up` | Passing (Phase 1) |
| `packages/domain/src/people/transfer-pack.test.ts`: `hazard HZ-001 refuses a pack whose sections belong to someone else`, `hazard HZ-001 no photo`; `admission.test.ts`: `hazard HZ-001 accepts no photo with a reason` (welcome checklist) | Passing (Phase 1) |
| `packages/domain/src/platform/search.test.ts`: `query normalisation (hazard HZ-001: an NHS number is exact, never a near match)` (9- and 11-digit, dotted and wrong check digit numbers refused); `shows identity fields to care roles, and the photo and age (never the date of birth) to an administrator (HZ-001)`; `leaves people who have left out unless the user may and does ask (HZ-001)` | Passing (Phase 1) |
| `packages/domain/src/platform/search.test.ts`: `hazard HZ-001 search ranking puts the right person first` (people first, whole-word before prefix, current before former, then name and date of birth; a same-name warning on each person who shares a name, none for one person found twice) | Passing (Phase 1) |
| `packages/domain/src/platform/onboarding.test.ts`: `hazard HZ-001 no photo for identification` (person readiness); `an active shared device not enrolled` (go-live items) | Passing (Phase 1) |
| `apps/web` Playwright: `hazard HZ-001 search results show photo, date of birth and status before a record opens` | Planned, Phase 1 |
| `apps/web/e2e/care-record.spec.ts` (Playwright with axe, WCAG 2.2 AA): `hazard HZ-001 hazard HZ-015 the header shows the resuscitation status, allergies and IDDSI levels on every tab, and 'not recorded' as a warning` (on each of the ten tabs: the name, the allergies in words, the resuscitation status, the food and drink IDDSI levels and when the header was read; axe on each tab in the light and the dark theme); `the record reflows at 320 px` (header and tabs fit, only the tab row scrolls) | Passing (local run; CI e2e-web on the PR) |
| `apps/web/src/lib/care-record.test.ts`: `hazard HZ-001 refuses a person whose identity or allergies cannot be read` | Passing (Phase 1 slice 9) |

---

## HZ-002 Stale offline data shown as current

| Field | Value |
| --- | --- |
| ID | HZ-002 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `packages/sync` and `apps/mobile` (lead engineer) |
| Source | Master prompt 5.2, 17.1, 17.2 |

**Description**: the mobile app shows information that has changed on the server since the device last synced (a new allergy, a stopped medicine, a changed resuscitation decision, a new risk, a dose already given by a colleague) and the user treats it as current.

**Causes**

- No connectivity (basements, rural home care, lifts) for long periods.
- A sync stream filter that fails to deliver an update to a device that should receive it.
- The app left in the background; a device used after days off.
- The user does not notice the device is offline.
- PowerSync service outage.
- An assignment change not yet reflected on the device.
- A server restore to a point in time earlier than data the device already holds ([restore runbook](../runbooks/restore.md)).
- On the web, a header drawn once and kept while the person moves between tabs (a shared layout), or a page left open, so a colleague's change (a withdrawn DNACPR, a new allergy) does not show.

**Effects**

- A stopped medicine given, or a medicine given despite a newly recorded allergy.
- A new care-plan instruction (for example a changed IDDSI level) missed.
- A dose given twice because a colleague's administration is not yet visible (see HZ-004).
- Resuscitation attempted or withheld contrary to a newly recorded decision.

**Initial risk**: severity Major, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Sync status banner on every Care-mode screen showing online or offline state, the time of the last successful sync and the number of queued changes | Built in Phase 0 |
| Design | The web point-of-care header is read again from the API on every tab move, every two minutes while the page is in view and when the person comes back to the window; it says when it was read ("Checked at 14:05") and has a "Check again" button. The interval is a product constant (`HEADER_REFRESH_INTERVAL_MS`), not a rate-table figure | Built in Phase 1 slice 9 (web) |
| Design | Stale-data warning: when the last successful sync is older than the threshold the banner switches to a warning state (icon plus words, for example "Last updated 3 hours ago. Information may be out of date"). The threshold is a named constant in `packages/sync`; the CSO confirms its value `[CSO decision - human action]` | Built in Phase 0 |
| Design | Reference data for assigned people (care plan summary, allergies, medicines, photo, communication needs) is never evicted while the assignment stands (`NEVER_EVICT_TABLES` in `packages/sync`) | Built in Phase 0 |
| Design | Safety-critical panels (allergies, medicines, resuscitation decision) show when that data was last confirmed from the server | Phase 1 |
| Design | Last-given time for every dose shows its source (this device, or synced from the server at a stated time) | Phase 2 |
| Design | High-priority changes (new allergy, medicine stopped, resuscitation decision changed) travel on a priority sync stream and a push that prompts the app to sync; the push content carries no personal data | Phase 2 |
| Design | Sync stream filters are tested separately from RLS, because logical replication bypasses RLS (shared with HZ-011) | Phase 0 gate |
| Design | Offline, search covers only what the device has synced and labels its results "This device only, last synced at HH:MM" ([platform-completions.md](../specs/platform-completions.md) rule 7; ADR-0070) | Phase 1 (mobile step) |
| Test | See Verification | Phase 1, Phase 2 |
| Training and user documentation | Care worker guide explains the banner states. Deployer control: critical changes (allergy, medicine stopped, resuscitation decision) are also handed over verbally at shift change; the nightly downtime pack (Phase 1) is kept where connectivity is poor | Phase 1 |

**Target residual risk**: severity Major, likelihood Low, **risk 3**.

**Justification for level 3**: offline operation is itself a safety control (continuity of care where connectivity is poor), and a device cannot know about changes it has not received. Harbour makes the age of the data visible and prioritises critical changes; the remaining risk depends on deployer controls (verbal handover). Further reduction would mean blocking offline use, which creates a larger hazard. `[CSO acceptance - human action]`

**Verification**

| Test | Status |
| --- | --- |
| `packages/ui-native/src/logic/sync-banner.test.ts`: `warns that offline data may be out of date past the threshold (HZ-002)`; stale warning kept until caught up (threshold 15 minutes, ADR-0029; CSO to confirm) | Passing (Phase 0) |
| `apps/web/e2e/care-record.spec.ts` (Playwright with axe, WCAG 2.2 AA): `hazard HZ-002 hazard HZ-015 a colleague's change to the CPR decision shows in the header after one tab move` (a second browser context records and then withdraws a DNACPR decision; the first sees each change after one tab move, and after "Check again") | Passing (local run; CI e2e-web on the PR) |
| `packages/sync`: `hazard HZ-002 banner state is stale when the last successful sync exceeds the threshold` | Planned, Phase 1 |
| `packages/sync/test/care-streams.test.ts`: `hazard HZ-002 reference data for assigned people is never evicted while the assignment stands` (care profile, active care plan, risk assessments, assessment results and advance care records stay whatever the window) | Passing (Phase 1) |
| `packages/ui-native`: `hazard HZ-002 allergy, medicines and resuscitation panels show when data was last confirmed` | Planned, Phase 1 |
| `apps/mobile` Maestro `hazard-HZ-002-offline-banner.yaml`: go offline, pass the threshold, banner shows the stale warning and the last-sync time | Planned, Phase 1 |
| `packages/sync`: `hazard HZ-002 priority stream delivers allergy and medicine-stopped changes before routine data` | Planned, Phase 2 |
| `apps/mobile/src/care/sync-summary.test.ts`: `hazard HZ-002 the sync status on Today` (last successful sync as UK date and time, changes waiting to upload, the stale warning, never synced, demo mode); `screens.test.ts`: `hazard HZ-002 Today shows the last successful sync and the changes waiting to upload` | Passing (Phase 1, mobile) |

---

## HZ-003 Missed medication administration

| Field | Value |
| --- | --- |
| ID | HZ-003 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `medicines` module (lead engineer) |
| Source | Master prompt 5.2, 10.2, 10.3; [NICE SC1](https://www.nice.org.uk/guidance/SC1/chapter/1-Recommendations); [CQC time-sensitive medicines](https://www.cqc.org.uk/guidance-providers/adult-social-care/time-sensitive-medicines) |

**Description**: a scheduled dose is not given, or not recorded, and the omission is not noticed in time. The highest risk is for time-critical medicines (for example Parkinson's medicines, insulin, anti-epileptics).

**Causes**

- The dose does not appear on the round (scheduling or frequency expansion error; see also HZ-009).
- The person is not assigned to anyone for the round.
- The carer is interrupted mid-round; the round is closed with doses outstanding.
- Medicine not available and no stock escalation.
- A new or changed prescription not yet on the MAR (see HZ-005).
- Reminder or escalation not delivered (offline device, failed job) or ignored (HZ-008).

**Effects**: deterioration from an omitted time-critical medicine (rigidity and swallowing difficulty in Parkinson's, hypo- or hyperglycaemia, seizures), untreated pain or infection.

**Initial risk**: severity Major, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Notification centre with escalation chains used by the medicines rules | Built in Phase 0 |
| Design | Round view by time slot lists every due dose for assigned people; a dose stays outstanding until an outcome is recorded (given, refused, omitted with coded reason, not available, self-administered, given by family, withheld with reason) | Phase 2 |
| Design | The app refuses to record an administration without a selected person, a dose and an outcome (master prompt 10.3) | Phase 2 |
| Design | Late warnings with time-critical rules; time-critical medicines escalate at an earlier threshold to the team leader, then the nurse in charge or on-call | Phase 2 |
| Design | A round cannot be closed with outstanding doses without a reason; outstanding doses appear in the auto-compiled handover | Phase 2 |
| Design | On-device reminders for due doses that work offline | Phase 2 |
| Design | A dose due for a person not assigned to any staff member on the shift alerts the shift lead | Phase 2 |
| Design | "Not available" creates a stock and ordering task | Phase 2 |
| Design | Expired medicines competence blocks administration (manager override logged) | Phase 2 |
| Design | Downtime pack medicines section (OPS-028): until the eMAR exists it names where the location keeps the paper MAR (set per location); with the eMAR it lists the scheduled doses still due while the pack is in use, time-critical first and in time order, never doses already given, and every PRN medicine with when it was last given ([operations.md](../specs/operations.md) rules 1 and 7) | Domain interface built in Phase 1 slice 11; data in Phase 2 |
| Test | See Verification | Phase 2 |
| Training and user documentation | eMAR training and competency assessment; deployer control: tenant policy on time-critical medicines and round allocation | Phase 2 |

**Target residual risk**: severity Major, likelihood Low, **risk 3**.

**Justification for level 3**: giving a medicine is a human act that Harbour cannot perform. Harbour makes every outstanding dose visible, escalates time-critical ones and blocks closing a round silently; the remaining risk sits with staffing and practice, which the tenant controls. `[CSO acceptance - human action]`

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain` (medicines): `hazard HZ-003 expands every supported frequency into the correct doses across a 28-day cycle` (table-driven) | Planned, Phase 2 |
| `packages/domain` (medicines): `hazard HZ-003 a dose with no recorded outcome stays outstanding after its window` | Planned, Phase 2 |
| `packages/domain` (medicines): `hazard HZ-003 time-critical medicines escalate at the earlier threshold` | Planned, Phase 2 |
| `packages/domain` (medicines): `hazard HZ-003 a round cannot close with outstanding doses without a reason` | Planned, Phase 2 |
| `packages/domain` (medicines): `hazard HZ-003 refuses an administration without person, dose and outcome` | Planned, Phase 2 |
| `apps/api`: `hazard HZ-003 an overdue time-critical dose escalates to the nurse in charge` | Planned, Phase 2 |
| `apps/mobile` Maestro `hazard-HZ-003-offline-round.yaml`: offline round shows due doses and fires a local reminder | Planned, Phase 2 |
| `packages/domain/src/operations/downtime-pack.test.ts`: `hazard HZ-003 lists doses still due while the pack is in use, in time order, time-critical first, never doses already given` (PRN medicines with their last-given time) | Passing (Phase 1, slice 11) |

---

## HZ-004 Duplicated medication administration

| Field | Value |
| --- | --- |
| ID | HZ-004 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `medicines` module and `packages/sync` (lead engineer) |
| Source | Master prompt 5.2, 6 (conflict model), 10.3, 17.1 |

**Description**: the same dose is given twice, by the same or different staff, or is recorded twice so that later dosing decisions rest on a false record.

**Causes**

- Two devices offline both record the same scheduled dose.
- Last-given time not visible; PRN minimum interval or 24-hour maximum not enforced.
- Upload retries create duplicate rows (non-idempotent writes); a double tap on save.
- Stale data (HZ-002), clock drift (HZ-010) or daylight-saving errors (HZ-009) make an interval look elapsed.
- A database restore loses acknowledged administrations and staff re-record or re-give ([restore runbook](../runbooks/restore.md)).

**Effects**: overdose (opioids, insulin, paracetamol, anticoagulants), hypoglycaemia, respiratory depression, death.

**Initial risk**: severity Major, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Point-of-care events are append-only with client-generated UUIDs and idempotent inserts, so a retried upload cannot create a second row (conflict model, ADR-0001) | Pattern built in Phase 0; applied to administrations in Phase 2 |
| Design | Duplicate administration within the minimum interval is blocked and needs an override reason (master prompt 10.3) | Phase 2 |
| Design | Last-given time, by whom and from which source, shown for every PRN and regular dose | Phase 2 |
| Design | PRN maximum in 24 hours enforced from the PRN protocol | Phase 2 |
| Design | A MAR row locks once synced; only referenced correction events are allowed | Phase 2 |
| Design | On sync, two administrations for the same scheduled dose from different devices go to a conflict review screen for the nurse in charge; nothing is merged silently | Phase 2 |
| Design | Save disabled after the first tap until the result returns; the confirmation names person, medicine and dose | Phase 2 |
| Design | Intervals measured in elapsed UTC time, drift-corrected where drift is known (HZ-009, HZ-010) | Phase 2 |
| Test | See Verification | Phase 2 |
| Training and user documentation | Deployer control: one staff member allocated per person per round; conflict review is part of the nurse-in-charge role | Phase 2 |

**Target residual risk**: severity Major, likelihood Very low, **risk 2**. A duplicate now needs two staff on two offline devices giving the same dose to the same person in the same window despite round allocation, and it is detected and escalated on sync.

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain` (medicines): `hazard HZ-004 blocks a second administration within the minimum interval unless an override reason is given` | Planned, Phase 2 |
| `packages/domain` (medicines): `hazard HZ-004 enforces the PRN maximum in 24 hours` | Planned, Phase 2 |
| `apps/api`: `hazard HZ-004 replaying the same client UUID does not create a second administration` | Planned, Phase 2 |
| `apps/api`: `hazard HZ-004 two devices recording the same scheduled dose create a conflict review task` | Planned, Phase 2 |
| `packages/db`: `hazard HZ-004 medication_administration has no UPDATE or DELETE grant` | Planned, Phase 2 |
| `apps/mobile` Maestro `hazard-HZ-004-offline-conflict.yaml`: two devices record the same dose offline; the nurse in charge sees the conflict on sync | Planned, Phase 2 |

---

## HZ-005 Unit or dose transcription error

| Field | Value |
| --- | --- |
| ID | HZ-005 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `medicines` module (lead engineer) |
| Source | Master prompt 5.2, 10.2; [NICE SC1](https://www.nice.org.uk/guidance/SC1/chapter/1-Recommendations); [dm+d standard](https://standards.nhs.uk/published-standards/dictionary-of-medicines-and-devices) |

**Description**: the dose, unit, strength, form, route, frequency or timing is entered or transcribed wrongly onto the MAR from a prescription, discharge letter or pharmacy label. Typical errors: milligrams for micrograms, millilitres for milligrams with oral liquids, misplaced decimal points and tenfold errors, "u" read as zero, a weekly medicine entered as daily, the wrong strength or a look-alike product selected.

**Causes**: free-text entry; ambiguous abbreviations; adjacent similar options in a picker; trailing zeros and missing leading zeros; import mapping errors; manual transcription from discharge summaries; changes passed on verbally.

**Effects**: overdose or underdose, wrong medicine, harm up to death.

**Initial risk**: severity Major, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Medicines selected only from dm+d; strength and form come from dm+d, never free text | Phase 2 |
| Design | Structured dose: a number plus a unit from the units permitted for that dm+d product; "micrograms", "nanograms" and "units" always written in full; leading zero enforced (0.5, never .5); trailing zeros never displayed (5, never 5.0) | Phase 2 |
| Design | Non-daily schedules (for example once weekly) show the day name on every MAR row and in the round view | Phase 2 |
| Design | A new or changed MAR entry is "Not yet checked" until a second competent user, different from the transcriber, verifies it against the source document, as NICE SC1 recommends for transcription | Phase 2 |
| Design | The source document (prescription, discharge letter, label) is attached to or referenced from each MAR entry | Phase 2 |
| Design | Imported medicines arrive as "Not yet checked"; the import dry run reports unmapped units | Phase 2 |
| Design | Pharmacy MAR import replaces manual transcription where a pharmacy is integrated | Phase 5 |
| Design | No dose calculation or dose-range advice is offered (medical-device boundary) | All phases |
| Test | See Verification | Phase 2 |
| Training and user documentation | Transcription competency; deployer control: tenant transcription and second-check policy | Phase 2 |

**Target residual risk**: severity Major, likelihood Low, **risk 3**, re-assessed when pharmacy import lands in Phase 5.

**Justification for level 3**: until pharmacy data is imported electronically, a person reads a source document and enters it. Structured entry and the second check reduce but do not remove that human step. Dose-range checking would cross the medical-device boundary. `[CSO acceptance - human action]`

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain` (medicines): `hazard HZ-005 rejects a dose whose unit is not permitted for the dm+d product` | Planned, Phase 2 |
| `packages/domain` (medicines): `hazard HZ-005 formats doses with a leading zero, no trailing zero and micrograms in full` (table-driven) | Planned, Phase 2 |
| `packages/domain` (medicines): `hazard HZ-005 a new or changed MAR entry stays not yet checked until a second competent user verifies it` | Planned, Phase 2 |
| `packages/domain` (medicines): `hazard HZ-005 the checker must be a different user from the transcriber` | Planned, Phase 2 |
| `packages/domain` (medicines): `hazard HZ-005 non-daily schedules show the day on every MAR row` | Planned, Phase 2 |
| `apps/api`: `hazard HZ-005 imported medicines are created as not yet checked` | Planned, Phase 2 |

---

## HZ-006 Silent sync failure

| Field | Value |
| --- | --- |
| ID | HZ-006 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `packages/sync`, `apps/api` upload handlers, `apps/mobile` (lead engineer) |
| Source | Master prompt 5.2, 6, 17.1, 17.2 |

**Description**: records written on a device do not reach the server, or server changes do not reach the device, and neither the user nor the organisation knows. Colleagues and the server record lack notes, charts, administrations or incidents.

**Causes**

- An upload rejected by the API (stale `expected_version`, validation change after a release) and dropped.
- Session expiry while offline: a session lasts 12 hours but a device may work offline for the whole
  offline window, and the API answers an expired session with the same 401 as a revoked one, so
  treating every 401 as a remote wipe deleted entries that had not uploaded.
- A 403 about the session (MFA required, account removed) read as a refusal of each entry, parking
  the whole queue as refused; and the opposite, a 403 from the edge (the web application firewall,
  a proxy, an HTML error page) or with a code the build does not know read as the session ending.
- A restore of held entries that fails after their owner signs in again, swallowed, so the entries
  stay held while the device reads "Up to date".
- Refused entries' content aged out with the offline window while the server kept no copy (the
  security review S7 design; removed in round 3, clinical review M1).
- Refused entries visible only on Today and the record, so the banner on other screens read "Up to
  date" while entries had not been saved; and refused or held entries that could not be read
  counted as none (clinical review round 5, C-L7).
- A role edit made by mistake withdraws Care mode at once: any API 403 on the sync token ends Care
  mode, and everything synced except the unsent work (allergies, care plans, resuscitation
  decisions) leaves the device mid-shift until access is restored (clinical review round 5, C-L9;
  HZ-021; CSO decision H-145).
- A hold whose session ended with a 401, `not_a_member` or `mfa_enrolment_required` is reported
  only when someone signs in on that device again: the owner's own sign-in sends the report, and so
  does another member's in the same organisation. Until then the server knows only the device's
  last report (clinical reviews round 5, C-M4 and round 6, M3; HZ-040). A report sent with another
  member's sign-in names the owner and the owner's locations, so the task goes where the owner or
  that member works and the owner can close it (round 6, M1 and M2).
- A poison record blocking the queue.
- Sign-out, uninstall, device reset, loss or remote wipe while changes are queued.
- PowerSync outage; device storage full; an upload handler that swallows errors.
- The app more than one schema version behind the server.
- A database restore to an earlier point.

**Effects**: missing records lead to missed or duplicated care (HZ-003, HZ-004), unescalated incidents (HZ-013), unseen safeguarding concerns and an incomplete legal record.

**Initial risk**: severity Major, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Sync status banner showing the time of the last successful sync and the number of queued changes | Built in Phase 0 |
| Design | Stale-data warning when the last successful sync is older than the threshold (shared with HZ-002) | Built in Phase 0 |
| Design | `audit_event` table exists for sync events (master prompt 5.5); sync events written to it | Table built in Phase 0; wiring Phase 1 |
| Design | Rejected uploads are never dropped: they move to a visible "Needs attention" list on the device and create a review task for the manager on the server (stale writes become review tasks, never silent overwrites) | Phase 1 |
| Design | One failing record does not block the rest of the queue; retries with backoff | Phase 1 |
| Design | Sign-out warns and requires a coded reason when anything is unsent; the device reports its unsent, refused, held and blocked counts and the age of the oldest (no names and no care data) after each sync and as soon as a hold starts (`POST /v1/sync/device-report`, an audit event whose resource is the device), so the server knows what a lost or wiped device held; each report names whose entries they are and the locations of the owner's sync scope, by opaque id, and a report waiting in the keystore keeps the id of the device that held the entries (clinical review round 6, M1 and M2); a hold's report goes with the ending session, again while the app runs for an hour, and otherwise waits in the keystore for the next session in the tenant; a report that could not be built is replaced by one from the marker's count, never taken as sent; then the ended session is signed out on the server (clinical review round 5, C-M4; security review round 5, S-L3). Tests: `device-report.test.ts`: `hazard HZ-006 the device tells the server what it has not sent (queue depth)`, `hazard HZ-040 still reports a hold whose entries could not be counted (round 5, C-M4)`, `hazard HZ-040 a hold's report names its owner, their locations and the device that held it (clinical review round 6, M1 and M2)`; the retry and sign-out are vault wiring, checked in the device test plan (H-68) | Built in Phase 1 (mobile and API) |
| Design | When the API ends the session, or the access Care mode needs (401; a 403 with a session code; a 403 from the API on the sync token; `GET /v1/me` without `people.person.read`), the device wipes only if nothing is waiting to upload (queued, refused or held entries). Otherwise it copies the upload queue into the local-only `held_entry` table and clears everything else synced, so only the unsent work stays, encrypted, until its owner sends it or the owner or a manager deletes it with a recorded reason; nothing is deleted automatically, and at `mobile.held_entries_max_days` the hold escalates to a manager (HZ-040). It stops uploading and asks for sign-in again ("Sign in again to send N entries", naming whose they are). The owner (`tenant_user`) is stored inside the encrypted database and checked before the device connects: only the owner resumes, and their entries go back into the queue; anyone else is refused; a keystore error or a database with no recorded owner is never opened for the next person ([care.md](../specs/care.md) section 6; security review S2 and S3; DPO position in human action H-68) | Built in Phase 1 (mobile) |
| Design | After the owner signs in again, each held entry goes back into the queue in its own transaction; one that cannot is moved to needs attention with its content, and one that cannot even be moved stays held and counted. The held marker stays until every entry is back, a failed restore is never swallowed, and the banner and Today count held entries, so the device never reads "Up to date" while any exist (clinical review round 3, M2). A restore that failed, or left entries held, is said in words on every screen until the next unlock puts them back, and a held count that cannot be read shows as needing attention, never as none (clinical review round 4, M4) | Built in Phase 1 (mobile) |
| Design | Deleting unsent entries (held entries, a refused entry, or sign-out from Settings or the lock screen with entries unsent) shows the count, needs a coded reason, a confirmation naming the count and device authentication, and is put on record before anything is deleted: a tombstone in the keystore holding codes and opaque ids only, and `POST /v1/sync/discards`, an audit event with the person's own words when they gave any. Tombstones are sent again at each sync until the server has them. A held deletion checks the file and key are gone before clearing the marker (security reviews S4, S5, M1 and M2; clinical review C2; HZ-040) | Built in Phase 1 (mobile and API) |
| Design | A 403 is read from its RFC 9457 problem body. One of the API's session codes (`not_a_member`, `mfa_enrolment_required`, `step_up_required`) ends the session. Any other code from the API (`missing_permission`, `feature_disabled`, or one this build does not know) on the sync token or a batch upload means the access Care mode needs was withdrawn: the device holds its unsent work, or wipes when there is none; on a single care upload it moves that entry to needs attention. Only a 403 with no JSON body, an HTML page or the edge's `edge_blocked` asks `GET /v1/me` first, in the session's organisation (`x-harbour-tenant`): an answer without `people.person.read`, a 401 or a session code ends the session; otherwise a care upload is moved to needs attention and the sync token and batch uploads back off and retry, and if `/v1/me` cannot be reached the entry stays queued. The web application firewall answers its blocks with code `edge_blocked` (403) and `rate_limited` (429 with Retry-After), and the device waits as long as Retry-After asks, up to 10 minutes (security reviews S6, round 3 H1 and round 4 H1) | Built in Phase 1 (mobile and infrastructure) |
| Design | The banner on every screen counts refused entries and never reads "Up to date" while one is on the device, or while refused or held entries cannot be counted, which Today and the record say in words too; refusals recorded without a tenant are listed and removable; a refused entry keeps what was recorded until someone removes it with a recorded reason, because the server keeps no copy (clinical reviews C1, round 3 M1, round 4 M4 and round 5 C-L7; security review S7). Tests: `sync-banner.test.ts`: `hazard HZ-006 refused entries on the banner (clinical review C1)`; `sync-summary.test.ts`: `hazard HZ-006 reads held entries that could not be counted as needing attention (round 4, M4)`, `hazard HZ-006 reads refused entries that could not be counted as needing attention (round 5, C-L7)`; `restore-problem.render.test.ts`: `reads an unknown count as needing attention on the banner, never up to date` | Built in Phase 1 (mobile) |
| Design | The server keeps a copy of every refused entry and raises a review task for the manager | Phase 1 (API follow-up) |
| Design | Manager dashboard lists devices on an active shift whose last sync is older than the threshold; on-call alert | Phase 1 |
| Design | The app blocks new writes and prompts an update when it is more than one schema version behind | Phase 1 |
| Design | Care events recorded offline before a person left or died are accepted after the exit and shown as recorded after it; the person leaves a device only after its queue has uploaded ([people.md](../specs/people.md) rule 3) | Phase 1 (domain rule built) |
| Test | See Verification | Phase 1 |
| Training and user documentation | Care worker guide: check the banner shows no queued changes before leaving at the end of a shift. Deployer control: devices charged and connected at handover | Phase 1 |

**Target residual risk**: severity Major, likelihood Very low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/ui-native/src/logic/sync-banner.test.ts`: `never fails silently: a failure is danger, urgent and offers retry (HZ-006)` | Passing (Phase 0) |
| `apps/api/test/api.test.ts`: rejected uploads return a code and a message the device can show | Passing (Phase 0) |
| `packages/sync`: `hazard HZ-006 exposes queued change count and last successful sync time to the banner` | Planned, Phase 1 |
| `apps/mobile/src/sync/connector.test.ts`: `hazard HZ-006 moves a refused entry to needs attention with its content, and the queue moves on` (the refusal lands in the device-only `upload_issue` table, not `packages/sync`) | Passing (Phase 1, mobile) |
| `apps/api`: `hazard HZ-006 a stale expected_version creates a review task, never a silent overwrite` | Planned, Phase 1 |
| `apps/api`: `hazard HZ-006 a device on an active shift with no recent sync appears on the manager dashboard` | Planned, Phase 1 |
| `apps/mobile` Maestro `hazard-HZ-006-signout-with-queue.yaml`: sign-out with queued changes warns and asks for a reason | Planned, Phase 1 |
| `apps/mobile` Maestro `hazard-HZ-006-sync-recovery.yaml`: write offline, restore connectivity, queue empties and records appear on the web (the "sync recovery" CI journey) | Planned, Phase 1 |
| `packages/domain/src/people/lifecycle.test.ts`: `hazard HZ-006 accepts an offline ... that happened before the death, flagged as recorded after it` (notes, observations, body-map marks, incidents) | Passing (Phase 1) |
| `apps/mobile/src/sync/connector.test.ts`: `hazard HZ-006 keeps a refusal for a missing permission on the device, without wiping it`, `hazard HZ-006 never completes an operation the API refused inside a 200`, `hazard HZ-006 never discards a refused write: it moves to needs attention`; network failures retry and stay queued | Passing (Phase 1, mobile) |
| `apps/mobile/src/care/entry-view.test.ts`: `hazard HZ-006 refused entries stay readable`, `hazard HZ-002 hazard HZ-006 entry status in words`; `queries.test.ts`: `hazard HZ-006 refused uploads on the device` | Passing (Phase 1, mobile) |
| `apps/mobile/.maestro/hazard-HZ-006-offline-note-and-vitals.yaml`: a note and vital signs written offline show as waiting to upload, survive the app being closed, then upload and read as saved | Written; not run in CI (the nightly workflow builds demo mode, which never syncs); run by hand on a live-API build before release |
| `apps/mobile/src/app-state/held-work.test.ts`: `hazard HZ-006 a 401 with pending entries keeps them`, `hazard HZ-006 keeps only the unsent work: identities and the care record leave the device (S2)`, `hazard HZ-006 a 401 with no pending entries wipes`, `hazard HZ-006 the same user resumes and the queue drains`, `hazard HZ-006 a different user is refused`, `hazard HZ-006 the database is checked before it connects (S3)`, `hazard HZ-006 a keystore read error means held with an unknown owner (S3)`, `hazard HZ-006 hazard HZ-040 the explicit discard wipes: requested and blocked first, deleted only once the entries cannot be read`; the owner check before connecting (`opening the database ... (S3, L4)`: the owner connects after the restore, a new database is claimed, someone else's empty database is remade, someone else's unsent work is held and the sign-in refused, a restore that failed is reported in words, `hazard HZ-006 says how many entries are still held when only some could not go back (round 4, M4)`); `components/restore-problem.render.test.ts`: `hazard HZ-006 held entries that could not be put back are shown, not hidden` (the notice as an alert, and a banner with an unknown count never "Up to date"); `care/sync-summary.test.ts`: `hazard HZ-006 reads held entries that could not be counted as needing attention (round 4, M4)`; `hazard HZ-006 moves an entry that cannot go back to needing attention, with its content (clinical review M2)`, `hazard HZ-006 keeps an entry held, and counted, when it can neither go back nor be moved`; the hold marker always has a deadline (L2) | Passing (Phase 1, mobile) |
| `apps/mobile/src/sync/device-report.test.ts`: `hazard HZ-006 the device tells the server what it has not sent (queue depth)` (counts and the oldest age with no personal data; sent when the counts change and every half hour; a hold's report kept for the next session in the same tenant), `hazard HZ-040 a hold's report names its owner, their locations and the device that held it (clinical review round 6, M1 and M2)` (opaque ids only, kept while the report waits, sent under the id of the device that held the entries); `apps/api/test/api.test.ts`: `hazard HZ-006 records a device's unsent counts without personal data` | Passing (Phase 1, mobile and API) |
| `apps/mobile/src/care/sync-summary.test.ts`: `hazard HZ-006 never reads up to date while entries are still held (clinical review M2)`, `hazard HZ-006 reads refused entries that could not be counted as needing attention (round 5, C-L7)`; `apps/mobile/src/components/sign-out.render.test.ts`: `hazard HZ-006 signing out with unsent entries (C2)` (rendered: the count named, a coded reason needed, the confirmation naming the count) | Passing (Phase 1, mobile) |
| `apps/mobile/src/sync/connector.test.ts`: `hazard HZ-006 treats a 403 %s from the sync token as an ended session` and `hazard HZ-006 ends the session on a 403 %s instead of parking the entry as refused` (the three session codes); `hazard HZ-006 treats a 403 %s from the sync token as access withdrawn, without asking /v1/me (round 4, H1)` and `stops and reports the ended session on %s (round 4, H1)` (`missing_permission`, `feature_disabled`, an unknown code); `hazard HZ-006 parks the entry the API refused with %s, never the session`; `hazard HZ-006 backs off on a 403 from the sync token with %s while /v1/me answers (H1)` and `hazard HZ-006 parks the entry, never the session, on a 403 with %s while /v1/me answers (H1)` (no JSON body, a WAF HTML page, `edge_blocked`; the probe carries the organisation); `hazard HZ-006 ends the session when /v1/me answers without the access Care mode needs (round 4, H1)` and `hazard HZ-006 ends the session on an unexplained 403 when /v1/me lacks the access Care mode needs (round 4, H1)`; `hazard HZ-006 keeps the entry queued on an unexplained 403 when /v1/me cannot be reached`; `hazard HZ-006 ends the session on an unexplained 403 when /v1/me says 401`; `session-signals.test.ts`: `classifyForbidden (security review round 4, H1)`, `checkSession (security review round 4, H1)`; `backoff.test.ts`: `waits the firewall's full 300 seconds on upload, and caps a longer hint at 10 minutes`; `auth-client.test.ts`: the same rule for `GET /v1/me`, asked in the session's organisation | Passing (Phase 1, mobile) |
| `packages/ui-native/src/logic/sync-banner.test.ts`: `hazard HZ-006 refused entries on the banner (clinical review C1)`: never "Up to date" with a refused entry, in any connection state | Passing (Phase 1) |
| `apps/mobile/src/care/queries.test.ts`: `hazard HZ-006 shows and removes a refusal recorded without a tenant (S7)`, `hazard HZ-006 keeps a refused entry's content however old, until someone removes it (clinical review M1)` | Passing (Phase 1, mobile) |
| `apps/api`: `hazard HZ-006 a refused care entry is kept on the server with a review task` | Planned, Phase 1 (API follow-up) |

---

## HZ-007 Incorrect or missing allergy display

| Field | Value |
| --- | --- |
| ID | HZ-007 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `people` module; `medicines` module from Phase 2; catering from Phase 3 (lead engineer) |
| Source | Master prompt 5.2, 10, 10.2 |

**Description**: a person's allergy or adverse reaction is not shown, is shown for the wrong person, is shown incompletely, or the screen implies "no allergies" when allergy status has never been recorded.

**Causes**: a blank allergy area that cannot distinguish "none" from "not asked"; truncation on small screens; allergy not synced or evicted; import dropping allergies; allergy recorded only in a free-text document; catering allergen flags held separately from the care record; allergy entered against the wrong person (HZ-001).

**Effects**: anaphylaxis or another adverse reaction to a medicine or food; death.

**Initial risk**: severity Major, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Allergies shown in the point-of-care header on every person screen | Built in Phase 0 |
| Design | Allergies are reference data, never evicted offline while the assignment stands | Built in Phase 0 |
| Design | Three explicit states, never blank: allergies listed; "No known allergies" (recorded positively with author and time); "Allergy status not recorded" (warning, icon plus words) | Phase 1 |
| Design | The header never truncates silently: it shows the count, the most severe reactions first, and the full list one tap away | Phase 1 |
| Design | Allergies recorded as coded entries (substance, reaction, severity) | Phase 1 |
| Design | Every print and export (including the printed MAR) carries the allergy section | Phase 1 (care exports), Phase 2 (MAR) |
| Design | The administration screen displays the person's recorded allergies next to the medicine being given. Any automatic matching of allergen to medicine ingredient needs a medical-device boundary decision first ([medical-device-boundary.md](../compliance/medical-device-boundary.md)) | Phase 2 |
| Design | Catering allergen flags read the same allergy record (single source) | Phase 3 |
| Design | The downtime pack lists allergies most severe first, with allergies of unknown severity among the severe, and reads "not recorded" with what to do when no allergy status is recorded ([operations.md](../specs/operations.md) rule 1) | Phase 1 (domain rules built, slice 11) |
| Design | Import dry run lists people without an allergy status | Phase 2 |
| Design | Go-live waits until every current person has an allergy status other than unknown; the full export's current summary gives each person's allergy status and allergies, and documents that `unknown` never means none ([platform-completions.md](../specs/platform-completions.md) rules 10 and 26) | Phase 1 (domain rules built) |
| Test | See Verification | Phase 1, Phase 2 |
| Training and user documentation | Deployer control: allergy status recorded at admission and at medicines reconciliation | Phase 1 |

**Target residual risk**: severity Major, likelihood Very low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/ui-native/src/logic/person.test.ts`: `allergy flag (HZ-007)` (unknown is never shown as calm; three states) | Passing (Phase 0) |
| `packages/db`: `allergy_status` enum distinguishes `unknown`, `no_known_allergies` and `has_allergies`; `apps/api/test/api.test.ts` returns `unknown` for a person never asked | Passing (Phase 0) |
| `apps/web/src/lib/people.test.ts`: `allergySummary` (unknown, and recorded as having allergies with none active, both read "Allergies not recorded", never "No known allergies") | Passing (Phase 0) |
| `packages/i18n/src/i18n.test.ts`: `names allergy severities and shows one it does not know as recorded, never blank (HZ-007)` (web point-of-care header) | Passing (Phase 0) |
| `packages/ui-native`: `hazard HZ-007 header shows allergy status not recorded when no allergy record exists` | Planned, Phase 1 |
| `packages/ui`: `hazard HZ-007 web header shows allergy status not recorded when no allergy record exists` | Planned, Phase 1 |
| `packages/domain` (people): `hazard HZ-007 no known allergies can only be recorded positively with author and time` | Planned, Phase 1 |
| `packages/sync`: `hazard HZ-007 allergy rows for assigned people survive eviction` | Planned, Phase 1 |
| `packages/ui-native`: `hazard HZ-007 header shows the count and most severe reactions first when allergies exceed the space` | Planned, Phase 1 |
| `apps/web` Playwright: `hazard HZ-007 printed MAR includes the allergy section` | Planned, Phase 2 |
| `packages/domain` (medicines): `hazard HZ-007 administration view includes the person's recorded allergies` | Planned, Phase 2 |
| `packages/domain/src/platform/onboarding.test.ts`: `hazard HZ-007 allergy status unknown` (person readiness blocks go-live) | Passing (Phase 1) |
| `packages/domain/src/people/pre-admission.test.ts`: `hazard HZ-007 never lets allergies be marked not applicable`; `admission.test.ts`: `hazard HZ-007 refuses allergies as not applicable` (welcome checklist) | Passing (Phase 1) |
| `packages/domain/src/people/transfer-pack.test.ts`: `hazard HZ-007 allergy status never recorded`, `allergies said to exist but none listed`, `lists the most severe allergies first` | Passing (Phase 1) |
| `packages/domain/src/operations/downtime-pack.test.ts`: `hazard HZ-007 lists the most severe allergies first, with unknown severity among the severe`; `hazard HZ-021 missing safety-critical information reads not recorded, never blank` (allergies) | Passing (Phase 1, slice 11) |

---

## HZ-008 Alert fatigue

| Field | Value |
| --- | --- |
| ID | HZ-008 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `platform` notification centre (lead engineer) |
| Source | Master prompt 5.2, 9.1 (notification centre) |

**Description**: users receive so many alerts, warnings and notifications, many of low value, that they dismiss or ignore the important ones or override safety warnings out of habit.

**Causes**: every rule raising an alert; duplicates across channels; alerts with no clear action; no tiering; thresholds not tuned; overdue alerts for work done but not yet recorded; repeated override prompts for benign cases; quiet hours misconfigured.

**Effects**: missed deterioration escalation, missed time-critical doses, missed notification deadlines, habitual overriding of duplicate-dose blocks.

**Initial risk**: severity Major, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Single notification centre for in-app, push, email and SMS with per-user quiet hours and escalation chains | Built in Phase 0 |
| Design | Status and alerts carry an icon and a word, never colour alone (design system rule) | Built in Phase 0 |
| Design | Every notification type declares a tier (interruptive with acknowledgement; task; information) and the action it expects; information-tier items never push | Phase 1 |
| Design | Interruptive tier reserved for conditions this log names as needing interruption (time-critical dose overdue, tenant escalation threshold reached, missed visit) | Phase 1, Phase 2 |
| Design | One alert per condition per person, updated rather than repeated | Phase 1 |
| Design | Design rule: a new alert type needs a hazard reference and a named action (checked in clinical PR review) | Phase 1 |
| Design | Tasks raised by Care mode sync (clinical reviews round 5 C-L8, round 6 M1 and M2 and round 7 M1 to M5; security reviews round 6 N1 and N2 and round 7 M1; HZ-040), each bounded, and no bound ever stops a task: past a cap, tasks merge. A device holding entries has one task at each of its locations (`sync.device_hold`), raised by its first report and moved by later ones, never a second; a task closed less than a day ago is reopened, and when it had escalated its escalation is reset under the same once-a-day check as after a refused close; when the day's reset is already used, the reopen records that and the device's next report once the reset is due (it re-reports every half hour while anything waits) resets it, once, so a new hold always signals, at most once a day (clinical review round 8, M2); a hold's start is never earlier than the device's last report for that hold said, nor than the server first heard from the device; a report's due time can only move earlier. Each reporter raises tasks for at most 3 devices in a rolling day, whatever became of them; past that, every further hold joins the reporter's one capped-holds task (source `device_hold_capped`), due at the earliest of those holds and escalating like a device task, which a manager completes. Flagged entries raise one task per deletion record, kind and location (`sync.entry_reported_deleted`, `sync.entry_deleted_after_upload`), never one per entry: later entries add to its count, only a deletion recorded as done counts, and an entry flagged before is not flagged again under a new record; each owner's deletions have at most 5 such tasks open at a location, and past that the entries join the oldest of them. A cap is audited, and in addition the location's Registered Managers get one notice (`sync.reporter_capped`, no personal data) per person and source a day. Flagged-entry tasks fall due at once when any of their entries is an observation (fluids, repositioning, vital signs and every other chart), because a possible duplicate counts towards the day's totals and can complete a round before anyone reviews it; a task holding only other entries (notes, body-map marks, activities, visits) is due 24 hours after it is raised, as a record to reconcile within the day, since due at once it would turn one carer's uploads into a stream of overdue alerts (whether 24 hours is acceptable for those is a CSO decision, H-148); an observation added later brings the task's due time forward. Device-hold tasks stay due when the hold escalates. Device reports are limited to 120 an hour, deletion records to 30 an hour and 20 new records a day per person. Overdue, these tasks escalate once, and only to people who hold the task's permission at its location, not to every first responder or to holders elsewhere; with no one at the location (a vacant post), the task is assigned to the longest-serving live Registered Manager anywhere in the organisation (else the longest-serving holder of the permission anywhere), who alone is told and, as its assignee, can see and complete it (clinical review round 8, M1); with no one at all, the task is not marked escalated, the gap is audited (`sync.escalation_unrouted`) and the task is left out of the escalation batches for a day. Tests: `api.test.ts`: `hazard HZ-008 reopens a device's task closed within the day and resets its escalation at most once a day, so a new hold always signals and raising again signals at most once more (round 6, N2; round 7, M1)`, `hazard HZ-008 merges each reporter's holds past the day's cap into one task, due at the earliest of them, and tells the location's Registered Manager once (round 6, N2; round 7, M2)`, `hazard HZ-008 resets a task's escalation when a new hold follows a refused close, once a day (round 6, M1)`, `hazard HZ-040 raises one task for the Registered Manager at the reporter's location, due when the hold escalates, never moved later, and closed at zero (round 5, C-H1 and S-M1)`, `limits each person's reports per hour (round 4, M4)`, `limits each person to 20 new deletion records a day, with or without ids (round 6, M2)`; `care.test.ts`: `keeps the entry and flags it for the manager, so care recorded again is not counted twice unseen` (a note: due within the day; a replay flags nothing more), `raises one task per deletion record, however many of its entries arrive (round 6, N1)`, `does not flag again an entry listed under a new deletion record (round 6, N1)`, `hazard HZ-008 merges an owner's flagged entries past the cap into their oldest open task there, so no cap stops a task (round 6, N1; round 7, M2)`, `hazard HZ-008 makes a flagged task due at once when an entry is an observation, and within the day otherwise (round 7, M3)`; `tasks.test.ts`: `hazard HZ-008 a sync task escalates only to people who can act on it (round 5, C-H1)` (including `does not tell a holder of the permission at another location (round 6)` and `signals again once a device's task is reset after a refused close (round 6, M1)`), `hazard HZ-040 a sync task whose location has no one who can act on it (round 7, M5)`; `api.test.ts`: `hazard HZ-008 signals a hold reopened after the day's reset was used once the reset is due, and only once (clinical review round 8, M2)` | Built in Phase 1 (API) |
| Design | Tenants tune thresholds within bounds Thapsus sets; escalation of time-critical medicines cannot be switched off | Phase 2 |
| Design | Alert volume, acknowledgement time and override rates per user and per alert type, reported monthly to managers and the CSO | Phase 2 |
| Test | See Verification | Phase 1, Phase 2 |
| Training and user documentation | User guides explain the tiers. Deployer control: managers review the monthly alert report | Phase 2 |

**Target residual risk**: severity Major, likelihood Low, **risk 3**.

**Justification for level 3**: alert fatigue is a human-factors hazard; design reduces volume and focuses interruption, and monitoring detects drift, but no design can remove it. Removing alerts would raise HZ-003 and HZ-013. `[CSO acceptance - human action]`

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain` (platform): `hazard HZ-008 every notification type declares a tier and an action` | Planned, Phase 1 |
| `packages/domain` (platform): `hazard HZ-008 repeated triggers for the same condition update one alert` | Planned, Phase 1 |
| `packages/domain` (platform): `hazard HZ-008 information-tier notifications never send push` | Planned, Phase 1 |
| `packages/domain/src/platform/tasks.test.ts`: `hazard HZ-008 task timing escalates once, after a grace period` (overdue after the window, escalated after the rate-table threshold) | Passing (Phase 1) |
| `apps/api/test/tasks.test.ts`: `hazard HZ-008 overdue tasks escalate once` (one notification per responder, generic title, no repeat on the next run) | Passing (Phase 1) |
| `apps/api`: `hazard HZ-008 a tenant cannot disable escalation of time-critical medicines` | Planned, Phase 2 |
| `apps/api`: `hazard HZ-008 alert volume and override metrics are reported per user and type` | Planned, Phase 2 |
| `packages/domain/src/people/reviews.test.ts`: `hazard HZ-008 raises one review on change for several unreviewed changes` | Passing (Phase 1) |
| `apps/api/test/api.test.ts`: `hazard HZ-008 reopens a device's task closed within the day and resets its escalation at most once a day, so a new hold always signals and raising again signals at most once more (round 6, N2; round 7, M1)`, `hazard HZ-008 merges each reporter's holds past the day's cap into one task, due at the earliest of them, and tells the location's Registered Manager once (round 6, N2; round 7, M2)`, `hazard HZ-008 resets a task's escalation when a new hold follows a refused close, once a day (round 6, M1)`; `apps/api/test/care.test.ts`: `raises one task per deletion record, however many of its entries arrive (round 6, N1)`, `hazard HZ-008 merges an owner's flagged entries past the cap into their oldest open task there, so no cap stops a task (round 6, N1; round 7, M2)`, `hazard HZ-008 makes a flagged task due at once when an entry is an observation, and within the day otherwise (round 7, M3)`; `apps/api/test/tasks.test.ts`: `hazard HZ-040 a sync task whose location has no one who can act on it (round 7, M5)`; `apps/api/test/tasks.test.ts`: `hazard HZ-008 a sync task escalates only to people who can act on it (round 5, C-H1)` | Passing (Phase 1) |

---

## HZ-009 Time-zone and daylight-saving errors on time-critical medicines

| Field | Value |
| --- | --- |
| ID | HZ-009 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `medicines` module; `platform` date-time utilities (lead engineer) |
| Source | Master prompt 5.2, 10.2, 18 (UTC with local offset); [CQC time-sensitive medicines](https://www.cqc.org.uk/guidance-providers/adult-social-care/time-sensitive-medicines) |

**Description**: scheduled times or intervals are wrong around the change between GMT and BST, or because a device or server uses the wrong time zone, so a dose is skipped, doubled or shown at the wrong time, or an interval check (for example a 4-hour paracetamol gap) gives the wrong answer.

**Causes**

- Local times stored without an offset; intervals computed in wall-clock time.
- A dose scheduled in the hour that does not exist (01:00 to 02:00 on the last Sunday of March) or the hour that happens twice (01:00 to 02:00 on the last Sunday of October).
- Server code running in UTC while rules assume Europe/London; cron jobs at local times.
- A device set to another time zone (staff returning from abroad).
- Date-only values (date of birth) shifted by a time-zone conversion.

**Effects**: missed or duplicated time-critical medicines; a PRN dose wrongly permitted; a misleading chronology in the legal record.

**Initial risk**: severity Major, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Instants stored in UTC with the device's local offset and the server-received time (master prompt 18) | Built in Phase 0 (data model convention) |
| Design | Date-only fields such as date of birth stored as dates, not instants | Built in Phase 0 |
| Design | Schedules defined as wall-clock times in the location's time zone (Europe/London in England) and expanded to instants with the IANA time-zone database, never by adding 24 hours | Phase 2 |
| Design | Transition rule (proposed; CSO to confirm `[CSO decision - human action]`): a dose in the skipped spring hour moves later by the length of the gap (01:30 becomes 02:30 BST) and is flagged on the round; a dose in the repeated autumn hour happens once, at the first occurrence | Phase 2 |
| Design | Recorded event times (proposed; CSO to confirm `[CSO decision - human action]`): one domain rule, `resolveRecordedUkTime`, for every screen where a person types when something happened, web and mobile. A time in the skipped spring hour is refused; a time in the repeated autumn hour is asked about (BST before the clocks went back, or GMT after) when both have passed, with no default; a time ahead of the clock beyond the drift tolerance is refused and never rolled back to an earlier day. Computed times (schedules, deadlines) keep `fromUkWallClock`. The Care mode forms on the phone use it for every typed time, with the tenant's `sync.clock_drift_flag_minutes` as the tolerance, and show BST or GMT beside times on a clock-change day; a correction keeps the original instant exactly | Built in Phase 1 (domain; mobile, clinical review round 3 H1) |
| Design | Times written on paper during an outage are resolved with the same rule (`resolvePaperTime` in `packages/domain/src/operations/outage.ts`, using `resolveRecordedUkTime`): a time in the skipped spring hour is refused, a time in the repeated autumn hour must say which one, a time ahead of the clock is refused, and the back-entry keeps the time as written beside the instant ([operations.md](../specs/operations.md) rule 11) | Phase 1 (domain rules built, slice 11) |
| Design | The web record reads every typed event time through `resolveRecordedUkTime`, in separate day, month, year, hour and minute boxes (so the browser's language cannot swap the day and month); in the repeated hour a required question asks which time, with nothing chosen; the skipped hour and future times are refused. "Now" is the instant the form is sent, not when the page was drawn. Times on the two clock-change days show BST or GMT beside them | Built in Phase 1 slice 9 (web) |
| Design | Minimum intervals and maximum-in-24-hours computed on elapsed time between UTC instants | Phase 2 |
| Design | Times always displayed in the location's time zone, 24-hour clock; on transition days the round view states that the clocks changed | Phase 2 |
| Design | A device whose time zone differs from the location's shows a warning; displayed times stay in the location's zone | Phase 1 |
| Design | Domain tests run under `TZ=UTC`, `TZ=Europe/London` and a non-UK zone in CI | Phase 1 |
| Test | See Verification | Phase 1, Phase 2 |
| Training and user documentation | Release note and in-app notice before each clock change | Phase 2 |

**Target residual risk**: severity Major, likelihood Very low, **risk 2**.

**Verification** (table-driven across the transitions on 29 March 2026, 25 October 2026, 28 March 2027 and 31 October 2027)

| Test | Status |
| --- | --- |
| `packages/domain/src/shared/time.test.ts`: `hazard HZ-009 UK offset`, `fromUkWallClock` (spring-forward gap and autumn overlap), `addUkDays keeps the wall-clock time across a clock change` | Passing (Phase 0) |
| `packages/domain/src/shared/time.test.ts`: `hazard HZ-009 ukWallClockOccurrences on every minute of the clock-change days` (every minute of 29/03/2026, 25/10/2026, 28/03/2027 and 31/10/2027) and `hazards HZ-009, HZ-010 and HZ-017 resolveRecordedUkTime` (skipped, ambiguous, one past occurrence, future beyond tolerance, impossible dates), run under `TZ=Europe/London`, `TZ=UTC` and `TZ=America/New_York` | Passing (Phase 1) |
| `apps/web/src/lib/uk-time.test.ts`: `hazard HZ-009 hazard HZ-017 reads every minute of 29/3/2026`, `25/10/2026`, `28/3/2027` and `31/10/2027` `through the form, by the domain rule`; `says the clocks went forward, and asks which time when they went back`; `does not ask when only the first 01:30 has happened yet`; `takes 'now' when the form is sent, not when the page was drawn` (each run with the process in Europe/London, America/New_York and UTC); `packages/ui/src/lib/zoned-time.test.ts`: `hazard HZ-009 hazard HZ-017 shows UK time on every device, across both clock changes`; `packages/ui/src/components/DateInput/DateInput.test.tsx`: `hazard HZ-009 hazard HZ-017 asks which time was meant only when the app's rule says it happened twice`; `apps/web/src/lib/format.test.ts`: `hazard HZ-009 hazard HZ-017 names the zone only on the days the clocks change` | Passing (Phase 1 slice 9) |
| `packages/domain/src/platform/tasks.test.ts`: `hazard HZ-009 recurring tasks keep UK local times across clock changes` (daily times stay local; a time in the spring gap moves an hour later; hourly intervals count elapsed time) | Passing (Phase 1) |
| `packages/domain` (medicines): `hazard HZ-009 a 01:30 dose on a spring-forward day moves to 02:30 BST and is flagged` | Planned, Phase 2 |
| `packages/domain` (medicines): `hazard HZ-009 a 01:30 dose on a clocks-back day occurs once` | Planned, Phase 2 |
| `packages/domain` (medicines): `hazard HZ-009 a 4-hour minimum interval spanning a clock change is measured in elapsed time` | Planned, Phase 2 |
| `packages/domain` (medicines): `hazard HZ-009 an 08:00 daily dose stays at 08:00 local time either side of each transition` | Planned, Phase 2 |
| `packages/domain` (platform): `hazard HZ-009 date of birth round-trips unchanged under every test time zone` | Planned, Phase 1 |
| `apps/mobile/src/care/time.test.ts`: `hazard HZ-009 the clock changes (C4, round 3 H1)`: `hazard HZ-009 refuses a time that did not happen when the clocks went forward` (in the default mode too), `hazard HZ-009 asks BST or GMT, with no default, when both have passed`, `hazard HZ-009 asks as soon as the second occurrence has passed`, `hazard HZ-009 keeps 25 hours between the same time on the days either side of a change`, `hazard HZ-009 shows BST or GMT beside times on a clock-change day only`, `hazard HZ-009 keeps an original in the repeated autumn hour exactly, never re-reading it` | Passing (Phase 1, mobile) |
| `packages/domain` (care): `hazard HZ-009 fluid balance days run from 00:00 to 24:00 UK time` (23- and 25-hour days) | Passing |
| `packages/domain` (care): `hazard HZ-009 counts elapsed hours across the autumn clock change` (repositioning) | Passing |
| `packages/domain` (care): `hazard HZ-009 keeps the prompt at the same UK time across the autumn clock change` (bowel) | Passing |
| Not medicines, family communications (slice 12): `packages/domain/src/comms/notify-plan.test.ts`: `hazard HZ-009 quiet hours always apply to family updates, on the UK clock` (both clock changes), `hazard HZ-009 ends a window in the repeated autumn hour at the right occurrence` (00:00 to 01:30 checked at 01:15 GMT on 25/10/2026 ends at 01:30 GMT, and at 01:15 BST ends at the first 01:30), `hazard HZ-009 ends a window whose end is skipped when the clocks go forward an hour later`; `notify-calendar.test.ts`: `hazard HZ-009 visit times read the same on either side of a clock change`; `visit-booking.test.ts`: `hazard HZ-009 reads booking hours on the UK clock` | Passing (Phase 1, slice 12) |
| `apps/mobile` Maestro `hazard-HZ-009-device-zone.yaml`: a device in another zone shows location time and a warning | Planned, Phase 1 |
| `packages/domain/src/operations/outage.test.ts`: `hazard HZ-009 hazard HZ-017 a time in the hour skipped on 29/03/2026 is refused`; `hazard HZ-009 hazard HZ-017 a time in the hour repeated on 25/10/2026 asks which one`; `hazard HZ-009 hazard HZ-017 resolves the repeated hour to the earlier time the person chose` (and the later); the hours after each change; `hazard HZ-009 a time before the autumn change resolves to summer time` | Passing (Phase 1, slice 11) |

---

## HZ-010 Device clock drift producing wrong recorded times

| Field | Value |
| --- | --- |
| ID | HZ-010 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `packages/sync`, `apps/api` (lead engineer) |
| Source | Master prompt 10.1 (device and server time), 10.3 (drift over 5 minutes) |

**Description**: a device clock is wrong (changed by the user, drifted, or reset after the battery ran flat), so times recorded on it are wrong: administration times, note times, visit check-ins; and interval checks on the device use the wrong "now".

**Causes**: manual time change; automatic time disabled; long periods offline; shared tablets without network time; deliberate back-dating.

**Effects**: wrong next-dose timing (overdose or omission), wrong chronology in the legal record, late entries not flagged, wrong notification deadlines, false visit times.

**Initial risk**: severity Major, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | A time typed on the phone that is later than the device clock by more than the tenant's tolerance (`sync.clock_drift_flag_minutes`, read from the rate table and cached; none until the device has read it) is refused, never moved to an earlier day (clinical review round 3, H1) | Built in Phase 1 (mobile) |
| Design | Held entries never act on the device clock: a clock earlier than when the hold started, or than the last time the server was reached, changes nothing, and a clock that jumped forward can only bring the escalation to a manager sooner, never a deletion (HZ-040; security review round 3). At the server, a hold report's times are never later than the server received it, so a fast device clock can bring the manager's task forward but never push it later (security review round 5, S-M1; clinical review round 5, L-3), and a hold's start is never earlier than the device's last report for that hold said, nor than the server first heard from the device, so a backdated start cannot make a new task due at once (security reviews round 6, N2 and round 7, M1). Tests: `held-limit.test.ts`: `hazard HZ-010 does not act on a clock earlier than the hold's start or the last server time`, `hazard HZ-010 treats a clock that jumped forward as a reason to escalate, nothing more`; `api.test.ts`: `hazard HZ-010 takes a hold's start no later than the server received the report (round 5, S-M1)`, `hazard HZ-040 raises one task for the Registered Manager at the reporter's location, due when the hold escalates, never moved later, and closed at zero (round 5, C-H1 and S-M1)` (an earlier start than the last report's is taken as that report's) | Built in Phase 1 (mobile and API) |
| Design | Every event records device time with its offset and the server-received time | Built in Phase 0 |
| Design | Drift between device and server is measured at each sync and held in local sync bookkeeping (`sync_meta` in `packages/sync`) | Built in Phase 0 |
| Design | Drift over 5 minutes is flagged on the device and on every record written while drifted (master prompt 10.3) | Phase 1 |
| Design | A record whose device time is later than its server-received time, or far earlier, raises a manager review flag; a note written more than 2 hours after the event carries the late-entry flag | Phase 1 |
| Design | The history view shows both device and server times | Phase 1 |
| Design | The web sends the device's clock reading with every entry (`x-harbour-sent-at`), so the API flags an entry from a browser whose clock is wrong; the entry shows "Device clock differed" in words and an icon | Built in Phase 1 slice 9 (web) |
| Design | Interval checks on the device use a drift-corrected clock when drift is known | Phase 2 |
| Test | See Verification | Phase 1, Phase 2 |
| Training and user documentation | Care worker guide: never change the device time. Deployer control: MDM policy enforces automatic network time on shared devices ([kiosk.md](../compliance/kiosk.md)) | Phase 1 |

**Target residual risk**: severity Major, likelihood Very low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain/src/shared/time.test.ts`: `hazard HZ-010 clock drift` (5-minute tolerance) | Passing (Phase 0) |
| `apps/web/src/components/care/EntryBadges.test.ts`: `hazard HZ-010 says when the device clock differed from the server's`; `apps/web/src/lib/uk-time.test.ts`: `hazard HZ-010 hazard HZ-017 refuses a time later than now, beyond the clock tolerance` | Passing (Phase 1 slice 9) |
| `packages/db`: append-only event columns keep device time, device offset and server-received time | Built in Phase 0 |
| `apps/api`: `hazard HZ-010 every uploaded event is stamped with server-received time` | Planned, Phase 1 |
| `packages/sync`: `hazard HZ-010 drift over 5 minutes between device and server is flagged` | Planned, Phase 1 |
| `apps/api`: `hazard HZ-010 a device time later than server-received time creates a review flag` | Planned, Phase 1 |
| `packages/domain` (care): `hazard HZ-010 a note written more than 2 hours after the event carries the late-entry flag` | Planned, Phase 1 |
| `packages/domain` (medicines): `hazard HZ-010 the minimum-interval check uses the drift-corrected clock` | Planned, Phase 2 |
| `apps/mobile/src/sync/connector.test.ts`: `hazard HZ-010 hazard HZ-017 sends the time it was written and the time it was sent apart`, `hazard HZ-010 stamps each retry with the time it is sent` (`deviceTime` is the time written; `x-harbour-sent-at` is stamped as each request leaves) | Passing (Phase 1, mobile) |
| `apps/mobile/src/components/when-field.render.test.ts`: `hazard HZ-009 hazard HZ-010 hazard HZ-017 WhenField on the autumn clock change`: `hazard HZ-009 hazard HZ-017 names the time, normalised, in the question and in both options`, `has no default, and records the zone chosen`, `asks nothing for a time that happened once`; `apps/api/test/api.test.ts`: `hazard HZ-010 takes a hold's start no later than the server received the report (round 5, S-M1)` | Passing (Phase 1) |
| `apps/mobile/src/care/time.test.ts`: `hazard HZ-010 when the event happened`: `hazard HZ-010 refuses a time later than now` (with the default day), `hazard HZ-010 never rolls a later time back to yesterday`, `hazard HZ-010 with a tolerance of %i minutes from the rate table reads %s as %s`; `notes.test.ts`: `hazard HZ-010 refuses a time still to come today rather than dating it yesterday`, `hazard HZ-010 takes the tenant's clock tolerance from the entry context`; `sync/clock-tolerance.test.ts`: `hazard HZ-010 the clock tolerance for typed times comes from the rate table` (cached for offline starts, none until known, a figure in the wrong unit or out of range ignored); `sync/held-limit.test.ts`: `hazard HZ-010 does not act on a clock earlier than the hold's start or the last server time`, `hazard HZ-010 treats a clock that jumped forward as a reason to escalate, nothing more` | Passing (Phase 1, mobile) |

---

## HZ-011 Cross-tenant or out-of-scope record exposure

| Field | Value |
| --- | --- |
| ID | HZ-011 |
| Status | Open |
| Clinical owner | `[CSO name - human action]`; data protection lead consulted |
| Engineering owner | `packages/db`, `packages/sync`, `apps/api` (lead engineer) |
| Source | Master prompt 4 (access model), 5.3 (tenant isolation); [ADR-0002](../decisions/0002-tenancy-and-row-level-security.md); [Postgres row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) |

**Description**: a user sees, or a device receives, records belonging to another tenant, or records in their own tenant outside their scope (location, team, assigned people, time window), or an external professional or agency worker keeps access after it should have expired.

**Causes**: a missing `tenant_id` predicate; RLS disabled or bypassed (owner role, `BYPASSRLS`, `SECURITY DEFINER` functions); `app.tenant_id` leaking between pooled transactions; a PowerSync stream filter error (logical replication bypasses RLS); cache or search keys without the tenant; a search index, query or result count that crosses the tenant or the user's scope; a break-glass search used to browse, or to find where a person at risk lives; an agency worker with no shift recorded given open-ended access; guessable or long-lived file URLs; export jobs (see HZ-070); operator impersonation; scope grants that do not expire; stale token claims after a role change.

**Effects**: disclosure of special category data and resulting distress; safeguarding risk (for example disclosure of the whereabouts of a person at risk); a wrong-person decision if an out-of-scope record is mistaken for the right one (HZ-001); a reportable personal data breach.

**Initial risk**: severity Major, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | `tenant_id` on every row; RLS enabled with `FORCE ROW LEVEL SECURITY` on every tenant table; the application connects as a non-owner role without `BYPASSRLS` and sets `app.tenant_id` per transaction | Built in Phase 0 |
| Design | Cross-tenant isolation test suite proving every table denies cross-tenant access | Built in Phase 0 |
| Design | Sync streams filtered by the token's tenant, location and assignment claims, tested on their own | Built in Phase 0 |
| Design | Every view of a care record, export and permission change written to the append-only, hash-chained `audit_event` table | Built in Phase 0 for person views, lists, history, break-glass, refusals and sync tokens; extended per module |
| Design | Attribute-based scoping (location, assigned people, time window) enforced in the API and in RLS | Built in Phase 0 (team scope with rotas, Phase 2) |
| Design | Break-glass access with typed justification, alerting the Registered Manager and quality lead, audited with the reason, lapsing after an hour; a weekly report by user, person and reason flags repeated use for the Registered Manager and data protection lead | Built in Phase 0 (weekly report aggregation built in Phase 1; job and screen with the people API) |
| Design | Short-lived presigned file URLs with tenant-prefixed keys; remote wipe and device revocation | Phase 1 |
| Design | Time-limited grants expire automatically (agency workers at shift end plus `access.agency.post_shift_hours`, and an agency worker with no shift recorded gets no access at all; external professionals at their expiry) | Phase 1 (professionals; the agency window rule is built in the domain and search refuses after it), Phase 2 (agency, with rota) |
| Design | Search runs under the same forced RLS as the records (ADR-0070); the plan allows only the kinds of record the user can read, in their scope, while their access lasts, and only current people unless `platform.search.archived` is held and used; results are filtered again and counted only over what may be seen, so an out-of-scope match looks like no match, and a disagreement raises a security alarm ([platform-completions.md](../specs/platform-completions.md) rules 1 to 7) | Phase 1 (domain rules built; index and routes with the schema and API step) |
| Design | Break-glass search: step-up (a sign-in with the second step within the window), MFA, a reason code and a typed reason, a specific query (an NHS number, or at least two name words) matched on whole words of names only (no prefixes, no room labels), identity fields only with location and room withheld until the record is opened, at most 10 people. The search itself alerts the Registered Manager of each location whose people were shown and the data protection lead; `break_glass.search_max_per_day` searches per user in 24 hours, after which further searches are refused and the data protection lead is told (rule 9) | Phase 1 (domain rules built; alert delivery and the weekly report with the API) |
| Design | Search audit events record the kinds searched and left out, the counts, the person scope, location ids, when the user's access ends and the opaque ids shown; people shown count as views of their care records. Never the words typed, which are usually a name; a break-glass search refers to its break-glass record, which holds the typed reason, instead of copying it (rule 8) | Phase 1 (domain rules built) |
| Design | Operator support access only after the tenant owner approves a ticketed request with step-up; requests and decisions written to the tenant's audit chain | Request and approval built in Phase 0; read-only impersonation session, Phase 1 |
| Test | See Verification; annual external penetration test `[Thapsus - human action]` | Phase 0 onwards |
| Training and user documentation | Tenant role-design guidance (least privilege); deployer control: periodic access review by the tenant | Phase 1 |

**Target residual risk**: severity Major, likelihood Very low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/db/test/rls-coverage.test.ts`: `hazard HZ-011 row-level security coverage` (RLS enabled and forced on every table, tenant policy on every tenant table, no DELETE for the app role, append-only grants and triggers, no role with BYPASSRLS or superuser, auth schema closed to the app role, every mutable aggregate versioned) | Passing (Phase 0) |
| `packages/db/test/isolation.test.ts`: `hazard HZ-011 tenant isolation for harbour_app` (no context sees nothing; no table returns another tenant's rows; cross-tenant inserts, updates, moves and foreign keys refused; context never leaks between pooled transactions; malformed tenant ids fail closed) | Passing (Phase 0) |
| `packages/db/test/isolation.test.ts`: `hazard HZ-011 service roles` (operator, sync and auth roles each limited to their tables) | Passing (Phase 0) |
| `packages/db/test/scope.test.ts`: `hazard HZ-011 person scope` (assigned, location, tenant and none scopes; expired assignments; care workers cannot create people or assign themselves) | Passing (Phase 0) |
| `packages/db/test/scope.test.ts`: `hazard HZ-011 break-glass access` (opens a person until expiry; cannot be opened for someone else) | Passing (Phase 0) |
| `packages/sync/test/streams.test.ts`: `hazard HZ-011 cross-tenant isolation`, `care worker (assigned scope)`, `location manager (locations scope)` (real PowerSync rules engine; no other tenant's or out-of-scope rows; no unneeded columns reach a device) | Passing (Phase 0) |
| `apps/api/test/api.test.ts`: `hazard HZ-011 tenancy at the API`, `people scope`, `break-glass access` (not-a-member refusals, 404 for other tenants' ids, MFA gate, step-up, Registered Manager and quality lead alerted, reason audited) | Passing (Phase 0) |
| `apps/api/test/operator-and-integrations.test.ts`: operator console cannot read people; support access needs the tenant owner's step-up approval and is audited in the tenant's chain | Passing (Phase 0) |
| `packages/db/test/tasks-and-workflows.test.ts`: `hazard HZ-011 task scope`, `workflow scope and history` (tasks follow the person's scope, location tasks the location, append-only workflow history) | Passing (Phase 1) |
| `apps/api/test/tasks.test.ts`: tasks about people outside a care worker's scope are hidden and cannot be completed; another tenant's person is not found | Passing (Phase 1) |
| `packages/domain/src/platform/search.test.ts`: `hazard HZ-011 agency access expires at shift end plus 2 hours` (the rate-table window; search refuses after it and a plan made earlier shows nothing) | Passing (Phase 1) |
| `apps/api`: `hazard HZ-011 agency access expires at shift end plus 2 hours` | Planned, Phase 2 |
| `packages/domain/src/platform/search.test.ts`: `hazard HZ-011 search plan follows permission and scope`, `hazard HZ-011 search results and counts stay in scope` (an out-of-scope match looks exactly like no match), `hazard HZ-011 search audit events record what was shown, never the words typed` (scope, location ids, access end, ids shown, care-record views; a break-glass search refers to its record instead of copying the reason) | Passing (Phase 1) |
| `packages/domain/src/platform/search.test.ts`: `hazard HZ-011 break-glass search` (step-up, MFA, reason, specific whole-word query, no prefix match, location and room withheld, the alert to Registered Managers and the data protection lead, the daily limit); `fails closed for an agency worker with no shift recorded` | Passing (Phase 1) |
| `packages/db`: `hazard HZ-011 search returns nothing from another tenant or outside scope` | Planned, Phase 1 |
| `apps/api`: `hazard HZ-011 search routes apply the plan, filter again and audit without the query` | Planned, Phase 1 |
| `packages/db/test/care-record.test.ts` and `apps/api/test/care.test.ts`: notes, charts and marks follow the person's scope | Passing (Phase 1) |
| `packages/db/test/mca-and-incidents.test.ts`: `hazard HZ-011 consent, capacity and DoLS records follow the person's scope` and `hazard HZ-011 incident scope across people and locations (ADR-0033)` (an incident is visible through any of its people, to its reporter, and by location only when nobody using the service is on it; per-person notifications and staff rows follow their own scope; location drafts follow location scope; another tenant sees nothing) | Passing (Phase 1) |
| `apps/api/test/incidents.test.ts`: `hazard HZ-011 incident scope across people (ADR-0033)` (a reader who can see only some of the people gets the header and their own people, with no narrative or reasoning, and cannot change it) | Passing (Phase 1) |
| `packages/domain/src/people/break-glass-report.test.ts`: `hazard HZ-011 weekly break-glass report` (UK weeks across clock changes; totals by user, person and reason; unreviewed openings; repeated use, the same person reopened and one person opened by many users flagged at the rate-table threshold) | Passing (Phase 1) |
| `apps/api`: `hazard HZ-011 the weekly break-glass report reaches the Registered Manager and data protection lead every Monday` | Planned, Phase 1 |
| `packages/sync/test/care-streams.test.ts`: `hazard HZ-011 care record streams` in the assigned and location scopes and across tenants: a person not assigned, an ended assignment, another tenant or a token without a tenant never reaches the device, whatever window the device asks for; connection parameters cannot widen the scope; a malformed window is refused | Passing (Phase 1) |
| `packages/sync/test/streams.test.ts`: stream queries read no connection parameters; `carries live people only in the location-scope care streams`; `care-streams.test.ts`: `takes the care record of people discharged, deceased or archived off managers' devices` (security review S8) | Passing (Phase 1) |

---

## HZ-012 Validated assessment tool calculated incorrectly

| Field | Value |
| --- | --- |
| ID | HZ-012 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `care` module and the forms engine in `platform` (lead engineer) |
| Source | Master prompt 5.2, 10.1; [RCP NEWS2](https://www.rcp.ac.uk/improving-care/resources/national-early-warning-score-news-2/); [BAPEN MUST](https://www.bapen.org.uk/must-and-self-screening/must-calculator); Waterlow scoring card `[authoritative source to be confirmed by CSO - human action]`; [medical-device boundary](../compliance/medical-device-boundary.md) |

**Description**: a NEWS2, MUST or Waterlow score (and later Braden, Abbey, PAINAD and the other tools in master prompt 10.1) is calculated, banded or displayed wrongly, or the wrong version or scale is used (for example NEWS2 SpO2 Scale 2 for a person who has no clinical decision for it).

**Causes**: transcription errors in scoring tables; boundary errors (less than versus less than or equal); unit conversions (weight, height, temperature); rounding of BMI; a missing value treated as zero; a form that pre-selects an answer (for example "Air" and "Alert" on the NEWS2 form), so an unanswered question is scored as normal; a tenant editing a locked template; new confusion not scored as the published value; supplemental oxygen not scored; MUST weight-loss percentage over the wrong period; Waterlow multi-select categories summed wrongly; mixing observations taken at different times.

**Effects**: under-scoring leads to missed deterioration (for example sepsis), missed malnutrition referral or pressure-ulcer prevention not started, causing severe harm or death; over-scoring leads to unnecessary escalation.

**Initial risk**: severity Major, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Validated tools are locked templates implemented exactly as published, with the publisher, edition and source cited in code and on screen; tenants cannot edit scoring | Phase 1 |
| Design | The screen shows every parameter's sub-score, the total and the published banding table, so the user can check the arithmetic | Phase 1 |
| Design | Missing inputs produce no total ("Score incomplete: 2 values missing"), never a partial total | Phase 1 |
| Design | Nothing is pre-selected on the web forms for validated tools; an unanswered question is refused at its own field (NEWS2 air or oxygen, and consciousness). Without the care profile the SpO2 scale is unknown, so vital signs are not offered | Built in Phase 1 slice 9 (web) |
| Design | NEWS2 SpO2 Scale 2 is available only when a registered clinician has recorded that decision and target range on the person's record | Phase 1 |
| Design | The result links to the tenant's escalation policy; Harbour adds no recommendation of its own | Phase 1 |
| Design | Each stored score records the tool edition and the code version that calculated it | Built in Phase 1 slice 4b: the server runs the tool by key and stores the version, answers, score, band and workings; the client never sends a score |
| Design | Waterlow and Braden stay off for real tenants until their licence terms are confirmed (H-25): `care.tool.waterlow` and `care.tool.braden` flags, off by default, on in the demo tenant | Built in Phase 1 slice 4b |
| Design | Fixed units (kg, cm, degrees Celsius) with visible conversion for stones and pounds | Phase 1 |
| Design | The CSO checks each tool implementation against its published source before release, including a spot-check of the NEWS2 reference vectors (the points for every parameter, worked by hand from RCP chart 1) `[CSO - human action]` (human action H-129) | Phase 1 |
| Design | On the phone NEWS2 shows the formula, the published bands, every parameter's points and the RCP chart 4 clinical response, with the source and a link to it; with no SpO2 scale on the device no total is shown and the server scores the readings on upload ([medical-device boundary](../compliance/medical-device-boundary.md) section 5 rules 1 to 3) | Built in Phase 1 (mobile, clinical review C6) |
| Test | See Verification | Phase 1 |
| Training and user documentation | User guide per tool with the published source; deployer control: tenant escalation policy linked in configuration | Phase 1 |

**Target residual risk**: severity Major, likelihood Very low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain` (care): `hazard HZ-012 NEWS2 scores every parameter band boundary as published by the RCP` (table-driven, every boundary value) | Passing |
| `packages/domain` (care): `hazard HZ-012 NEWS2 adds 2 for supplemental oxygen and scores new confusion as published` | Passing |
| `packages/domain` (care): `hazard HZ-012 NEWS2 applies SpO2 Scale 2 only when a clinician decision is recorded` | Passing |
| `packages/domain` (care): `hazard HZ-012 NEWS2 returns incomplete when any parameter is missing` | Passing |
| `packages/domain` (care): `hazard HZ-012 NEWS2 refuses impossible or malformed values rather than scoring them` | Passing |
| `packages/domain` (care): `hazard HZ-012 NEWS2 clinical risk follows RCP chart 2 at every threshold` | Passing |
| `packages/domain` (care): `hazard HZ-012 MUST BMI, weight-loss and acute disease scores match the BAPEN worked examples` | Passing |
| `packages/domain` (care): `hazard HZ-012 MUST bands the exact BMI and rounds it only for display` (18.45, 18.49, 18.5, 19.99, 20.0, 20.01) | Passing |
| `packages/domain` (care): `hazard HZ-012 MUST gives no total for missing or impossible values` | Passing |
| `packages/domain` (care): `hazard HZ-012 Waterlow totals and risk bands match the published scoring card` | Passing |
| `packages/domain` (care): `hazard HZ-012 Waterlow gives no total for missing or contradictory answers` | Passing |
| `packages/domain` (care): `hazard HZ-012 Braden totals and risk bands match the published form` | Passing |
| `packages/domain` (care): `hazard HZ-012 Braden gives no total for missing or impossible subscale scores` | Passing |
| `packages/domain/src/care/validated-assessment.test.ts`: `hazard HZ-012 the tool runs on the server by its key` (MUST, Waterlow, Braden and the NG249 pathway stored with tool version, score, band and workings; the falls pathway with no score and no band; no result for incomplete answers) | Passing |
| `apps/api/test/care-planning.test.ts`: `hazard HZ-012 refuses Braden where its licence flag is off (H-25), and allows it in the demo tenant` | Passing |
| `packages/domain` (platform): `hazard HZ-012 tenants cannot edit locked validated templates` | Planned, Phase 1 |
| `apps/web/e2e/care-record.spec.ts` (Playwright with axe, WCAG 2.2 AA): `hazard HZ-012 a nurse runs MUST and sees the API's score, band, workings, follow-ups and source` (the web sends answers only; the test checks each step's points in the workings, the total, the band in the publisher's words and the source link); `hazard HZ-014 vital signs show the NEWS2 result and the RCP response the API returns` (saving with air or oxygen and consciousness unanswered is refused at those fields) | Passing (local run; CI e2e-web on the PR) |
| `packages/domain/src/care/news2.test.ts`: `hazard HZ-012 NEWS2 matches the reference vectors worked by hand from RCP chart 1` (`NEWS2_REFERENCE_VECTORS`: the points for every parameter as well as the total, so two errors cannot cancel out; every band and chart 4 threshold, both SpO2 scales, a single 3, and the boundaries respiration rate 25, systolic 219 and 220, temperature 35.1, pulse 41 and 50, scale 2 on air, and scale 2 on oxygen at 92 to 97; clinical review round 3). The CSO spot-checks the vectors (H-129) | Passing |
| `apps/mobile/src/care/charts.test.ts`: `hazard HZ-012 NEWS2 on the device against the reference vectors (C6)` (the same vectors from typed readings); `NEWS2 on the device (HZ-012, HZ-014)`: no total without the person's SpO2 scale on the device, the readings kept for the server; the RCP chart 4 clinical response kept with the score; nothing scored until every reading; `components/news2-panel.render.test.ts`: `hazard HZ-012 the NEWS2 panel shows its workings and the published response (C6)` (rendered: the score, the RCP wording, every parameter's points, the formula, bands, policy and source) | Passing (Phase 1, mobile) |
| `apps/web/src/lib/assessments.test.ts`: `hazard HZ-012 names the publisher, edition and source the API calculates from`; `hazard HZ-012 words every MUST and Waterlow band in the catalogue, never by its code` (against the domain's band types); `apps/web/src/lib/assessment-answers.test.ts`: `answer options match the API's contract`; `apps/web/src/lib/chart-entry.test.ts`: `hazard HZ-012 hazard HZ-014 refuses vital signs until air or oxygen and consciousness are chosen` | Passing (Phase 1 slice 9) |
| `apps/web` Playwright: `hazard HZ-012 the score screen shows the full published banding table beside the band` | Planned, Phase 1 |

---

## HZ-013 Statutory notification missed or late

| Field | Value |
| --- | --- |
| ID | HZ-013 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `safety` module (lead engineer) |
| Source | Master prompt 4 (`safety.notification.submit`), 11.1; [CQC Registration Regulations 2009 Reg 18](https://www.legislation.gov.uk/uksi/2009/3112/regulation/18); [RIDDOR](https://www.hse.gov.uk/riddor/when-do-i-report.htm); [Care Act 2014 s.42](https://www.legislation.gov.uk/ukpga/2014/23/section/42) |

**Description**: a notifiable event (CQC death or other incident notification, RIDDOR report, safeguarding referral, UKHSA outbreak report, duty of candour notification) is not identified, not drafted, not submitted, or submitted late.

**Causes**: the incident is not recorded; a classifier question is answered wrongly or the rule is wrong or out of date (for example after the June 2026 Supreme Court judgment on deprivation of liberty); no holder of `safety.notification.submit` is available and no acting-up grant is in place; the deadline clock starts late or from the wrong time; a notification job fails silently; alert fatigue (HZ-008); an incident recorded offline is not synced (HZ-006).

**Effects**: a person remains at risk of abuse; the regulator cannot act; an outbreak spreads; the family is not told what happened; regulatory enforcement against the tenant.

**Initial risk**: severity Major, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Notification centre with escalation chains | Built in Phase 0 |
| Design | Incident classifier with structured questions produces each required output (master prompt 11.1); rules are table-driven, versioned and dated with their source regulation and nation, not hard-coded | Phase 1 |
| Design | Deadline clocks start from the recorded event or awareness time; deadlines come from the rate table ([rates.md](../specs/rates.md)), not literals in code; clocks show on the incident, the Registered Manager dashboard and the notification centre, and escalate before breach to the Registered Manager, then the Nominated Individual | Phase 1 |
| Design | Submission requires `safety.notification.submit` with step-up authentication; when no holder is available the system prompts an acting-up grant | Phase 1 |
| Design | An incident recorded offline is classified on sync with its clock started at the recorded event time and a flag if the clock is already running late | Phase 1 |
| Design | A notification decision cannot close without submission evidence or a recorded "not notifiable" reason | Phase 1 |
| Design | Weekly digest of open notification decisions to the Registered Manager and Nominated Individual | Phase 1 |
| Design | An "unsure" answer drafts a provisional notification with its clock; an unanswered question raises a task due at the event time; outside England the classifier says notifications are not checked rather than giving a partial answer (`packages/domain/src/safety/classifier.ts`) | Phase 1 (domain rules built) |
| Design | An incident cannot close while a notification is a draft or ready, a classifier question is open or the candour record is open (`incidentCloseProblems`) | Phase 1 (domain rules built) |
| Design | The classifier runs on the server whenever an incident is created, synced, changed or answered, with tenant-wide scope so it always reads every person on the incident (ADR-0033); it stores its version and reasoning, writes one draft per incident and kind (per person for deaths, LeDeR, the medical examiner pack and missing people) with clocks from `occurred_at`, and a draft that a later answer no longer supports is flagged, never closed, until a holder of `safety.notification.submit` marks it not required with a reason and step-up (`apps/api/src/services/safety.ts`) | Phase 1 (built) |
| Design | An overdue draft alerts the holders of `safety.notification.submit` at its location once, through the tenant's `safety.notification.overdue` escalation chain (by default the Nominated Individual after `statutory_notification.escalation_minutes`, H-69), until it is submitted or marked not required; closing an incident counts drafts about people the closer cannot see | Phase 1 (built) |
| Design | Safeguarding log and outbreak register feed the same clocks | Phase 2 |
| Test | See Verification | Phase 1, Phase 2 |
| Training and user documentation | User guide states that the classifier supports, and never replaces, the Registered Manager's judgement. Deployer control: tenant notifications policy and acting-up arrangements for absences | Phase 1 |

**Target residual risk**: severity Major, likelihood Low, **risk 3**.

**Justification for level 3**: Harbour cannot ensure an incident is recorded, and submission is a human decision by a named role. Harbour makes the obligation and its deadline visible and escalates; further reduction is impractical without automating a regulated judgement. `[CSO acceptance - human action]`

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain` (safety): `hazard HZ-013 classifier produces the required notifications for each incident scenario` (`classifier.test.ts`: 21 scenarios that together produce every output kind across CQC, RIDDOR, safeguarding, candour, LeDeR, medical examiner, missing person and UKHSA) | Passing |
| `packages/domain` (safety): `hazard HZ-013 classifier exclusions say why` (every exclusion with its reason) | Passing |
| `packages/domain` (safety): `hazard HZ-013 RIDDOR asks the work-activity, premises or equipment question first` (a fall from the person's own condition is not reportable and the reasoning is recorded) | Passing |
| `packages/domain` (safety): `hazard HZ-013 harm thresholds come from the rate table` (Reg 18 and candour thresholds at and below the figure; the threshold decision wins) | Passing |
| `packages/domain` (safety): `hazard HZ-013 deadline clocks read their periods from the rate table` (without-delay kinds overdue at once; RIDDOR across the October and March clock changes; candour working days across the Christmas bank holidays) | Passing |
| `packages/domain` (safety): `hazard HZ-013 an incident recorded offline starts its clock at the recorded event time` | Passing |
| `packages/domain` (safety): `hazard HZ-013 open questions, provisional drafts and tasks` | Passing |
| `packages/domain` (safety): `hazard HZ-013 nations and questions` (no partial answer outside England; answer validation) | Passing |
| `packages/domain` (safety): `hazard HZ-013 safety figures come from the rate table` | Passing |
| `packages/domain` (safety): `hazard HZ-013 an unacted clock escalates to the Nominated Individual before breach` | Planned, Phase 1 |
| `packages/domain` (safety): `hazard HZ-013 only a holder of safety.notification.submit with step-up can submit` (`workflows.test.ts`, the workflow rules) | Passing |
| `apps/api/test/incidents.test.ts`: `hazard HZ-013 only a holder of safety.notification.submit with step-up can submit` (and the submission time with a reference or the form) | Passing |
| `apps/api/test/incidents.test.ts`: `hazard HZ-013 marking not required needs step-up and a reason, and is audited with it` | Passing |
| `apps/api/test/incidents.test.ts`: `hazard HZ-013 an overdue notification escalates through the chain until it is submitted` (one alert per draft, the chain's step to the Nominated Individual, alerts acknowledged on submission) | Passing |
| `apps/api/test/incidents.test.ts`: `hazard HZ-013 an incident recorded offline that syncs late runs its clocks from occurred_at` and `ignores an offline incident replayed with the same device id` | Passing |
| `apps/api/test/incidents.test.ts`: `hazard HZ-013 the classifier runs on the server` (version and reasoning stored, open questions with a task due at the event time, provisional drafts for not sure, drafts no longer indicated kept for a person to decide, `nationSupported` false outside England) | Passing |
| `apps/api/test/incidents.test.ts`: `hazard HZ-013 refuses to close while questions or drafts are open, and refuses the person who raised it` | Passing |
| `packages/db/test/mca-and-incidents.test.ts`: `hazard HZ-013 refuses an incident closed by the person who raised it` (database check) | Passing |
| `apps/api/test/incidents.test.ts`: `hazard HZ-013 drafts the UKHSA report once two linked respiratory cases start within the window` and `records the candour threshold decision, which the classifier follows, and the candour steps` | Passing |
| `packages/domain` (safety): `hazard HZ-013 a decision cannot close without evidence or a not-notifiable reason` | Passing |
| `packages/domain` (safety): `hazard HZ-013 incident workflow: the person who raised it cannot close it` | Passing |
| `packages/domain` (safety): `hazard HZ-013 duty of candour steps follow regulation 20` | Passing |
| `packages/domain` (safety): `hazard HZ-013 the outbreak rule fires for linked cases within the configured window` (`outbreak.test.ts`; the rule landed in Phase 1) | Passing |
| `packages/domain/src/people/exit.test.ts`: `hazard HZ-013 lists the statutory notifications first` (the death checklist names the regulator, medical examiner and LeDeR notifications that the safety module drafts) | Passing (Phase 1) |

---

## HZ-014 Deterioration score or screening trigger not acted on

| Field | Value |
| --- | --- |
| ID | HZ-014 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `care` module (lead engineer) |
| Source | Master prompt 10.1 (NEWS2, MUST); [RCP NEWS2](https://www.rcp.ac.uk/improving-care/resources/national-early-warning-score-news-2/); [BAPEN MUST](https://www.bapen.org.uk/must-and-self-screening/must-toolkit/) |

**Description**: a NEWS2 score or MUST result that calls for a response (for example NEWS2 of 5 or more, or a single parameter scoring 3; MUST medium or high) is calculated correctly but the nurse in charge is not told, or the follow-up (repeat observations, food record, dietitian referral) is not scheduled.

**Causes**: the result is shown only on the screen where it was entered; no task or alert is raised; the alert goes to someone off shift; the follow-up interval is wrong; offline entry delays the alert (HZ-006); alert fatigue (HZ-008).

**Effects**: deterioration goes unnoticed until the person is seriously unwell; malnutrition progresses; avoidable hospital admission or death.

**Initial risk**: severity Major, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Every validated result stores the published response band; bands that call for action raise a task and an urgent notification to the nurse in charge on shift, escalating through the location's chain until acknowledged | Phase 1 |
| Design | Follow-ups are generated from the band: repeat observation frequency for NEWS2, a food record for MUST medium risk, a dietitian referral task for MUST high risk; intervals come from the rate table where they are defaults | Phase 1 |
| Design | Stored MUST results schedule the next screening (`must.care_home.screening_interval_months`) and weighing (weekly at medium or high risk, otherwise monthly, from the rate table) as tasks, one open task of each kind at a time; a recorded weight answers the weight check; a correction raises only the follow-ups the original did not | Built in Phase 1 slice 4b |
| Design | Results entered offline raise the task on the device immediately and the alert on sync, with the original time | Phase 1 |
| Design | Handover always includes NEWS2 above the low band (an aggregate of 5 or more, or a single parameter scoring 3) and MUST follow-ups raised in the shift (HZ-018) | Phase 1 |
| Design | Go-live waits until a working deterioration escalation chain exists and every validated tool switched on links the tenant's escalation policy (onboarding items `escalation_chains_set` and `escalation_policies_linked`, [platform-completions.md](../specs/platform-completions.md) rule 26) | Phase 1 (domain rules built) |
| Training and user documentation | User guide: the score supports clinical judgement and the published response, never replaces it; deployer control: escalation policy and on-shift nurse in charge set per location | Phase 1 |

**Target residual risk**: severity Major, likelihood Low, **risk 3**.

**Justification for level 3**: Harbour raises, routes and escalates the response, but acting on it is a clinical decision by the staff on shift; further reduction would mean automating a clinical judgement, which the medical-device boundary rules out. `[CSO acceptance - human action]`

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain` (care): `hazard HZ-014 NEWS2 bands that call for a response raise a task and an urgent alert` | Passing |
| `packages/domain` (care): `hazard HZ-014 MUST medium and high risk schedule the food record and the dietitian referral` | Passing |
| `packages/domain` (care): `hazard HZ-014 Waterlow nutrition score over 2 raises a nutrition assessment task` | Passing |
| `packages/domain/src/care/validated-assessment.test.ts`: `hazard HZ-014 MUST high risk raises the dietitian referral and sets the next screening date`; `hazard HZ-014 MUST at medium or high risk weighs weekly; low risk monthly (rate table)` | Passing |
| `apps/mobile/src/care/charts.test.ts`: `NEWS2 on the device (HZ-012, HZ-014)`: `shows a raised score at once, with the published response` with no signal; the API recalculates on upload and raises the alert and tasks | Passing (Phase 1, mobile) |
| `apps/api/test/care-planning.test.ts`: `hazard HZ-014 MUST high raises the dietitian referral and sets next_due_on` (the rescreen and weight-check tasks are scheduled, one open at a time, and the next result answers the rescreen); `a weight answers the weight check and schedules the next at the MUST interval` | Passing |
| `apps/api`: `hazard HZ-014 an urgent assessment alert escalates until acknowledged` | Planned, Phase 1 |
| `apps/api/test/care.test.ts`: `hazard HZ-012 and HZ-014 NEWS2 vital signs` (a high score alerts the nurse in charge and creates the urgent response and continuous-monitoring tasks; a score of 0 schedules nothing outside the care plan) | Passing |
| `packages/domain/src/platform/onboarding.test.ts` (go-live clinical items): `hazard HZ-014 a deterioration alert with no escalation chain`, `hazard HZ-014 NEWS2 switched on with no escalation policy linked` | Passing (Phase 1) |
| `apps/web/src/lib/charts.test.ts`: `hazard HZ-014 reads the score, band and the RCP's response wording as stored`; `hazard HZ-014 counts workings it cannot read, and never assumes SpO2 scale 1`; `apps/web/src/lib/assessments.test.ts`: `hazard HZ-014 never shows a result that raised something unknown as if it raised nothing`; `apps/web/src/lib/assessments.test.ts`: `hazard HZ-014 says what a result raised in the API's words, and leaves out what it cannot read` | Passing (Phase 1 slice 9) |
| `apps/web/e2e/care-record.spec.ts` (Playwright with axe, WCAG 2.2 AA): `hazard HZ-014 vital signs show the NEWS2 result and the RCP response the API returns` (score 6, clinical risk Medium, "Key threshold for urgent response", minimum 1 hourly, with the workings) | Passing (local run; CI e2e-web on the PR) |

---

## HZ-015 Resuscitation decision missing, out of date or not visible

| Field | Value |
| --- | --- |
| ID | HZ-015 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `care` module (lead engineer) |
| Source | Master prompt 10.1 (end of life); [ReSPECT](https://www.resus.org.uk/respect); hazard-log candidate list |

**Description**: staff cannot see, at the moment they need it, whether the person has a ReSPECT plan, DNACPR decision or advance decision to refuse treatment, or they see one that has been withdrawn or replaced.

**Causes**: the document is filed but not flagged; an old version is shown; the record is not available offline or in the downtime pack; the hospital transfer pack omits it; on the web, a header kept from an earlier tab after a colleague withdrew or recorded a decision (HZ-002); a status the screen does not know shown as if it were "Attempt CPR".

**Effects**: resuscitation attempted against the person's wishes, or not attempted when it should have been; distress to the person and family.

**Initial risk**: severity Major, likelihood Low, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | The point-of-care header shows the current resuscitation status (word and icon) with the date and clinician; a missing record shows as 'Not recorded', never as blank | Built in Phase 1 slice 9 (web: a warning chip that says to check the paper record; records that disagree are the strongest warning; an overdue review keeps the decision and says it still stands); mobile in slice 10 |
| Design | The person summary every point-of-care header reads carries the resuscitation status in force from an active ReSPECT or DNACPR record, with the clinician and dates, or `not_recorded`; records in force that disagree are flagged; a passed review date never hides a decision | Built in Phase 1 slice 4b (screens in slice 9) |
| Design | Go-live waits until every current person has a resuscitation status, either a decision in force or a recorded "no decision in place"; the full export's current summary gives the decision in force, or `conflicting` with every record in force ([platform-completions.md](../specs/platform-completions.md) rules 10 and 26) | Phase 1 (domain rules built) |
| Design | Only one active record per kind; recording a new one supersedes the old; review dates raise tasks | Built in Phase 1 slice 4b (database partial unique index; hourly review job) |
| Design | The web header is read again on every tab move and says when (HZ-002); the resuscitation status is checked against the API's schema, and one that cannot be read, or that this version does not know, shows "CPR decision could not be read" as the strongest warning, never "Attempt CPR". Withdrawing a ReSPECT plan or DNACPR decision says first that the header will then show "CPR decision not recorded" unless another record is in force | Built in Phase 1 slice 9 (web) |
| Design | Advance care records are reference data on the device (never evicted while assigned), in the downtime pack and in the hospital transfer pack | Phase 1 |
| Design | On the downtime pack, every active ReSPECT and DNACPR record prints, newest first, with its clinician and dates. Records that disagree mark the section itself as conflicting, with the words "Resuscitation records disagree. Every record in force is listed here. Harbour does not choose between them: check the signed forms and follow the home's policy." A passed review date is noted and never hides the decision ([operations.md](../specs/operations.md) rule 5; wording for the CSO to confirm, H-100) | Phase 1 (domain rules built, slice 11) |
| Training and user documentation | Deployer control: the original signed form stays with the person as the home's policy requires; Harbour shows the record, it is not the legal document | Phase 1 |

**Target residual risk**: severity Major, likelihood Very low, **risk 2**.

**Verification**

| `apps/mobile/src/care/person-summary.test.ts`: `hazard HZ-015 resuscitation status in the header` (not recorded with a warning, never blank; DNACPR and ReSPECT decisions as word and icon with the form and clinician; an overdue review keeps the decision and is spoken; records that disagree flagged; withdrawn and unreadable rows ignored); `queries.test.ts`: `hazard HZ-015 resuscitation status from the device's records` | Passing (Phase 1, mobile) |
| `packages/sync/test/care-streams.test.ts`: `hazard HZ-015 only advance care records in force, and active risk assessments` | Passing (Phase 1) |
| Test | Status |
| --- | --- |
| `packages/domain/src/care/advance-care.test.ts`: `hazard HZ-015 a missing resuscitation record shows as not recorded`; `hazard HZ-015 the current resuscitation status` (latest decision, conflicts flagged, withdrawn and superseded records ignored, overdue review keeps the decision) | Passing |
| `packages/db/test/care-planning.test.ts`: `hazard HZ-015 only one advance care record of each kind is active` | Passing |
| `packages/contracts/src/contracts.test.ts`: `hazard HZ-015 needs a resuscitation status on every point-of-care summary` | Passing |
| `packages/domain/src/platform/onboarding.test.ts`: `hazard HZ-015 no resuscitation status`, `hazard HZ-015 a recorded 'no decision in place' counts` (person readiness) | Passing (Phase 1) |
| `apps/api/test/care-planning.test.ts`: `hazard HZ-015 advance care records and the resuscitation status` (a DNACPR shows on the person summary and list; superseding and withdrawal) | Passing |
| `apps/api`: `hazard HZ-015 the transfer pack and the downtime pack include the current resuscitation record` | Planned, Phase 1 |
| `packages/domain/src/operations/downtime-pack.test.ts`: `hazard HZ-015 resuscitation status on the downtime pack` (`prints the decision in force`; `marks a conflict between ReSPECT and DNACPR in the section itself, and prints every record in force`; `prints two records that agree without a conflict`; `notes a decision past its review date without hiding it`; `puts safety-critical gaps and conflicts first on the front sheet`) | Passing (Phase 1, slice 11) |
| `packages/domain/src/people/pre-admission.test.ts`: `hazard HZ-015 requires the resuscitation and advance care section` | Passing (Phase 1) |
| `packages/domain/src/people/transfer-pack.test.ts`: `hazard HZ-015 no resuscitation record`, `only a withdrawn resuscitation record`, `prints only the active resuscitation record` | Passing (Phase 1) |
| `apps/web/src/lib/care-record.test.ts`: `hazard HZ-015 a missing decision reads as a warning, never blank or calm`; `a DNACPR decision shows the word, icon, source and clinician`; `an overdue review keeps the decision and says it still stands`; `records that disagree are the strongest warning`; `a status that could not be read, or is unknown, is a warning, never 'Attempt CPR'`; `keeps the person but marks a resuscitation status it cannot read` | Passing (Phase 1 slice 9) |
| `apps/web/e2e/care-record.spec.ts` (Playwright with axe, WCAG 2.2 AA): `hazard HZ-001 hazard HZ-015 the header shows the resuscitation status, allergies and IDDSI levels on every tab, and 'not recorded' as a warning`; `hazard HZ-015 a DNACPR decision recorded on the advance care tab shows in the header on every tab`; `hazard HZ-002 hazard HZ-015 a colleague's change to the CPR decision shows in the header after one tab move` | Passing (local run; CI e2e-web on the PR) |

---

## HZ-016 Wrong IDDSI diet or fluid texture displayed or recorded

| Field | Value |
| --- | --- |
| ID | HZ-016 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `care` module (lead engineer) |
| Source | Master prompt 10.1 (food chart with IDDSI); [IDDSI framework](https://www.iddsi.org/framework); hazard-log candidate list |

**Description**: the person's prescribed IDDSI food or drink level is shown wrongly, or food or fluid of a different level is recorded as given without challenge.

**Causes**: levels shown as numbers only; the prescribed level is out of date after a speech and language therapy review; the food chart accepts any level silently; a form that pre-selects the prescribed level, so the record says the right texture was given without anyone choosing it; a drink level left optional when one is prescribed; a viewer who cannot read the care profile told "No level prescribed". Added in slice 11: food and drink levels merged on a printout, so a missing drink level hides behind a recorded food level; a stored code that is not an IDDSI level printed as if it were one.

**Effects**: choking, aspiration pneumonia, death.

**Initial risk**: severity Major, likelihood Low, **risk 3**.

| Design | Go-live waits until every current person has IDDSI food and drink levels recorded ([platform-completions.md](../specs/platform-completions.md) rule 26) | Phase 1 (domain rules built) |
**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | The prescribed food and drink levels show with their IDDSI number, name and colour in the header and on the food and fluid charts | Built in Phase 1 slice 9 (web: the header, and beside the level chosen on the food and drink forms, which ask for a reason on a mismatch); mobile in slice 10 |
| Design | Recording a level that does not match the prescribed level needs an override reason and raises an alert to the nurse in charge | Phase 1 |
| Design | The web food and drink forms pre-select no level: the texture given is chosen every time, with the prescribed level shown beside it. A drink level is required when one is prescribed (the API to require it too: a planned API change, listed in care.md section 10). A viewer who cannot read the care profile is told the prescribed level is not available to them; the header says so too | Built in Phase 1 slice 9 (web) |
| Design | A change of prescribed level records who changed it, on whose advice, and shows as new for 72 hours | Phase 1 |
| Design | The downtime pack shows the food level and the drink level as two separate safety-critical sections, each with number, name and colour. A missing level reads "not recorded" with "check before giving food or drink"; a stored code that is not an IDDSI level reads "This could not be read from the record. Check the record before giving food or drink." and never stops the pack ([operations.md](../specs/operations.md) rules 1 and 6) | Phase 1 (domain rules built, slice 11) |
| Training and user documentation | Deployer control: kitchen and dietary profiles are kept in step (Phase 3 catering links them) | Phase 1 |
| Design | With a drink level prescribed, a drink is recorded with its level; with no care profile on the device the header and the chart say "Food and drink levels are not on this device. Check with the nurse in charge.", and a level, or a drink recorded with no level, is accepted only once the carer confirms they checked it with the nurse in charge | Built in Phase 1 (mobile, clinical reviews C3 and round 3 M3) |
| Design | The server stores an unsafe IDDSI entry with an alert to the nurse in charge instead of refusing it, so the record of what was given is never lost | Phase 1 (API follow-up) |

**Target residual risk**: severity Major, likelihood Very low, **risk 2**.

**Verification**
| `packages/domain/src/platform/onboarding.test.ts`: `hazard HZ-016 no IDDSI drink level`, `hazard HZ-016 no IDDSI food level` (person readiness) | Passing (Phase 1) |

| Test | Status |
| --- | --- |
| `packages/domain` (care): `hazard HZ-016 a food entry at a different IDDSI level needs an override reason` | Passing |
| `packages/domain` (care): `hazard HZ-016 recorded IDDSI levels are checked against the prescribed level` | Passing |
| `packages/domain` (care): `hazard HZ-016 IDDSI levels show number, name and colour` | Passing |
| `apps/web/src/lib/care-record.test.ts`: `hazard HZ-016 food level 5 shows number, name and colour` (and the other levels, and no level prescribed); `apps/web/src/lib/charts.test.ts`: `hazard HZ-016 shows IDDSI levels with number, name and colour` | Passing (Phase 1 slice 9) |
| `apps/web/e2e/care-record.spec.ts` (Playwright with axe, WCAG 2.2 AA): `hazard HZ-016 food at a texture other than the prescribed level is refused without a reason` (the header shows the prescribed level; the form shows it beside the choice with nothing chosen; saving without a level is refused at the level; the API's refusal is shown in the catalogue's words at the level and the reason, then the entry with its reason is saved) | Passing (local run; CI e2e-web on the PR) |
| `apps/mobile/src/care/charts.test.ts`: `hazard HZ-016 IDDSI levels on food and drink` (the prescribed level beside the choice; food more solid or a drink thinner than prescribed refused without a reason and marked unsafe; a softer level refused without a reason; saved with a reason and the alert flag); `person-summary.test.ts`: `hazard HZ-016 prescribed IDDSI levels in the header` | Passing (Phase 1, mobile) |
| `apps/mobile/src/care/charts.test.ts`: `hazard HZ-016 food and drink levels on the device (C3)` (a drink needs its level when one is prescribed; a level is blocked without a profile until confirmed), `hazard HZ-016 asks the same confirmation for a drink with no level when the profile is not on the device (round 3 M3)`; `person-summary.test.ts`: `warns that the levels are not recorded when the profile is not on the device (C3)`; `person-header.render.test.ts`: `hazard HZ-016 says the food and drink levels are not recorded when the profile is not on the device (C3)` | Passing (Phase 1, mobile) |
| `apps/web/src/lib/chart-entry.test.ts`: `hazard HZ-016 needs the texture given for food, and for a drink when a level is prescribed`; `apps/web/src/lib/refusals.test.ts`: `hazard HZ-016 puts a texture without its reason at the reason and the level`; `apps/web/src/lib/care-record.test.ts`: `hazard HZ-016 marks a care profile it cannot read` | Passing (Phase 1 slice 9) |
| `apps/api/test/care.test.ts`: `hazard HZ-016 IDDSI levels` (a level change needs who advised it; food above the prescribed level needs a reason and alerts) | Passing |
| `packages/domain/src/people/pre-admission.test.ts`: `hazard HZ-016 never lets eating, drinking and swallowing be marked not applicable`; `transfer-pack.test.ts`: `hazard HZ-016 re-checks allergies, resuscitation decisions and IDDSI levels on return` | Passing (Phase 1) |
| `packages/domain/src/operations/downtime-pack.test.ts`: `hazard HZ-016 tells staff to check before giving food or drink when a level is missing`; `hazard HZ-016 an unreadable IDDSI code says check the record and never stops the pack` (food, drink, both); `hazard HZ-016 shows IDDSI levels with number, name and colour` | Passing (Phase 1, slice 11) |

---

## HZ-017 Late or retrospective entry mistaken for a contemporaneous record

| Field | Value |
| --- | --- |
| ID | HZ-017 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `care` module (lead engineer) |
| Source | Master prompt 10.1 (late-entry flag), 13.4 (downtime forms and back-entry workflow), 18 (times); [NMC record keeping](https://www.nmc.org.uk/standards/code/read-the-code-online/) |

**Description**: a note, chart entry or incident written long after the event, or backdated, reads as if it were written at the time, so decisions or investigations rely on it wrongly.

**Causes**: only one time stored; device clock wrong (HZ-010); offline entries synced days later; edits overwrite the original. Added in slice 11: care written on paper during an outage and entered hours later (back-entry) without saying so; the paper time mistyped, or outside the outage it belongs to; the same paper form entered twice by two staff (a fluid chart double-counted); paper forms never entered at all. Added in the slice 11 review: a paper time written in the hour the clocks skip or repeat (HZ-009); a paper record typed in through the normal care screen, so it looks contemporaneous; the same event recorded on paper and on a device that stayed online (paper against digital); the person who entered the forms also signing off the reconciliation.

**Effects**: misleading care history; unsafe decisions based on charts that look complete; investigations and inquests misled.

**Initial risk**: severity Considerable, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Every entry stores the event time, the device time and the server-received time; entries recorded more than the rate-table late-entry threshold after the event are flagged late everywhere they appear | Phase 1 |
| Design | Entries are append-only; a correction supersedes the original with a reason and both remain readable | Phase 1 |
| Design | Future event times beyond the clock-drift tolerance are refused | Built in Phase 1 (mobile, clinical review round 3 H1; HZ-010) |
| Design | A correction keeps the original entry's instant exactly by default; "When" is today unless the carer chooses an earlier day within the offline window, and says which date and time will be recorded (with BST or GMT on a clock-change day). A time still to come today is refused, never dated yesterday on its own: yesterday only through the day choice | Built in Phase 1 (mobile, clinical reviews C4 and round 3 H1) |
| Design | Paper times (`resolvePaperTime` in `packages/domain/src/operations/outage.ts`, using `resolveRecordedUkTime`): the date and time written on the form are kept as written; a time in the skipped spring hour is refused, a time in the repeated autumn hour must say which one, and a time ahead of the clock is refused ([operations.md](../specs/operations.md) rule 11; HZ-009) | Phase 1 (domain rules built, slice 11) |
| Design | Back-entry from paper (`checkBackEntry`): the resolved paper time is the event time, the late-entry reason is `downtime` and the entry names its declared outage at the person's location; a paper time outside the outage window is refused unless a reason is given, which is shown with the entry; every back-entry carries the words "Written on paper ... during the outage ... Entered in Harbour ... on the device, received ..." (the device time and the server-received time) wherever it appears (operations.md rule 12) | Phase 1 (domain rules built, slice 11; columns and routes with the schema and API step) |
| Design | Through the normal route (`checkEntryAgainstOutages`): any care entry whose event time falls inside a declared outage at its location, but which was written after the outage ended or past the late-entry threshold, must carry back-entry details or say why it is not from paper; entries made at the time on a device that kept working offline are allowed (operations.md rule 13) | Phase 1 (domain rules built, slice 11) |
| Design | Possible duplicates (`possibleDuplicateBackEntries`, `checkOutageReconciliation`): entries for the same person and kind within `downtime.duplicate_match_minutes` of each other are grouped, paper against paper and paper against digital, unless their form references differ; an outage cannot be reconciled until each group is reviewed and a manager says what was checked; the reconciler cannot be anyone who entered records for that outage; the summary counts forms entered and entries without a form reference; overdue back-entry escalates after `downtime.back_entry_due_hours` (operations.md rules 10 and 14) | Phase 1 (domain rules built, slice 11) |

**Target residual risk**: severity Considerable, likelihood Low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain` (care): `hazard HZ-017 entries older than the late-entry threshold are flagged late` | Passing |
| `packages/domain` (care): `hazard HZ-017 future event times beyond the clock-drift tolerance are refused` | Passing |
| `packages/db/test/care-record.test.ts`: `hazard HZ-017 notes and observations cannot be updated or deleted by the app` | Passing |
| `packages/db/test/care-record.test.ts`: corrections supersede; replayed device ids are ignored | Passing |
| `apps/mobile/src/care/notes.test.ts`: `hazard HZ-017 late and corrected notes` (event time and time written kept apart; a correction supersedes with a reason, never an edit); `entry-view.test.ts`: `hazard HZ-017 corrections and late entries in lists`; `queries.test.ts`: `hazard HZ-017 a note written on the device and its correction read back as one current entry`; `sync/care-upload.test.ts`: `hazard HZ-017 sends a correction with the entry it supersedes and the reason` | Passing (Phase 1, mobile) |
| `apps/mobile/src/care/notes.test.ts`: `hazard HZ-017 a correction keeps the original's event time by default (C4)`, `hazard HZ-017 dates a note yesterday only when the carer chooses yesterday (C4)`; `time.test.ts`: `hazard HZ-017 earlier days within the offline window (C4)`, `hazard HZ-017 a correction keeps the original instant unchanged (C4)` | Passing (Phase 1, mobile) |
| `apps/api/test/care.test.ts`: `hazard HZ-017 flags a note written hours after the event, not one synced late`; `corrects by superseding with a reason; the original stays readable` | Passing |
| `packages/db/test/care-planning.test.ts`: `hazard HZ-017 assessments, activities and visits are append-only` (UPDATE and DELETE refused for the app and by trigger; a correction supersedes with a reason and only for the same person; replayed device ids ignored) | Passing |
| `packages/domain/src/care/validated-assessment.test.ts`: `hazard HZ-017 corrections supersede with a reason` | Passing |
| `apps/api/test/care-planning.test.ts`: `hazard HZ-017 corrects a result by superseding it with a reason, and reads the latest per tool`; `hazard HZ-017 ignores a replayed upload with the same device id` | Passing |
| `packages/domain/src/operations/outage.test.ts`: `hazard HZ-017 a back-entry carries the paper time, the downtime reason and its outage` (accepted inside the window with its label; refused with no outage, an unknown or cancelled outage, an outage at another location, a future paper time, an entry before the outage began, or a time outside the window without a reason) | Passing (Phase 1, slice 11) |
| `packages/domain/src/operations/outage.test.ts`: `hazard HZ-017 a back-entry outside the outage window needs a reason, and shows it` | Passing (Phase 1, slice 11) |
| `packages/domain/src/operations/outage.test.ts`: `hazard HZ-009 hazard HZ-017 a time in the hour skipped on 29/03/2026 is refused`; `hazard HZ-009 hazard HZ-017 a time in the hour repeated on 25/10/2026 asks which one`; `hazard HZ-009 hazard HZ-017 resolves the repeated hour to the earlier time the person chose` (and the later) | Passing (Phase 1, slice 11) |
| `packages/domain/src/operations/outage.test.ts`: `hazard HZ-017 an entry through the normal route for a time inside an outage must say whether it is from paper` | Passing (Phase 1, slice 11) |
| `packages/domain/src/operations/outage.test.ts`: `hazard HZ-017 possible duplicates are listed for review, paper against paper and paper against digital`; `hazard HZ-017 reconciling an outage` (duplicates unreviewed, a reconciler who entered records, no statement, the forms count) | Passing (Phase 1, slice 11) |
| `apps/api`: `hazard HZ-017 a back-entry through each care route keeps the paper time and shows the label` | Planned, Phase 1 (schema and API step) |
| `apps/web/src/components/care/EntryBadges.test.ts`: `hazard HZ-017 says an entry was written late, with when it was recorded, in words and an icon`; `apps/web/src/lib/uk-time.test.ts`: the HZ-009 and HZ-017 entry time tests (a time later than now is refused; a note correction keeps the original instant) | Passing (Phase 1 slice 9) |

---

## HZ-018 Safety-critical item omitted from shift handover

| Field | Value |
| --- | --- |
| ID | HZ-018 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `care` module (lead engineer) |
| Source | Master prompt 10.1 (tasks and rounds), 15.1 (handover) |

**Description**: the incoming shift is not told about a fall, a raised NEWS2, a refusal, a new wound, an open incident or an overdue task from the outgoing shift.

**Causes**: handover written from memory; compiled list editable so items are removed; items recorded offline sync after the handover is compiled; nobody acknowledges it; the configured shift pattern does not match the real rota (an event just before the configured start belongs to the wrong shift); a fall or refusal recorded only in free text or in a chart field the compiler does not read; an urgent alert or a skipped task outlives the shift it was raised in; a late addition arrives after the receiving shift has gone home.

**Effects**: missed observation or treatment; repeated harm; delayed escalation.

**Initial risk**: severity Major, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Handover compiles automatically from the shift's records by rule (falls, NEWS2 above the low band, incidents, urgent alerts raised in the shift or still unacknowledged, new body-map marks, overdue, skipped and unfinished tasks, MUST follow-ups, refusals from every chart that records one and from fixed note tags); compiled items cannot be removed, only annotated | Phase 1 |
| Design | Shift patterns are set per location to the minute with two or more shifts; the defaults are flagged for confirmation before go-live | Phase 1 |
| Design | Items that sync after compilation are appended to both affected handovers and marked as late additions; the incoming staff are notified while on shift, otherwise the nurse in charge on duty | Phase 1 |
| Design | Each incoming member of staff acknowledges the handover; an acknowledgement records the items seen, so a late addition makes it pending again and shows only the new items; unacknowledged handovers show on the nurse-in-charge view | Phase 1 |

**Target residual risk**: severity Major, likelihood Very low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain/src/care/handover.test.ts`: `hazard HZ-018 handover includes every safety-critical item from the shift` (falls, NEWS2 above low including a single parameter of 3, incidents, urgent alerts including unacknowledged ones from earlier shifts, new body-map marks, overdue, skipped and unfinished tasks, MUST follow-ups, refusals; entries synced late count for the shift that received them; a 13-hour night at the clock change) | Passing (domain) |
| `packages/domain/src/care/handover.test.ts`: `hazard HZ-018 items synced after compilation are appended as late additions` (items are never removed; an acknowledgement covers the items seen, including one made in the same instant as a late addition; late additions reach the nurse in charge once the receiving shift has ended) | Passing (domain) |
| `packages/domain/src/care/handover.test.ts`: `hazard HZ-018 refusals are read from every chart that records one`; shifts to the minute, two or three per day, with no gap or overlap across both clock changes | Passing (domain) |
| `apps/api` (care): handover compiled, refreshed and acknowledged through the API | Planned, Phase 1 slice 5 |

---

## HZ-019 Body-map side or site recorded wrongly

| Field | Value |
| --- | --- |
| ID | HZ-019 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `care` module (lead engineer) |
| Source | Master prompt 10.1 (body map and skin) |

**Description**: a wound, pressure ulcer or bruise is recorded on the wrong side or site, because the drawing is mirrored (front and back views) or tapped imprecisely on a small screen.

**Causes**: front and back views mirror left and right; side shown only by position on the drawing; no confirmation in words.

**Effects**: wrong site treated or checked; deterioration of the real wound missed; safeguarding concern misjudged.

**Initial risk**: severity Considerable, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Side and region are chosen in words as well as on the drawing, and must agree before saving; front and back views label the person's left and right | Built in Phase 1 slice 9 (web: front and back drawings labelled with the person's left and right, a list of the same areas for keyboard and screen reader users, the side confirmed in words, and the API's refusal shown word for word); mobile in slice 10 |
| Design | Wound photos are linked to the mark, with a ruler prompt | Phase 1 |
| Design | The body map is read against the body's midline, with a narrow centre band over the head and trunk only, so a mark on a leg or an arm is always on a side; three buttons choose the same zones for screen readers | Built in Phase 1 (mobile, clinical review C5) |

**Target residual risk**: severity Considerable, likelihood Low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain` (care): `hazard HZ-019 a mark whose drawn side and stated side differ cannot be saved` | Passing |
| `packages/domain` (care): `hazard HZ-019 body map sides are the person's own left and right` | Passing |
| `apps/api/test/care.test.ts`: `hazard HZ-019 body map` (a mark whose stated side differs from the drawing is refused; a category 3 ulcer prompts an incident and the safeguarding guide) | Passing |
| `apps/mobile/src/care/body-map.test.ts`: `hazard HZ-019 the side on the drawing and in words` (front and back views; a mark drawn on one side and described as the other refused with both sides named; the midline only for central areas); `sync/care-upload.test.ts`: `hazard HZ-019 sends the side drawn and the side chosen in words` so the API repeats the check | Passing (Phase 1, mobile) |
| `apps/mobile/src/care/body-map.test.ts`: `hazard HZ-019 the drawing is split at the body's midline (C5)` (a mark on the person's left leg reads left on both views; no centre band between the legs; the band only over the head and trunk; taps mapped from the frame to the drawing) | Passing (Phase 1, mobile) |
| `apps/api/test/incidents.test.ts`: `hazard HZ-019 links a mark recorded for the incident and refuses one for someone not on it` (marks keep the body map's checks; linked pressure ulcers reach the classifier) | Passing (Phase 1) |
| `apps/web/src/lib/body-map.test.ts`: `hazard HZ-019 match the API's regions and the sides each allows, on both views`; `hazard HZ-019 places the person's left on your right on the front view and on your left on the back`; `hazard HZ-019 reads the midline and either side of it the same way as the domain, on both views`; `apps/web/src/lib/refusals.test.ts`: `hazard HZ-019 says a side mismatch in the catalogue's words, at the side and the area` (the rule run in the domain package) | Passing (Phase 1 slice 9) |
| `apps/web/e2e/care-record.spec.ts` (Playwright with axe, WCAG 2.2 AA): `hazard HZ-019 a body map mark whose side in words differs from the drawing is refused` (a tap on the front view's knee on your right, the person's left, with "Right" chosen in words, is refused, with the error at the side question and the body area list; the list then records the person's right knee); `keyboard only: move between tabs and record a body map mark with the area list and the side in words` | Passing (local run; CI e2e-web on the PR) |

---

## HZ-020 Deprivation-of-liberty authorisation lapses unnoticed

| Field | Value |
| --- | --- |
| ID | HZ-020 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `care` module (lead engineer) |
| Source | Master prompt 10.4; [Mental Capacity Act 2005 Schedule A1](https://www.legislation.gov.uk/ukpga/2005/9/schedule/A1); [DHSC interim guidance after the June 2026 Supreme Court judgment](https://www.gov.uk/government/publications/changes-to-the-definition-of-deprivation-of-liberty/uk-supreme-court-2026-judgment-on-what-constitutes-a-deprivation-of-liberty) (updated 22 September 2026) |

**Description**: an urgent or standard authorisation expires, or a review required by the 2026 legal change is not done, while the person is still deprived of their liberty.

**Causes**: expiry dates kept outside the record; no reminder; the legal-change review not tracked; the CQC outcome notification not drafted.

**Effects**: unlawful deprivation of liberty; the person's rights not protected; regulatory action.

**Initial risk**: severity Considerable, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | DoLS register with expiry clocks from the rate table; tasks at 28 and 7 days before expiry (configurable) to the Registered Manager | Phase 1 |
| Design | The outcome of an application drafts the CQC notification (HZ-013) | Phase 1 |
| Design | Tenant switch for the 2026 legal change turns on the review-of-existing-authorisations workflow and lists every authorisation awaiting review | Phase 1 |
| Design | Authorisation dates are checked against Schedule A1 (urgent period, one extension request, extension period, standard period) before they are saved; the register shows status and days left; a reminder that would fall before an urgent authorisation starts fires at its start (`packages/domain/src/care/mca/dols.ts`) | Phase 1 (domain rules built) |
| Design | The legal-change review records the DHSC guidance's multifactorial assessment, objection and consent signs, and cannot close without the local authority referral when the person is no longer deprived of liberty or there is doubt | Phase 1 (domain rules built) |
| Design | The API stores the register and checks it with the domain rules; a known outcome drafts the CQC notification and publishes `care.dols.outcome_known`; an hourly job raises each expiry reminder once (task, alert to the Registered Manager, `care.dols.expiring`); each review step goes through the workflow engine | Phase 1 (built) |

**Target residual risk**: severity Considerable, likelihood Low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain` (care): `hazard HZ-020 DoLS expiry tasks fire before the end of each authorisation type` (`dols.test.ts`) | Passing |
| `packages/domain` (care): `hazard HZ-020 a DoLS outcome drafts the CQC notification` | Passing |
| `packages/domain` (care): `hazard HZ-020 DoLS periods stay within Schedule A1` | Passing |
| `packages/domain` (care): `hazard HZ-020 DoLS status and clocks` | Passing |
| `packages/domain` (care): `hazard HZ-020 review of existing authorisations after the June 2026 judgment` | Passing |
| `packages/domain/src/people/exit.test.ts`: `hazard HZ-020 a DoLS authorisation is closed with the supervisory body` (the discharge, transfer and death checklists) | Passing (Phase 1) |
| `apps/api/test/mca.test.ts`: `hazard HZ-020 checks the dates against Schedule A1`, `a DoLS outcome creates the CQC regulation 18(4A) draft` and `does not notify an urgent authorisation on its own` | Passing (Phase 1) |
| `apps/api/test/mca.test.ts`: `hazard HZ-020 expiry reminders fire once` | Passing (Phase 1) |
| `apps/api/test/mca.test.ts`: `hazard HZ-020 lists authorisations from before the judgment and records their review` | Passing (Phase 1) |

---

## HZ-021 No access to essential information during an IT outage

| Field | Value |
| --- | --- |
| ID | HZ-021 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `operations` module (lead engineer) |
| Source | Master prompt 13.4 (nightly downtime pack); hazard-log candidate list |

**Description**: during a power cut, network failure or Harbour outage, staff cannot see allergies, resuscitation status, IDDSI levels, care plan summaries, PEEPs or contacts.

**Causes**: no downtime pack; the pack is out of date; it is printed but not where staff can find it; no way to back-enter records made on paper. Added in slice 11, for the out-of-date pack: an allergy, resuscitation decision or IDDSI level changed after the pack was made; the nightly job failed, or a kiosk's cache was not refreshed; the outage lasts longer than the pack's life; an old printed pack is kept beside the new one; a kiosk builds the pack from a cache synced long ago; a person admitted, or a section recorded for the wrong person (HZ-001), after the last pack; resuscitation records that disagree; PEEPs and the MAR not yet held in Harbour. Added in the slice 11 review: a pack used during an outage that says nothing about what has changed since; a device clock behind the pack's time, so an old pack reads as current; food and drink levels merged so one hides the other; a stored value that cannot be read; the paper MAR or PEEPs kept somewhere other than the pack says; the kiosk's cached pack opened by someone who should not see every person at the location, or left on a withdrawn device. Added in round 5 of the Care mode review (C-L9): a care worker's access withdrawn, by mistake or by a role edit that lands mid-shift, removes the care record from their phone at once (allergies, resuscitation decisions, IDDSI levels and care plans; only unsent entries are kept), so that worker is without essential information until access is restored. Whether the phone should keep the care record for a while after access is withdrawn is a CSO decision (human action H-145); until then the downtime pack and colleagues' devices are the fallback.

**Effects**: wrong care given during the outage (an allergen given, resuscitation against a recorded decision, food or drink of an unsafe texture); records lost; evacuation without PEEPs.

**Initial risk**: severity Major, likelihood Low, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | A downtime pack per location is generated nightly (allergies, resuscitation status, IDDSI levels, care plan summaries, PEEPs, contacts) and cached on kiosk devices; each page shows when it was generated | Phase 1 |
| Design | Every person receiving care at the location gets a page (on leave and in hospital included), never left out for an incomplete record; the safety-critical sections (identity, allergies, resuscitation, IDDSI food, IDDSI drink, communication, evacuation, medicines due) are never blank: missing ones read "not recorded" with what to do (`assembleDowntimePack` in `packages/domain/src/operations/downtime-pack.ts`; [operations.md](../specs/operations.md) rules 1 and 3) | Phase 1 (domain rules built, slice 11) |
| Design | Until PEEPs and the eMAR are in Harbour, the evacuation and medicines sections say where this location keeps the PEEPs and the paper MAR (location settings `downtime.mar_location` and `downtime.peep_location`; a placeholder with no place set is refused). With the eMAR, the medicines section lists doses still due and PRN last-given times (HZ-003) (`paperMarMedicinesPort`, `fireFileEvacuationPort`; operations.md rule 7) | Phase 1 (domain rules built, slice 11); data in Phase 2 and 3 |
| Design | Freshness on every page: each pack carries its generation time, the time its information was read and a "use until" time (`downtime_pack.valid_hours`, 36 hours so one failed nightly run still leaves a pack in date; CSO to confirm, H-101). Every page's header, worked out when printed or shown, says one of four things: current ("Information as at ... Use until ..."); out of date, in words, with what to check; during a declared outage, "Latest available pack: information as at X. Anything recorded since X is on paper or not shown here: check the downtime forms and ask the nurse in charge about changes."; or that the device clock is behind the pack, so the time cannot be trusted. A kiosk-built pack counts from its last sync (`downtimePackFreshness`, `downtimePageHeader`; operations.md rule 2) | Phase 1 (domain rules built, slice 11; PDF and kiosk with the API and mobile steps) |
| Design | A section from another person's record is withheld with words saying so, never printed (HZ-001); resuscitation records that disagree mark the section as conflicting and print every record in force (HZ-015); food and drink levels print separately and an unreadable value says to check the record (HZ-016) (operations.md rules 4 to 6) | Phase 1 (domain rules built, slice 11) |
| Design | The kiosk's cached pack is encrypted under a key released only to a PIN session of a holder of `operations.downtime.read`; every print and open is queued as an audit event; it is evicted when the device key is revoked and when its retention ends (`kiosk-cache.ts`; operations.md rule 8; [kiosk.md](../compliance/kiosk.md) section 3.5) | Phase 1 (domain rules built, slice 11; device storage with the mobile step) |
| Design | Back-entry workflow for paper records made during downtime, flagged as late entries (HZ-017) | Phase 1 (domain rules built, slice 11) |
| Training and user documentation | Deployer control: business continuity plan says where the printed pack is kept and who prints it, and that a superseded printed pack is shredded when the new one arrives | Phase 1 |
| Training and user documentation | Deployer control: until the eMAR and PEEPs are in Harbour, the paper MAR and the fire file are kept current and where the location settings say | Phase 1 |

**Target residual risk**: severity Major, likelihood Very low, **risk 2**.

**Residual risk while the MAR and PEEPs are pointers only**: until Phase 2 (eMAR) and Phase 3 (PEEPs), the pack cannot show medicines due or evacuation needs; it can only say where the paper copies are. The risk then rests on the paper MAR and the fire file being current, which is a deployer control. The CSO decides whether that residual risk is acceptable for go-live or needs a further control (H-102). `[CSO acceptance - human action]`

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain/src/operations/downtime-pack.test.ts`: `hazard HZ-021 the downtime pack has a page with every section for every person receiving care at the location` (people away included, discharged, deceased and other locations left out, incomplete records never left out, room order) | Passing (Phase 1, slice 11) |
| `packages/domain/src/operations/downtime-pack.test.ts`: `hazard HZ-021 missing safety-critical information reads not recorded, never blank` (photo, allergies, resuscitation, IDDSI food and drink, communication) | Passing (Phase 1, slice 11) |
| `packages/domain/src/operations/downtime-pack.test.ts`: `hazard HZ-021 every page says when its information is from and whether it is out of date` (`says out of date in words at the moment it expires` and later; `during a declared outage says it is the latest available and that anything since is on paper`; `flags a device clock behind the pack instead of calling it current`; `marks a pack built on a kiosk from an old sync as out of date from the start`) | Passing (Phase 1, slice 11) |
| `packages/domain/src/operations/downtime-pack.test.ts`: `keeps a pack in date for longer than the nightly interval, so one failed night still leaves a pack`; `points to the location's own MAR and PEEP places until medicines and PEEPs are in Harbour`; `refuses a placeholder with no place set` | Passing (Phase 1, slice 11) |
| `packages/domain/src/operations/downtime-pack.test.ts`: `hazard HZ-001 information from another person's record is withheld, never printed`; `hazard HZ-015 resuscitation status on the downtime pack` (conflicting section listing every record in force); `hazard HZ-016 an unreadable IDDSI code says check the record and never stops the pack` | Passing (Phase 1, slice 11) |
| `packages/domain/src/operations/kiosk-cache.test.ts`: `hazard HZ-021 the kiosk opens its cached pack only in a PIN session of a downtime reader`; `hazard HZ-021 the kiosk evicts its cached pack on revocation and at the end of retention`; `hazard HZ-021 the kiosk queues an audit event for every print and open` | Passing (Phase 1, slice 11) |
| `apps/api`: `hazard HZ-021 the downtime pack contains every required section for every current resident` | Planned, Phase 1 |
| `apps/mobile` Maestro `hazard-HZ-021-kiosk-downtime-pack.yaml`: print the cached pack offline with the freshness words | Planned, Phase 1 |

---

## HZ-022 A person's information shown to a family member or professional without a sharing decision

| Field | Value |
| --- | --- |
| ID | HZ-022 |
| Status | Open |
| Clinical owner | `[CSO name - human action]`; data protection lead consulted |
| Engineering owner | `people` module (sharing rules); `comms` module (family feed, Phase 1 slice 12; family app mode, Phase 4) |
| Source | Master prompt 9.2 (family and professional sharing), 15.1 (sections stay closed until a sharing decision exists); [Caldicott principles](https://www.gov.uk/government/publications/the-caldicott-principles) (principle 7); Phase 1 plan candidate hazard ("family feed showing a section without a sharing decision") |

**Description**: a section of a person's record (updates, photos, care plan, health summary, medicines, finance, About Me) is shown to a family member, representative, external professional or share-link holder when no sharing decision in force covers that section for that recipient: there was never a decision, it has expired, consent was withdrawn, an attorney's authority has lapsed, sharing was suspended during a safeguarding enquiry, or the person has died or left the service.

**Causes**: a feed that is open by default; a decision that covers "the person" rather than named sections; decisions with no expiry; a withdrawal or suspension not applied at once (including on devices that synced earlier); a decision for one recipient applied to another (contact ids confused, a shared family account); a lasting power of attorney or deputyship accepted without evidence or after it ended, or a health and welfare attorney treated as having authority while the person has capacity; share links that outlive their decision; sharing left open after a death. In the family feed (slice 12): an update composed for one person shown in another person's feed; updates from before a decision started, or from a gap after a withdrawal, shown once a later decision exists; an update taken down still shown to people who never saw it; a property and financial affairs attorney shown care updates, or a welfare attorney shown finance; a photo shared without consent or a best-interests decision, or one in which other residents can be recognised; another resident named, or a phone or NHS number written, in a shared note or caption; a visit booking refusal that reveals a hospital stay, a safeguarding suspension or a restriction; a staff role holding the family feed permission. Found in review: an update from a suspension period shown once the suspension is lifted; a welfare attorney's or representative's decision still honoured after the person regains capacity; a deputy acting outside the sections their order covers; an appointee shown finance statements; another resident's name written in lower case, with a zero-width space or with lookalike Cyrillic or Greek letters; a phone number written with brackets or points, or an email address with a full-width at sign; a photo attached to another kind of update, or a care plan update with no section; a family member given a person assignment, which would open every staff table through `app.person_visible`; a portal permission in a staff role or grant, or a staff permission in a portal session.

**Effects**: a person's whereabouts, health or money disclosed to someone who may harm them (safeguarding risk, financial abuse); a person with capacity overridden; distress and loss of trust; a reportable personal data breach; a family member relying on information they should no longer see.

**Initial risk**: severity Major, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Closed by default: every section is hidden from every family member, professional and share link until a sharing decision in force covers that section (and, for the care plan, that domain) for that recipient (`checkSectionVisibility` in `packages/domain/src/people/sharing.ts`) | Phase 1 (domain rule built; family feed in slice 12) |
| Design | Every decision records its basis and is checked: no consent from a person assessed as lacking capacity for it; an authority needs evidence, must cover the section, and a welfare authority applies only when the person lacks capacity; a best-interests decision must be recorded; direct care only for professionals and clinical sections | Phase 1 (domain rule built) |
| Design | Every decision expires; withdrawal, suspension (for example during a safeguarding enquiry) and the end of an authority close the section at once; suspensions are stored as periods (`isSharingSuspendedAt`); a stored decision that breaks the rules is never honoured | Phase 1 (domain rule built) |
| Design | Sharing closes when the person is discharged, dies or is archived; correcting a discharge or death does not reopen it without a manager | Phase 1 (domain rule built) |
| Design | About Me share links carry About Me only, store only a hash of the token, and cannot outlive their decision | Phase 1 (domain rule built; links with the API step) |
| Design | Every view by a family member, professional or link holder is audited with the decision that allowed it (`buildFamilyFeed` names the decision for each entry; the API writes `feed_view`) | Phase 1 (domain rule built; API in slice 12's API step) |
| Design | The family feed adds nothing to the sharing rules: each update belongs to one section (`FEED_ITEM_SECTIONS`) and is shown only when `checkSectionVisibility` finds a decision in force for that person, section, care plan domain and family contact; an update about another person is never shown; only decisions in force and not suspended when the thing happened count (`decisionInForceAt`), so earlier updates, gaps after a withdrawal and suspension periods stay closed even after a suspension is lifted; a care plan update with no section, and a photo on another kind of update unless the photos section is open and the photo basis holds, are hidden (`checkFeedItemVisibility` in `packages/domain/src/comms/feed-visibility.ts`); the schema step adds CHECK constraints for both | Phase 1 (domain rule built, slice 12) |
| Design | Attorneys, deputies and appointees see only what their authority covers through the same rules: welfare authorities, a representative's consent and a best-interests decision only while the current capacity finding says the person lacks capacity for the decision (presumed otherwise, `capacity_regained`); deputies only within the sections their order covers (`orderSections`); property and finance authorities the finance placeholder; appointees the benefits section only; a decision naming a section outside the authority is never honoured (`packages/domain/src/people/sharing.ts`) | Phase 1 (domain rule built, slice 12) |
| Design | Photos need their own basis (`feedPhotoBasis`): the person's consent or a representative's with authority, or a best-interests decision after an assessment of the photos decision; a refusal or an overdue review stops them; only photos where nobody else can be recognised are composed, and photo updates are taken down when the basis ends | Phase 1 (domain rule built, slice 12) |
| Design | Composition normalises staff-written words first (Unicode NFKC, invisible format and direction characters removed, lookalike Cyrillic and Greek letters folded) and refuses words naming another resident (full names with given, preferred or known-as first names, and surnames, in any case), an email address (including a full-width at sign) or a run of ten or more digits across spaces, points, hyphens or brackets; it strips staff surnames in any case when the tenant asks; visitors are never named; withdrawn updates disappear for anyone who had not seen them (`composeFeedItem`, `checkFeedText` in `feed-compose.ts`, `feed-text.ts`) | Phase 1 (domain rule built, slice 12) |
| Design | What a family member saw cannot be unseen: `feedExposure` lists what was seen under a decision and flags any view after it closed as a breach candidate | Phase 1 (domain rule built, slice 12) |
| Design | A visit booking refusal about the person, a sharing decision, a restriction or a location restriction (an outbreak) always reads "We cannot book this visit online. Please call the home to arrange it."; the decision is checked before the person's status, and the refusal code and restriction id are typed staff-only (`checkVisitBooking`); confirmed bookings are re-checked when the person's status, a decision or a restriction changes (`visitBookingsToReview`) | Phase 1 (domain rule built, slice 12) |
| Design | Family-only permissions (`PORTAL_ONLY_PERMISSIONS`) are never given to staff roles; a role that mixes portal and staff permissions, or a grant carrying a portal permission, is refused (`checkRoleDefinition`, `checkGrantPermissions`) and ignored if stored; a portal session is resolved from portal roles only, with no grants and no person scope, and a staff session never carries a portal permission (`resolveAccess` in `packages/domain/src/platform/access.ts`); reading the feed needs MFA (`comms.feed.read` touches care records) | Phase 1 (built, slice 12) |
| Design | Database: family members get no `person_assignment`, so `app.person_visible` is false for every person in a family session; feed tables carry a restrictive policy calling `app.family_can_see(person_id, section, care_plan_domain, occurred_at)`, which mirrors the domain rule; family-owned rows are keyed on the caller's contacts (ADR-0061, [comms.md](../specs/comms.md) section 2.1) | Phase 1 (schema step) |
| Design | Family device sync streams carry only the sections a decision covers, tested on their own (replication bypasses RLS) | Phase 4 (family app mode) |
| Test | See Verification | Phase 1 |
| Training and user documentation | Deployer control: the Registered Manager reviews sharing decisions at each care plan review and suspends sharing when a safeguarding concern involves a family member; staff check a photo shows only the person before choosing it for the feed | Phase 1 |

**Target residual risk**: severity Major, likelihood Very low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain/src/people/sharing.test.ts`: `hazard HZ-022 a section is visible only under a sharing decision in force` (no decision; a section or care plan domain the decision does not name; another recipient; another person; expired; not yet started; withdrawn; suspended; lapsed authority; a stored decision that breaks the rules; a person who has died or left) | Passing (Phase 1) |
| `packages/domain/src/people/sharing.test.ts`: recording a sharing decision (capacity, authority evidence and coverage, best interests, direct-care limits, share-link limits, expiry) and About Me share links | Passing (Phase 1) |
| `packages/domain/src/comms/feed-visibility.test.ts`: `hazard HZ-022 the family feed shows an item only under a sharing decision in force` (no decision; another family member; a professional's decision with the same id; a section or care plan domain not covered; expired, withdrawn, suspended, not yet started; another person's item; an item from before the decision started; a withdrawn item never seen; a photo without a basis; the lifecycle statuses; a gap between a withdrawal and a later decision) | Passing (Phase 1, slice 12) |
| `packages/domain/src/comms/feed-visibility.test.ts`: `hazard HZ-022 attorneys and deputies see what their authority covers` (welfare attorney and deputy with the current capacity finding, finance attorney and deputy, deputies within their order, appointees and benefits, decisions naming sections outside the authority, an ended order, a lapsed authority); `hazard HZ-022 suspensions and data that should never exist stay closed` (an update from a safeguarding suspension after it is lifted, an open suspension, a care plan update with no section, a photo on another kind of update) | Passing (Phase 1, slice 12) |
| `packages/domain/src/people/sharing-scope.test.ts`: `hazard HZ-022 authorities cover only what the law gives them`, `hazard HZ-022 a decision that needs a lack of capacity follows the current finding`, `hazard HZ-022 suspensions are periods` | Passing (Phase 1, slice 12) |
| `packages/domain/src/platform/access-portal.test.ts`: `hazard HZ-022 portal and staff permissions never mix` (built-in roles, mixed roles and grants refused, staff and portal sessions resolved apart, stored mixed roles ignored) | Passing (Phase 1, slice 12) |
| `packages/domain/src/comms/feed-text-review.test.ts`: `hazard HZ-022 names in any case, with hidden characters or lookalike letters` ("robert sample", "ROBERT SAMPLE", "Bob", a Cyrillic o, a zero-width space), `hazard HZ-022 clinical words hidden by hyphens, plurals, case or lookalikes` ("COVID-19", "anti-depressants", "pre-diabetic", "UTIs"), contact details with brackets, points and a full-width at sign; `feed-compose-review.test.ts`: `hazard HZ-022 other residents however their names are written` | Passing (Phase 1, slice 12) |
| `packages/domain/src/comms/feed-visibility.test.ts`: `hazard HZ-022 photos with ...` (consent, an attorney's consent, best interests, refusals, expired or withdrawn consent, overdue reviews, an older assessment); `hazard HZ-022 is empty with no decision`; `hazard HZ-022 flags views after the decision closed for the breach register` | Passing (Phase 1, slice 12) |
| `packages/domain/src/comms/feed-compose.test.ts`: `hazard HZ-022 refuses another resident's name`, `... keeps staff surnames out when the tenant asks`, `... refuses a staff surname used on its own`, `... refuses an email address`, `... an NHS number`, `... a phone number`, `hazard HZ-022 refuses a photo ...`, `hazard HZ-022 nothing is composed for the wrong person or a closed record` | Passing (Phase 1, slice 12) |
| `packages/domain/src/comms/visit-booking.test.ts`: `hazard HZ-022 a refusal never says why when the reason is about the person` (including an outbreak and the decision checked before status), `hazard HZ-022 booked visits are checked again when something changes` | Passing (Phase 1, slice 12) |
| `packages/domain/src/comms/feed-permissions.test.ts`: `hazard HZ-022 never gives a member of staff a portal-only permission`, `hazard HZ-022 asks for MFA wherever the feed or its sources are read or published` | Passing (Phase 1, slice 12) |
| `apps/api`: `hazard HZ-022 the family feed returns nothing without a sharing decision in force` | Planned, Phase 1 (slice 12) |
| `apps/api`: `hazard HZ-022 withdrawing or suspending a decision closes the section on the next request` | Planned, Phase 1 |
| `packages/db/test`: the family isolation tests in [comms.md](../specs/comms.md) section 2.1 (a family session reaches no table with a person column except the feed and its own rows; own contact's decisions only; suspension periods and closed records hidden; no writes to staff tables; `app.family_can_see` tenant-bound with a fixed search path and agreeing with the domain rule on the same fixtures; no portal user with a `person_assignment`; the CHECK constraints) | Planned, Phase 1 (slice 12 schema step) |
| `packages/sync`: `hazard HZ-022 family streams carry only shared sections` | Planned, Phase 4 |

---

## HZ-023 Essential information missing from the hospital transfer pack

| Field | Value |
| --- | --- |
| ID | HZ-023 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `people` module (lead engineer); `medicines` module from Phase 2 (reconciliation on return) |
| Source | Master prompt 9.2 (hospital transfer: red bag content generated in one click; return reconciliation); NHS England hospital transfer pathway ("red bag"); [NICE SC1](https://www.nice.org.uk/guidance/sc1) (medicines when people transfer between care settings) |

**Description**: a person goes to hospital without their photo, allergies, current medicines, communication needs, resuscitation status or About Me; with a pack that belongs to someone else, is out of date, or shows a missing item as blank or as "none"; without their glasses, hearing aids or dentures; or comes back without the home picking up what the hospital changed (new allergies, a DNACPR decision, a new IDDSI level, changed medicines).

**Causes**: a pack put together by hand under time pressure; sections never recorded; "unknown" printed as blank or "none"; a withdrawn DNACPR printed; another person's data in the pack (HZ-001); stale offline data (HZ-002); belongings not sent; the hospital discharge letter not reconciled on return.

**Effects**: a medicine given that the person is allergic to; time-critical medicines (for example for Parkinson's disease) missed; resuscitation contrary to the person's wishes; the person unable to communicate pain or needs; harm after return when hospital changes are missed.

**Initial risk**: severity Major, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | One function assembles the pack from the record (`assembleHospitalTransferPack` in `packages/domain/src/people/transfer-pack.ts`); it refuses data from another person's record and an incomplete identity (HZ-001) | Phase 1 (domain rule built) |
| Design | Photo, allergies, medicines, communication needs, resuscitation status and About Me are safety-critical: when missing they read "not recorded" on the first page, never blank; "none" must be recorded positively with who and when | Phase 1 (domain rule built) |
| Design | Only active resuscitation records print (HZ-015); allergies print most severe first (HZ-007); time-critical medicines first; every section shows when it was last updated; a pack printed offline shows the last sync time (HZ-002) | Phase 1 (domain rule built; print with the API step) |
| Design | The pack is never blocked, because a transfer must not wait, but recording the hand-over of an incomplete pack needs a named acknowledgement and a reason | Phase 1 (domain rule built) |
| Design | Glasses, hearing aids, dentures and walking aids in the property inventory are offered for sending; items left behind are listed; items sent are checked back in on return | Phase 1 (domain rule built) |
| Design | Return checks: discharge letter, medicines (HZ-005), new allergies, resuscitation decisions made in hospital, IDDSI changes (HZ-016), skin | Phase 1 (checks), Phase 2 (eMAR reconciliation) |
| Design | The pre-admission assessment and the welcome checklist require allergies, medicines, communication needs and resuscitation status at admission, so the pack rarely lacks them | Phase 1 (domain rules built) |
| Design | Go-live waits until every current person has a communication-needs status recorded ([platform-completions.md](../specs/platform-completions.md) rule 26) | Phase 1 (domain rules built) |
| Test | See Verification | Phase 1 |
| Training and user documentation | Deployer control: the transfer procedure names who prints the pack and checks the red bag, agreed with the local hospital trust | Phase 1 |

**Target residual risk**: severity Major, likelihood Low, **risk 3**. Further reduction is impractical: blocking or delaying a transfer until the record is complete would cause greater harm, and the remaining likelihood depends on the provider completing records, which the controls make visible but cannot force. `[CSO decision - human action]`

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain/src/people/transfer-pack.test.ts`: `hazard HZ-023 missing safety-critical information is flagged, never left blank` (each of the six sections; empty lists; a withdrawn-only resuscitation record; positive "none" statements accepted) | Passing (Phase 1) |
| `packages/domain/src/people/transfer-pack.test.ts`: `hazard HZ-023 needs a named acknowledgement and reason when critical sections are missing` | Passing (Phase 1) |
| `packages/domain/src/people/transfer-pack.test.ts`: `hazard HZ-001 refuses a pack whose sections belong to someone else`, `hazard HZ-015 prints only the active resuscitation record`, `hazard HZ-007 lists the most severe allergies first`, `hazard HZ-016 re-checks allergies, resuscitation decisions and IDDSI levels on return` | Passing (Phase 1) |
| `apps/api`: `hazard HZ-023 the transfer pack PDF shows not recorded on the first page for each missing critical section` | Planned, Phase 1 |
| `apps/mobile` Maestro `hazard-HZ-023-offline-transfer-pack.yaml`: print the pack offline with the last sync time shown | Planned, Phase 1 |
| `packages/domain/src/platform/onboarding.test.ts`: `hazard HZ-023 communication needs not recorded` (person readiness) | Passing (Phase 1) |

---

## HZ-024 Care plan or risk assessment out of date, or a draft or superseded version followed

| Field | Value |
| `packages/sync/test/care-streams.test.ts`: `hazard HZ-024 only the active care plan, with its own sections and actions` (drafts and superseded plans never reach a device) | Passing (Phase 1) |
| --- | --- |
| ID | HZ-024 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `care` module (lead engineer) |
| Source | Master prompt 10.1 (care planning, risk assessments), 9.2 (first plan within 7 working days); [care.md](../specs/care.md) rules 1 and 2; Reg 9 and Reg 12 |

**Description**: staff follow a care plan or risk assessment that no longer matches the person's needs, or a draft or superseded version, because the first plan was never written, a review was missed, or a change in needs did not prompt a review.

**Causes**: no first plan after admission; review dates missed; a new screening band, a fall or a new resuscitation decision does not prompt a review; a draft or superseded version shown or used as current; two active plans; tasks generated from a draft; risk assessment reviews missed.

**Effects**: care against needs that have changed (moving and handling, nutrition, falls, skin), leading to falls, pressure ulcers or malnutrition; a regulatory breach of Regs 9 and 12.

**Initial risk**: severity Considerable, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | One active plan and one open draft per person (database partial unique indexes); only an active plan's actions drive tasks; publishing supersedes the previous version and both stay readable with their history | Built in Phase 1 slice 4b |
| Design | The first plan is due within `care_plan.initial_working_days` working days of admission, skipping the nation's bank holidays; plans are reviewed every `care_plan.review_interval_months` months; the plan list shows what is due and whether it is overdue | Built in Phase 1 slice 4b |
| Design | A changed screening band, a fall or a new advance care record brings the review forward to that day and raises the review task at once | Built in Phase 1 slice 4b |
| Design | An hourly job raises one task and one alert to the nurse in charge for each overdue first plan, plan review, risk assessment review and advance care record review, and never two for the same record (HZ-008) | Built in Phase 1 slice 4b |
| Design | Draft and superseded versions are labelled with word and icon, with the active version one tap away | Built in Phase 1 slice 9 (web: "Draft, not in use" with a pencil, "Superseded, not in use" with a clock turned back, "In use" with a tick; a draft or superseded version opens under a notice with a link to the plan in use) |
| Design | The downtime pack summarises the active care plan only, need by need in the plan's domain order, never a draft or superseded version ([operations.md](../specs/operations.md) rule 1) | Phase 1 (domain rules built, slice 11) |
| Training and user documentation | Deployer control: the provider's care planning policy names who reviews plans and how changes in need are reported | Phase 1 |

**Target residual risk**: severity Considerable, likelihood Low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain/src/care/care-plan.test.ts`: `hazard HZ-024 rule 1: the first care plan is due within the working days after admission`; `hazard HZ-024 rule 1: reviews every review interval and on change`; `hazard HZ-024 rule 2: only an active plan drives tasks` | Passing |
| `packages/domain/src/care/validated-assessment.test.ts`: `hazard HZ-024 rule 1: a change in the result brings the care plan review forward` | Passing |
| `packages/db/test/care-planning.test.ts`: integrity rules (a second active care plan is refused; child rows cannot claim another person) | Passing |
| `apps/api/test/care-planning.test.ts`: `hazard HZ-024 raises one review task to the nurse in charge for an overdue first plan or review`; `hazard HZ-024 publishes a draft, supersedes it with the next version and keeps both` | Passing |
| `apps/web/src/lib/assessments.test.ts`: `hazard HZ-024 labels every version in word and icon, and only the active one as in use` | Passing (Phase 1 slice 9) |
| `packages/domain/src/operations/downtime-pack.test.ts`: `hazard HZ-024 summarises the active care plan by need, in the plan's domain order` | Passing (Phase 1, slice 11) |
| `apps/web/e2e/care-record.spec.ts` (Playwright with axe, WCAG 2.2 AA): `hazard HZ-024 a draft care plan is labelled as not in use until it is published with sign-off` (the draft shows its status and the draft notice; once published with who agreed it, the plan in use and the versions table show one version in use and no draft) | Passing (local run; CI e2e-web on the PR) |

---

## HZ-025 Bed rail entrapment risk not identified

| Field | Value |
| --- | --- |
| ID | HZ-025 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `care` module (lead engineer) |
| Source | Master prompt 10.1 (bed rails, MHRA gaps); [MHRA: bed rails management and safe use](https://www.gov.uk/guidance/bed-rails-management-and-safe-use); [rates.md](../specs/rates.md) `bed_rail.*` |

**Description**: bed rails are used where the gaps between the bars, to the mattress or to the headboard, or the rail height, are outside the MHRA figures, or for a person at risk of entrapment, and the record does not show it.

**Causes**: measurements not recorded; limits held as literals and out of date; "under" read as "at most"; the smaller between-bars figure for a small or atypical body size not applied; a mattress or rail changed without measuring again; the review missed.

**Effects**: entrapment of the head, neck or chest; asphyxia; death.

**Initial risk**: severity Major, likelihood Low, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | The bed rails template records each MHRA measurement and checks it against the rate-table figure: gaps strictly under the figure, the rail height at least the figure, and the smaller between-bars figure when the person has a small or atypical body size; findings outside the figures are stored and shown with the assessment | Built in Phase 1 slice 4b |
| Design | The figures live only in the rate table with their source and verification status | Built in Phase 1 slice 4b |
| Design | Risk assessment reviews raise tasks when due (HZ-024) | Built in Phase 1 slice 4b |
| Training and user documentation | Deployer control: measure at fitting and whenever the bed, mattress or rail changes; the MHRA guidance is cited on the template | Phase 1 |

**Target residual risk**: severity Major, likelihood Very low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain/src/care/risk-assessment.test.ts`: `hazard HZ-025 bed rails against the MHRA figures in the rate table` | Passing |
| `apps/api/test/care-planning.test.ts`: `hazard HZ-025 lists the templates with the MHRA figures from the rate table` | Passing |

---

## HZ-026 Restrictive or covert care under consent or authority that is not valid

| Field | Value |
| --- | --- |
| ID | HZ-026 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `care` module (lead engineer) |
| Source | Master prompt 10.4; [Mental Capacity Act 2005](https://www.legislation.gov.uk/ukpga/2005/9) sections 1 to 4, 9, 11, 20 and 37 to 39; [NICE SC1](https://www.nice.org.uk/guidance/sc1) 1.15 (covert administration); care.md section 4 rules 9 and 10 |

**Description**: bed rails, covert medicines or other restrictive care are given on the strength of a consent, capacity assessment or best-interests decision that does not meet the Mental Capacity Act: consent from someone without authority (a relative, a property and financial attorney, an unregistered attorney, a deputy outside their order), the person's own consent recorded while they lacked capacity, a "lacks capacity" outcome the two-stage test does not support, an assessment of "everything" rather than one decision, or an incomplete best-interests checklist.

**Causes**: next of kin treated as decision makers; the two kinds of lasting power of attorney confused; capacity assessed once and reused for other decisions; no practicable steps recorded; consent relied on after it expired or was withdrawn, or after the person regained capacity; no IMCA where nobody could be consulted.

**Effects**: covert medication or bed rails without lawful authority (entrapment, medicines given in an unsafe form, distress); the person's own decision overridden; unlawful restriction; regulatory action.

**Initial risk**: severity Considerable, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Consent is checked by representative type: only a registered health and welfare attorney or a personal welfare deputy within their order may consent for a person who lacks capacity for the decision; relatives, appointees, IMCAs and advocates are refused with the reason; marketing and AI processing only from the person (`consent.ts`) | Phase 1 (domain rules built) |
| Design | Bed rails need the restraint conditions (MCA s.11 and s.20); covert medicines need a lack of capacity and a best-interests decision (NICE SC1 1.15) | Phase 1 (domain rules built) |
| Design | `consentStatus` decides at the time of use: expired, withdrawn, refused or superseded consent, and a representative's consent once the person has capacity, are not valid | Phase 1 (domain rules built) |
| Design | The API finds the person's capacity for the decision from their assessments (`capacityFinding`), never from the request, refuses with the domain's words whatever `checkConsentRecord`, `checkCapacityAssessment` and `checkBestInterests` refuse, and shows each decision's status now | Phase 1 (built) |
| Design | Capacity assessments are decision- and time-specific; "lacks capacity" only when stage 1 is met, a stage 2 element is not and the inability is because of the impairment, with practicable steps recorded (`capacity.ts`) | Phase 1 (domain rules built) |
| Design | The best-interests checklist is complete only when every item is answered, with reasons for "not applicable", a consultation or the reason there was none, and the IMCA prompt (`best-interests.ts`) | Phase 1 (domain rules built) |
| Test | See Verification | Phase 1 |
| Training and user documentation | User guide on consent, capacity and representatives with the Act's wording. Deployer control: the tenant's Mental Capacity Act policy and training | Phase 1 |

**Target residual risk**: severity Considerable, likelihood Low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain` (care): `hazard HZ-026 consent authority by representative type` (`consent.test.ts`) | Passing |
| `packages/domain` (care): `hazard HZ-026 whether a valid consent exists at a time` | Passing |
| `packages/domain` (care): `hazard HZ-026 capacity: lacks capacity only when stage 1 is met and a stage 2 element is not` (`capacity.test.ts`) | Passing |
| `packages/domain` (care): `hazard HZ-026 capacity is assumed unless an assessment of that decision says otherwise` | Passing |
| `packages/domain` (care): `hazard HZ-026 best-interests checklist is complete only when every item is answered` | Passing |
| `packages/domain` (care): `hazard HZ-026 IMCA prompt when nobody appropriate can be consulted (MCA s.37 to s.39)` | Passing |
| `apps/api/test/mca.test.ts`: `hazard HZ-026 a consent without authority is refused` (a relative, an attorney while capacity is assumed, a property and financial attorney) | Passing |
| `apps/api/test/mca.test.ts`: `hazard HZ-026 lets a registered welfare attorney agree to bed rails, with the restraint conditions, once the person lacks capacity` (capacity found from the assessments, never the request) | Passing |
| `apps/api/test/mca.test.ts`: `hazard HZ-026 needs a complete best-interests decision before covert medicines`, `prompts for an IMCA when nobody appropriate can be consulted about a move` and `records a withdrawal, keeps the record` | Passing |
| `packages/db/test/mca-and-incidents.test.ts`: append-only capacity assessments and best-interests decisions; a lacks-capacity outcome the two-stage test does not support and a consent claiming an assessment it does not name are refused by the database | Passing |

---

## HZ-027 Head injury after a fall not observed or escalated

| Field | Value |
| --- | --- |
| ID | HZ-027 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `safety` module (lead engineer) |
| Source | Master prompt 11.1 (falls protocol); [NICE NG232](https://www.nice.org.uk/guidance/ng232/chapter/Recommendations) 1.2.4 and 1.9.11; safety.md section 4 rule 12 |

**Description**: after a fall, a person with a head injury, or on anticoagulant or antiplatelet treatment, is not observed closely enough or urgent medical advice is not sought, so an intracranial bleed is missed.

**Causes**: a head injury not recognised (an unwitnessed fall); anticoagulant status not known at the point of care; no observation schedule created, or one not followed; tasks lost at handover (HZ-018); offline capture delays the tasks (HZ-006); the observation defaults not suited to the setting.

**Effects**: delayed treatment of an intracranial haemorrhage; death or permanent disability.

**Initial risk**: severity Major, likelihood Medium, **risk 3**.

| Design | Go-live waits until a working post-fall observation escalation chain exists and the clinical lead has reviewed the post-fall observation settings (`falls.*`) apart from the other defaults (onboarding items `escalation_chains_set` and `clinical_settings_reviewed`, [platform-completions.md](../specs/platform-completions.md) rule 26) | Phase 1 (domain rules built) |
**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Every fall creates the post-fall checklist; a head injury or anticoagulant or antiplatelet treatment, or either not ruled out, prompts urgent medical advice under the tenant's post-fall policy and creates timed observation tasks (`packages/domain/src/safety/post-fall.ts`) | Phase 1 (domain rules built) |
| Design | Observation intervals and the monitoring period come from the rate table (`falls.*`), defaulting to NICE NG232 1.9.11, to be confirmed by the CSO (human action H-66); observation times are elapsed time, so a clock change does not move them | Phase 1 (domain rules built) |
| Design | The API creates the checklist through the task engine whenever a fall is recorded or synced, in every nation, with one task per timed observation counted from when the person was found; an answer that rules out both risks cancels the timed observations and starts general monitoring; overdue tasks escalate (HZ-008) | Phase 1 (built) |
| Design | The tasks are created on the device when a fall is recorded offline, before it syncs | Phase 1 (offline slice) |
| Test | See Verification | Phase 1 |
| Training and user documentation | Deployer control: the tenant's post-fall policy and escalation route linked from the task; staff trained in post-fall observations | Phase 1 |

**Target residual risk**: severity Major, likelihood Low, **risk 3**.

**Justification for level 3**: Harbour prompts, schedules and escalates, but recognising deterioration and seeking advice are clinical actions by the staff on shift; further reduction would mean automating a clinical judgement, which the medical-device boundary rules out. `[CSO acceptance - human action]`

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain` (safety): `hazard HZ-027 head injury or anticoagulants shorten the observation schedule` (`post-fall.test.ts`) | Passing |
| `packages/domain` (safety): `hazard HZ-013 open questions, provisional drafts and tasks` (a fall on anticoagulants raises urgent advice and timed observations) | Passing |
| `apps/api/test/incidents.test.ts`: `hazard HZ-027 a fall creates the post-fall tasks with the observation schedule, shortened for a head injury` (one task per timed observation from the rate table) | Passing |
| `apps/api/test/incidents.test.ts`: `hazard HZ-027 ruling out both risks replaces the timed observations with general monitoring` and `counts the observations from when an unwitnessed fall was found` | Passing |
| `packages/domain` (safety): `hazard HZ-027 counts post-fall observations from when the person was found` (`classifier.test.ts`; the found time was dropped before slice 7 stored it) | Passing |
| Maestro `hazard-HZ-027-post-fall-observations.yaml` | Planned, Phase 1 |
| `packages/domain/src/platform/onboarding.test.ts` (go-live clinical items): `hazard HZ-027 a post-fall chain with no steps`, `hazard HZ-027 post-fall observation figures not reviewed by the clinical lead` | Passing (Phase 1) |

---

## HZ-028 Point-of-care history on a device mistaken for the complete record

| Field | Value |
| --- | --- |
| ID | HZ-028 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `packages/sync` and `apps/mobile` (lead engineer) |
| Source | Master prompt 17.1 and 17.2; [ADR-0011](../decisions/0011-offline-window-and-kiosk-lock.md) (offline window); [care.md](../specs/care.md) section 6 |

**Description**: a carer working offline reads the notes, charts or body-map marks on the phone as the person's whole recent history, but entries older than the tenant's offline window (`mobile.offline_window_days`) are not on the device, so an older open wound, a fluid or weight trend or an earlier refusal is missed.

**Causes**: the window removes entries by the day they happened (ADR-0011), and a body-map mark that is still present (an open pressure ulcer recorded ten days ago) is an entry, not reference data; a tenant choosing a short window; a device that has not yet read the tenant's figure keeps today only; a device that has not synced for days.

**Effects**: an existing wound not checked, or recorded again as new; a falling intake or weight not noticed; a pattern of refusals or falls missed at the point of care.

**Initial risk**: severity Considerable, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Today, the person's record and every chart say how many days of entries the device keeps ("Entries from the last 7 days are kept on this device"), a chart even when it has no entries on the device | Phase 1 (built in slice 10 part 1; empty charts after clinical review C9) |
| Design | Reference data is never evicted while the person is in scope: allergies, the care profile (IDDSI levels, SpO2 scale), the active care plan, active risk assessments, every validated-tool result and active advance care records | Phase 1 (built in slice 10 part 1) |
| Design | Present body-map marks and the latest weight and NEWS2 stay on the device whatever their age, through a current-record flag the server maintains and the streams filter on (needs an API and database change) | Phase 1 (slice 10 part 2) |
| Design | The full history stays one tap away online; the tenant chooses the window within ADR-0011's options | Phase 1 |
| Design | The window is minted by the API into the signed sync token from the rate table; the streams read it only from there, so a device cannot widen it (security review S1) | Built in Phase 1 |
| Test | See Verification | Phase 1 |
| Training and user documentation | Care worker guide: the phone holds the last few days; check the full record online or with the nurse in charge before relying on history. Deployer control: handover covers open wounds and charts with a trend | Phase 1 |

**Target residual risk**: severity Considerable, likelihood Low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/sync/test/care-streams.test.ts`: `hazard HZ-028 takes entries off the device when their day leaves the window`; `hazard HZ-002 reference data for assigned people is never evicted while the assignment stands` | Passing (Phase 1) |
| `apps/mobile/src/care/sync-summary.test.ts`: `hazard HZ-028 says how many days of entries the device keeps` | Passing (Phase 1, mobile) |
| `packages/sync`: `hazard HZ-028 present body-map marks stay on the device beyond the window` | Planned, Phase 1 (needs the server-maintained flag) |
| `packages/sync/test/care-streams.test.ts`: `hazard HZ-028 ignores a window sent by the device: only the token's window counts`, `sends no entries when the token has no window, whatever the device sends`; `apps/api/test/api.test.ts`: `hazard HZ-028 puts the tenant's offline window from the rate table in the token`, `does not let a script with a normal session widen the offline window` | Passing (Phase 1) |

---

## HZ-029 An entry recorded twice when a save is tried again

| Field | Value |
| --- | --- |
| ID | HZ-029 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `care` module and `apps/web` (lead engineer) |
| Source | Clinical review of the slice 9 web screens (finding M4); master prompt 6 (client UUIDs and idempotent inserts) |

**Description**: a note, chart entry, body-map mark, assessment, activity or visit is recorded twice because a save was tried again after its outcome was unknown, so the record shows two events where there was one.

**Causes**: the connection drops after the server saved the entry but before the reply arrived; the person presses Save again after an error message; a form that makes a new id on every attempt; a record type whose create route takes no client id (advance care records, risk assessments and care plan actions today).

**Effects**: a fluid intake counted twice overstates the day's total and hides a shortfall (dehydration); a repeated NEWS2 or repositioning entry misrepresents the observations or turns given; a duplicated body-map mark or incident note misleads a review; a duplicated advance care record could confuse which decision is in force.

**Initial risk**: severity Considerable, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Every append-only entry carries a client UUIDv7 made by the form; the same id is sent with every attempt and a new one is made only after a confirmed save (`useEntryId`, `apps/web/src/lib/entry-id.ts`) | Built in Phase 1 slice 9 (web) |
| Design | The API inserts with the client id and ignores a replay with the same id for the same person, returning the entry already saved; an id used for another person is refused | Built in Phase 1 slices 4a and 4b |
| Design | Mutable records (care plans, risk assessment reviews, closing and withdrawing) carry the version read, so a repeated update is refused as a conflict rather than applied twice | Built in Phase 1 slice 4b |
| Design | Advance care records, risk assessments and care plan actions take a client id on create (an API gap, listed in care.md section 10) | Planned, Phase 1 |
| Test | See Verification | Phase 1 |

**Target residual risk**: severity Considerable, likelihood Low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `apps/web/src/lib/entry-id.test.ts`: `uuidv7 (hazard HZ-029) makes RFC 9562 version 7 ids that the API's contracts accept`; `orders ids by time and makes a new one each time` | Passing (Phase 1 slice 9) |
| `packages/db/test/care-record.test.ts`: corrections supersede; replayed device ids are ignored | Passing |
| `apps/api/test/care-planning.test.ts`: `hazard HZ-017 ignores a replayed upload with the same device id` | Passing |
| `apps/api`: `hazard HZ-029 an advance care record, risk assessment or care plan action sent twice with the same client id is recorded once` | Planned, Phase 1 |

---

## HZ-040 Held entries deleted to get past the lockout

| Field | Value |
| --- | --- |
| ID | HZ-040 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `apps/mobile`, `apps/api` sync routes and task engine (lead engineer) |
| Source | Clinical review C8, round 3 H2, round 4 H1, H2 and M3, round 5 C-H1, C-M1 to C-M4 and lows, round 6 M1 to M3, and round 7 M1 to M5; security reviews S4, S5, round 3 M1 to M3, round 4 M1 to M3, round 5 S-M1, S-M2 and lows, round 6 N1, N2 and M2, and round 7 M1; [care.md](../specs/care.md) section 6; linked to HZ-006 and HZ-008 |

**Description**: when a session ends with entries unsent, the device holds them for their owner and refuses anyone else (HZ-006). Notes, observations or body-map marks that never reached the server are lost if the held entries are deleted: by the next member of staff, locked out on a shared device, deleting them to get in, or by the device itself.

**Causes**

- The owner is off shift or has left; staff do not know whose entries they are or that the owner can send them; the lockout comes at the start of a busy shift; deleting is quicker than finding the owner.
- On a shared device, the device passcode alone allowed anyone to delete someone else's held entries (security review round 3, M2; now the owner's or a manager's sign-in is needed).
- The hold's time limit deleting held entries automatically when it ran out (the round 2 design; removed in round 3: the hold now escalates to a manager and nothing is deleted automatically). Assessed as a cause because it removed care records with no person deciding.
- Refused entries' content ageing out with the offline window while the server kept no copy (the security review S7 design; removed in round 3, clinical review M1). Assessed as a cause for the same reason.
- A device clock moved forward, bringing a deadline early, or moved back, hiding it (the clock never moves a hold on now: HZ-010). At the server, a report's times are never later than the server received it (round 5).
- A deletion recorded nowhere but the device (the earlier tombstone had no endpoint), or recorded with the person's words in the keystore outside the encrypted database (security review round 3, M1).
- The server records a deletion that then fails on the device (the round 3 design): the audit trail showed a deletion of entries still held, which could later upload. Round 4 recorded the stages apart; round 4's "failed" was also recorded when the entries were already gone (a sign-out clears the rows before the file), so the record said entries survived that did not (clinical review round 5, C-M1).
- A deletion recorded without its entry ids: a cancelled face or fingerprint prompt led to the passcode and a deletion with no ids, and a lock-screen sign-out after a cold start never opened the database (clinical review round 5, C-M2).
- Entries whose deletion was recorded reach the server later all the same (from another copy, or after a failed deletion), or had already reached it when a response was lost, so the same care is counted twice without anyone seeing it.
- The manager's task for a held device was often invisible to the Registered Manager: it had a location only when the reporter had exactly one live assignment, and a task with no location is visible only to tenant-wide roles (an agency worker's role ends at shift end plus 2 hours); its escalation went to team leaders, who cannot act on it (clinical review round 5, C-H1).
- Any member could close, postpone or open the manager's task for any device id with a report (security review round 5, S-M1).
- A hold's task orphaned when the device's id changed after a deletion, wipe or reset (clinical review round 5, C-M3).
- A hold whose session ended with a 401, `not_a_member` or `mfa_enrolment_required` cannot be reported until someone signs in on that device again (the owner, or another member of the organisation): until then the server knows only the device's last report (clinical reviews round 5, C-M4 and round 6, M3).
- The hold's owner could not close a task another member's sign-in had raised for them, and a deletion's last stage sent from the device's next database named the new device, so a hold the owner had drained or deleted stayed open and escalated (clinical review round 6, M1).
- Raising, closing and raising again with a backdated start made a new task due at once each time, about 60 escalated tasks an hour from one member, and the cap on open tasks dropped real holds silently (security review round 6, N2; clinical review round 6, M1).
- Staff working at more than one location had the task raised at one of them only (clinical review round 6, M2).
- Flagged entries raised one task per entry at every stage of a deletion, due at once and never deduplicated, about 2,000 tasks a day from one carer (security review round 6, N1).
- A report could name anyone in the organisation as the hold's owner: the organisation-wide owner's role routed one overdue task to each of up to 50 locations, the audit trail named an innocent person as the owner, a reporter reopening a task took over its owner's right to close it, and naming a new owner each report escaped the start floor (security review round 7, M1).
- A reopened task kept its escalation, so a new hold after a proper close never signalled; a cap could stop the signal altogether (one notice a day, capped flagged entries kept out of every later task); flagged fluid entries waited a day while counting towards the fluid total; flagged entries for people at two locations went to one; an escalation with no one to tell was marked done (clinical review round 7, M1 to M5).

**Effects**: missing care records lead to missed or duplicated care (HZ-003, HZ-004), unescalated incidents (HZ-013) and an incomplete legal record, with no trace of what was lost.

**Initial risk**: severity Major, likelihood Medium, **risk 3**.

**Controls**

Tests are named in `file`: `test name` form; the Verification table below lists them all.

| Type | Control | When |
| --- | --- | --- |
| Design | The sign-in screen names whose entries are held and how many, and says only that member of staff can send them. Tests: `held-work.test.ts`: `hazard HZ-040 says whose entries are waiting, in whole sentences (C8)`; `held-view.test.ts`: `hazard HZ-040 the sign-in screen on held entries (clinical review H2, C8)` | Built in Phase 1 (mobile, clinical review C8) |
| Design | Nothing is deleted automatically. At `mobile.held_entries_max_days` the hold escalates: the last day shows a final warning naming the count and the time, then the sign-in screen says a manager must resolve the entries; a local notification, with no names or counts, fires when the last day starts and at the escalation. A hold without a usable deadline gets now plus the fail-safe day and is saved, so it is never open-ended (security review round 3, M3 and L2; clinical review round 3, H2). Tests: `held-limit.test.ts`: `hazard HZ-040 a hold escalates to a manager and is never deleted (security review M3)`; `held-work.test.ts`: `the hold marker always has a deadline (L2)` | Built in Phase 1 (mobile) |
| Design | Deleting held entries on a shared device needs the owner's or a manager's sign-in on the device (a manager holds `safety.incident.manage` in the same tenant; when the owner is unknown, only a manager, and only when the entries name the manager's organisation and no other), then device authentication, a coded reason from the list and a confirmation naming the count; the device passcode alone is not enough. There are no words and no "Other" here, because the database the words would be kept in is the one deleted. The signer's session ends straight after. Tests: `held-work.test.ts`: `hazard HZ-040 $case`, `hazard HZ-040 checks the entries are the manager's organisation's when the owner is unknown (round 4, low)`, `hazard HZ-040 offers no words, and no Other, where the database is deleted (round 4, M3)`; `sign-out.render.test.ts`: `hazard HZ-040 offers the listed reasons only: no Other and no words, which the deletion would remove (round 4, M3)` | Built in Phase 1 (mobile) |
| Design | A deletion always says which entries it removes, read before anything is deleted (clinical reviews round 4 M3 and round 5 C-M2). A key that is there but could not be read this time (a cancelled prompt) refuses the deletion and asks to try again; entries that could not be read with a key that was read refuse it too. A deletion goes ahead without ids only when nothing on the device could ever be read: no key at all (`key_absent`) or a key kept that is not a valid one (`key_invalid`), and the reason is recorded at the server. A sign-out from the lock screen after a cold start opens the database to read them; a sign-out whose ids cannot be read is refused. Whether a deletion without ids is ever acceptable is a CSO decision (H-144). Tests: `held-work.test.ts`: `hazard HZ-040 which entries a deletion removes, read before anything is deleted (round 5, C-M2)` (all five cases, including `hazard HZ-040 refuses with HeldIdsUnreadableError when the key was read but the entries could not be`); `api.test.ts`: `records what a deletion left on the device as a security event, and why it has no ids (round 5, C-M1 and C-M2)` | Built in Phase 1 (mobile and API) |
| Design | A deletion is put on record as requested before anything is deleted: a tombstone in the keystore holding only a coded reason, the stage and opaque ids (entry, person, owner, who deleted, kind), and `POST /v1/sync/discards`, an append-only audit event per stage with who sent it, who deleted (unknown stays unknown), whose they were, the coded reason, the ids and the device. A request sent at once carries up to 500 entry ids, never more than the count; a request that has to wait keeps 20 of them in the keystore (each item stays under 2 KB) and sends those (round 5, C-L2). The person's own words are never sent: Harbour records the coded reason. A tombstone that cannot be written refuses the deletion. A member of staff's own entries may be deleted while the request waits to be sent; anyone else's, or entries whose owner is unknown, only once the server has acknowledged it. Waiting stages are sent again at each sync, in order; a record this session may not send (403) is skipped and kept; none is dropped before the server has it, and a full list refuses a new deletion rather than drop one. At the API, anyone but the caller's own entries deleted by the caller needs `safety.incident.manage` (Registered Manager, deputy, nurse in charge); the owner and the deleter must be staff of the organisation; a later stage must match the first stage's kind and owner and come from its sender, the owner or a manager; each person may send 30 records an hour, start 20 new records a day (with or without ids) and list 2,000 new entry ids a day (security reviews S4, round 3 M1 and M2, round 4 M1 to M3, round 5 S-M2, S-L1 and S-L2, and round 6 M2). The tombstone names the device the entries were held on, and every stage sends it, so a stage sent from the device's next database still closes that device's task (clinical review round 6, M1). Tests: `discards.test.ts`, `tombstones.test.ts` and `api.test.ts` `hazard HZ-040 device discards (POST /v1/sync/discards)`, as listed below | Built in Phase 1 (mobile and API) |
| Design | A deletion is checked, and its outcome means one thing (clinical reviews round 4 H1 and round 5 C-M1 and C-L1). The entries are marked never to be uploaded together with the request, before anything is deleted; if that keystore write fails, "failed" is recorded and nothing is deleted. Then the rows are cleared (on sign-out, where the database is open), the file deleted and the key destroyed, each checked. "Failed", superseding the request, is recorded only while the entries can still be read: the file, its key and the rows all remain. The entries then stay held and blocked: when their owner signs in they move to "needs attention" (`held_discard_failed`), the device does not connect until they have, and if they cannot be moved the person is told those entries will never be sent. Otherwise "deleted" is recorded, and any file or key left behind is recorded at the server as a separate security event (`sync.device.residue`). Signing out with unsent entries follows the same steps. What "deletion failed" means for the record is a CSO decision (H-143). Tests: `held-work.test.ts`: `hazard HZ-006 hazard HZ-040 the explicit discard wipes: requested and blocked first, deleted only once the entries cannot be read`, `hazard HZ-040 records failed only while the entries can still be read: the file and its key both remain (round 5, C-M1)`, `hazard HZ-040 records deleted when the entries cannot be read, reporting %s left behind (round 5, C-M1)`, `hazard HZ-040 deletes nothing when the entries cannot be marked never to be uploaded (round 5, C-L1)`, `hazard HZ-040 signing out clears the rows before the file, so a file left behind holds no readable entries (round 5, C-M1)`, `hazard HZ-040 signing out records failed when the rows could not be cleared and the file and key remain (round 5, C-M1)`, `hazard HZ-040 a deletion of %j ends %s (round 5, C-M1)`, `hazard HZ-040 after a deletion that did not finish, nothing is uploaded: every entry moves to needs attention (round 4, H1)`, `hazard HZ-040 entries a failed deletion left, which could not be moved (round 5, C-L6)`; `api.test.ts`: `records what a deletion left on the device as a security event, and why it has no ids (round 5, C-M1 and C-M2)` | Built in Phase 1 (mobile and API) |
| Design | An entry uploaded after its own owner's device recorded deleting it (the "deleted" stage, and not later that the deletion failed) is kept, and flagged: an audit event on the entry and a count on one review task for the deletion record, for the Registered Manager at the entries' location, so care recorded again is not counted twice unseen. Only a deletion whose owner is the uploader counts, so no one can mark someone else's entries. An entry a deletion lists that had already reached the server, written by the deletion's owner (a lost response), is flagged the same way when the deletion is recorded as done (clinical reviews round 4 H1 and round 5 C-L2; security reviews round 5 S-M2 and round 6 N1). Each deletion record has one task per kind and location, so each location's managers see only their own people's entries (clinical review round 7, M4), whatever its number of entries, carrying the count in its title and the count and up to 20 opaque entry ids in its audit events (there is no details column); a transaction-scoped lock on the tenant, kind, record and location, and a check for an open task, stop a second, and one owner's flags are taken in turn under a per-owner lock; an entry flagged before, under an earlier record or on its upload, is not flagged again, and every flagged entry is on a task; each owner's deletions have at most 5 such tasks open at a location, and past that the entries join the oldest of them, the cap is audited and the Registered Managers get the daily notice (round 7, M2; HZ-008). The task is due at once when any entry is an observation, otherwise within 24 hours, and comes forward when an observation joins it (round 7, M3; HZ-008). The lookup reads the tenant's deletion records without an index, which a test keeps fast at 3,000 records. **Go-live blocker**: a partial GIN index on `audit_event` scope `entryIds` for `device_discard` rows, or a `device_discard_entry` table, must land before go-live (migration list item 2). Tests: `care.test.ts`: `hazard HZ-040 an entry a device reported deleted, uploaded later (round 4, H1)` (all eleven cases, including `hazard HZ-040 gives each location's managers only their own people's flagged entries (round 7, M4)`, `hazard HZ-008 makes a flagged task due at once when an entry is an observation, and within the day otherwise (round 7, M3)`, `hazard HZ-008 merges an owner's flagged entries past the cap into their oldest open task there, so no cap stops a task (round 6, N1; round 7, M2)`, `flags nothing until the device records the deletion as done (round 6, N1)`, `raises one task per deletion record, however many of its entries arrive (round 6, N1)`, `does not flag again an entry listed under a new deletion record (round 6, N1)`, `stays fast with many deletion records in the tenant (round 5, S-M2)` and `flags an entry a deletion lists that had already reached the server, once the deletion is done (round 5, C-L2; round 6, N1)`) | Built in Phase 1 (API); the index is a go-live blocker |
| Design | The device reports its held, unsent, refused and blocked counts, the oldest age and when the hold started, at each sync when they change and as soon as a hold starts: with the session that is ending (any member of the organisation may report, with MFA where their roles call for it), again while the app runs for an hour, and otherwise with the next session in the tenant; a report that could not be built is replaced by one from the marker's count and kept, never taken as sent; once it has gone, or the hour has passed, the ended session is signed out on the server (clinical reviews round 4 H2 and round 5 C-M4; security review round 5, S-L3). The owner's own next sign-in sends a waiting report too. Every report names the hold's owner and the opaque ids of the locations of the owner's sync scope (kept in the hold's marker and the database's owner record), and a waiting report is sent under the id of the device that held the entries (clinical review round 6, M1 and M2). The device sends its id with every sync token request, so the server records who has used it (security review round 7, M1). Tests: `device-report.test.ts`: `says when the hold started only while entries are held`, `hazard HZ-040 counts the entries a failed deletion left, so the manager's task stays open (round 5, C-M3)`, `hazard HZ-040 still reports a hold whose entries could not be counted (round 5, C-M4)`, `hazard HZ-040 a hold's report names its owner, their locations and the device that held it (clinical review round 6, M1 and M2)`; `held-work.test.ts`: `hazard HZ-040 a hold names where its owner works, so the manager's task goes there (clinical review round 6, M2)`; `connector.test.ts`: `hazard HZ-040 names the device when it asks for credentials, so the server knows who has used it (security review round 7, M1)`; `api.test.ts`: `hazard HZ-006 records a device's unsent counts without personal data`, `asks for MFA where the member's roles call for it (round 5, S-M1)`. The retry and the sign-out are vault wiring with no automated test (device test plan, H-68) | Built in Phase 1 (mobile and API) |
| Design | While anything waits (held, unsent or blocked), the server keeps the device's task for a Registered Manager, due at the hold's start plus `mobile.held_entries_max_days` (clinical reviews round 5 C-H1, round 6 M1 and M2 and round 7 M1, M2 and M5; security reviews round 5 S-M1, round 6 N2 and round 7 M1). The owner the report names counts only when bound to the device: they already have an event from it whose resource is the device (a sync token issued to it, or a report sent from it), as the real owner has from syncing before the hold. A named owner who is not bound is recorded as a claim (`claimedOwnerTenantUserId`) and changes nothing: the task is routed by the reporter's assignments alone, it gives no right to close, the hold's start floor applies whoever is named, and a reopen keeps the recorded owner. Where it goes: the report names the hold's owner (who must be staff of the organisation) and the locations of the device's sync scope; the server keeps those where the reporter, or the owner when bound, has a live or most recent role assignment (any of the organisation's for someone assigned across it), and raises one task at each, closed together; with none left, the reporter's live locations, then their most recent one (an agency worker's role ends with the shift); with no location at all, each Registered Manager in the organisation gets one, assigned to them. Overdue, it escalates only to holders of `safety.incident.manage` at its location. Who closes it: a report with nothing waiting, or recording "deleted" for the device's whole hold (found by the device the deletion names, C-M3), closes every copy when it comes from the hold's owner (named when the task was raised or reopened, even when another member's sign-in sent that report), from whoever raised it, or from a holder of `safety.incident.manage` at one of its locations; anyone else's close is refused and audited. A new hold after a refused close resets the escalation (the due time never later), and so does a reopen of a task that had escalated, under one once-a-day check; a reopen that finds the day's reset used is reset by a later report once it is due, once, so a new hold always signals (clinical review round 8, M2). Bounds: a report's times are never later than the server received it, and a hold's start never earlier than the device's last report for that hold said, nor than the server first heard from the device; a later report can bring the due time earlier, never later; a task closed less than a day ago is reopened; each reporter raises tasks for at most 3 devices in a rolling day, counted under a per-reporter lock, and past that each further hold joins the reporter's one capped-holds task, due at the earliest of them and escalating like a device task, so no cap stops a hold's task; the cap is audited and the location's Registered Managers also get one notice a day about the reporter. Overdue with no one at the location who can act, the task is assigned to the longest-serving Registered Manager anywhere (else holder of the permission anywhere), who can then see and complete it, and is never marked escalated with no one told (rounds 7 and 8, M5 and M1). Every location is taken only from the reporter's own organisation-wide role, and the start floor applies whoever is named as owner (security review round 7, L1 and L2). The task is written as the reporter, and its raise, reopen, moves, reset, close, refused close and cap are audited with opaque ids; reports for a device are handled one at a time under a lock. Who receives and may close these tasks is a CSO decision (H-142), as is the merge in place of a stopped task (H-149). Tests: `api.test.ts`: `hazard HZ-040 raises one task for the Registered Manager at the reporter's location, due when the hold escalates, never moved later, and closed at zero (round 5, C-H1 and S-M1)`, `hazard HZ-040 lets the hold's owner close the task another member's sign-in raised for them (round 6, M1)`, `hazard HZ-040 takes a named owner who never used the device as a claim only: routed by the reporter, recorded, with no right to close (security review round 7, M1)`, `hazard HZ-040 keeps a hold's start floor on the bound owner, so naming a new owner each report does not escape it (security review round 7, M1)`, `hazard HZ-040 keeps the bound owner when a member who never used the device reopens its task (security review round 7, M1)`, `hazard HZ-040 routes to every location only from the reporter's own organisation-wide role, never from a named owner's (security review round 7, L1)`, `hazard HZ-040 never takes a hold's start earlier than the device's last report for it said, whoever reports (round 6, N2; security review round 7, L2)`, `hazard HZ-008 signals a hold reopened after the day's reset was used once the reset is due, and only once (clinical review round 8, M2)`, `hazard HZ-040 raises the task at each location of the device's scope where the owner or reporter works, and closes them together (round 6, M2)`, `hazard HZ-040 closes every Registered Manager's copy with one report or one deletion (round 6)`, `hazard HZ-040 lets a manager close a device's task only at its locations (round 6)`, `hazard HZ-040 gives each Registered Manager the task when the reporter's location is not known (round 5, C-H1)`, `hazard HZ-040 finds the location of an agency worker whose role ended with the shift (round 5, C-H1)`, `hazard HZ-040 another member can neither close nor postpone a known device's task (round 5, S-M1)`, `hazard HZ-010 takes a hold's start no later than the server received the report (round 5, S-M1)`, `hazard HZ-008 reopens a device's task closed within the day and resets its escalation at most once a day, so a new hold always signals and raising again signals at most once more (round 6, N2; round 7, M1)`, `hazard HZ-008 merges each reporter's holds past the day's cap into one task, due at the earliest of them, and tells the location's Registered Manager once (round 6, N2; round 7, M2)`, `hazard HZ-008 resets a task's escalation when a new hold follows a refused close, once a day (round 6, M1)`, `hazard HZ-040 closes the device's hold task when its held entries are recorded deleted (round 5, C-M3)`, `hazard HZ-040 closes the hold of the device a deletion names, sent from the device's next database (round 6, M1)`; `tasks.test.ts`: `tells holders of the task's permission at its location, not team leaders`, `does not tell a holder of the permission at another location (round 6)`, `hazard HZ-040 a sync task whose location has no one who can act on it (round 7, M5)` | Built in Phase 1 (API) |
| Design | A manager can hand over another member of staff's held entries: upload them under the owner's name with the manager recorded, so they reach the server without the owner (task 29) | Planned, Phase 1; go-live blocker under human action H-68 |
| Design | A server check for a device whose last report or sync has gone stale, raising a task for the Registered Manager, would cover holds the server cannot hear of (below). It needs a table of devices and their users, so it waits for a migration; whether it blocks go-live is a CSO decision (H-141) | Planned; needs a migration |
| Test | See Verification | Phase 1 |
| Training and user documentation | Shared-device procedure: before leaving, wait for the banner to show nothing waiting; if locked out by someone else's entries, ask the nurse in charge to contact them rather than deleting; when a hold escalates, a manager resolves it. Deployer control: a shift lead can reach staff who have just left | Phase 1 |

**Target residual risk**: severity Major, likelihood Low, **risk 3**, and not lower until the location routing (C-H1) and the meaning of "failed" (C-M1) are confirmed on a device and the manager hand-over upload (task 29) lands. The server hears of every deletion and each of its stages with who made it and why, nothing is deleted automatically, a shared device needs the owner or a manager to delete, a failed deletion never uploads, and a held device gives a Registered Manager who can act a task. The gap that remains: a hold whose session ended with a 401, `not_a_member` or `mfa_enrolment_required` is reported only when someone signs in on that device again (the owner's own sign-in sends the report, as does another member's in the organisation); until then the server knows only the last report. When another member's sign-in sends it, the task goes where the owner (bound to the device) or that member works and the owner, its raiser or a manager there may close it. The rating stays Major / Low / 3 with the round 6 and 7 fixes. The rating, and whether clinical entries may ever be deleted automatically, are CSO decisions (human actions H-124, H-126 and H-141).

**Verification**

| Test | Status |
| --- | --- |
| `apps/mobile/src/app-state/held-work.test.ts`: `deleting held entries (S4, S5, M1, M2, L4; clinical review round 4, H1)`: `hazard HZ-006 hazard HZ-040 the explicit discard wipes: requested and blocked first, deleted only once the entries cannot be read`, `hazard HZ-040 records failed only while the entries can still be read: the file and its key both remain (round 5, C-M1)`, `hazard HZ-040 records deleted when the entries cannot be read, reporting %s left behind (round 5, C-M1)`, `hazard HZ-040 records failed, and keeps it to send, when the entries remain readable and the server cannot be reached`, `hazard HZ-040 deletes nothing when the entries cannot be marked never to be uploaded (round 5, C-L1)`, `hazard HZ-040 signing out clears the rows before the file, so a file left behind holds no readable entries (round 5, C-M1)`, `hazard HZ-040 signing out records failed when the rows could not be cleared and the file and key remain (round 5, C-M1)`, `hazard HZ-040 a deletion of %j ends %s (round 5, C-M1)`, `hazard HZ-040 deletes nothing when the database id cannot be read (L4)`, `hazard HZ-040 deletes nothing when the deletion cannot be put on record (L4)`, `hazard HZ-040 deletes nothing of someone else's until the server has the request (round 4, M2)`, `hazard HZ-040 a deletion with words needs a coded reason (%j)`, `hazard HZ-040 offers no words, and no Other, where the database is deleted (round 4, M3)`, `hazard HZ-040 checks the entries are the manager's organisation's when the owner is unknown (round 4, low)`, `hazard HZ-040 says whose entries are waiting, in whole sentences (C8)`; `hazard HZ-040 which entries a deletion removes, read before anything is deleted (round 5, C-M2)`: `hazard HZ-040 reads the entry ids with the key, the prompt being the device authentication`, `hazard HZ-040 refuses, and asks to try again, when the key is there but could not be read (a cancelled prompt)`, `hazard HZ-040 refuses with HeldIdsUnreadableError when the key was read but the entries could not be`, `hazard HZ-040 goes ahead without ids only when nothing could ever be read, saying why`, `hazard HZ-040 refuses when the keystore cannot be read at all`; `hazard HZ-040 the words kept for a removed entry (round 5, S-L4)`; `hazard HZ-040 entries a failed deletion left, which could not be moved (round 5, C-L6)`; the owner check before connecting: `hazard HZ-040 after a deletion that did not finish, nothing is uploaded: every entry moves to needs attention (round 4, H1)`, `hazard HZ-040 someone else's refused sign-in keeps the entries blocked (round 4, H1)`; `hazard HZ-040 keeps the words given for a removed entry, which never leave the device (round 4, M3)`; `who may delete held entries on a shared device (M2)`: `hazard HZ-040 $case` | Passing (Phase 1, mobile) |
| `apps/mobile/src/app-state/tombstones.test.ts`: `hazard HZ-040 tombstones hold no personal data (security review M1)` (the API's kinds, codes, stages, leftovers and missing-id reasons; only codes, opaque ids, a count and a time), `hazard HZ-040 tombstones in the keystore (S4, M1, L4)` (`never drops a record the server does not have: a full list refuses the new deletion (round 4, M2)`; only acknowledged records make room; the next stage updates in place); `keeps the opaque id of the device the entries were held on, and nothing else in its place (round 6, M1)` | Passing (Phase 1, mobile) |
| `apps/mobile/src/sync/discards.test.ts`: `hazard HZ-040 deletions go to the API as audit events, one per stage` (including `says why a deletion has no ids, and what its deletion left, only where it applies (round 5, C-M1 and C-M2)` and `names the device the entries were held on, at every stage, so a stage sent from the device's next database closes that device's task (round 6, M1)`), `hazard HZ-040 putting a deletion on record before anything is deleted (round 4, M2)`, `hazard HZ-040 how a deletion ended (clinical review round 4, H1)`, `hazard HZ-040 sending waiting deletions at each sync (round 4, M2)` | Passing (Phase 1, mobile) |
| `apps/mobile/src/sync/held-limit.test.ts`: `hazard HZ-040 a hold escalates to a manager and is never deleted (security review M3)`; `app-state/held-view.test.ts`: `hazard HZ-040 the sign-in screen on held entries (clinical review H2, C8)`; `sync/device-report.test.ts`: `says when the hold started only while entries are held`, `hazard HZ-040 counts the entries a failed deletion left, so the manager's task stays open (round 5, C-M3)`, `hazard HZ-040 still reports a hold whose entries could not be counted (round 5, C-M4)`, `hazard HZ-040 a hold's report names its owner, their locations and the device that held it (clinical review round 6, M1 and M2)`; `app-state/held-work.test.ts`: `hazard HZ-040 a hold names where its owner works, so the manager's task goes there (clinical review round 6, M2)`; `components/sign-out.render.test.ts`: `hazard HZ-040 offers the listed reasons only: no Other and no words, which the deletion would remove (round 4, M3)`, `hazard HZ-040 removing one refused entry (round 4, M3)` | Passing (Phase 1, mobile) |
| `apps/api/test/api.test.ts`: `hazard HZ-040 device discards (POST /v1/sync/discards)`: `records who deleted what, whose, the coded reason, how many and from which device`, `keeps the person's words out of the hash-chained audit trail (round 4, M3; round 5, S-L6)`, `records each stage of a deletion once, and a failure supersedes the request (round 4, H1)`, `records two racing copies of the same stage once`, `needs a manager to delete another member of staff's entries`, `needs a manager for %s (round 4, M1)`, `refuses an owner or deleter who is not staff of this organisation (round 4, M1)`, `records an unknown deleter as unknown, never as the sender (round 5, S-L2)`, `ties a later stage to the deletion it continues: same kind and owner (round 5, S-L1)`, `records what a deletion left on the device as a security event, and why it has no ids (round 5, C-M1 and C-M2)`, `hazard HZ-040 closes the device's hold task when its held entries are recorded deleted (round 5, C-M3)`, `hazard HZ-040 closes the hold of the device a deletion names, sent from the device's next database (round 6, M1)`, `counts each person's entry ids a day (round 5, S-M2)`, `keeps the event in the caller's tenant only (HZ-011)`, `refuses an unknown reason code, more ids than entries, and a body over 64 KB (round 4, M4)`, `limits each person to 20 new deletion records a day, with or without ids (round 6, M2)`; `hazard HZ-006 device reports (POST /v1/sync/device-report)`: `hazard HZ-040 raises one task for the Registered Manager at the reporter's location, due when the hold escalates, never moved later, and closed at zero (round 5, C-H1 and S-M1)`, `hazard HZ-040 another member can neither close nor postpone a known device's task (round 5, S-M1)`, `hazard HZ-010 takes a hold's start no later than the server received the report (round 5, S-M1)`, `hazard HZ-040 gives each Registered Manager the task when the reporter's location is not known (round 5, C-H1)`, `hazard HZ-040 finds the location of an agency worker whose role ended with the shift (round 5, C-H1)`, `hazard HZ-008 reopens a device's task closed within the day and resets its escalation at most once a day, so a new hold always signals and raising again signals at most once more (round 6, N2; round 7, M1)`, `hazard HZ-008 merges each reporter's holds past the day's cap into one task, due at the earliest of them, and tells the location's Registered Manager once (round 6, N2; round 7, M2)`, `hazard HZ-040 lets the hold's owner close the task another member's sign-in raised for them (round 6, M1)`, `hazard HZ-040 takes a named owner who never used the device as a claim only: routed by the reporter, recorded, with no right to close (security review round 7, M1)`, `hazard HZ-040 keeps a hold's start floor on the bound owner, so naming a new owner each report does not escape it (security review round 7, M1)`, `hazard HZ-040 keeps the bound owner when a member who never used the device reopens its task (security review round 7, M1)`, `hazard HZ-040 routes to every location only from the reporter's own organisation-wide role, never from a named owner's (security review round 7, L1)`, `hazard HZ-040 never takes a hold's start earlier than the device's last report for it said, whoever reports (round 6, N2; security review round 7, L2)`, `hazard HZ-008 signals a hold reopened after the day's reset was used once the reset is due, and only once (clinical review round 8, M2)`, `hazard HZ-040 raises the task at each location of the device's scope where the owner or reporter works, and closes them together (round 6, M2)`, `hazard HZ-040 closes every Registered Manager's copy with one report or one deletion (round 6)`, `hazard HZ-040 lets a manager close a device's task only at its locations (round 6)`, `hazard HZ-008 resets a task's escalation when a new hold follows a refused close, once a day (round 6, M1)`, `asks for MFA where the member's roles call for it (round 5, S-M1)`; `test/tasks.test.ts`: `hazard HZ-008 a sync task escalates only to people who can act on it (round 5, C-H1)` (including `does not tell a holder of the permission at another location (round 6)` and `signals again once a device's task is reset after a refused close (round 6, M1)`), `hazard HZ-040 a sync task whose location has no one who can act on it (round 7, M5)`; `test/care.test.ts`: `hazard HZ-040 an entry a device reported deleted, uploaded later (round 4, H1)`; `packages/contracts`: `hazard HZ-040 device discards and reports` | Passing (Phase 1, API) |
| Manager hand-over upload (task 29); stale-device check (needs a migration); the index on deletion records' entry ids (needs a migration; go-live blocker) | Planned, Phase 1 |

---

## HZ-050 An inspector evidence pack exposes a third party or a person outside its scope

| Field | Value |
| --- | --- |
| ID | HZ-050 |
| Status | Open |
| Clinical owner | `[CSO name - human action]`; data protection lead consulted |
| Engineering owner | `quality` module (lead engineer) |
| Source | Master prompt 11.2 (evidence library: "inspector evidence pack export (PDF bundle, watermarked, time-limited link)"), 4 (inspector role: read-only, time-boxed, watermarked exports), 5.1 (data minimisation); [quality.md](../specs/quality.md) rules 1 to 10; [ADR-0050](../decisions/0050-evidence-pack-links.md) |

**Description**: an evidence pack sent to an inspector or commissioner contains the name or details of someone it should not: a relative, visitor, witness or other resident named in a record; a person receiving care who is not in the pack's scope; a whistleblower; or identifiers not needed for the assessment; or the pack reaches someone other than its recipient, or stays open after it should have closed.

**Causes**: records selected by location or date only, without the people in scope; free-text notes that name other residents or family members; incident records about several people; witness and visitor fields copied as written; speak-up or employee relations records tagged as evidence; NHS numbers and addresses copied by default; one person both composing and releasing without a second check; a link forwarded to a colleague; a link with no expiry, or one that cannot be withdrawn; a bundle left in storage after the link ends. Added in the slice 11 review: a field's kind taken from the caller rather than the record type, so a typed column is treated as safe; a hand redaction that misses a name or an NHS number; the person who redacted the text releasing it; a new link issued after a lock-out by someone who shaped the pack, or to a different address; a code guessed by alternating with the real recipient, reused, or verified in one browser and used in another; the permission to open packs held by roles that do not need it.

**Effects**: a person's health, whereabouts or safeguarding history disclosed to someone they did not expect (distress, loss of trust, risk from an alleged abuser who learns of a concern); a whistleblower identified; a reportable personal data breach; the provider's relationship with the regulator harmed.

**Initial risk**: severity Considerable, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Selection by rule: restricted silos never included; date range in UK time; requested locations and statements only; items about nobody in scope excluded, with the reason kept in the internal manifest (`evidenceItemExclusion` in `packages/domain/src/quality/evidence-pack.ts`) | Phase 1 (domain rules built, slice 11) |
| Design | Minimisation field by field: the kind of every field comes from a typed map per record type (`EVIDENCE_FIELD_KIND_MAP`), never from the caller, and a field the map does not name is free text; every column a person types into is free text; care content only about people in scope; identifiers withheld; third parties and (by default) staff replaced by a role from a closed list; free text withheld until a person has redacted it by hand; every redaction says why in words (`minimiseEvidenceField`, `evidenceFieldKind`; [quality.md](../specs/quality.md) rule 3) | Phase 1 (domain rules built, slice 11) |
| Design | A hand-redacted copy is withheld again when it still holds a third party's name, a staff name while roles are shown, the name of a person on the record outside the pack's scope, or a run of ten digits (`redactionLeaks`; quality.md rule 4) | Phase 1 (domain rules built, slice 11) |
| Design | Release, and any new link, by someone who did not shape the pack (not the composer, a hand redactor or any other editor), with step-up; a new link goes to the same recipient only and revokes the old one (`evidencePackContributors`, `checkEvidencePackRelease`, `checkEvidencePackLinkReissue`; quality.md rules 6 and 9) | Phase 1 (domain rules built, slice 11) |
| Design | One link per recipient: a hashed random token, opened only after a six-digit one-time code from a cryptographic source, stored hashed, used once and valid for at most 10 minutes, sent to the bound address; verification held in an HttpOnly session for that link, never on the link row; a failed-code count that never resets and locks the link for good; expiry at a tenant default up to a maximum; revocable at once; the bundle deleted when the link ends; every page watermarked with the recipient, purpose, time and pack id (`checkEvidencePackCode`, `evidencePackLinkAccess`, `evidencePackWatermark`, `evidencePackBundleDeletable`; quality.md rules 7, 8 and 10; ADR-0050) | Phase 1 (domain rules built, slice 11; routes with the API step) |
| Design | `quality.evidence.read` is a care-record permission (MFA) held by the inspector role alone | Phase 1 (built, slice 11) |
| Design | Every open, code attempt and revocation is audited | Phase 1 (API step) |
| Test | See Verification | Phase 1 |
| Training and user documentation | Deployer control: the quality lead reviews the redaction preview before asking a second person to release; the DPO confirms the redaction rules (H-96) | Phase 1 |

**Target residual risk**: severity Considerable, likelihood Very low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain/src/quality/evidence-pack.test.ts`: `hazard HZ-050 fields are minimised and redacted by rule` (third parties' names removed, care content about people outside the pack withheld, free text withheld until a person has redacted it, identifiers withheld, staff by role) | Passing (Phase 1, slice 11) |
| `packages/domain/src/quality/evidence-pack.test.ts`: `hazard HZ-050 items outside the request are excluded` (restricted records, dates in UK time, locations, statements, people outside the pack's scope) | Passing (Phase 1, slice 11) |
| `packages/domain/src/quality/evidence-pack.test.ts`: `hazard HZ-050 the field-to-kind map decides how every field is treated` (`covers every evidence record type`; `treats every field a person types as free text`; `ignores any kind the caller tries to give a field`) | Passing (Phase 1, slice 11) |
| `packages/domain/src/quality/evidence-pack.test.ts`: `hazard HZ-050 hand-redacted text that still names someone is withheld` | Passing (Phase 1, slice 11) |
| `packages/domain/src/quality/evidence-pack.test.ts`: `hazard HZ-050 releasing a pack: nobody who shaped it may release it`; `hazard HZ-050 issuing a new link is a release` | Passing (Phase 1, slice 11) |
| `packages/domain/src/quality/evidence-pack.test.ts`: `hazard HZ-050 one-time codes` (six digits only, wrong link, malformed, used, expired, wrong code; `never resets the failed-attempt count, even after a correct code`); `hazard HZ-050 the link opens only for its recipient's own session, before expiry and revocation`; `lets a tenant shorten the code lifetime but never lengthen it` | Passing (Phase 1, slice 11) |
| `packages/domain/src/quality/evidence-pack.test.ts`: `gives opening a released pack to the inspector role alone (least privilege)` | Passing (Phase 1, slice 11) |
| `apps/api`: `hazard HZ-050 the rendered pack contains no third party's name and no person outside its scope` (snapshot of a rendered fixture pack) | Planned, Phase 1 (API step) |

---

## HZ-051 A letter or email carries another person's details, or wording that was not approved

| Field | Value |
| --- | --- |
| ID | HZ-051 |
| Status | Open |
| Clinical owner | `[CSO name - human action]`; data protection lead consulted |
| Engineering owner | `comms` module (lead engineer) |
| Source | Master prompt 15.1 (templates and letters: "merge-field letters and emails (admission, fee review, incident follow-up, duty of candour) with approval and audit"); regulation 20 of the 2014 Regulations (candour letters); [comms.md](../specs/comms.md) rules 18 to 26; [ADR-0051](../decisions/0051-personal-data-in-template-emails.md) |

**Description**: a letter or email generated from a template merges details that belong to a different person (another resident's name, fees, incident or candour account), goes to another person's contact, leaves a blank where a fact should be, carries health details by email, or uses wording that nobody with authority approved, so a family acts on wrong information or learns about someone else.

**Causes**: values gathered for the wrong person or from a stale screen; a recipient picked from another person's contacts; a missing value merged as an empty string; a template edited after approval; the author approving their own template; an unknown or mistyped merge field rendered as text; special category fields allowed in email; markup in a value breaking an HTML email; a duty of candour letter missing the apology or the account required by regulation 20(4). Added in the slice 11 review: a line break or hidden character in an email subject (header injection, or a subject that reads differently from what it says); an address field merged into a subject; an incident or candour letter set up as an email; the NHS number or date of birth in an email; a candour letter sent to someone who is not the relevant person under regulation 20(7); a first candour letter with the results left blank, or no follow-up once they are known; letter text treated as markup by the PDF renderer.

**Effects**: a family told the wrong fee, the wrong account of an incident or the wrong apology; another person's health details disclosed (breach, distress); a candour obligation not met; decisions (for example about a fee or a complaint) taken on wrong information.

**Initial risk**: severity Considerable, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Every person-bound merge value must belong to the person the letter is about, and the recipient must be that person's contact, or the letter is refused (`renderTemplate` in `packages/domain/src/comms/templates.ts`) | Phase 1 (domain rules built, slice 11) |
| Design | A missing or blank value refuses the letter; values are type-checked and formatted (dates, pounds and pence); unknown or malformed fields are refused at authoring | Phase 1 (domain rules built, slice 11) |
| Design | Only an approved version renders; nobody who wrote or edited a version approves it; approved versions never change, so any change is approved again (`checkTemplateApproval`, `checkTemplateEdit`, `TEMPLATE_WORKFLOW`) | Phase 1 (domain rules built, slice 11) |
| Design | No personal data in email subjects and no special category data in email bodies; every value and the template's text escaped for HTML; a duty of candour template must contain the regulation 20(4) contents (`checkTemplateDefinition`; ADR-0051) | Phase 1 (domain rules built, slice 11) |
| Design | Email subjects refuse C0 and C1 control characters, U+2028 and U+2029 and bidirectional controls, in the template and again after merging, and refuse multi-line fields such as `{{location.address}}`; incident follow-up and duty of candour templates are letters only; the NHS number and date of birth never go in an email body (`hasUnsafeHeaderCharacter`, `LETTER_ONLY_KINDS`, `checkTemplateDefinition`; [comms.md](../specs/comms.md) rule 20) | Phase 1 (domain rules built, slice 11) |
| Design | A duty of candour letter renders only for the relevant person on the candour record, and a representative only on a regulation 20(7) basis (`checkCandourRelevantPerson`); `candour.results` alone may say the results are to follow, with standard words, and the letter is marked so the follow-up stays due (`resultsToFollowText`; comms.md rule 21; wording and reading for the CSO and a solicitor, H-103) | Phase 1 (domain rules built, slice 11) |
| Design | Letter text is passed to the PDF renderer (Typst) as data, never as markup (comms.md rule 24) | Phase 1 (API step) |
| Design | Before sending, the sender sees the person's name and photo (HZ-001), the recipient and the flagged personal-data fields; the letter, template version and fields used are stored and audited | Phase 1 (API and web steps) |
| Test | See Verification | Phase 1 |
| Training and user documentation | Deployer control: starter wording reviewed by the provider's adviser; candour letters signed off by the Registered Manager | Phase 1 |

**Target residual risk**: severity Considerable, likelihood Low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain/src/comms/templates.test.ts`: `hazard HZ-051 refuses to merge details that belong to another person`; `hazard HZ-051 refuses a recipient who is another person's contact`; `hazard HZ-051 refuses a person-bound value with no person`; `hazard HZ-051 needs the person the letter is about` | Passing (Phase 1, slice 11) |
| `packages/domain/src/comms/templates.test.ts`: `hazard HZ-051 refuses a letter with a missing value rather than leaving it blank`; `hazard HZ-051 only an approved version can be used` | Passing (Phase 1, slice 11) |
| `packages/domain/src/comms/templates.test.ts`: approval and separation of duties, fixed approved versions, email data classes, HTML escaping, the regulation 20(4) contents | Passing (Phase 1, slice 11) |
| `packages/domain/src/comms/templates.test.ts`: `hazard HZ-051 email subjects cannot carry hidden characters or several lines` (`refuses a rendered subject whose value smuggles in a line break`); `hazard HZ-051 health details and identifiers stay out of email` | Passing (Phase 1, slice 11) |
| `packages/domain/src/comms/templates.test.ts`: `hazard HZ-051 duty of candour letters` (results to follow with and without a date; only in `candour.results`; the recipient must be the relevant person; the regulation 20(7) bases) | Passing (Phase 1, slice 11) |
| `apps/api`: `hazard HZ-051 a letter's values print as text in the PDF` (a value full of Typst syntax) | Planned, Phase 1 (API step) |
| `apps/api`: `hazard HZ-051 a letter cannot be made with another person's details` | Planned, Phase 1 (API step) |

---

## HZ-060 Health details in an email, SMS or push notification to a family member

| Field | Value |
| --- | --- |
| ID | HZ-060 |
| Status | Open |
| Clinical owner | `[CSO name - human action]`; data protection lead consulted |
| Engineering owner | `comms` module (family notifications); `integrations` (adapters) |
| Source | Master prompt 9.1 (push, email and SMS bodies never carry personal data), 15.1, 15.3 (communications); [comms.md](../specs/comms.md) section 4 rules 13 to 15 |

**Description**: a notification telling a family member about a new update carries something about the person's health or care (a fall, an infection, a score, a hospital visit, the person's name with an event) in an email subject, an SMS or a push notification, where it can be read on a lock screen, a shared phone or tablet, a work inbox, a smartwatch or by the SMS gateway and push services, before or without the family member signing in.

**Causes**: a notification built from the update's text ("Ada had a fall today"); a template with merge fields for the person's name or the update; a template edited by staff without approval; a link that carries the person's id, name or the update in its query; a stale phone number or email address now held by someone else; an urgent-feeling event (a fall, a hospital admission) sent as a notification instead of a phone call; a mobile number shared by several family members.

**Effects**: the person's health or circumstances disclosed to someone who should not know (a safeguarding or financial abuse risk, loss of dignity and trust); a family member learning of a fall or a deterioration from a lock screen without support; a reportable personal data breach.

**Initial risk**: severity Considerable, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Content-free by construction: the planner is given the ids of new updates, never their content, so nothing an update says can reach a message (`planFamilyNotification` in `packages/domain/src/comms/notify-plan.ts`) | Phase 1 (domain rule built, slice 12) |
| Design | The words are the latest approved template for the channel, the same for everyone: no placeholders; refused when not approved or withdrawn, when the outbound guard objects (NHS numbers, dates, email addresses, phone numbers, more than 80 characters), when it contains a clinical, event or wellbeing term, or when it names the person in any case or with lookalike letters (`checkFamilyNotificationTemplate`) | Phase 1 (domain rule built, slice 12) |
| Design | The link is the portal's updates page with no id, name, query or fragment (`familyUpdatesLink`); the detail is shown only after sign-in with MFA and under the sharing rules (HZ-022) | Phase 1 (domain rule built, slice 12) |
| Design | Every adapter rechecks the title with `outboundTitleProblem` before sending | Built in Phase 0 |
| Design | Channels are opt-in and verified; a bounce, complaint, unregistered device or opt-out stops the channel; a new address must be verified again (`channels.ts`) | Phase 1 (domain rule built, slice 12) |
| Design | No notification ever carries an event: it holds only the approved template. The feed has no kind for deaths, discharges, falls or hospital admissions; staff-written words that announce one (`FEED_EVENT_TERMS`: a fall, hospital or A&E, an ambulance, a death, a stroke and similar) are refused unless a member of staff holding `comms.feed.publish` confirms with a reason (HZ-061), and nothing is published while the person is in hospital or an incident waits for next-of-kin contact. A held notification is re-checked before it goes and cancelled when nothing is left to tell (`recheckPendingNotification`) | Phase 1 (domain rule built, slice 12) |
| Test | See Verification | Phase 1 |
| Training and user documentation | Deployer control: staff tell next of kin about incidents, hospital admissions, deterioration and deaths by phone or in person under the tenant's policy; template approvers are trained to keep templates generic | Phase 1 |

**Target residual risk**: severity Considerable, likelihood Very low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain/src/comms/notify-plan.test.ts`: `hazard HZ-060 sends only the approved words and a link with no ids, whatever the updates are` | Passing (Phase 1, slice 12) |
| `packages/domain/src/comms/notify-plan.test.ts`: `hazard HZ-060 refuses a template with ...` (a score and the person's name, a diagnosis, a prognosis, the surname in lower case, a merge field, an NHS number, a date, a phone number, an email address, a long message, an event, a wellbeing claim) | Passing (Phase 1, slice 12) |
| `packages/domain/src/comms/feed-text-review.test.ts`: `hazards HZ-060 and HZ-061 events and wellbeing claims need a manager's confirmation`; `notify-plan.test.ts`: `a waiting notification is checked again before it goes` | Passing (Phase 1, slice 12) |
| `packages/domain/src/comms/notify-plan.test.ts`: `hazard HZ-060 skips a channel whose template is not allowed, and says why`; `hazard HZ-060 keeps every validated tool name out of templates` | Passing (Phase 1, slice 12) |
| `apps/api/test/adapters.test.ts`: `refuses a title that looks like personal data` (the port contract every adapter passes) | Passing (Phase 0) |
| `apps/api`: `hazard HZ-060 the notification worker sends the approved template only` | Planned, Phase 1 (slice 12 API step) |

---

## HZ-061 Family reassured by a stale or misleading update

| Field | Value |
| --- | --- |
| ID | HZ-061 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `comms` module (family feed) |
| Source | Master prompt 15.1 (family portal feed), 8 (plain English for family surfaces); [comms.md](../specs/comms.md) section 4 rules 3, 4, 7 and 12. HZ-002 covers staff reading stale data on an offline device; this hazard is about families reading the feed |

**Description**: a family member or representative reads the feed as a current, complete picture of how the person is, when it is old, selective or wrong: an update from days ago read as today's, routine activity updates while the person is unwell or in hospital, a cheerful sentence that says more than the record does, or an update later found to be wrong. They do not visit, ask questions or raise a concern, or an attorney does not take part in a decision, because the feed reassured them.

**Causes**: updates without the time they happened; an update written days later shown as new; phrasing that claims wellbeing ("Ada had a lovely day", "settled and happy"); a feed that looks like the whole record; a corrected or withdrawn update left showing, or silently removed after being read; few updates read as "all is well"; events that matter (a fall, a hospital admission, a change in needs) missing from a feed that only carries everyday items. Found in review: staff-written words that announce an event ("had a fall", "went to A&E", "died", "had a stroke") or claim how the person is ("settled and happy"), published before the family has been told by a person; everyday updates published while the person is in hospital, an incident waits for next-of-kin contact or a duty of candour step is open; a care plan update announcing end of life or a medicines change; an accompaniment to an emergency or unplanned appointment, or a visit still under way, shown as routine; a feed that empties without a word after a death or discharge.

**Effects**: concerns about neglect or deterioration raised late; an attorney or deputy not involved when they should be; distress and loss of trust when the family learns more; complaints.

**Initial risk**: severity Considerable, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Every entry shows when the thing happened, and when it was written if that was on a later UK day; the feed shows when the newest update happened; newest first (`buildFamilyFeed`) | Phase 1 (domain rule built, slice 12) |
| Design | Every feed says: "These are everyday updates. They are not the full care record. The home will phone you about anything important." (`FEED_NOT_FULL_RECORD_STATEMENT`) | Phase 1 (domain rule built, slice 12) |
| Design | Approved phrases say what happened, never how the person is, and are tested over every care plan section the feed announces (`FEED_PHRASES`) | Phase 1 (domain rule built, slice 12) |
| Design | Staff-written words (shared notes, captions, activity names) that announce an event (`FEED_EVENT_TERMS`) or claim how the person is (`FEED_WELLBEING_TERMS`) are refused unless a member of staff holding `comms.feed.publish` confirms with a reason of at least `FEED_CONFIRMATION_MIN_REASON_LENGTH` characters; the update records who confirmed and why; clinical terms are refused whatever is confirmed (`checkFeedText`). The lists are a backstop behind the staff member's decision to share, not a complete vocabulary | Phase 1 (domain rule built, slice 12) |
| Design | Publishing holds: nothing is published for the person while they are in hospital, while an incident waits for their next of kin to be told, or while a duty of candour step is open (`feedPublishingHolds`, reading the candour workflow in `packages/domain/src/safety/candour.ts`) | Phase 1 (domain rule built, slice 12; safety exposes the next-of-kin state in its schema step) |
| Design | Care plan sections outside a typed allow-list are never announced (`FEED_CARE_PLAN_DOMAINS`: end of life, medicines, skin, continence, cognition, mood, behaviour, pain, breathing, sexuality and relationships); accompaniments are composed only with a recorded purpose and only for planned appointments; a visit still under way is never composed (`ACCOMPANIMENT_PURPOSES`) | Phase 1 (domain rule built, slice 12) |
| Design | After a discharge or death, a family member who had a decision sees "Updates are paused. The home will be in touch." (`FEED_PAUSED_STATEMENT`), never a feed that suddenly empties | Phase 1 (domain rule built, slice 12) |
| Design | A wrong update is taken down with a reason; a family member who saw it sees that it was taken down, and a corrected update names the one it replaces (`checkFeedWithdrawal`, `FEED_WITHDRAWN_NOTICE`) | Phase 1 (domain rule built, slice 12) |
| Design | The family app mode shows its last sync time (as HZ-002 for staff) | Phase 4 (MOB-004) |
| Test | See Verification | Phase 1 |
| Training and user documentation | Deployer control: the tenant's communication policy says what families are told by phone (incidents, hospital admissions, changes in needs, deterioration, deaths) and by whom; the family guide explains what the feed is and is not | Phase 1 |

**Target residual risk**: severity Considerable, likelihood Medium, **risk 3** (kept at the initial rating until the CSO reviews the lists, holds and wording, H-110).

**Justification for level 3**: the feed exists to share everyday staff-written news (master prompt 15.1), and no word list can recognise every way of announcing an event or reassuring a family ("had a tumble", "a good day"); a manager may confirm wording that reassures more than the record supports; the publishing holds depend on the incident, candour and lifecycle records being up to date; and families may still read a run of everyday updates as all being well. The controls make the feed's limits visible and keep the commonest events and claims behind a deliberate, recorded decision; removing staff-written words altogether would remove what families value most. `[CSO acceptance - human action]`

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain/src/comms/feed-visibility.test.ts`: `hazard HZ-061 lists open items newest first with when they happened and when they were added`; `hazard HZ-061 tells a viewer who saw an update that it was taken down, without its content`; `hazard HZ-061 does not count a withdrawn notice as the last update` | Passing (Phase 1, slice 12) |
| `packages/domain/src/comms/feed-compose.test.ts`: `hazard HZ-061 approved phrases say what happened, never how the person is` (every phrase over every announced care plan section: no clinical, event or wellbeing words; the reading-age lint on one sample section); `hazard HZ-061 care plan sections announced in the feed` (every section against the allow-list; never end of life or medicines); `hazard HZ-061 holds every update while the person is in hospital` | Passing (Phase 1, slice 12) |
| `packages/domain/src/comms/feed-compose-review.test.ts`: `hazard HZ-061 a fall`, `hazard HZ-061 an A&E visit`, `hazard HZ-061 a death`, `hazard HZ-061 a stroke`, `hazard HZ-061 pressure sores` (a clinical term, refused outright), `hazard HZ-061 settled and happy`, an ambulance and the police; `hazard HZ-061 publishes flagged words once a manager confirms, and records who and why`; `hazard HZ-061 refuses a confirmation ...` (without the permission, with a short reason, by nobody); `hazard HZ-061 never lets a confirmation publish a clinical term`; `hazard HZ-061 publishing holds` (in hospital, an incident waiting for next-of-kin contact, an open candour step); `hazard HZ-061 visits and accompaniments` | Passing (Phase 1, slice 12) |
| `packages/domain/src/comms/feed-text-review.test.ts`: `hazards HZ-060 and HZ-061 events and wellbeing claims need a manager's confirmation` (and ordinary words that are not flagged: falling asleep, happy birthday, hospitality) | Passing (Phase 1, slice 12) |
| `packages/domain/src/comms/feed-visibility.test.ts`: `hazard HZ-061 pauses the feed with a neutral statement when the person is ..., never an empty feed` (discharged, deceased) | Passing (Phase 1, slice 12) |
| `apps/web`: `hazard HZ-061 the family feed shows the statement, the last update time and each entry's times` (Playwright with axe) | Planned, Phase 1 (slice 12 web step) |

---

## HZ-070 Full tenant export disclosed beyond the organisation

| Field | Value |
| --- | --- |
| ID | HZ-070 |
| Status | Open |
| Clinical owner | `[CSO name - human action]`; data protection lead consulted |
| Engineering owner | `platform` module (lead engineer) |
| Source | Master prompt 5.1 (free full export, delivered by expiring link), 5.3 (step-up for data export); [platform-completions.md](../specs/platform-completions.md) rules 10 to 15 |

**Description**: the organisation's full export, which holds every person's record and documents and its staff data, reaches someone it should not: through a forwarded or leaked link, a download by someone other than the person who asked for it, a file kept long after its purpose, or a copy left on a shared or unmanaged computer; or the export holds another organisation's records.

**Causes**: bearer links in emails or chat; links or files that never expire; downloads without signing in again; an owner who has left still able to download; long-lived or cached storage URLs; a stolen session; export files stored indefinitely; secrets or internal keys in the files; an export saved to a personal device; an export job that reads another organisation's rows (a query or role that bypasses row-level security, a missing tenant predicate, a shared storage path), so one organisation receives another's records; a cell that a spreadsheet runs as a formula when the file is opened.

**Effects**: disclosure of special category data for every person, including the whereabouts of people at risk (a safeguarding risk, for example to someone who has fled domestic abuse); a reportable personal data breach; staff data disclosed.

**Initial risk**: severity Major, likelihood Low, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Only holders of `platform.export.create` (the owner) can ask for an export; it is a care-record permission, so MFA is required, and the request needs a sign-in completed with the second step within the step-up window; every request is audited | Phase 1 (domain rules built) |
| Design | Only the person who asked can download it, while they still hold the permission and have stepped up with MFA, while it is ready; the notification carries a pointer to that check, not a bearer link; the API streams the file or mints a storage URL that lasts 5 minutes | Phase 1 (domain rules built; API) |
| Design | The file is deleted `export.link_expiry_hours` after it is ready (tenant default 72, to verify) and never later than the ceiling `export.link_expiry_hours_max` (168, to verify), whatever the tenant sets; a new export is always free, so nothing is kept "in case" | Phase 1 (domain rules built; worker) |
| Design | Every column is classified `exported`, `internal` or `secret` in the catalogue keyed by `schema.table`; only the `public` schema and only exported columns are read, so passwords, sessions, authenticator secrets, secret references, storage keys and sign-in ids never leave; an unclassified table or column is never written and makes the export incomplete; quarantined files are never handed out | Phase 1 (domain rules built) |
| Design | The export worker runs as `harbour_app` inside `withRequestContext` for the exporting organisation, so forced row-level security applies to every read; the manifest counts any row whose `tenant_id` differs from the exporting organisation's, which fails the export and raises a security alarm | Phase 1 (domain rules built; worker with the API step) |
| Design | Files are stored in the eu-west-2 export bucket with SSE-KMS under the organisation's own prefix (`tenants/<tenant>/exports/<export>/`) | Phase 1 (domain rules built; infrastructure) |
| Design | In CSV files a text cell starting with `=`, `+`, `-`, `@`, a tab, a carriage return or an apostrophe gets a leading apostrophe so a spreadsheet does not run it; `schema.json` documents the guard and JSON Lines keep the exact value | Phase 1 (domain rules built) |
| Design | Every download is audited and visible to the owners and the data protection lead | Phase 1 |
| Test | See Verification | Phase 1 |
| Training and user documentation | Deployer control: download only to a managed, encrypted device; delete local copies once used; the export guide says so | Phase 1 |

**Target residual risk**: severity Major, likelihood Very low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain/src/platform/export.test.ts`: `hazard HZ-070 the export link expires and works only for the requester` (MFA step-up, expiry ceiling, 5-minute storage URL), `hazard HZ-070 export request: free, MFA step-up, one at a time`, `hazard HZ-070 export plan reads only what may leave` (internal and secret columns, the `auth` schema and unclassified tables never planned), `hazard HZ-070 CSV cells cannot run as spreadsheet formulas`, `stores each export under the organisation's own prefix (HZ-070)`; `hazard HZ-071 an incomplete export is never offered` (a row from another organisation fails the export) | Passing (Phase 1) |
| `packages/domain/src/platform/access.test.ts`: `platform.export.create` touches care records, so MFA is required | Passing (Phase 1) |
| `packages/db`: `hazard HZ-070 the export reads only the exporting tenant` (the worker's reads as `harbour_app` inside `withRequestContext` return no other organisation's rows) | Planned, Phase 1 (schema step) |
| `apps/api`: `hazard HZ-070 an export download needs the requester's fresh sign-in and stops at expiry` | Planned, Phase 1 |
| `apps/api` (worker): `hazard HZ-070 an expired export's file is deleted` | Planned, Phase 1 |

---

## HZ-071 Full tenant export incomplete or misread when a provider changes system

| Field | Value |
| --- | --- |
| ID | HZ-071 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `platform` module (lead engineer) |
| Source | Master prompt 5.1 (full export in a documented schema; DSCR data migration standard); DPA clause 9.1; [data-standards.md](../specs/data-standards.md); [platform-completions.md](../specs/platform-completions.md) rules 10, 11, 14 and 16 |

**Description**: a provider moving to another system relies on Harbour's export, but records are silently missing from it or are misread, so the new system lacks some people's allergies, resuscitation decisions, medicines or care plans.

**Causes**: a new table or column left out of the export; rows dropped by a fault; a truncated file; documents not copied or corrupted; held or deleted records handled inconsistently; codes whose meaning is not documented; destroyed records indistinguishable from missing ones; sample data mixed in; files read at different moments, so one table disagrees with another; a correction and the entry it corrects read as two current facts; a date-only fact (a date of death or discharge) read from its UTC instant, a day early after 23:00 in summer; numbers without units (millilitres or litres, kilograms or stones); an allergy status of unknown read as no allergies; resuscitation records that conflict reduced to one; the receiving system's import mapping errors.

**Effects**: care given without essential information after the move (as HZ-007 and HZ-015), for example an allergen given or a resuscitation decision not known; an incomplete legal record. The export covers every person the organisation cares for, so one misread file can affect many people at once.

**Initial risk**: severity Catastrophic, likelihood Medium, **risk 4**. Re-rated after the clinical review: a fault in a tenant-wide export can harm multiple people, which the plan's severity scale rates Catastrophic, not Major.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | The catalogue (`EXPORT_TABLES`) keys every table by `schema.table` and classifies every column, with a description and a unit for every number; tables holding care records describe every column explicitly; `schema.json` is generated from the same plan as the files; a test against the Drizzle schema fails the build when a table or column is unclassified or has gone, and at run time an unclassified one makes the export incomplete | Phase 1 (domain rules and catalogue test built) |
| Design | The manifest records row counts and SHA-256 for every file and document; a missing table or file, a row count that does not match, a current summary without one row per exported person, or a document whose bytes differ from the checksum recorded at upload marks the export incomplete, so it is failed and retried, never offered | Phase 1 (domain rules built) |
| Design | Every file is read in one `REPEATABLE READ` read-only transaction, so all tables are from one moment, recorded in the manifest as `snapshotAt` in UTC and UK time; a "changes since this export" export holds only rows created, changed, recorded, deleted or destroyed at or after an earlier snapshot | Phase 1 (domain rules built; worker with the API step) |
| Design | `schema.json` carries the conventions a reader needs: a correction is a new row naming the row it corrects and the current value is the row nothing supersedes; instants are UTC with the UK offset stated; a date-only fact stored as an instant gets a `<column>_uk_date` column; recurrence times are Europe/London wall-clock times; every number has its unit, and observation values have a schema per chart; allergy status codes with their meaning (`unknown` never means none) | Phase 1 (domain rules built) |
| Design | `current_summary.csv` gives one row per person with the essentials as Harbour shows them, worked out by the same functions as the point-of-care header and the transfer pack: allergy status and allergies most severe first, the resuscitation decision in force (or `conflicting` with every record in force), IDDSI levels and communication needs | Phase 1 (domain rules built) |
| Design | Documented row rules: records under legal hold always in; soft-deleted and sample rows left out and counted; destroyed records listed with their certificate ids; quarantined files keep their rows | Phase 1 (domain rules built) |
| Design | Field meanings and code lists in [data-standards.md](../specs/data-standards.md), versioned with `EXPORT_SCHEMA_VERSION` (1.1.0) | Phase 1 (built) |
| Test | See Verification | Phase 1, Phase 2 |
| Training and user documentation | Deployer control: the receiving provider reconciles row counts against the manifest and checks allergies, resuscitation decisions and medicines person by person before relying on the new system; the export guide gives the steps | Phase 1 |

**Target residual risk**: severity Catastrophic, likelihood Very low, **risk 3**. Until the CSO accepts that the controls bring the likelihood to Very low (H-119), the residual risk is recorded as Catastrophic / Low / **4**, which blocks a production release.

**Justification for level 3**: severity stays Catastrophic, because one bad import still reaches every person. The new controls lower the likelihood: an export that is incomplete, mixes moments or holds an unclassified column is never offered; the meaning of every column, correction, date and unit is in the export itself; and the essentials (allergies, resuscitation, IDDSI, communication) arrive pre-computed, one row per person, so misreading them needs the receiving system to ignore both the schema and the current summary. Level 3 is the lowest the matrix gives a Catastrophic hazard, and further reduction is impractical because the receiving system's import and mapping are outside Harbour's control; that remaining risk is managed by the receiving provider's reconciliation (deployer control). `[CSO acceptance - human action]`

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain/src/platform/export.test.ts`: `hazard HZ-071 the export catalogue describes every table and column`, `hazard HZ-071 which rows go into the export` (including changes since a snapshot), `hazard HZ-071 an incomplete export is never offered` (missing files, row counts, current summary, document checksums, foreign rows), `hazard HZ-071 schema.json gives every column its meaning` (conventions, units, codes, derived UK dates) | Passing (Phase 1) |
| `packages/domain/src/platform/export.test.ts`: `hazard HZ-071 UK dates and times in the export` (dates of death after 23:00 in summer, the autumn overlap), `hazard HZ-071 observation values carry their units and a schema per chart`, `hazard HZ-071 the current summary is worked out as Harbour shows it` (unknown allergy status, conflicting resuscitation records, IDDSI, communication needs) | Passing (Phase 1) |
| `packages/db/src/export-catalogue.test.ts`: `hazard HZ-071 the export catalogue matches the Drizzle schema` (every public table and column classified, nothing stale, every exported column described and every number given a unit, nothing planned outside `public`) | Passing (Phase 1) |
| `apps/api` (worker): `hazard HZ-071 every file of an export is read in one snapshot` | Planned, Phase 1 |
| `apps/api`: `hazard HZ-071 an export round-trips through the import wizard with matching counts` | Planned, Phase 2 (with PLAT-014) |

---

## HZ-072 Sample data mistaken for, or mixed with, real records

| Field | Value |
| --- | --- |
| ID | HZ-072 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `platform` module (lead engineer) |
| Source | Master prompt 9.1 (sample data mode); [platform-completions.md](../specs/platform-completions.md) rules 29 to 32 |

**Description**: while an organisation is getting started, invented sample people or records are taken for real ones, real care is recorded against a sample person, or a sample incident is treated as a real one.

**Causes**: sample people who look real; a sample telephone number or address that belongs to a real person; sample and real people in the same lists; real records arriving by import, integration, enquiry or TUPE transfer while sample data exists; a real note, incident or document linked to a sample person; sample data left in place at go-live; a notification, alert, escalation, handover, downtime pack, print, clock, report or export that does not check the sample flag; a removal that deletes real rows.

**Effects**: a real person's note, observation or administration recorded against a sample person and missing from their record; a wrong-person decision (HZ-001); a false statutory notification; misleading reports.

**Initial risk**: severity Considerable, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Sample people are plainly invented: family name "Example", 999-range NHS numbers that pass the check digit, `example.invalid` email addresses, telephone numbers in Ofcom's drama ranges (to verify, H-123) and invented addresses (an "Example" street, no postcode or the ZZ99 pseudo-postcode area) | Phase 1 (domain rules built) |
| Design | A sample person carries a "Sample" badge on every screen, and any print showing sample data carries the watermark "SAMPLE DATA: NOT A REAL PERSON" | Phase 1 (domain rules built; screens and prints) |
| Design | Sample data loads only before any real person exists, and real records wait until it has gone by every creation path (manual entry, enquiry, import, integration, TUPE transfer), so sample and real people never share a list | Phase 1 (domain rules built) |
| Design | A record about sample people is sample; a record linking sample and real records is refused | Phase 1 (domain rules built) |
| Design | Sample records take part in no statutory notification or clock, return, export, report, bill, message, integration, in-app alert, escalation chain, handover, downtime pack or bulk print (`SAMPLE_DATA_TREATMENT`, `forSurface`); a central outbound guard refuses any email, SMS, push, webhook or partner message about a sample record | Phase 1 (domain rules built; each module calls them) |
| Design | Removal is one all-or-nothing step through a narrow security-definer function owned by a no-login role, deleting only the organisation's rows flagged sample in that batch in one transaction; the application role never holds DELETE; "sample data removed" blocks go-live on the onboarding checklist; a banner shows on every screen while sample data exists | Phase 1 (domain checks built; function with the schema step) |
| Test | See Verification | Phase 1 |
| Training and user documentation | Onboarding guide: what sample data is and when to remove it | Phase 1 |

**Target residual risk**: severity Considerable, likelihood Low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain/src/platform/onboarding.test.ts`: `hazard HZ-072 sample data is flagged, never mixed with real people, and removable in one step` (invented names, numbers, telephone numbers and addresses; every surface's treatment; badge and watermark; the outbound guard; every creation path refused while sample data exists; all-or-nothing removal) | Passing (Phase 1) |
| `packages/db`: `hazard HZ-072 sample removal leaves real rows` (the function deletes only the batch's sample rows of the current organisation; `harbour_app` has no DELETE) | Planned, Phase 1 (schema step) |
| `apps/api`: `hazard HZ-072 a real person cannot be added while sample data exists`, `hazard HZ-072 a sample incident drafts no statutory notification` | Planned, Phase 1 |
| Maestro `hazard-HZ-072-sample-banner.yaml`: the sample data banner on every screen | Planned, Phase 1 |

---

## Candidate hazards for the first CSO workshop

Not yet in the log (no IDs allocated). The CSO decides at the Phase 1 SWIFT workshop whether each becomes a hazard `[CSO decision - human action]`:

- Data import mapping errors beyond allergies and medicines (care-plan content, contacts, legal representatives).
- AI module output mistaken for clinical advice (Phase 6; scope lock in [medical-device-boundary.md](../compliance/medical-device-boundary.md)).
- Missed domiciliary visit not escalated (Phase 4).
