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

Eight hazards (HZ-002, HZ-003, HZ-005, HZ-008, HZ-013, HZ-014, HZ-023, HZ-027) have a target residual risk of 3, which the plan allows only when further reduction is impractical. Each entry gives the justification; the CSO must accept or reject it `[CSO decision - human action]`.

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

**Effects**

- Medication given to the wrong person: overdose for one person, omission for the other.
- Care given contrary to the person's allergies, resuscitation decision, IDDSI diet level or moving and handling plan.
- An inaccurate legal record; a confidentiality breach.

**Initial risk**: severity Major, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Point-of-care header on every person screen shows photo, full and preferred name, date of birth, room, allergies and communication needs (master prompt 10). The offline person table carries photo and communication needs (`packages/sync`) | Built in Phase 0 |
| Design | A missing photo shows a labelled placeholder ("No photo on record", icon plus words), never a silhouette that could be mistaken for a photo; the photo's date is shown and an old photo prompts an update | Phase 1 |
| Design | "Similar name" flag (icon plus words) in the header of every active person at a location who shares a family name or has a similar name with another | Phase 1 |
| Design | No automatic advance after saving: the app confirms the save naming the person and returns to that person or the list | Phase 1 |
| Design | Lists do not re-order under the user's finger while sync applies changes | Phase 1 |
| Design | Notification deep links carry tenant and person IDs; the target screen re-validates both before rendering | Phase 1 |
| Design | Probable duplicate check on create and import (same NHS number, or same date of birth and similar name) | Phase 1 |
| Design | eMAR requires positive identification for each administration: wristband barcode scan or photo confirmation | Phase 2 |
| Design | Shared and kiosk devices lock after 30 seconds by default and return to user sign-in, not to the last person ([kiosk.md](../compliance/kiosk.md)) | Phase 1 |
| Design | The room on the header comes from the dated bed history, which never puts two people in one bed; a death or discharge recorded against the wrong person is corrected with a reason (and a fresh sign-in for a death), cancelling the exit workflow and the death notification drafts ([people.md](../specs/people.md) rules 2 and 6) | Built in Phase 1 (slice 8 API) |
| Test | See Verification | Phase 1, Phase 2 |
| Training and user documentation | Care worker guide: check photo and date of birth before every administration and entry. Deployer control: photos taken at admission and refreshed under the tenant's policy | Phase 1 |

**Target residual risk**: severity Major, likelihood Very low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/ui-native/src/logic/person.test.ts`: names, initials fallback and NHS number formatting for the point-of-care header (photo or initials, preferred and full name) | Passing (Phase 0) |
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
| `apps/api/test/people-lifecycle.test.ts`: `hazard HZ-001 shows the room from the bed history on the header`, `hazard HZ-001 refuses a pack when a section belongs to someone else` (a photo filed against another person), `hazard HZ-001 corrects a death recorded in error only with a reason and step-up` | Passing (Phase 1) |
| `apps/api/test/people-lifecycle.test.ts`: `hazard HZ-001 refuses to send an item that does not exist with the person (422)` and `another person's item`, `hazard HZ-001 refuses evidence from another person's record on the checklist`, `hazard HZ-001 refuses a review document filed against another person` | Passing (Phase 1) |
| `packages/db/test/people-lifecycle.test.ts`: `hazard HZ-001 a bed holds one person and a person holds one bed` (both exclusion constraints, including an occupant the writer cannot see; half-open ranges; a bed the room does not have) | Passing (Phase 1) |

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
| Design | Stale-data warning: when the last successful sync is older than the threshold the banner switches to a warning state (icon plus words, for example "Last updated 3 hours ago. Information may be out of date"). The threshold is a named constant in `packages/sync`; the CSO confirms its value `[CSO decision - human action]` | Built in Phase 0 |
| Design | Reference data for assigned people (care plan summary, allergies, medicines, photo, communication needs) is never evicted while the assignment stands (`NEVER_EVICT_TABLES` in `packages/sync`) | Built in Phase 0 |
| Design | Safety-critical panels (allergies, medicines, resuscitation decision) show when that data was last confirmed from the server | Phase 1 |
| Design | Last-given time for every dose shows its source (this device, or synced from the server at a stated time) | Phase 2 |
| Design | High-priority changes (new allergy, medicine stopped, resuscitation decision changed) travel on a priority sync stream and a push that prompts the app to sync; the push content carries no personal data | Phase 2 |
| Design | Sync stream filters are tested separately from RLS, because logical replication bypasses RLS (shared with HZ-011) | Phase 0 gate |
| Test | See Verification | Phase 1, Phase 2 |
| Training and user documentation | Care worker guide explains the banner states. Deployer control: critical changes (allergy, medicine stopped, resuscitation decision) are also handed over verbally at shift change; the nightly downtime pack (Phase 1) is kept where connectivity is poor | Phase 1 |

**Target residual risk**: severity Major, likelihood Low, **risk 3**.

**Justification for level 3**: offline operation is itself a safety control (continuity of care where connectivity is poor), and a device cannot know about changes it has not received. Harbour makes the age of the data visible and prioritises critical changes; the remaining risk depends on deployer controls (verbal handover). Further reduction would mean blocking offline use, which creates a larger hazard. `[CSO acceptance - human action]`

**Verification**

| Test | Status |
| --- | --- |
| `packages/ui-native/src/logic/sync-banner.test.ts`: `warns that offline data may be out of date past the threshold (HZ-002)`; stale warning kept until caught up (threshold 15 minutes, ADR-0029; CSO to confirm) | Passing (Phase 0) |
| `packages/sync`: `hazard HZ-002 banner state is stale when the last successful sync exceeds the threshold` | Planned, Phase 1 |
| `packages/sync`: `hazard HZ-002 reference data for assigned people is never evicted while the assignment stands` | Planned, Phase 1 |
| `packages/ui-native`: `hazard HZ-002 allergy, medicines and resuscitation panels show when data was last confirmed` | Planned, Phase 1 |
| `apps/mobile` Maestro `hazard-HZ-002-offline-banner.yaml`: go offline, pass the threshold, banner shows the stale warning and the last-sync time | Planned, Phase 1 |
| `packages/sync`: `hazard HZ-002 priority stream delivers allergy and medicine-stopped changes before routine data` | Planned, Phase 2 |

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
- The person's rounds stay stopped after the people lifecycle stopped them: a discharge or death
  recorded in error is corrected, or a return from hospital is recorded, and the rounds (with
  medicines rounds from Phase 2) the exit or the absence cancelled are not brought back (slice 8
  review, clinical finding H1).
- Rounds whose times passed before a late return or correction was recorded stay cancelled with
  nothing caught up, and the review task does not say which rounds were missed; or rounds that
  ended long before the return are counted (slice 8 review round 3, clinical finding M2).
- A correction or the migration that coded existing tasks brings back tasks a different exit, or
  a manager, stopped, because it matched reason text a user can type (round 3, security finding
  L5).

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
| Design | The tasks and series the people lifecycle stops carry a code (`task.cancel_code`, `task_series.inactive_code`: paused while away, ended at exit) and, when an exit stopped them, that exit (`stopped_by_exit_id`). Migration 0023 codes existing rows only from the lifecycle event that stopped them (the outbox event written in the same transaction), never from reason text. A return brings back the rounds paused while the person was away; correcting a discharge or death recorded in error brings back only what that exit ended and starts its series again ([people.md](../specs/people.md) rules 1 and 2). Whether rounds restart without a person confirming them is for the CSO (H-89) | Built in Phase 1 slice 8 |
| Design | Of the tasks brought back (`planTaskRestore`), only those whose window ends at or after the return count. A task an entry answered while it was stopped is restored as done, never due again (HZ-004; H-91). One still in its window reopens. Of those whose window passed, the latest occurrence of each series (and each one-off task) reopens as overdue so the round is caught up once, unless a later occurrence was done; the earlier ones stay cancelled, coded as missed (H-92). One urgent review task goes to the nurse in charge and lists every round, its due time and whether it was reopened (`task.details.missedTasks`) | Built in Phase 1 slice 8 (review round 3) |
| Design | A correction returns the person to the status recorded on the exit (active, on leave or in hospital, `exit_record.status_before`) from when that status began; back to on leave or in hospital, what the exit ended waits for the return, paused, and nothing is due while the person is away (HZ-008; H-93) | Built in Phase 1 slice 8 (review round 3) |
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
| `apps/api/test/people-lifecycle.test.ts`: `hazard HZ-003 brings back the rounds and point-of-care tasks the death ended, and cancels the exit task` (the series starts again; the safety follow-ups were never stopped) and `hazards HZ-003 and HZ-023 record the return: rounds resume, ...` | Passing (Phase 1) |
| `packages/db/test/people-lifecycle.test.ts`: `hazard HZ-003 codes the tasks the lifecycle cancels, and only cancelled tasks carry a code` and `hazard HZ-003 codes only what a lifecycle event stopped, with the exit that stopped it (backfill)` (migration 0023 codes existing rows from the event that stopped them; a task a manager cancelled with the same words is left alone) | Passing (Phase 1) |
| `packages/domain/src/platform/tasks.test.ts`: `hazards HZ-003 and HZ-004 tasks brought back after a return or a correction` (table-driven: a round answered offline restored as done at 10:05 and 10:10; a round still in its window; a window closed before the return; the latest missed round of each series caught up once; a series whose later occurrence was done) | Passing (Phase 1) |
| `apps/api/test/people-lifecycle.test.ts`: `hazard HZ-003 restores a round an offline entry answered as done, never due again, when a death recorded in error is corrected (10:05, 10:08, 10:15, 10:20)`, `hazard HZ-003 codes the rounds missed during a late-recorded return, catches each series up once and lists them for review` and `hazards HZ-003 and HZ-008 correct a death recorded in error while the person was in hospital back to in hospital, with rounds still paused` | Passing (Phase 1) |
| `packages/domain/src/people/lifecycle.test.ts`: `hazards HZ-003 and HZ-008 correct ...` (table-driven: back to active, on leave or in hospital as recorded on the exit; any other status refused; an exit with no recorded status returns to active) | Passing (Phase 1) |

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
- A round answered offline before a death recorded in error, or before a move, is reopened by the correction or the return as if never done, so it is done again (slice 8 review round 3, clinical finding H1).
- A second entry for a round already done, or an entry by someone who may not complete the round, is kept with nothing to show it was not linked and nobody to review it (round 3, clinical finding M4).

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
| Design | A task the people lifecycle stopped, which an entry answered while it was stopped, is restored as done when the return or correction is recorded, never reopened (HZ-003; H-91) | Built in Phase 1 slice 8 (review round 3) |
| Design | What an entry did to the task it names is stored on the entry (`task_outcome`: completed, task cancelled, task already closed, not linked; `checkTaskLink`). An entry for a round already done or skipped, or one its author may not complete, is kept, flagged and listed on one review task for the nurse in charge (`care.entry_review`). An entry for a `medicines.*` task its author may not complete, or one already done or skipped, is refused (`task_medicines_not_yours`, `task_medicines_already_closed`), so a second dose is never recorded against a closed round. The chart and task views show the outcome as an icon and words | Built in Phase 1 slice 8 (review round 3; the views with the chart screens) |
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
| `packages/domain/src/platform/tasks.test.ts`: `hazards HZ-004 and HZ-006 what an entry does to the task it names` (table-driven: completes an open round; keeps late evidence for a cancelled round; flags a round already done or skipped, and one the author may not complete, for review; refuses a medicines task not the author's, already done or already skipped; refuses another person's task) and `hazards HZ-003 and HZ-004 tasks brought back after a return or a correction` | Passing (Phase 1) |
| `apps/api/test/people-lifecycle.test.ts`: `care.md rule 13: an entry and the task it names (HZ-004, HZ-006)`: `hazard HZ-004 keeps an entry for a round its author may not complete, unlinked and flagged, with a review for the nurse in charge`, `hazard HZ-004 keeps a second entry for a round already done, flagged, on the same review`, `hazard HZ-004 refuses an entry for a medicines task its author may not complete` and `... a medicines task already done (a second dose)`; `hazard HZ-003 restores a round an offline entry answered as done, never due again, ...` | Passing (Phase 1) |
| `packages/db/test/people-lifecycle.test.ts`: `hazards HZ-004 and HZ-006 an entry names its task only with what happened to it` (every entry table: a task and an outcome together, or neither) | Passing (Phase 1) |
| `apps/web/src/components/care/LifecycleBadges.test.ts`: `hazard HZ-004 an entry for a round already recorded, for review` and `hazard HZ-004 an entry its author could not link to the round, for review` (words and an icon) | Passing (Phase 1) |

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

**Causes**: free-text entry; ambiguous abbreviations; adjacent similar options in a picker; trailing zeros and missing leading zeros; import mapping errors; manual transcription from discharge summaries; changes passed on verbally; the medicines check after a return from hospital recorded by someone who may only record movements, not reconcile medicines (slice 8 review round 3, security finding M2).

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
| Design | A return check (the discharge letter, medicines, allergies, resuscitation decisions, IDDSI levels, skin) is recorded only by someone holding the permission its task requires (`care.plan.write` for the clinical checks) or its assignee; checking belongings back in stays with `people.movement.record`. A refusal is audited ([people.md](../specs/people.md) rule 10) | Built in Phase 1 slice 8 (review round 3) |
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
| `apps/api/test/people-lifecycle.test.ts`: `hazards HZ-005 and HZ-015 let only someone who may complete a return check's task record it` (a team leader, who records movements but not care plans, is refused the medicines, resuscitation and allergy checks, each refusal audited, and checks belongings back in; a check's assignee may record it; the nurse in charge records the medicines check) | Passing (Phase 1) |

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
- Authentication expiry while offline; a poison record blocking the queue.
- Sign-out, uninstall, device reset, loss or remote wipe while changes are queued.
- PowerSync outage; device storage full; an upload handler that swallows errors.
- The app more than one schema version behind the server.
- A database restore to an earlier point.
- An entry recorded offline before a person left names the round it answers, the move cancels
  that round before the device uploads, and the upload is refused because of the task (slice 8
  review, clinical finding H3).
