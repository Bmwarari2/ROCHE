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

Six hazards (HZ-002, HZ-003, HZ-005, HZ-008, HZ-013, HZ-014) have a target residual risk of 3, which the plan allows only when further reduction is impractical. Each entry gives the justification; the CSO must accept or reject it `[CSO decision - human action]`.

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
- Authentication expiry while offline; a poison record blocking the queue.
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
| Design | Sign-out warns and requires a reason when the queue is not empty; the device reports its queue depth at every sync so that the server knows how many changes a lost or wiped device held | Phase 1 |
| Design | Manager dashboard lists devices on an active shift whose last sync is older than the threshold; on-call alert | Phase 1 |
| Design | The app blocks new writes and prompts an update when it is more than one schema version behind | Phase 1 |
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
| Design | Import dry run lists people without an allergy status | Phase 2 |
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
| Design | Break-glass access with typed justification, alerting the Registered Manager and quality lead, audited with the reason, lapsing after an hour | Built in Phase 0 (weekly report, Phase 1) |
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
| Design | Each stored score records the tool edition and the code version that calculated it | Phase 1 |
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
| Design | Safeguarding log and outbreak register feed the same clocks | Phase 2 |
| Test | See Verification | Phase 1, Phase 2 |
| Training and user documentation | User guide states that the classifier supports, and never replaces, the Registered Manager's judgement. Deployer control: tenant notifications policy and acting-up arrangements for absences | Phase 1 |

**Target residual risk**: severity Major, likelihood Low, **risk 3**.

**Justification for level 3**: Harbour cannot ensure an incident is recorded, and submission is a human decision by a named role. Harbour makes the obligation and its deadline visible and escalates; further reduction is impractical without automating a regulated judgement. `[CSO acceptance - human action]`

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain` (safety): `hazard HZ-013 classifier produces the required notifications for each incident scenario` (table-driven across CQC, RIDDOR, safeguarding, candour) | Planned, Phase 1 |
| `packages/domain` (safety): `hazard HZ-013 deadline clocks read their periods from the rate table` | Planned, Phase 1 |
| `packages/domain` (safety): `hazard HZ-013 an unacted clock escalates to the Nominated Individual before breach` | Planned, Phase 1 |
| `apps/api`: `hazard HZ-013 only a holder of safety.notification.submit with step-up can submit` | Planned, Phase 1 |
| `packages/domain` (safety): `hazard HZ-013 an incident recorded offline starts its clock at the recorded event time` | Planned, Phase 1 |
| `packages/domain` (safety): `hazard HZ-013 a decision cannot close without evidence or a not-notifiable reason` | Planned, Phase 1 |
| `packages/domain` (safety): `hazard HZ-013 the outbreak rule fires for linked cases within the configured window` | Planned, Phase 2 |

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
| Design | Results entered offline raise the task on the device immediately and the alert on sync, with the original time | Phase 1 |
| Design | Handover always includes NEWS2 of 5 or more and open MUST follow-ups from the shift (HZ-018) | Phase 1 |
| Training and user documentation | User guide: the score supports clinical judgement and the published response, never replaces it; deployer control: escalation policy and on-shift nurse in charge set per location | Phase 1 |

**Target residual risk**: severity Major, likelihood Low, **risk 3**.

**Justification for level 3**: Harbour raises, routes and escalates the response, but acting on it is a clinical decision by the staff on shift; further reduction would mean automating a clinical judgement, which the medical-device boundary rules out. `[CSO acceptance - human action]`

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain` (care): `hazard HZ-014 NEWS2 bands that call for a response raise a task and an urgent alert` | Passing |
| `packages/domain` (care): `hazard HZ-014 MUST medium and high risk schedule the food record and the dietitian referral` | Passing |
| `packages/domain` (care): `hazard HZ-014 Waterlow nutrition score over 2 raises a nutrition assessment task` | Passing |
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

**Causes**: the document is filed but not flagged; an old version is shown; the record is not available offline or in the downtime pack; the hospital transfer pack omits it.

**Effects**: resuscitation attempted against the person's wishes, or not attempted when it should have been; distress to the person and family.

**Initial risk**: severity Major, likelihood Low, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | The point-of-care header shows the current resuscitation status (word and icon) with the date and clinician; a missing record shows as 'Not recorded', never as blank | Phase 1 |
| Design | Only one active record per kind; recording a new one supersedes the old; review dates raise tasks | Phase 1 |
| Design | Advance care records are reference data on the device (never evicted while assigned), in the downtime pack and in the hospital transfer pack | Phase 1 |
| Training and user documentation | Deployer control: the original signed form stays with the person as the home's policy requires; Harbour shows the record, it is not the legal document | Phase 1 |

**Target residual risk**: severity Major, likelihood Very low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain` (care): `hazard HZ-015 a missing resuscitation record shows as not recorded` | Planned, Phase 1 |
| `packages/db`: `hazard HZ-015 only one advance care record of each kind is active` | Planned, Phase 1 |
| `apps/api`: `hazard HZ-015 the transfer pack and the downtime pack include the current resuscitation record` | Planned, Phase 1 |

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

**Causes**: handover written from memory; compiled list editable so items are removed; items recorded offline sync after the handover is compiled; nobody acknowledges it.

**Effects**: missed observation or treatment; repeated harm; delayed escalation.

**Initial risk**: severity Major, likelihood Medium, **risk 3**.

**Controls**

| Type | Control | When |
| --- | --- | --- |
| Design | Handover compiles automatically from the shift's records by rule (late tasks, NEWS2 of 5 or more, incidents, new body-map marks, refusals, falls, alerts); compiled items cannot be removed, only annotated | Phase 1 |
| Design | Items that sync after compilation are appended and marked as late additions, and the incoming staff are notified | Phase 1 |
| Design | Each incoming member of staff acknowledges the handover; unacknowledged handovers show on the nurse-in-charge view | Phase 1 |

**Target residual risk**: severity Major, likelihood Very low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain` (care): `hazard HZ-018 handover includes every safety-critical item from the shift` | Planned, Phase 1 |
| `packages/domain` (care): `hazard HZ-018 items synced after compilation are appended as late additions` | Planned, Phase 1 |

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

---

## HZ-020 Deprivation-of-liberty authorisation lapses unnoticed

| Field | Value |
| --- | --- |
| ID | HZ-020 |
| Status | Open |
| Clinical owner | `[CSO name - human action]` |
| Engineering owner | `care` module (lead engineer) |
| Source | Master prompt 10.4; [Mental Capacity Act 2005 Schedule A1](https://www.legislation.gov.uk/ukpga/2005/9/schedule/A1); DHSC interim guidance after the June 2026 Supreme Court judgment |

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

**Target residual risk**: severity Considerable, likelihood Low, **risk 2**.

**Verification**

| Test | Status |
| --- | --- |
| `packages/domain` (care): `hazard HZ-020 DoLS expiry tasks fire before the end of each authorisation type` | Planned, Phase 1 |
| `packages/domain` (care): `hazard HZ-020 a DoLS outcome drafts the CQC notification` | Planned, Phase 1 |

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

## Candidate hazards for the first CSO workshop

Not yet in the log (no IDs allocated). The CSO decides at the Phase 1 SWIFT workshop whether each becomes a hazard `[CSO decision - human action]`:

- Data import mapping errors beyond allergies and medicines (care-plan content, contacts, legal representatives).
- AI module output mistaken for clinical advice (Phase 6; scope lock in [medical-device-boundary.md](../compliance/medical-device-boundary.md)).
- Missed domiciliary visit not escalated (Phase 4).