- A device clock a few minutes fast times an entry just after the exit and it is refused; an
  entry refused after an exit is kept on the device but nobody on the server knows to review it
  (slice 8 review, clinical finding M7); the review task then names no entry, so nobody can
  match it to the device that holds it (round 3, clinical finding M7).
- An entry kept for a round already recorded, or not linked to its round, is shown nowhere as
  such (round 3, clinical findings M3 and M4).
- An incident about an event after a death is accepted as if the person were still in care
  (round 3, clinical finding L11).

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
| Design | Sign-out warns and requires a reason when the queue is not empty; the device reports its queue depth at every sync so that the server knows how many changes a lost or wiped device held | Phase 1 |
| Design | Manager dashboard lists devices on an active shift whose last sync is older than the threshold; on-call alert | Phase 1 |
| Design | The app blocks new writes and prompts an update when it is more than one schema version behind | Phase 1 |
| Design | Care events recorded offline before a person left or died are accepted after the exit and shown as recorded after it; the person leaves a device only after its queue has uploaded ([people.md](../specs/people.md) rule 3) | Phase 1 (accepted on upload: built in slice 8; leaving the device after upload: offline work) |
| Design | An entry is not refused because of the round it names: a task the lifecycle cancelled keeps the entry as evidence, flagged (`task.evidence_after_close`), and stays cancelled; a round already done or skipped, or one the user may not complete, is left alone and the entry is flagged and listed on one review task for the nurse in charge (`care.entry_review`). The entry stores what happened (`task_outcome`) and the chart and task views show it as an icon and words. A task for another person is still refused (HZ-001), and so is a `medicines.*` task the user may not complete or that is already closed (HZ-004) | Built in Phase 1 slice 8 (review round 3) |
| Design | Rule 3 accepts a care event timed up to `sync.clock_drift_flag_minutes` after the exit (a fast clock), flagged as recorded after it. A later one is refused with `care_event_after_exit`, so the device keeps it under "Needs attention"; the refusal is audited and one urgent review task goes to the nurse in charge (`people.late_entry_review`), listing each refused entry by kind, client id, device and user (opaque ids, no clinical text; `task.details.entries`) so it can be found on the device. Incidents follow the same rule. Keeping a server copy of the refused entry comes with the mobile hand-over of held entries. A result recorded before a move to hospital or on leave still alerts the nurse in charge; after a discharge or death only the safety prompts are raised. Whether late entries are refused or accepted for review, and the alerts before a move, are for the CSO (H-83) | Built in Phase 1 slice 8 |
| Test | See Verification | Phase 1 |
| Training and user documentation | Care worker guide: check the banner shows no queued changes before leaving at the end of a shift. Deployer control: devices charged and connected at handover | Phase 1 |

**Target residual risk**: severity Major, likelihood Very low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/ui-native/src/logic/sync-banner.test.ts`: `never fails silently: a failure is danger, urgent and offers retry (HZ-006)` | Passing (Phase 0) |
| `apps/api/test/api.test.ts`: rejected uploads return a code and a message the device can show | Passing (Phase 0) |
| `packages/sync`: `hazard HZ-006 exposes queued change count and last successful sync time to the banner` | Planned, Phase 1 |
| `packages/sync`: `hazard HZ-006 a rejected upload moves to needs attention and stays on the device` | Planned, Phase 1 |
| `apps/api`: `hazard HZ-006 a stale expected_version creates a review task, never a silent overwrite` | Planned, Phase 1 |
| `apps/api`: `hazard HZ-006 a device on an active shift with no recent sync appears on the manager dashboard` | Planned, Phase 1 |
| `apps/mobile` Maestro `hazard-HZ-006-signout-with-queue.yaml`: sign-out with queued changes warns and asks for a reason | Planned, Phase 1 |
| `apps/mobile` Maestro `hazard-HZ-006-sync-recovery.yaml`: write offline, restore connectivity, queue empties and records appear on the web (the "sync recovery" CI journey) | Planned, Phase 1 |
| `packages/domain/src/people/lifecycle.test.ts`: `hazard HZ-006 accepts an offline ... that happened before the death, flagged as recorded after it` (notes, observations, body-map marks, incidents) and `hazard HZ-006 a person who went ... is accepted` (in hospital or on leave) | Passing (Phase 1) |
| `apps/api/test/care.test.ts`: `hazard HZ-006 accepts entries from before a discharge, flagged, and refuses later ones except post-event notes` | Passing (Phase 1) |
| `apps/api/test/people-lifecycle.test.ts`: `hazard HZ-006 accepts an observation from before the transfer, flagged, and refuses a later one`, `hazard HZ-006 accepts observations from before the death and post-event notes, and refuses later chart entries` | Passing (Phase 1) |
| `apps/api/test/people-lifecycle.test.ts`: `hazard HZ-006 keeps an entry recorded offline at 10:05 for the 10:10 round when the person left at 10:10 and it uploads at 10:15` (accepted, linked, flagged; the round stays cancelled) and `hazard HZ-006 accepts an entry within the clock tolerance after the move, flagged, and gives a later one to the nurse in charge to review` | Passing (Phase 1) |
| `packages/domain/src/people/lifecycle.test.ts`: `hazard HZ-006 an observation timed ... is accepted within the clock tolerance` (at the death, two minutes after, exactly at the tolerance, a minute beyond) | Passing (Phase 1) |
| `packages/db/test/people-lifecycle.test.ts`: `hazard HZ-006 keeps the status time in step when only the status is written` | Passing (Phase 1) |
| `apps/api/test/people-lifecycle.test.ts`: `hazard HZ-006 accepts an entry within the clock tolerance after the move, flagged, and gives a later one to the nurse in charge to review` (the review lists the entry's kind, client id, device and user, and no clinical text), `hazard HZ-006 incidents follow rule 3: one about an event after a death is refused and reviewed` | Passing (Phase 1) |
| `apps/web/src/components/care/LifecycleBadges.test.ts`: `hazard HZ-006 an entry recorded offline for a round a move cancelled`, `hazard HZ-006 an entry accepted after an exit`, `hazard HZ-006 says a cancelled task's evidence arrived after it was cancelled` | Passing (Phase 1) |

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

**Causes**: a blank allergy area that cannot distinguish "none" from "not asked"; truncation on small screens; allergy not synced or evicted; import dropping allergies; allergy recorded only in a free-text document; catering allergen flags held separately from the care record; allergy entered against the wrong person (HZ-001); a printed transfer pack that cannot print a substance as written (for example "β-lactam" printed as "?-lactam", slice 8 review, clinical finding M4) or prints "no known allergies" without who confirmed it; a confirmer taken from the values a client writes rather than from who wrote them (slice 8 review round 3, security finding L4); "not recorded" shown with the clock of a due task, so it reads as a task rather than a gap (round 3, clinical finding L12).

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
| Design | Import dry run lists people without an allergy status | Phase 2 |
| Design | The printed transfer pack embeds Noto Sans (SIL Open Font Licence), so substances and reactions print as written in Latin, Greek and Cyrillic scripts (β-lactam, μg, Welsh ŵ and ŷ); a section holding a character the font lacks is named on the first page ([ADR-0040](../decisions/0040-transfer-pack-pdf-writer.md)) | Built in Phase 1 slice 8 |
| Design | Who set the allergy status and when is kept on the person by a trigger on every write that touches the status or the confirmer columns (`allergy_status_confirmed_by`, `_at`): always the signed-in user and the time of the write, never values the client sends and never the last person to edit the row; both are cleared when the status is unknown. "No known allergies" prints with them, and one without a confirmer is listed on the pack's first page to check | Built in Phase 1 slice 8 (review round 3) |
| Design | "Not recorded" is one shared status in `@harbour/ui` (`notRecorded`: the warning colour, a question mark and the words, never the clock of a due task), used for allergies and communication needs, and a link to where they are recorded when that screen is given. The design is for the CSO (H-130) | Built in Phase 1 slice 8 (review round 3; the links with the record screens) |
| Test | See Verification | Phase 1, Phase 2 |
| Training and user documentation | Deployer control: allergy status recorded at admission and at medicines reconciliation | Phase 1 |

**Target residual risk**: severity Major, likelihood Very low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/ui-native/src/logic/person.test.ts`: `allergy flag (HZ-007)` (unknown is never shown as calm; three states) | Passing (Phase 0) |
| `packages/db`: `allergy_status` enum distinguishes `unknown`, `no_known_allergies` and `has_allergies`; `apps/api/test/api.test.ts` returns `unknown` for a person never asked | Passing (Phase 0) |
| `packages/ui-native`: `hazard HZ-007 header shows allergy status not recorded when no allergy record exists` | Planned, Phase 1 |
| `packages/ui`: `hazard HZ-007 web header shows allergy status not recorded when no allergy record exists` | Planned, Phase 1 |
| `packages/domain` (people): `hazard HZ-007 no known allergies can only be recorded positively with author and time` | Planned, Phase 1 |
| `packages/sync`: `hazard HZ-007 allergy rows for assigned people survive eviction` | Planned, Phase 1 |
| `packages/ui-native`: `hazard HZ-007 header shows the count and most severe reactions first when allergies exceed the space` | Planned, Phase 1 |
| `apps/web` Playwright: `hazard HZ-007 printed MAR includes the allergy section` | Planned, Phase 2 |
| `packages/domain` (medicines): `hazard HZ-007 administration view includes the person's recorded allergies` | Planned, Phase 2 |
| `packages/domain/src/people/pre-admission.test.ts`: `hazard HZ-007 never lets allergies be marked not applicable`; `admission.test.ts`: `hazard HZ-007 refuses allergies as not applicable` (welcome checklist) | Passing (Phase 1) |
| `packages/domain/src/people/transfer-pack.test.ts`: `hazard HZ-007 allergy status never recorded`, `allergies said to exist but none listed`, `lists the most severe allergies first` | Passing (Phase 1) |
| `apps/api/test/people-lifecycle.test.ts`: `hazard HZ-007 refuses 'not applicable' for allergies, and an unexplained one for equipment` (pre-admission); `hazard HZ-007 ticks the welcome checklist, refusing 'not applicable' for allergies and a stale version` | Passing (Phase 1) |
| `apps/api/test/pdf.test.ts`: `hazard HZ-023 text prints as written` (β-lactam, μg, ŵ and ŷ, Ł, Œ, €; characters the font lacks named), `hazard HZ-007 prints clinical words as written, with line breaks kept` | Passing (Phase 1) |
| `packages/db/test/people-lifecycle.test.ts`: `hazard HZ-007 records who set the allergy status and when, not who last edited the person`; `packages/domain/src/people/transfer-pack.test.ts`: `hazard HZ-007 asks for a check when no known allergies has no confirmer` | Passing (Phase 1) |
| `packages/db/test/people-lifecycle.test.ts`: `hazard HZ-007 never takes the allergy confirmer from the writer` (a write of the confirmer columns alone is replaced with the signed-in user and the time) | Passing (Phase 1) |
| `packages/ui/src/components/StatusChip/StatusChip.test.tsx`: `hazard HZ-007 shows not recorded as a warning with a question mark, never the clock of a due task`, `hazard HZ-007 links not recorded to the action that records it, with the words as the link text`; the `NotRecorded` and `NotRecordedWithAction` stories pass axe (`stories.a11y.test.tsx`) | Passing (Phase 1) |

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

**Causes**: every rule raising an alert; duplicates across channels; alerts with no clear action; no tiering; thresholds not tuned; overdue alerts for work done but not yet recorded; repeated override prompts for benign cases; quiet hours misconfigured; a correction of a discharge or death recorded while the person was in hospital returning them to active, so rounds fall due and escalate for someone who is not there (slice 8 review round 3, clinical finding M6); every missed round of a long gap reopened as overdue at once (round 3, clinical finding M2).

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
| Design | Tenants tune thresholds within bounds Thapsus sets; escalation of time-critical medicines cannot be switched off | Phase 2 |
| Design | Alert volume, acknowledgement time and override rates per user and per alert type, reported monthly to managers and the CSO | Phase 2 |
| Design | A correction returns the person to the status recorded on the exit, so rounds stay paused for someone still in hospital or on leave; after a late return only the latest missed occurrence of each series reopens as overdue, the rest listed on one review task (HZ-003; H-92, H-93) | Built in Phase 1 slice 8 (review round 3) |
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
| `apps/api/test/people-lifecycle.test.ts`: `people.md rule 8: the review scheduler (HZ-008)` (one task for a local authority review in its window, once; one review on change for several changes, covered by a care plan review; recording the review completes the task) | Passing (Phase 1) |
| `apps/api/test/people-lifecycle.test.ts`: `hazard HZ-008 tells the Registered Manager once a day when reviews are not scheduled for a home` (a home in a nation without its review figures: one notice per recipient per day however often the sweep runs); `hazards HZ-003 and HZ-008 correct a death recorded in error while the person was in hospital back to in hospital, with rounds still paused` | Passing (Phase 1) |

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
| Design | Recorded event times (proposed; CSO to confirm `[CSO decision - human action]`): one domain rule, `resolveRecordedUkTime`, for every screen where a person types when something happened, web and mobile. A time in the skipped spring hour is refused; a time in the repeated autumn hour is asked about (BST before the clocks went back, or GMT after) when both have passed, with no default; a time ahead of the clock beyond the drift tolerance is refused and never rolled back to an earlier day. Computed times (schedules, deadlines) keep `fromUkWallClock` | Built in Phase 1 (domain) |
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
| `packages/domain/src/platform/tasks.test.ts`: `hazard HZ-009 recurring tasks keep UK local times across clock changes` (daily times stay local; a time in the spring gap moves an hour later; hourly intervals count elapsed time) | Passing (Phase 1) |
| `packages/domain` (medicines): `hazard HZ-009 a 01:30 dose on a spring-forward day moves to 02:30 BST and is flagged` | Planned, Phase 2 |
| `packages/domain` (medicines): `hazard HZ-009 a 01:30 dose on a clocks-back day occurs once` | Planned, Phase 2 |
| `packages/domain` (medicines): `hazard HZ-009 a 4-hour minimum interval spanning a clock change is measured in elapsed time` | Planned, Phase 2 |
| `packages/domain` (medicines): `hazard HZ-009 an 08:00 daily dose stays at 08:00 local time either side of each transition` | Planned, Phase 2 |
| `packages/domain` (platform): `hazard HZ-009 date of birth round-trips unchanged under every test time zone` | Planned, Phase 1 |
| `packages/domain` (care): `hazard HZ-009 fluid balance days run from 00:00 to 24:00 UK time` (23- and 25-hour days) | Passing |
| `packages/domain` (care): `hazard HZ-009 counts elapsed hours across the autumn clock change` (repositioning) | Passing |
| `packages/domain` (care): `hazard HZ-009 keeps the prompt at the same UK time across the autumn clock change` (bowel) | Passing |
| `apps/mobile` Maestro `hazard-HZ-009-device-zone.yaml`: a device in another zone shows location time and a warning | Planned, Phase 1 |

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
| Design | Every event records device time with its offset and the server-received time | Built in Phase 0 |
| Design | Drift between device and server is measured at each sync and held in local sync bookkeeping (`sync_meta` in `packages/sync`) | Built in Phase 0 |
| Design | Drift over 5 minutes is flagged on the device and on every record written while drifted (master prompt 10.3) | Phase 1 |
| Design | A record whose device time is later than its server-received time, or far earlier, raises a manager review flag; a note written more than 2 hours after the event carries the late-entry flag | Phase 1 |
| Design | The history view shows both device and server times | Phase 1 |
| Design | Interval checks on the device use a drift-corrected clock when drift is known | Phase 2 |
| Test | See Verification | Phase 1, Phase 2 |
| Training and user documentation | Care worker guide: never change the device time. Deployer control: MDM policy enforces automatic network time on shared devices ([kiosk.md](../compliance/kiosk.md)) | Phase 1 |

**Target residual risk**: severity Major, likelihood Very low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain/src/shared/time.test.ts`: `hazard HZ-010 clock drift` (5-minute tolerance) | Passing (Phase 0) |
| `packages/db`: append-only event columns keep device time, device offset and server-received time | Built in Phase 0 |
| `apps/api`: `hazard HZ-010 every uploaded event is stamped with server-received time` | Planned, Phase 1 |
| `packages/sync`: `hazard HZ-010 drift over 5 minutes between device and server is flagged` | Planned, Phase 1 |
| `apps/api`: `hazard HZ-010 a device time later than server-received time creates a review flag` | Planned, Phase 1 |
| `packages/domain` (care): `hazard HZ-010 a note written more than 2 hours after the event carries the late-entry flag` | Planned, Phase 1 |
| `packages/domain` (medicines): `hazard HZ-010 the minimum-interval check uses the drift-corrected clock` | Planned, Phase 2 |

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

**Causes**: a missing `tenant_id` predicate; RLS disabled or bypassed (owner role, `BYPASSRLS`, `SECURITY DEFINER` functions); `app.tenant_id` leaking between pooled transactions; a PowerSync stream filter error (logical replication bypasses RLS); cache or search keys without the tenant; guessable or long-lived file URLs; export jobs; operator impersonation; scope grants that do not expire; stale token claims after a role change.

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
| Design | Break-glass access with typed justification, alerting the Registered Manager and quality lead, audited with the reason, lapsing after an hour; a weekly report by user, person and reason flags repeated use for the Registered Manager and data protection lead | Built in Phase 0 (weekly report job, storage and API built in Phase 1 slice 8; screen with the web work) |
| Design | Short-lived presigned file URLs with tenant-prefixed keys; remote wipe and device revocation | Phase 1 |
| Design | Time-limited grants expire automatically (agency workers at shift end plus 2 hours; external professionals at their expiry) | Phase 1 (professionals), Phase 2 (agency, with rota) |
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
| `apps/api`: `hazard HZ-011 agency access expires at shift end plus 2 hours` | Planned, Phase 2 |
| `packages/db/test/care-record.test.ts` and `apps/api/test/care.test.ts`: notes, charts and marks follow the person's scope | Passing (Phase 1) |
| `packages/db/test/mca-and-incidents.test.ts`: `hazard HZ-011 consent, capacity and DoLS records follow the person's scope` and `hazard HZ-011 incident scope across people and locations (ADR-0033)` (an incident is visible through any of its people, to its reporter, and by location only when nobody using the service is on it; per-person notifications and staff rows follow their own scope; location drafts follow location scope; another tenant sees nothing) | Passing (Phase 1) |
| `apps/api/test/incidents.test.ts`: `hazard HZ-011 incident scope across people (ADR-0033)` (a reader who can see only some of the people gets the header and their own people, with no narrative or reasoning, and cannot change it) | Passing (Phase 1) |
| `packages/domain/src/people/break-glass-report.test.ts`: `hazard HZ-011 weekly break-glass report` (UK weeks across clock changes; totals by user, person and reason; unreviewed openings; repeated use, the same person reopened and one person opened by many users flagged at the rate-table threshold) | Passing (Phase 1) |
| `apps/api/test/people-lifecycle.test.ts`: `PLAT-006 the weekly break-glass report (HZ-011)` (one report per location for the week before, stored once; alerts the Registered Manager and the data protection lead; each reader sees only the locations in their access, with counts and opaque ids only; the review is recorded once; the reason code is stored). The worker runs it daily so a missed Monday catches up | Passing (Phase 1) |
| `packages/db/test/people-lifecycle.test.ts`: `hazard HZ-011 the lifecycle tables follow the person's scope` (every new person table, the welcome checklist template per tenant, the weekly report per location) | Passing (Phase 1) |
| `apps/api/test/people-lifecycle.test.ts`: `hazard HZ-011 shows every occupied bed but names only the people in the reader's access`; `hazard HZ-011 refuses a room, its bed board and its clearance to a caller who works elsewhere` (rooms carry only the tenant policy, so the API checks the location); `hazard HZ-011 permissions per route` (out-of-scope people are not found; packs and transfers need `people.movement.record`; audit by record id) | Passing (Phase 1) |
| `apps/api/test/people-lifecycle.test.ts`: `PLAT-006 the weekly break-glass report (HZ-011)`: `refuses a review by the person whose use the report flags`, `refuses a review of a location outside the reviewer's access as not found` | Passing (Phase 1) |
| `packages/db/test/people-lifecycle.test.ts`: `hazard HZ-011 keeps About Me, the pre-admission assessment and property out of device replication` (migration 0023 removes them from the PowerSync publication until assignment-pinned streams with two-tenant tests exist) | Passing (Phase 1) |

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

**Causes**: transcription errors in scoring tables; boundary errors (less than versus less than or equal); unit conversions (weight, height, temperature); rounding of BMI; a missing value treated as zero; a tenant editing a locked template; new confusion not scored as the published value; supplemental oxygen not scored; MUST weight-loss percentage over the wrong period; Waterlow multi-select categories summed wrongly; mixing observations taken at different times.

**Effects**: under-scoring leads to missed deterioration (for example sepsis), missed malnutrition referral or pressure-ulcer prevention not started, causing severe harm or death; over-scoring leads to unnecessary escalation.

**Initial risk**: severity Major, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Validated tools are locked templates implemented exactly as published, with the publisher, edition and source cited in code and on screen; tenants cannot edit scoring | Phase 1 |
| Design | The screen shows every parameter's sub-score, the total and the published banding table, so the user can check the arithmetic | Phase 1 |
| Design | Missing inputs produce no total ("Score incomplete: 2 values missing"), never a partial total | Phase 1 |
| Design | NEWS2 SpO2 Scale 2 is available only when a registered clinician has recorded that decision and target range on the person's record | Phase 1 |
| Design | The result links to the tenant's escalation policy; Harbour adds no recommendation of its own | Phase 1 |
| Design | Each stored score records the tool edition and the code version that calculated it | Built in Phase 1 slice 4b: the server runs the tool by key and stores the version, answers, score, band and workings; the client never sends a score |
| Design | Waterlow and Braden stay off for real tenants until their licence terms are confirmed (H-25): `care.tool.waterlow` and `care.tool.braden` flags, off by default, on in the demo tenant | Built in Phase 1 slice 4b |
| Design | Fixed units (kg, cm, degrees Celsius) with visible conversion for stones and pounds | Phase 1 |
| Design | The CSO checks each tool implementation against its published source before release `[CSO - human action]` | Phase 1 |
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
| `apps/web` Playwright: `hazard HZ-012 the score screen shows sub-scores and the banding table` | Planned, Phase 1 |

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

**Causes**: the incident is not recorded; a classifier question is answered wrongly or the rule is wrong or out of date (for example after the June 2026 Supreme Court judgment on deprivation of liberty); no holder of `safety.notification.submit` is available and no acting-up grant is in place; the deadline clock starts late or from the wrong time; a notification job fails silently; alert fatigue (HZ-008); an incident recorded offline is not synced (HZ-006); a discharge or death cancels the person's safety, statutory and exit tasks along with their rounds (slice 8 review, clinical finding H2); the drafts of a death recorded in error and corrected stand in for a later real death, or a notification already submitted for it is never corrected with the regulator (H5); the LeDeR question is taken as "no" when nobody answered it (M3); an incident's draft for a death recorded in error is counted for a later real death, or stays submitted with nobody asked to correct it (round 3, clinical finding L9).

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
| Design | An exit ends only rounds (series tasks) and point-of-care tasks (`care.*`, `medicines.*`), coded `ended_at_exit`; incident reports, safeguarding decisions, DoLS expiry, every `safety.*` and `people.*` task and the exit checklist task stay open | Built in Phase 1 slice 8 |
| Design | Each death notification draft belongs to its exit record (source key `exit:<exit id>:<kind>`) and the exit checklist follows only that exit's drafts, so a death recorded in error never stands for a later one. A correction flags that exit's drafts no longer indicated, never closing them, and gives the holders of `safety.notification.submit` one urgent task to tell the regulator that a submitted notification was made in error. An incident's draft that counted for that death is withdrawn the same way, and neither counts for a later death. What to do with submitted notifications is for the CSO (H-88) | Built in Phase 1 slice 8 (incident drafts: review round 3) |
| Design | Recording a death needs an explicit answer on learning disability or autism (LeDeR); the exit record has no default. Whether each exit notification is statutory comes from the safety module's `NOTIFICATION_KINDS`, so the checklist and the notification agree. The clocks and the statutory labels for LeDeR and the medical examiner are for the CSO and DPO (H-87) | Built in Phase 1 slice 8 |
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
| `apps/api/test/people-lifecycle.test.ts`: `hazard HZ-013 records a death at night: the room is held and the death notifications are drafted, with LeDeR` (the regulator's death notification, the medical examiner and LeDeR drafts raised from `people.person.died`, linked as evidence on the exit checklist and labelled as `NOTIFICATION_KINDS` labels them) and `hazard HZ-001 corrects a death recorded in error only with a reason and step-up` (the drafts are flagged no longer indicated, never closed; a submitted one stays as sent) | Passing (Phase 1) |
| `apps/api/test/people-lifecycle.test.ts`: `hazard HZ-013 needs to know whether the death was expected, and whether LeDeR applies`, `hazard HZ-013 ends rounds and point-of-care tasks at the death, and keeps the safety follow-ups`, `hazard HZ-013 submits the regulator's death notification`, `hazard HZ-013 gives the Registered Manager a task to tell the CQC that a submitted notification was made in error` (once, however often the event is relayed), `hazard HZ-013 drafts new notifications for a real death after a corrected one, never reusing the old ones` | Passing (Phase 1) |
| `packages/domain/src/people/exit.test.ts`: `hazard HZ-013 drafts the regulator, medical examiner and LeDeR notifications in safety, labelled as the safety module labels them` | Passing (Phase 1) |
| `apps/api/test/people-lifecycle.test.ts`: `hazard HZ-013 never counts an incident's draft from a death recorded in error for a later death` (the incident's submitted draft gets a correction task; the later death's checklist follows its own draft, never the incident's) | Passing (Phase 1) |

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
| `apps/api/test/care-planning.test.ts`: `hazard HZ-014 MUST high raises the dietitian referral and sets next_due_on` (the rescreen and weight-check tasks are scheduled, one open at a time, and the next result answers the rescreen); `a weight answers the weight check and schedules the next at the MUST interval` | Passing |
| `apps/api`: `hazard HZ-014 an urgent assessment alert escalates until acknowledged` | Planned, Phase 1 |
| `apps/api/test/care.test.ts`: `hazard HZ-012 and HZ-014 NEWS2 vital signs` (a high score alerts the nurse in charge and creates the urgent response and continuous-monitoring tasks; a score of 0 schedules nothing outside the care plan) | Passing |

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

**Causes**: the document is filed but not flagged; an old version is shown; the record is not available offline or in the downtime pack; the hospital transfer pack omits it, or prints it on a later page behind a long medicines list (slice 8 review round 3, clinical finding M5); a check of resuscitation decisions made in hospital recorded by someone who may not review the care plan (round 3, security finding M2).

**Effects**: resuscitation attempted against the person's wishes, or not attempted when it should have been; distress to the person and family.

**Initial risk**: severity Major, likelihood Low, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | The point-of-care header shows the current resuscitation status (word and icon) with the date and clinician; a missing record shows as 'Not recorded', never as blank | Phase 1 |
| Design | The person summary every point-of-care header reads carries the resuscitation status in force from an active ReSPECT or DNACPR record, with the clinician and dates, or `not_recorded`; records in force that disagree are flagged; a passed review date never hides a decision | Built in Phase 1 slice 4b (screens in slice 9) |
| Design | Only one active record per kind; recording a new one supersedes the old; review dates raise tasks | Built in Phase 1 slice 4b (database partial unique index; hourly review job) |
| Design | Advance care records are reference data on the device (never evicted while assigned), in the downtime pack and in the hospital transfer pack | Phase 1 |
| Design | The transfer pack prints the CPR decision in force by the same rule as the header (`resuscitationStatus`), from ReSPECT and DNACPR records only; an ADRT or advance care plan alone leaves it "not recorded" and still prints. Records that disagree print together as a conflict on the first page and need the named acknowledgement at hand-over; an overdue review is shown on the first page | Built in Phase 1 slice 8 |
| Design | The identity block on page 1 of the pack carries a "CPR decision:" line in bold, copied from the stored pack and never resolved: the decision in force with its record and date, "not recorded", "no decision in place" with who confirmed it, or that the records disagree. A long medicines list cannot push it to a later page. The wording is for the CSO (H-94) | Built in Phase 1 slice 8 (review round 3) |
| Design | The return check on resuscitation decisions made in hospital is recorded only by someone who may complete its task (HZ-005) | Built in Phase 1 slice 8 (review round 3) |
| Training and user documentation | Deployer control: the original signed form stays with the person as the home's policy requires; Harbour shows the record, it is not the legal document | Phase 1 |

**Target residual risk**: severity Major, likelihood Very low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain/src/care/advance-care.test.ts`: `hazard HZ-015 a missing resuscitation record shows as not recorded`; `hazard HZ-015 the current resuscitation status` (latest decision, conflicts flagged, withdrawn and superseded records ignored, overdue review keeps the decision) | Passing |
| `packages/db/test/care-planning.test.ts`: `hazard HZ-015 only one advance care record of each kind is active` | Passing |
| `packages/contracts/src/contracts.test.ts`: `hazard HZ-015 needs a resuscitation status on every point-of-care summary` | Passing |
| `apps/api/test/care-planning.test.ts`: `hazard HZ-015 advance care records and the resuscitation status` (a DNACPR shows on the person summary and list; superseding and withdrawal) | Passing |
| `apps/api/test/people-lifecycle.test.ts`: `hazard HZ-015 prints the current resuscitation record in the pack` (reads the printed PDF: the CPR decision in force and the DNACPR with its clinician and date) and `hazard HZ-015 prints ReSPECT and DNACPR that disagree, and an overdue review, on the first page` (both records printed, the hand-over refused without an acknowledgement) | Passing (Phase 1) |
| `packages/domain/src/people/transfer-pack.test.ts`: `hazard HZ-015 keeps an ADRT beside the CPR decision but never as one`, `hazard HZ-015 prints ReSPECT and DNACPR that disagree as a conflict, with both, never resolved`, `hazard HZ-015 shows a resuscitation decision past its review date`; `apps/api/test/pdf.test.ts`: `hazard HZ-015 prints ReSPECT and DNACPR that disagree with both records, never resolved`, `hazard HZ-015 prints an ADRT alone as no CPR decision` | Passing (Phase 1) |
| `apps/api`: `hazard HZ-015 the downtime pack includes the current resuscitation record` | Planned, Phase 1 |
| `packages/domain/src/people/pre-admission.test.ts`: `hazard HZ-015 requires the resuscitation and advance care section` | Passing (Phase 1) |
| `packages/domain/src/people/transfer-pack.test.ts`: `hazard HZ-015 no resuscitation record`, `only a withdrawn resuscitation record`, `prints only the active resuscitation record` | Passing (Phase 1) |
| `apps/api/test/pdf.test.ts`: `hazard HZ-015 prints the CPR decision in force on page 1, however long the medicines list` (25 long medicines) and `hazard HZ-015 says on page 1 when the CPR decision is ...` (none recorded, records that disagree); the two HZ-015 pack tests in `apps/api/test/people-lifecycle.test.ts` read the line from page 1; `hazards HZ-005 and HZ-015 let only someone who may complete a return check's task record it` | Passing (Phase 1) |

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

**Causes**: levels shown as numbers only; the prescribed level is out of date after a speech and language therapy review; the food chart accepts any level silently.

**Effects**: choking, aspiration pneumonia, death.

**Initial risk**: severity Major, likelihood Low, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | The prescribed food and drink levels show with their IDDSI number, name and colour in the header and on the food and fluid charts | Phase 1 |
| Design | Recording a level that does not match the prescribed level needs an override reason and raises an alert to the nurse in charge | Phase 1 |
| Design | A change of prescribed level records who changed it, on whose advice, and shows as new for 72 hours | Phase 1 |
| Design | Eating and drinking (IDDSI levels) is a safety-critical section of the hospital transfer pack: printed with the level's number and name, and "not recorded" on the first page when missing. Whether it stays safety-critical is for the CSO (H-86) | Built in Phase 1 slice 8 |
| Training and user documentation | Deployer control: kitchen and dietary profiles are kept in step (Phase 3 catering links them) | Phase 1 |

**Target residual risk**: severity Major, likelihood Very low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain` (care): `hazard HZ-016 a food entry at a different IDDSI level needs an override reason` | Passing |
| `packages/domain` (care): `hazard HZ-016 recorded IDDSI levels are checked against the prescribed level` | Passing |
| `packages/domain` (care): `hazard HZ-016 IDDSI levels show number, name and colour` | Passing |
| `apps/web`: `hazard HZ-016 the header shows the prescribed IDDSI levels with number and name` | Planned, Phase 1 |
| `apps/api/test/care.test.ts`: `hazard HZ-016 IDDSI levels` (a level change needs who advised it; food above the prescribed level needs a reason and alerts) | Passing |
| `packages/domain/src/people/pre-admission.test.ts`: `hazard HZ-016 never lets eating, drinking and swallowing be marked not applicable`; `transfer-pack.test.ts`: `hazard HZ-016 re-checks allergies, resuscitation decisions and IDDSI levels on return` | Passing (Phase 1) |
| `packages/domain/src/people/transfer-pack.test.ts`: `hazard HZ-016 copies the IDDSI codes exactly, including easy to chew (7EC)` | Passing (Phase 1) |
| `apps/api/test/pdf.test.ts`: `hazard HZ-016 prints the IDDSI levels with their names` | Passing (Phase 1) |

---

## HZ-017 Late or retrospective entry mistaken for a contemporaneous record

| Field | Value |
| --- | --- |
| ID | HZ-017 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `care` module (lead engineer) |
| Source | Master prompt 10.1 (late-entry flag), 18 (times); [NMC record keeping](https://www.nmc.org.uk/standards/code/read-the-code-online/) |

**Description**: a note, chart entry or incident written long after the event, or backdated, reads as if it were written at the time, so decisions or investigations rely on it wrongly.

**Causes**: only one time stored; device clock wrong (HZ-010); offline entries synced days later; edits overwrite the original.

**Effects**: misleading care history; unsafe decisions based on charts that look complete; investigations and inquests misled.

**Initial risk**: severity Considerable, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Every entry stores the event time, the device time and the server-received time; entries recorded more than the rate-table late-entry threshold after the event are flagged late everywhere they appear | Phase 1 |
| Design | Entries are append-only; a correction supersedes the original with a reason and both remain readable | Phase 1 |
| Design | Future event times beyond the clock-drift tolerance are refused | Phase 1 |

**Target residual risk**: severity Considerable, likelihood Low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain` (care): `hazard HZ-017 entries older than the late-entry threshold are flagged late` | Passing |
| `packages/domain` (care): `hazard HZ-017 future event times beyond the clock-drift tolerance are refused` | Passing |
| `packages/db/test/care-record.test.ts`: `hazard HZ-017 notes and observations cannot be updated or deleted by the app` | Passing |
| `packages/db/test/care-record.test.ts`: corrections supersede; replayed device ids are ignored | Passing |
| `apps/api/test/care.test.ts`: `hazard HZ-017 flags a note written hours after the event, not one synced late`; `corrects by superseding with a reason; the original stays readable` | Passing |
| `packages/db/test/care-planning.test.ts`: `hazard HZ-017 assessments, activities and visits are append-only` (UPDATE and DELETE refused for the app and by trigger; a correction supersedes with a reason and only for the same person; replayed device ids ignored) | Passing |
| `packages/domain/src/care/validated-assessment.test.ts`: `hazard HZ-017 corrections supersede with a reason` | Passing |
| `apps/api/test/care-planning.test.ts`: `hazard HZ-017 corrects a result by superseding it with a reason, and reads the latest per tool`; `hazard HZ-017 ignores a replayed upload with the same device id` | Passing |
| `packages/db/test/people-lifecycle.test.ts`: `hazard HZ-017 refuses to ...` (admission decisions, review records and weekly reports cannot be updated or deleted; a correction supersedes once) | Passing (Phase 1) |

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
| Design | Side and region are chosen in words as well as on the drawing, and must agree before saving; front and back views label the person's left and right | Phase 1 |
| Design | Wound photos are linked to the mark, with a ruler prompt | Phase 1 |

**Target residual risk**: severity Considerable, likelihood Low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain` (care): `hazard HZ-019 a mark whose drawn side and stated side differ cannot be saved` | Passing |
| `packages/domain` (care): `hazard HZ-019 body map sides are the person's own left and right` | Passing |
| `apps/api/test/care.test.ts`: `hazard HZ-019 body map` (a mark whose stated side differs from the drawing is refused; a category 3 ulcer prompts an incident and the safeguarding guide) | Passing |
| `apps/api/test/incidents.test.ts`: `hazard HZ-019 links a mark recorded for the incident and refuses one for someone not on it` (marks keep the body map's checks; linked pressure ulcers reach the classifier) | Passing (Phase 1) |

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

**Causes**: no downtime pack; the pack is out of date; it is printed but not where staff can find it; no way to back-enter records made on paper.

**Effects**: wrong care given during the outage; records lost; evacuation without PEEPs.

**Initial risk**: severity Major, likelihood Low, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | A downtime pack per location is generated nightly (allergies, resuscitation status, IDDSI levels, care plan summaries, PEEPs, contacts) and cached on kiosk devices; each page shows when it was generated | Phase 1 |
| Design | Back-entry workflow for paper records made during downtime, flagged as late entries (HZ-017) | Phase 1 |
| Training and user documentation | Deployer control: business continuity plan says where the printed pack is kept and who prints it | Phase 1 |

**Target residual risk**: severity Major, likelihood Very low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `apps/api`: `hazard HZ-021 the downtime pack contains every required section for every current resident` | Planned, Phase 1 |

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

**Causes**: a feed that is open by default; a decision that covers "the person" rather than named sections; decisions with no expiry; a withdrawal or suspension not applied at once (including on devices that synced earlier); a decision for one recipient applied to another (contact ids confused, a shared family account); a lasting power of attorney or deputyship accepted without evidence or after it ended, or a health and welfare attorney treated as having authority while the person has capacity; share links that outlive their decision; sharing left open after a death.

**Effects**: a person's whereabouts, health or money disclosed to someone who may harm them (safeguarding risk, financial abuse); a person with capacity overridden; distress and loss of trust; a reportable personal data breach; a family member relying on information they should no longer see.

**Initial risk**: severity Major, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Closed by default: every section is hidden from every family member, professional and share link until a sharing decision in force covers that section (and, for the care plan, that domain) for that recipient (`checkSectionVisibility` in `packages/domain/src/people/sharing.ts`) | Built in Phase 1 slice 8 (family feed in slice 12) |
| Design | Every decision records its basis and is checked: no consent from a person assessed as lacking capacity for it; an authority needs evidence, must cover the section, and a welfare authority applies only when the person lacks capacity; a best-interests decision must be recorded; direct care only for professionals and clinical sections | Built in Phase 1 slice 8 |
| Design | Every decision expires; withdrawal, suspension (for example during a safeguarding enquiry) and the end of an authority close the section at once; a stored decision that breaks the rules is never honoured | Built in Phase 1 slice 8 |
| Design | Sharing closes when the person is discharged, dies or is archived; correcting a discharge or death does not reopen it without a manager | Built in Phase 1 slice 8 |
| Design | About Me share links carry About Me only, store only a hash of the token, and cannot outlive their decision | Phase 1 (links issued and revoked in slice 8; the link viewer with the portal) |
| Design | Every view by a family member, professional or link holder is audited with the decision that allowed it | Phase 1 (slice 12) |
| Design | Family device sync streams carry only the sections a decision covers, tested on their own (replication bypasses RLS) | Phase 4 (family app mode) |
| Test | See Verification | Phase 1 |
| Training and user documentation | Deployer control: the Registered Manager reviews sharing decisions at each care plan review and suspends sharing when a safeguarding concern involves a family member | Phase 1 |

**Target residual risk**: severity Major, likelihood Very low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain/src/people/sharing.test.ts`: `hazard HZ-022 a section is visible only under a sharing decision in force` (no decision; a section or care plan domain the decision does not name; another recipient; another person; expired; not yet started; withdrawn; suspended; lapsed authority; a stored decision that breaks the rules; a person who has died or left) | Passing (Phase 1) |
| `packages/domain/src/people/sharing.test.ts`: recording a sharing decision (capacity, authority evidence and coverage, best interests, direct-care limits, share-link limits, expiry) and About Me share links | Passing (Phase 1) |
| `apps/api`: `hazard HZ-022 the family feed returns nothing without a sharing decision in force` | Planned, Phase 1 (slice 12) |
| `apps/api/test/people-lifecycle.test.ts`: `hazard HZ-022 withdrawing or suspending a decision closes the section on the next request` | Passing (Phase 1) |
| `packages/sync`: `hazard HZ-022 family streams carry only shared sections` | Planned, Phase 4 |
| `apps/api/test/people-lifecycle.test.ts`: `hazard HZ-022 shows a family member nothing without a decision in force`, `hazard HZ-022 closes the sections once the decision expires`, `hazard HZ-022 opens only the sections a decision in force covers`, `hazard HZ-022 refuses a decision without a valid basis`; at exit, sharing decisions are withdrawn and links revoked (`hazard HZ-022 starts the transfer workflow and closes sharing, the bed and future tasks`) | Passing (Phase 1) |
| `apps/api/test/people-lifecycle.test.ts`: `hazard HZ-022 makes an About Me link that stores only the token's hash and never outlives its decision` (making a link needs a fresh sign-in); `hazard HZ-022 treats managing sharing as care-record access: MFA first`; `packages/db/test/people-lifecycle.test.ts`: `share links store the token's hash only` | Passing (Phase 1) |

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

**Causes**: a pack put together by hand under time pressure; sections never recorded; "unknown" printed as blank or "none"; a withdrawn DNACPR printed; another person's data in the pack (HZ-001); stale offline data (HZ-002); belongings not sent; the hospital discharge letter not reconciled on return; names and clinical words printed with characters missing because the PDF's fonts cannot print them (slice 8 review, clinical finding M4); a medicines list from before admission printed as if it were current; return checks raised with no owner or due time; a photo counted as printable that the PDF cannot decode (a 16-bit or interlaced PNG, a truncated or oversized file), or a crafted image that stops the service printing any pack (slice 8 review round 3, security finding M1 and clinical finding L10); the home or hospital name printed with characters missing and not named (round 3, clinical finding L10); return checks recorded by someone who may not complete them (round 3, security finding M2).

**Effects**: a medicine given that the person is allergic to; time-critical medicines (for example for Parkinson's disease) missed; resuscitation contrary to the person's wishes; the person unable to communicate pain or needs; harm after return when hospital changes are missed.

**Initial risk**: severity Major, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | One function assembles the pack from the record (`assembleHospitalTransferPack` in `packages/domain/src/people/transfer-pack.ts`); it refuses data from another person's record and an incomplete identity (HZ-001) | Built in Phase 1 slice 8 |
| Design | Photo, allergies, medicines, communication needs, resuscitation status and About Me are safety-critical: when missing they read "not recorded" on the first page, never blank; "none" must be recorded positively with who and when | Built in Phase 1 slice 8 |
| Design | Only active resuscitation records print (HZ-015); allergies print most severe first (HZ-007); time-critical medicines first; every section shows when it was last updated; a pack printed offline shows the last sync time (HZ-002) | Built in Phase 1 slice 8 (PDF: ADR-0040) |
| Design | The pack is never blocked, because a transfer must not wait, but recording the hand-over of an incomplete pack needs a named acknowledgement and a reason | Built in Phase 1 slice 8 |
| Design | Glasses, hearing aids, dentures and walking aids in the property inventory are offered for sending; items left behind are listed; items sent are checked back in on return | Built in Phase 1 slice 8 |
| Design | Return checks: discharge letter, medicines (HZ-005), new allergies, resuscitation decisions made in hospital, IDDSI changes (HZ-016), skin | Phase 1 (checks), Phase 2 (eMAR reconciliation) |
| Design | Each return check is a task for the nurse in charge, due `people.return_checks_due_hours` after the return (never in the past for a backdated return), urgent where it carries a hazard, and escalated by the task engine when overdue. The owner, the due time and the escalation are for the CSO (H-85) | Built in Phase 1 slice 8 |
| Design | The printed pack embeds Noto Sans, so names and clinical words print as written; a section with a character the font lacks is named on the first page; a photo held but not printable (anything but JPEG or PNG) is named on the first page ([ADR-0040](../decisions/0040-transfer-pack-pdf-writer.md)) | Built in Phase 1 slice 8 |
| Design | The pack decides whether the photo is printable with the decoder the PDF uses: only 8-bit, non-interlaced PNGs and JPEGs up to 4096 x 4096 pixels (8192 on a side) print; every PNG chunk is bounds-checked, decompression is capped at the size the header promises and decoding never throws. Anything else counts as missing: page 1 names it and the hand-over needs the acknowledgement. The home and hospital names are checked for characters the font lacks, as the person's name and the sections are ([ADR-0040](../decisions/0040-transfer-pack-pdf-writer.md)) | Built in Phase 1 slice 8 (review round 3) |
| Design | Until the eMAR (Phase 2) the pack's medicines come from the pre-admission assessment and are marked on the first page as needing checking against the MAR; an empty list reads "not recorded since admission". Whether that list may be printed at all is for the CSO (H-82) | Built in Phase 1 slice 8 |
| Design | The pre-admission assessment and the welcome checklist require allergies, medicines, communication needs and resuscitation status at admission, so the pack rarely lacks them | Built in Phase 1 slice 8 |
| Test | See Verification | Phase 1 |
| Training and user documentation | Deployer control: the transfer procedure names who prints the pack and checks the red bag, agreed with the local hospital trust | Phase 1 |

**Target residual risk**: severity Major, likelihood Low, **risk 3**. Further reduction is impractical: blocking or delaying a transfer until the record is complete would cause greater harm, and the remaining likelihood depends on the provider completing records, which the controls make visible but cannot force. `[CSO decision - human action]`

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain/src/people/transfer-pack.test.ts`: `hazard HZ-023 missing safety-critical information is flagged, never left blank` (each of the six sections; empty lists; a withdrawn-only resuscitation record; positive "none" statements accepted) | Passing (Phase 1) |
| `packages/domain/src/people/transfer-pack.test.ts`: `hazard HZ-023 needs a named acknowledgement and reason when critical sections are missing` | Passing (Phase 1) |
| `packages/domain/src/people/transfer-pack.test.ts`: `hazard HZ-001 refuses a pack whose sections belong to someone else`, `hazard HZ-015 prints only the active resuscitation record`, `hazard HZ-007 lists the most severe allergies first`, `hazard HZ-016 re-checks allergies, resuscitation decisions and IDDSI levels on return` | Passing (Phase 1) |
| `apps/api/test/people-lifecycle.test.ts`: `hazard HZ-023 prints not recorded on the first page for each missing critical section` (reads the printed PDF's first page through the font's character map; identity on every page) | Passing (Phase 1) |
| `apps/api/test/pdf.test.ts`: `hazard HZ-023 text prints as written`, `hazard HZ-023 the printed transfer pack` (first page names what is missing and what needs checking; characters the font cannot print named) | Passing (Phase 1) |
| `apps/api/test/people-lifecycle.test.ts`: `hazard HZ-023 marks a medicines list from the pre-admission assessment as needing checking against the MAR`, `hazards HZ-003 and HZ-023 record the return: rounds resume, the checks come up as tasks with an owner and a due time, and the care plan review comes forward` | Passing (Phase 1) |
| `apps/mobile` Maestro `hazard-HZ-023-offline-transfer-pack.yaml`: print the pack offline with the last sync time shown | Planned, Phase 1 |
| `apps/api/test/people-lifecycle.test.ts`: `hazard HZ-023 previews the pack with every missing safety-critical section flagged`, `hazard HZ-023 previews with the reason and the items to send in the body, never the URL`, `hazard HZ-023 records the hand-over of an incomplete pack only with a named acknowledgement`, `hazard HZ-023 refuses a pack for someone not receiving care`, `hazard HZ-023 communication needs: an empty list is not 'none'` | Passing (Phase 1) |
| `apps/web/src/lib/people.test.ts`: `communicationSummary (HZ-023)` (the people list and the person header show "Not recorded" as a warning with an icon and words, and "None identified" only for a positive none) | Passing (Phase 1) |
| `apps/api/test/pdf.test.ts`: `hazard HZ-023 treats ... as not printable, without decoding it` (a 16-bit PNG, an interlaced PNG, one claiming 20000 x 20000 pixels, one over the pixel limit, a truncated one, a chunk running past the end, image data that inflates past its header), `hazard HZ-023 treats a JPEG over the pixel limit, or truncated, as not printable`, `names the home or the hospital on page 1 when their names have characters it cannot print` | Passing (Phase 1) |
| `apps/api/test/people-lifecycle.test.ts`: `hazards HZ-001 and HZ-023 count ... photo as missing, so page 1 names it and the hand-over needs an acknowledgement` (16-bit and truncated PNGs), `hazard HZ-023 never sets a return check due in the past for a return recorded more than a day late` (a return with no transfer record still raises the checks) | Passing (Phase 1) |

---

## HZ-024 Care plan or risk assessment out of date, or a draft or superseded version followed

| Field | Value |
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
| Design | Draft and superseded versions are labelled with word and icon, with the active version one tap away | Phase 1 (slice 9) |
| Training and user documentation | Deployer control: the provider's care planning policy names who reviews plans and how changes in need are reported | Phase 1 |

**Target residual risk**: severity Considerable, likelihood Low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain/src/care/care-plan.test.ts`: `hazard HZ-024 rule 1: the first care plan is due within the working days after admission`; `hazard HZ-024 rule 1: reviews every review interval and on change`; `hazard HZ-024 rule 2: only an active plan drives tasks` | Passing |
| `packages/domain/src/care/validated-assessment.test.ts`: `hazard HZ-024 rule 1: a change in the result brings the care plan review forward` | Passing |
| `packages/db/test/care-planning.test.ts`: integrity rules (a second active care plan is refused; child rows cannot claim another person) | Passing |
| `apps/api/test/care-planning.test.ts`: `hazard HZ-024 raises one review task to the nurse in charge for an overdue first plan or review`; `hazard HZ-024 publishes a draft, supersedes it with the next version and keeps both` | Passing |
| `apps/web` Playwright: `hazard HZ-024 a draft or superseded plan is labelled and never shown as the current plan` | Planned, Phase 1 |

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

---

## Candidate hazards for the first CSO workshop

Not yet in the log (no IDs allocated). The CSO decides at the Phase 1 SWIFT workshop whether each becomes a hazard `[CSO decision - human action]`:

- Data import mapping errors beyond allergies and medicines (care-plan content, contacts, legal representatives).
- AI module output mistaken for clinical advice (Phase 6; scope lock in [medical-device-boundary.md](../compliance/medical-device-boundary.md)).
- Missed domiciliary visit not escalated (Phase 4).
