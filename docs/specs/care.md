# Care delivery (`care`) - specification

Master prompt sections 10.1 (care planning and the point-of-care record) and 10.4 (mental capacity,
consent and deprivation of liberty), with section 17 for offline behaviour and section 18 for the
data model. Medicines (10.2, 10.3) have their own spec in Phase 2. Status per feature lives in the
[feature register](feature-register.md).

## 1. Purpose and register rows

The point-of-care record: what a carer reads before helping someone and writes straight after.
Everything here works offline on the phone and shows the person's photo, allergies and
communication needs at the top of every screen (HZ-001, HZ-007).

| Phase 1 rows | Later rows |
| --- | --- |
| CARE-001 care and support plan; CARE-002 risk assessments; CARE-003 Waterlow, Braden and MUST; CARE-006 NG249 falls; CARE-007 NEWS2; CARE-009 daily notes; CARE-010 core charts; CARE-012 body maps; CARE-013 tasks, rounds and handover; CARE-014 activities, life story and visiting; CARE-015 ReSPECT and DNACPR; CARE-021 consent, capacity and best interests; CARE-022 DoLS register | Oral health, pain, mood, dependency, continence and Barthel tools (Phase 2); RESTORE2 and SBARD drill (Phase 5); remaining charts (Phase 2); end-of-life depth, dementia and LD tools, PBS, delegated healthcare, CHC (Phase 5) |

## 2. Schema

All tables carry `id` (UUIDv7), `tenant_id`, `created_at`, `created_by` and forced RLS through
`app.person_in_scope(person_id, location_id)` (ADR-0002). Mutable aggregates carry `version`,
`updated_at`, `updated_by`, `deleted_at` and write a `record_version` row on every change.
Append-only tables have no UPDATE or DELETE grant for the app; a correction is a new row with
`supersedes_id`, and readers show the latest row in each chain with the history one tap away.

| Table | Kind | Key columns | Retention class |
| --- | --- | --- | --- |
| `care_plan` | mutable, versioned | person, status (`draft`, `active`, `superseded`), `review_due_on`, `signed_off_by_person` (person, representative or `unable` with reason), `signed_off_at`, `published_version`, `copy_from_active` (whether starting the draft asked to copy the active plan, so a start sent again is compared with it; migration 0047, null before) | `care_record` |
| `care_plan_section` | mutable | plan, domain (one of the 16 PCSP domains), need, outcome in the person's words, strengths, contingency | `care_record` |
| `care_plan_action` | mutable | section, action, who (role), when (recurrence rule in the person's location time zone), task generation flag, linked risk assessment, the task series it drives, the action of the earlier version it was copied from (`based_on_action_id`, slice 5) | `care_record` |
| `risk_assessment` | mutable, versioned | person, template key, hazard, who is at risk, likelihood, severity, controls, residual risk, positive-risk statement, review date | `care_record` |
| `assessment` | append-only | person, tool key and tool version, answers, score, band, workings (the calculation shown), triggers raised, assessor, `next_due_on` | `care_record` |
| `care_note` | append-only | person, category, text, tags, `occurred_at`, `device_time`, `recorded_at` (server), `device_id`, `late_entry` (derived), attachments, `supersedes_id` | `care_record` |
| `observation` | append-only | person, chart type, values (typed per chart), units, method, `occurred_at`, `device_time`, `recorded_at`, flags (for example NEWS2 component scores), `supersedes_id` | `care_record` |
| `body_map_mark` | append-only | person, view (`front`, `back`), region code, side (`left`, `right`, `midline`) stated separately from the drawing, mark type, pressure-ulcer category, size, photo document, linked incident or safeguarding concern, `supersedes_id` | `care_record` |
| `task`, `task_series` (the platform task engine) | mutable | person, location, source (care plan action, chart rule, assessment trigger, manual), kind (`care.plan_action` for a care plan round), title naming the need, role, due window, status, completed by, evidence (note or observation id), escalation state; one live series per care plan action (a unique index) | as the person (`care_record`) |
| `handover` | mutable then locked | location, shift (name, start, end), when compiled, refreshed and locked; written only in the system's view; a trigger refuses moving the shift, changing the organisation or first compilation, soft-deleting or unlocking | `care_record` |
| `handover_item` | append-only | handover, key, position, kind, person, source table and id, when, whether and when added late (references only); readable only by those who can see its person | `care_record` |
| `handover_note` | append-only | handover, the item it annotates (or none for the whole handover) and that item's person (taken from the item by trigger), text, author, device | `care_record` |
| `handover_acknowledgement` | append-only | handover, the member of staff (always the person acknowledging), the keys of the items they could see (recorded by the server), server time, device | `care_record` |
| `activity_record` | append-only | person or group, activity, attendance, engagement rating, notes | `care_record` |
| `visit_log` | append-only | person, visitor (contact or free text), kind (Reg 9A: facilitated visit, visit out, accompaniment), times, restrictions applied and why | `care_record` |
| `advance_care_record` | mutable, versioned | person, kind (`respect`, `dnacpr`, `adrt`, `advance_care_plan`), clinician name and role, date completed, review date, document, status | `care_record` |
| `consent_record` | mutable, versioned | person, decision (`CONSENT_DECISION_KINDS`: care plan, photos, social media, sharing, marketing, AI processing, bed rails, covert medicines), outcome (given or refused), given by (person or representative with authority: health and welfare or property and financial LPA with OPG reference and registration, deputy with order scope, decisions and end date, appointee, IMCA, advocate, family or friend), capacity status (assumed, or the capacity assessment), evidence, restraint conditions (bed rails), best-interests decision (covert medicines), expiry, withdrawn at | `care_record` |
| `capacity_assessment` | append-only | person, decision, time specific, stage 1 (impairment or disturbance), stage 2 (understand, retain, use or weigh, communicate), practicable steps taken, outcome, assessor, review date | `care_record` |
| `best_interests_decision` | append-only | capacity assessment, section 4 checklist answers, people consulted, less restrictive options considered, decision, review date | `care_record` |
| `dols_authorisation` | mutable, versioned | person, type (`urgent`, `standard`, `court_order`), request date, granted from and to, extension, conditions, RPR, supervisory body, outcome, CQC notification link, objection evidence, legal-change review status | `care_record` |
| `dols_legal_change_review` | mutable, versioned | authorisation (one review each), state (`awaiting_review`, `reviewed`, `referred`, `closed`, mirroring the workflow engine), the DHSC multifactorial factors, objection and its forms, consent signs, decision, decided at and by, referral to the local authority, closing reason | `care_record` |
| `refused_entry` | append-only | the entry's id (one copy each), table, person (when known) and their location, the request the device made for it (checked against that kind's contract), the refusal's HTTP status, code and reason, when refused, author, device, the review task; written only in the system's view, read like the care record (Device integrity, part 5) | `care_record` |
| `device_discard_entry` | append-only | the deletion record (`device_discard` audit resource id), its stage, the entry id, the owner; the index that tells an upload its entry was deleted (Device integrity, part 3) | `audit_event` |
| `handed_over_entry` | append-only | the hand-over id, the device that held the entry, its owner, who sent it, the table and entry id, when accepted; one row per entry, written in the entry's own transaction by `app.admit_handed_over_entry`; a hand-over id names one owner, device and sender (Device integrity, part 6) | `audit_event` |
| `handed_over_by` on `care_note`, `observation`, `body_map_mark`, `activity_record`, `visit_log` | append-only (with the entry) | who sent the entry for its author in a manager's hand-over ("Sent by"; null when the author sent it), returned with every entry item (Device integrity, part 6) | `care_record` |
| `drawn_x`, `drawn_y`, `drawn_zone`, `drawn_side` (migration 0043) and `drawn_from_device_side` (migration 0045) on `body_map_mark` | append-only (with the mark) | where the mark was placed on the drawing (the point in the drawing's own units, or the zone chosen with the buttons) and the person's side the server worked out from it and the view, set together; flagged when the place was taken from the side a phone from before sent (rule 7) | `care_record` |
| `escalation_policy_link` (migrations 0043 and 0044) | mutable, versioned, soft-deleted | validated tool, band (or every band), location (or the whole organisation), title, reference, the policy document; one live link per tool, band and place (rule 5) | tenant configuration |
| `discard_reason` (migrations 0043 and 0044) | mutable, versioned, never deleted (retired instead) | code, English and Welsh labels, order, whether seeded, when and by whom retired; the five the phone offers seeded for every organisation (Device integrity, part 8) | tenant configuration |
| `device_discard_record` (migrations 0043 and 0044) | append-only | one row per stage of each deletion record: the deletion id, stage, kind, coded reason (a `discard_reason` code), owner, who deleted, who sent it, device, count, when; unique on deletion and stage (Device integrity, part 8) | `audit_event` |
| `entry_device_deletion_flag` (migrations 0043 and 0044) | append-only | the server's flag on an entry its device recorded deleting: the entry and its table, person, location, owner, flag (`uploaded_after_deletion`, `deleted_after_upload`), the deletion id and the review task; one per entry, by table and id (Device integrity, part 8) | `care_record` |

New personal data fields are added to `docs/compliance/records-of-processing.md` and mapped in
`data-standards.md` (PRSB PCSP sections, SNOMED CT for chart concepts where a code exists) in the
same pull request as the table.

## 3. Permissions

From the catalogue in `packages/domain/src/platform/roles.ts` (matrix: [permissions.md](permissions.md)):
`care.plan.read`, `care.plan.write`, `care.note.read`, `care.note.write`, `care.assessment.write`,
`care.handover.manage`, `care.capacity.write` (consent, capacity assessments and best-interests
decisions), `care.dols.manage` (the register and the legal-change review), `care.respect.record`;
reading consents, capacity, best interests and DoLS needs `care.plan.read`. Scope
follows the person (tenant, location, assigned or break-glass). Care workers write notes, charts,
body-map marks and tasks for assigned people; nurses and seniors also complete assessments and
publish care plans; capacity assessments and DoLS need the senior or manager roles. Every read of
a person's care record is audited; writes are audited with the record id, never the content.

Slice 5 routes (no new permission; `care.handover.manage` is held by every point-of-care role):

| Route | Permission | Scope |
| --- | --- | --- |
| Publishing a care plan, which plans its rounds | `care.plan.write` | The person |
| `GET /v1/locations/{id}/round` | `care.plan.read` (MFA) | The location; tasks and people as the viewer may see them |
| `GET /v1/locations/{id}/handovers`, `GET .../handovers/{handoverId}` | `care.handover.manage` (MFA) | The location; only the items (and notes on items) about people the viewer may see, counted over those; a viewer who is not a tenant-wide role or a role at the location sees only their own acknowledgements |
| `POST /v1/locations/{id}/handovers` (compile or refresh) | `care.handover.manage` (MFA) | The location; compiled in the system's view, never the requester's; not before the offline window; limited per user a minute |
| `POST .../handovers/{handoverId}/notes` | `care.handover.manage` (MFA) | The handover; a note on an item needs an item the writer can see and takes its person |
| `POST .../handovers/{handoverId}/acknowledgements` | `care.handover.manage` (MFA) | The handover; only for oneself, for the items one could see (seen token) |
| `POST /v1/task-series/{id}/end` on a care plan series | Refused for everyone: the plan ends its rounds | - |

Device integrity routes (section 6; `care.held_entry.hand_over` is new, held by the owner, the
Registered Manager, the deputy and the nurse, with step-up):

| Route | Permission | Scope |
| --- | --- | --- |
| `POST /v1/sync/refused-entries` | `care.note.write` (MFA) for the author's own refusals; for another member's, as a hand-over | Written in the system's view; the author is the caller or the hand-over's owner and must have cared for the person within the offline window; a revoked device only with a hand-over |
| `GET /v1/people/{id}/refused-entries` (pages: `limit`, `before`), `GET /v1/refused-entries/{id}` | `care.note.read` (MFA) | The person; a copy with no person only for tenant-wide roles and roles at its location; every read audited |
| A care entry upload with `x-harbour-handover-owner` and `x-harbour-handover` | The route's own permission, and `care.held_entry.hand_over` (step-up) unless the sender is the owner | The person in the sender's scope and in the owner's care within the offline window; the owner and the sender bound to the device; within the device's reported hold (part 6) |

Care API follow-up routes (section 5; no new permission):

| Route | Permission | Scope |
| --- | --- | --- |
| `GET /v1/escalation-policies` | `care.plan.read` | Every link in the organisation (configuration, read beside every result) |
| `POST /v1/escalation-policies`, `PUT /v1/escalation-policies/{linkId}`, `POST .../{linkId}/remove` | `quality.policy.manage` | Where a role or grant carrying `quality.policy.manage` is held: a link for the whole organisation needs it across the organisation (a role assigned with no location, or a grant with none), a location's link needs it there. Read from those roles and grants, never the session's merged scope, which another role widens (#26 review round 2, S1); checked in the API (`permissionPlaces`) and again by restrictive policies (`app.holds_permission_at`, migration 0046) |
| `GET /v1/discard-reasons` | `care.note.write` (the permission recording a deletion needs; a device offers them before it deletes anything) | The organisation |
| `POST /v1/discard-reasons`, `PUT /v1/discard-reasons/{reasonId}` | `platform.tenant.manage` | Only from a role or grant carrying it across the organisation (an owner role assigned at one home does not count; a role mixing portal and staff permissions gives none), in the API and the restrictive policies (migration 0046) |

A location is in scope for tenant-wide roles, for location roles there, and for anyone who can see
a person living there (an assigned care worker).

## 4. Rules that are easy to get wrong

Every rule has a table-driven test in `packages/domain` (named with its hazard ID where one
applies). Figures come from `rate_table` by key.

1. **Care plan timing.** A first plan is due within `care_plan.initial_working_days` working days of
   admission (England bank holidays from the rate table) and is reviewed every
   `care_plan.review_interval_months` months and on change; overdue reviews raise a task to the
   nurse in charge.
2. **Plan publication.** Only an `active` plan drives tasks. Publishing supersedes the previous
   version; sign-off records whether the person or their representative agreed, or why not.
3. **Late entries.** An entry made more than `care_note.late_entry_hours` hours after its event
   is flagged late and shown so everywhere. "Made" is the device time when the entry was written
   (the server time for the web), never the upload time: an entry written on time on a phone that
   synced hours later is not late. `occurred_at` can never be in the future beyond the clock-drift
   tolerance (`sync.clock_drift_flag_minutes`, HZ-010); clock drift is flagged by comparing the
   device clock when it sent the request (`x-harbour-sent-at`) with the server's.
4. **Corrections.** Notes, observations, assessments and marks are never edited. A correction
   supersedes the original with a reason; both remain readable (Reg 17).
5. **Validated tools** (locked templates, medical-device boundary): scoring exactly as published,
   with the tool version stored on every result and the workings shown.
   - NEWS2 (RCP 2017): respiration rate, SpO2 on scale 1 or scale 2 (scale 2 only when a clinician
     has recorded hypercapnic respiratory failure for the person), air or oxygen (+2), systolic
     blood pressure, pulse, consciousness (alert, or new confusion, voice, pain, unresponsive) and
     temperature. Aggregate 0, 1 to 4, a single parameter scoring 3, 5 to 6, and 7 or more map to
     the published clinical responses; the response text is the RCP wording, not Harbour advice.
   - MUST (BAPEN): BMI score, unplanned weight loss in 3 to 6 months, acute disease effect; 0 low,
     1 medium, 2 or more high. In care homes screening repeats every
     `must.care_home.screening_interval_months` months; medium risk raises a
     `must.medium_risk.food_record_days`-day food record; high risk raises a dietitian referral
     task. Weight and height alternatives (ulna length, MUAC) are supported as BAPEN publishes.
     Bands apply to the exact BMI; it is rounded to one decimal place only for display.
   - Waterlow (2005 revision) and Braden: every published category and band, with the source and
     licence recorded (human action H-25). Braden bands use the publisher's wording (severe risk,
     high risk, moderate risk, at risk); a total of 19 or more reads "Below the at-risk threshold".
   - Falls: no falls prediction score (NG249 1.1.1), in NICE's words. Residential care settings
     offer everyone a comprehensive falls assessment on admission, at review and after a fall
     (1.1.7). Community settings ask about falls in the last year or a fall now (1.1.2): a fall
     with any 1.1.3 criterion (frailty, injury needing treatment, loss of consciousness, unable to
     get up, 2 or more falls) raises the comprehensive falls assessment, a fall without them raises
     the gait and balance check (1.1.4), and no fall gives information and advice (1.1.6). A
     reported fall also raises a review task.
   - **Escalation policy link** (care API follow-ups; HZ-012, HZ-014; medical-device boundary
     section 5 rule 4). Every result of NEWS2 (vital signs), MUST, Waterlow, Braden and the NG249
     falls pathway is returned with `escalationPolicy`: the organisation's own escalation policy for
     the tool and the result's band (title, reference, policy document, and what it matched on), or
     `not_configured`, which the web shows on assessment results and NEWS2 entries as "No
     escalation policy is configured for this result. Follow your organisation's procedures and
     tell the nurse in charge." with an icon, and never as nothing; a configured policy shows its
     title and reference, linking the policy document (`/documents/{id}`, a PDF the API audits).
     The phone shows it next (H-73).
     Links live in `escalation_policy_link`, per tool and optionally per band (none for the falls
     pathway, which has no band) and per location; a result takes the location's link for its band,
     then the location's for the tool, then the organisation's for the band, then the
     organisation's for the tool (`escalationPolicyFor`), so a location's policy for every band
     wins over the organisation's policy for one band (for the CSO, H-163). They are resolved when
     the result is read, so a changed policy shows on old results too. The policy document must be
     a current organisation document (available, its latest version). Harbour stores and shows the
     link only; it adds no recommendation of its own. The rule for the onboarding item
     `escalation_policies_linked` reads the links (`validatedToolsWithLinks`: linked when every
     band of the tool, at every location, finds a policy); the onboarding route that calls it is
     not built yet (slice 13), so until then the go-live check does not read the links (#26 review
     round 3). The NEWS2 result shown and focused straight after saving vital signs names the
     policy too, from the save's response, as the saved entry does (#26 review round 3).
6. **Charts.** Fluid balance keeps a daily target per person and a running total from 00:00 in the
   location's time zone, with the shortfall visible by mid-afternoon; food intake records the IDDSI
   level (0 to 7) and shows the person's prescribed level beside it, refusing a mismatched level
   without an override reason; repositioning intervals default to
   `repositioning.interval_hours.at_risk` or `repositioning.interval_hours.high_risk` hours from the
   person's skin risk and raise overdue tasks; bowel uses the Bristol scale 1 to 7 with "no bowel
   movement" counted for the 3-day prompt; weight every `weight.default_interval_months` months, or
   every `weight.at_risk_interval_weeks` weeks when MUST is medium or high.
   IDDSI on the server (care API follow-ups; HZ-016, clinical review C3): food always carries its
   level (the contract requires it); a drink needs its level whenever a drink level is prescribed.
   From the web the API refuses a drink without it, naming the prescribed level ("Level 2 Mildly
   thick (pink) is prescribed. Choose the IDDSI drink level given."), as it refuses a different
   level without a reason. From a device (a request naming `x-harbour-device`) the entry is kept
   instead, because it records food or drink already given: it is flagged
   (`flags.iddsiProblem`: `level_not_recorded`,
   `reason_missing`, or `prescribed_unreadable` when the prescribed level stored is not an IDDSI
   level) and, when it may not be safe (no level while one is prescribed, a level more solid or
   thinner than prescribed, an unreadable prescription), the nurse in charge is alerted as for an
   unsafe level. A code that is not an IDDSI level is refused from both. The web shows every kept
   entry's problem in words with an icon, in place of the reason line, and says plainly when a
   thinner drink or more solid food may not be safe (#26 review round 2, C1). A drink recorded as
   refused (not given) needs no level and raises nothing, since there was no texture to check.
   The level given is compared with the prescription in the care profile when the entry reaches
   the server, not when it was given (for the CSO, H-166).
   An urgent result alert (a NEWS2 band, an IDDSI entry) goes only to someone who can open the
   person's record (the database's own person scope, read for each member as at sign-in), on the
   staff and with a role in force: the nurse in charge at the location; with no one there who
   can, the Registered Managers across the organisation, then other Registered Managers whose
   scope covers the person, then the holders of `care.plan.write` who can see the person,
   longest-serving first in each (#26 review rounds 2 and 3). Its title names the home ("An
   observation at Harbour Lodge needs a response now"), nothing about the person. The route is
   worked out before the entry is written and kept on it (`flags.alertRoute`: `nurse_in_charge`,
   `fallback` or `no_one`), so the web says who was told from what happened ("The nurse in charge
   was told.", the fallback, or "No one who can open this record could be told. Tell the nurse in
   charge or a manager now."; an alert kept before the route was recorded says "Check that the
   nurse in charge knows."). With no one who can see the person, nothing is counted as raised and
   `care.alert.unrouted` is audited with a coded reason (`news2_threshold`,
   `iddsi_level_not_recorded`, `iddsi_reason_missing`, `iddsi_prescribed_unreadable`,
   `iddsi_unsafe_level`), never the result in words. The sync tasks keep their own fallback,
   where assigning the task is what lets its taker see it.
   A drink offered and refused adds nothing to the intake or the shortfall: the fluid day reports
   the drinks refused and the amount offered (`refusedEntries`, `refusedOfferedMl`), which the web
   shows beside the total, and a refused drink reads "200 ml offered" on the web and the phone
   (#26 review round 3; whether to show the offered amount beside the total is for the CSO,
   H-167).
   An entry its device recorded deleting stays in the fluid totals and NEWS2 lists, flagged: the
   fluid day returns how many such entries it counted and their intake and output
   (`flaggedEntries`, `flaggedIntakeMl`, `flaggedOutputMl`), which the web shows beside the total
   ("Includes 2 entries that a device recorded as deleted (300 ml in, 0 ml out): check for
   duplicates."), and every entry carries `deviceDeletion`, shown on the entry with an icon.
   Whether such entries should count is for the CSO (H-165); they are never left out silently.
7. **Body maps.** Side is chosen in words (left, right, midline) as well as on the drawing, and the
   two must agree before saving. Pressure ulcers use the NPIAP and NHS England categories 1 to 4,
   unstageable, deep tissue injury, with device-related and moisture-associated damage recorded
   separately. A category 2 or worse, or any unexplained bruise, prompts an incident and the
   safeguarding decision guide (see [safety.md](safety.md)).
   The server works out the drawn side itself (care API follow-ups; HZ-019): every screen draws on
   one drawing in its own units (`BODY_MAP_DRAWING`: 120 wide and 240 high, midline x = 60, a
   centre band 4 either side of it over the head, neck and trunk only, above y = 124), and a mark
   carries where it was placed, as `drawnAt` (the point, scaled to those units) or `drawnZone`
   (`viewer_left`, `centre`, `viewer_right`, from the buttons beside the drawing), or both, which
   must agree. `sideFromDrawing` reads the person's side from the place and the view (on the front
   view the person's left is on the viewer's right); a mark with no place and no side drawn, a
   point off the drawing, or a side in words that disagrees is refused, and so is a `drawnSide` a
   device sends with a place that is not the side the server worked out. A phone from before this
   was built sends only `drawnSide`: the server reads it as the zone that side names on the view
   (`zoneForPersonSide`), exactly as the current phone sends an entry queued before it was
   updated, checks the side in words against it, and stores the mark flagged
   `drawn_from_device_side` (returned as `drawnFromDeviceSide`), so those phones' marks are kept,
   not refused, and the record says the place was the phone's (#26 review round 2, C4). The place
   and the side are stored with the mark and the side is returned as `drawnSide`. A refused mark's
   review is urgent at once when it may be harm: a pressure ulcer of category 2 or worse, or
   with no category or one that cannot be read (#26 review round 3), a bruise, a skin tear, a laceration, a burn or a wound (Device integrity, part 5). The web sends
   each area's spot as a point (its drawing is twice the
   size; the left and right spots of the neck, back of the neck, genitals and coccyx moved just
   outside the centre band, and the groin and genitals just above where the legs begin, so every
   spot reads as its own side: H-162); the phone sends the point tapped, or the zone chosen with a
   button, and an entry queued before this was built is sent as the zone its drawn side names on
   that view.
8. **Handover.** Compiled from the shift's late tasks, NEWS2 of 5 or more, incidents, new body-map
   marks, refusals, falls, and alerts; nothing safety-critical can be removed, only added to. Each
   incoming member of staff acknowledges it. As built (`packages/domain/src/care/handover.ts`):
   - **Shifts** follow the location's pattern in UK local time, to the minute and with two or more
     shifts (default day 08:00 and night 20:00 from `handover.day_shift_start_minute` and
     `handover.night_shift_start_minute`), so a shift over a clock change is an hour shorter or longer.
   - **Items**: falls (incidents, and notes tagged `fall`); notes tagged `handover` ("Include in
     handover", item kind `flagged_note`, after body-map marks); NEWS2 in any band above "low", which is an
     aggregate of 5 or more or a single parameter scoring 3 (the RCP's urgent-response trigger), so
     wider than "5 or more"; incidents, with or without a person; urgent alerts raised in the shift
     or still unacknowledged at its end; new body-map marks; tasks overdue at the end of the shift;
     urgent or evidence-bearing tasks skipped or cancelled in it (with the reason); tasks due by the
     end of the shift that are not done though their window is still open; MUST follow-ups raised in
     it; refusals (food or drink refused, repositioning declined, notes tagged `refusal`).
     Medicines refusals join from the eMAR in Phase 2 (HZ-003).
   - **Tags** are a fixed vocabulary (`HANDOVER_NOTE_TAGS`: `fall`, `refusal`, `handover`) that the
     note form offers as choices; free-text tags are never matched, and an untagged note never
     reaches the handover. Which notes should is for the CSO (H-155; master prompt 10.1 says
     "auto-compiled from the shift's notes").
   - **Late syncs**: an entry belongs to the shift it happened in and to the shift that received it;
     the API refreshes both handovers, locked ones included, appending late additions. Who hears of
     one is `lateAdditionNotices` (below).
   - **Acknowledgement** records the keys of the items the person saw (server time alongside); a
     late addition they can see makes them pending again and shows them only the new items. The
     incoming shift has acknowledged (`incomingAcknowledged`) only when someone acknowledged at or
     after the shift's end and what they acknowledged covers every item they can see now.
   - **Round view** (`rounds.ts`): open tasks due before the round ends (unfinished ones from
     earlier rounds included) and later tasks whose window is already open, by floor, then room in
     natural order, then due time. Each stop shows the point-of-care header (photo, name,
     allergies; HZ-001), and offline views show the last sync time (HZ-002).

   As built in slice 5 (`apps/api/src/services/handover.ts`, `routes/handovers.ts`, `routes/rounds.ts`):
   - **Stored** as one `handover` per location and shift, with its items (`handover_item`, one row
     each), notes and acknowledgements in their own append-only tables. It is compiled in the
     system's view of the organisation, never the requester's, so nothing is missed because of who
     asked; who asked is audited. Only the system's view writes a handover or its items (restrictive
     policies on scope `tenant`): a reader can neither add an item, lock, refresh nor soft-delete.
   - **When**: on request (`POST /v1/locations/{id}/handovers`, for the shift running at `at`,
     never one that has not started nor an `at` before the offline window, `mobile.offline_window_days`
     and a day; at most `HANDOVER_COMPILE_REQUESTS_PER_MINUTE`, default 12, per user a minute), and
     by a worker job every 5 minutes, which compiles and locks every shift that ended within the
     offline window if nobody has (so a missed run or an outage loses none), and locks a handover
     once its shift has ended (`previousShift`). Locked handovers whose shift ended within `mobile.offline_window_days` days
     and a day are refreshed when an entry that happened in the shift arrives after the last
     refresh (read back 10 minutes, twice the run interval, because an entry's recorded time is
     when its transaction began, so one that committed just after a refresh is never missed), and
     open ones on every run. Late items are appended (`refreshHandover`); the shift a
     late entry arrived in gets it when its own handover is compiled.
   - **Sources** at the location: open tasks due by the end of the shift, MUST follow-ups raised in
     it and tasks staff skipped or cancelled in it (the task's completion time; tasks the people
     lifecycle or a plan change cancelled are not "skipped"); vital signs by the NEWS2 band stored
     with them, and refusals (`observationIsRefusal`); notes with the fixed tags; body-map marks;
     incidents with their people; and urgent alerts naming the location. Alerts now name the person
     and location they concern (`notification.person_id`, `location_id`; migration 0028 fills them
     for earlier alerts from their source). Each alert is one item however many people it reached
     (`alertConditions`), counted acknowledged from the first acknowledgement; escalation copies
     and every handover notice (`care.handover.*`) are left out.
   - **Only added to**: besides the API (`checkHandoverKeepsItems`), items are append-only rows
     with a unique key and position per handover, and a trigger refuses any update of a handover
     that moves the shift, changes its organisation or first compilation, soft-deletes it or unlocks
     it; every refresh is versioned in `record_version`.
   - **Notes** by the outgoing staff, on the handover or on one of its items, until the shift ends
     or it is locked (`handoverOpen`, `checkHandoverNote`; up to 2,000 characters, client id so a
     retry is recorded once). A note on an item takes that item's person (a trigger, whatever the
     writer sends) and follows their scope; an item the writer cannot see cannot be annotated. Once
     closed, the refusal says "This handover has closed. Add a care note tagged "Include in
     handover" instead: the next handover carries it, and if you time it within this shift it is
     added to this handover too."
   - **Acknowledgement** with a client id (a retry is recorded once) and the seen token
     (`you.seenToken`) of the view the person was shown: the server records the keys of the items
     they could see and the server time, and refuses an old token with 409, so nobody acknowledges
     what they were not shown; only for oneself (row-level security). Until rotas say who comes on
     (Phase 2), the incoming staff are those who acknowledge: the incoming shift has acknowledged
     only when every item is covered by at least one acknowledgement made at or after the shift's
     end, by the keys each recorded (`incomingAcknowledged`). Once the shift has ended without that,
     the handover is marked unacknowledged, and after `handover.acknowledgement_grace_minutes` (60,
     to verify) the nurse in charge on duty gets one acknowledgeable alert per handover ("A handover
     has not been acknowledged", `care.handover.unacknowledged`, in the app, raised within a day of
     falling due; with no nurse in charge, the longest-serving Registered Manager anywhere, else the
     longest-serving holder of `care.handover.manage`, and with no one an audit with `told: 0`;
     H-153).
   - **Reading**: row-level security shows only the items about people the reader may see, items
     about nobody (a staff injury, a fridge check) only to those who see the handover whole, and a
     note on an item only with its item (HZ-011); every count is over those; the reader's own state
     (`viewerAcknowledgement`) counts only those, so a late addition about someone else does not ask
     them again. A reader who is not a tenant-wide role or a role at the location sees the handover
     `limitedToYourPeople`: only their own acknowledgements, `unacknowledged` null, and the refresh
     time of the last item they can see, so nothing tells them about the rest. Each item names its
     person; the people on the visible items come with the point-of-care header.
   - **Late additions** are announced once per refresh and recipient (`lateAdditionNotices`), never
     before the receiving shift starts: while it runs, to the staff who acknowledged on it (an
     outgoing read-back never counts), about what they can see, and to
     the nurse in charge (clinical leads and team leaders at the location whose assignment is in
     force, else the Registered Manager; never suspended or departed staff) about anything none of
     them can see (everything when nobody has acknowledged) and always about a fall, a raised NEWS2,
     an incident or an urgent alert; once it has ended, to the nurse in charge about everything.
     Urgent with push only when such an item the recipient can see was added, otherwise a warning
     in the app (`lateAdditionSeverity`, HZ-008); an addition nobody on duty can see is counted in
     the refresh's audit. The notice is generic ("A handover has new items") and links to the
     handover.
   - **Round view** (`GET /v1/locations/{id}/round`): the shift running now in the location's
     pattern, or `from` and `to` (at most 24 hours); the location's open tasks that `roundView`
     keeps, by area (the room's floor, else its unit, from the person's current bed) and room;
     every stop with the point-of-care header (`PersonSummary`: photo, names, allergies,
     communication needs, the resuscitation decision and the prescribed IDDSI food and drink levels,
     each `not_recorded` until recorded; HZ-001, HZ-007, HZ-015, HZ-016); every task with its state,
     and a care plan round with the action as its plan words it, the plan's status and, when the
     action is no longer in the active plan, "From an earlier plan: check the current plan"
     (HZ-024); and the person's active plan actions that are not rounds (`notRounds`: medicines,
     "Not a round: see the medicines record"; HZ-003). The view says when it was read, so a copy
     kept offline shows its age (HZ-002). Tasks and people follow the viewer's scope.
9. **Capacity and consent.** Assume capacity (Mental Capacity Act 2005 s.1(2)); a capacity
   assessment is decision-specific and time-specific, and records the practicable steps taken to
   support the person to decide (s.1(3)). An outcome of "lacks capacity" is accepted only when
   stage 1 is met ("an impairment of, or a disturbance in the functioning of, the mind or brain",
   s.2(1)), at least one stage 2 element is not (understand, retain, use or weigh, communicate,
   s.3(1)) and the inability is because of the impairment (s.2(1) "because of"); every element found
   unable carries its evidence. Consent is per decision: from the person while capacity is assumed
   or assessed; from a representative only when an assessment shows the person lacks capacity for
   that decision and the representative's authority covers it. A registered health and welfare
   attorney covers care decisions (s.9(1)(a), s.11(7)) unless the instrument excludes them; a
   property and financial attorney does not; a deputy acts within the decisions in their order
   while it lasts (s.16, s.20); appointees, IMCAs, advocates and family have no power to consent,
   and their views go into a best-interests decision. Bed rails restrict movement, so an attorney
   needs the s.11(1) to (5) conditions and a deputy express authority (s.20(8)). Covert medicines
   apply only to a person who lacks capacity and need a best-interests decision (NICE SC1 1.15.1
   and 1.15.3). Only the person can agree to marketing or to AI processing (H-34). A later
   refusal or withdrawal replaces an earlier consent; expired consent is not valid; a
   representative's consent stops applying once the person has capacity for the decision.
10. **Best interests.** The section 4 checklist (s.4(1), (2), (3), (4), (5), (6)(a), (b), (c), (7)
    and the less restrictive option in s.1(6), in the Act's words, citing legislation.gov.uk) is
    complete only when every item is answered (including "not applicable" with a reason) and at
    least one consultation is recorded or its absence explained. It follows an assessment that
    found a lack of capacity (s.1(5)). An IMCA prompt appears when nobody other than paid carers or
    professionals can be consulted about serious medical treatment (s.37) or a change of
    accommodation (s.38, s.39); the NHS body or local authority instructs the IMCA.
11. **DoLS.** An urgent authorisation lasts at most `dols.urgent.days` days (Schedule A1 para
    78(2)) with one request (`dols.urgent.max_extension_requests`, para 77(4)) to extend it by at
    most `dols.urgent.extension_days` days (para 85(3)); a standard authorisation lasts at most
    `dols.standard.max_months` months (para 42(2)(b), para 51(2)). Expiry tasks fire
    `dols.expiry_reminder_days.first` and `.second` days before the end (28 and 7 by default,
    tenant settings, H-64); a reminder that would fall before an urgent authorisation starts fires
    when it starts. When the outcome of a request for a standard authorisation or a court
    application is known, or it is withdrawn, the CQC notification draft is created in
    [safety](safety.md) with the regulation 18(4B) statement (date and nature, whether an urgent
    authorisation preceded it, outcome or reason for withdrawal, date); an urgent authorisation is
    not notified on its own, and Welsh locations wait for the Wales pack. The legal-change switch is
    the tenant flag `dols.post_2026_review_workflow` (on by default, England and Wales only). The
    Supreme Court decided *A Reference by the Attorney General for Northern Ireland* [2026] UKSC 16
    on 2 June 2026; the DHSC interim guidance
    ([UK Supreme Court 2026 judgment on what constitutes a deprivation of liberty](https://www.gov.uk/government/publications/changes-to-the-definition-of-deprivation-of-liberty/uk-supreme-court-2026-judgment-on-what-constitutes-a-deprivation-of-liberty),
    published 15 June 2026, updated 22 September 2026) says existing authorisations where the person
    may no longer be deprived of liberty "should be reviewed as soon as is practicable", that leaving
    one in place meanwhile "does not mean the person is being unlawfully deprived of their liberty",
    and that DoLS still applies in hospitals and care homes. The review workflow (awaiting review,
    reviewed, referred, closed) records the guidance's multifactorial assessment in its words (type,
    duration, effects and manner of the restrictions, how far removed from a prison cell, relative
    normality, purpose), whether the person objects and how, the guidance's signs of valid consent
    and serious doubt, the decision (still deprived, no longer deprived, in doubt), its date and who
    made it, and the request to the local authority. That request is required for "no longer
    deprived" (the managing authority must request a review when a qualifying requirement appears
    reviewable, Schedule A1 para 103(2); only the supervisory body ends it, para 117) and where
    there is doubt or the objection fluctuates (the guidance). Authorisations granted before the
    judgment and still in force are listed for review, soonest ending first. Further DHSC guidance
    is expected; a legal review of this content is H-62.
12. **Deceased or discharged people** are read-only except for post-event records (after-death care,
    property return, medical examiner pack). Care events that happened at or before the discharge,
    death or move to hospital are still accepted when they upload, flagged as recorded after it
    ([people.md](people.md#4-rules-that-are-easy-to-get-wrong) rule 3, HZ-006).
13. **An entry and the task it names** (`checkTaskLink`, HZ-004, HZ-006). An entry stores the task
    it named and what it did to it (`task_outcome`). The task row is locked while the entry is
    planned and written, so of two entries sent at once only one completes it, and a replayed
    upload returns the stored entry before anything is planned again. An open or in-progress task
    for the same person, whatever its window, is completed by an author who may complete it
    (a holder of its permission, or its assignee while they could still be given it), judged when
    the care was recorded: a grant that ended before the upload still counts, a revoked one never
    does, and never earlier than the task was made (`entryPermissionTime`, H-138) (`completed`). A cancelled task with no evidence,
    whether the people lifecycle or a manager cancelled it, keeps the entry as late evidence,
    flagged, and stays cancelled (`task_cancelled`; a return or correction that brings back what
    the lifecycle stopped later restores it as done). A task already done or skipped, or a
    cancelled task an earlier entry already answered (`task_already_closed`), or one the author
    may not complete (`not_linked`), is left alone; the entry is kept, flagged, and listed on one
    review task for the nurse in charge (`care.entry_review`). For a `medicines.*` task in any of
    those cases the entry is kept as `medicines_conflict`, never completing the task, with an
    urgent conflict review (`care.entry_conflict_review`), and the user is told "Tell the nurse in
    charge now. Only the person who gave a medicine records it.", so a dose is never given twice
    on the strength of the record (H-132); a task for another person is refused (HZ-001). Every
    entry view shows the outcome as an icon and words.
14. **Care plan rounds** (`packages/domain/src/care/plan-tasks.ts`; HZ-024, HZ-003, HZ-004,
    HZ-008). Each task-generating action of the person's active plan drives one task series of
    kind `care.plan_action` in the task engine, sourced from the action. The series takes the
    action's role and its need for evidence; its title names the need ("Care plan: skin"), never
    the person or the action's words, which the round view reads from the plan. Anyone who writes
    the person's care record completes a round (`care.note.write`), as with any task about a person.
    - **Window** (`roundTimes`): a round may be done from `care_plan.task_window_before_minutes`
      minutes before its time until `care_plan.task_window_after_minutes` after, then it is overdue
      and escalates once after `task.overdue_escalation_minutes`, through the task engine. Windows
      come from the real instants of consecutive rounds, never the clock face: where two rounds
      are closer than that, the earlier one's time after and the later one's time before are cut
      to stay a minute short of the real gap between them (each under half of it), so no instant is
      inside two windows and no window is ever nothing, and an entry answers one round only. Times
      of one action whose consecutive occurrences are under `MIN_ROUND_GAP_MINUTES` (10) apart on
      the clock face are refused when it is written, for every frequency (`roundGapProblem`: across
      midnight, from one weekday to the next, across the cycle), and occurrences a clock change
      brings that close are one round (01:00 and 02:00, or 01:30 and 02:30, are the same instant on
      the night the clocks go forward). The series keeps the tenant's figures as the
      most either side; the task engine (`seriesRoundTimes`) and the lifecycle's gap filling apply
      the rule, so the windows do not depend on when rounds are made.
    - **Generation** (`planActionTaskSeries`), when a version is published and by an hourly sweep
      (which also catches plans published before slice 5): an action already driving a series
      keeps it, so generating again changes nothing; an action copied unchanged from the previous
      version (same need, schedule, role and evidence, `sameTaskSchedule`) takes over that action's
      series, so none of its rounds is cancelled or made twice; every other live series ends. A
      series ends with its rounds due from then that nobody has started cancelled with the reason
      (a round in progress stays to be finished, and an overdue one stays open, marked "From an
      earlier plan: check the current plan"; HZ-024), and rounds paused
      while the person was away lose their pause code, so a return never brings back the old
      schedule. A series the people lifecycle stopped stays with its action and is never replaced
      by a second one (one live series per action, a unique index). A new series starts on the day
      of publication and materialises 48 hours ahead; nothing is made for a person away, not yet
      admitted or whose record is closed.
    - **Never medicines**: an action in the medicines domain cannot generate tasks
      (`checkPlanAction` refuses it when it is written and when the plan is published): medicines
      rounds come from the medicines record, so a care plan task is never ticked off as if it
      were a dose (H-151).
    - **Changed only through the plan**: the task series end route refuses a care plan series.

### Domain modules for consent, capacity and DoLS (slice 6)

`packages/domain/src/care/mca/`, exported from `@harbour/domain`; pure functions with no I/O:

| Module | Main exports | For |
| --- | --- | --- |
| `consent.ts` | `CONSENT_DECISION_KINDS`, `CONSENT_DECISIONS`, `checkConsentRecord(record, at)`, `consentStatus(records, decision, at, capacityNow)` | Refusing a record without authority; whether a valid consent exists at a time, and why not |
| `capacity.ts` | `checkCapacityAssessment(input, now)`, `capacityFinding(assessments, decision, at, today)`, `FUNCTIONAL_ELEMENT_WORDING` | The two-stage test, decision- and time-specific; assumed capacity |
| `best-interests.ts` | `BEST_INTERESTS_CHECKLIST`, `checkBestInterests(input)`, `imcaPrompt(input)` | Section 4 completeness, consultation, IMCA |
| `dols.ts` | `resolveDolsRates`, `checkDolsAuthorisation`, `dolsEndsAt`, `dolsStatus`, `dolsReminders`, `dolsCqcNotification`, `DOLS_LEGAL_CHANGE`, `legalChangeReviewEnabled`, `checkLegalChangeReview`, `DOLS_LEGAL_CHANGE_REVIEW_WORKFLOW`, `legalChangeStepProblems`, `authorisationsAwaitingLegalChangeReview` | Register clocks and status, reminders, the Reg 18(4A) decision, the legal-change review |

## 5. API and events

Built in slice 4a: `POST` and `GET /v1/people/{id}/notes`, `/observations` (typed values per chart;
vital signs scored with NEWS2 using the recorded SpO2 scale; food and drink checked against the IDDSI
levels), `GET /v1/people/{id}/charts/fluid?date=`, `POST` and `GET /v1/people/{id}/body-map`,
`GET` and `PUT /v1/people/{id}/care-profile`. Any entry may name the `taskId` it answers (for example
the 02:00 turn), which completes that task with the entry as evidence. A NEWS2 response band alerts
the nurse in charge and creates the response and repeat-observation tasks; a score of 0 schedules
nothing outside the care plan (HZ-008). Body marks that prompt an incident or the safeguarding guide
create those tasks for the manager. Charts and marks follow
[people.md](people.md#4-rules-that-are-easy-to-get-wrong) rule 3 (built in slice 8; slice 4a
refused them whatever the event time): for a person who has left, died or gone to hospital or on
leave, an entry for an event at or before that change (for example observations a phone recorded
offline before a death) is accepted and returned with `recordedAfterExit: true` (HZ-006); a later
event is refused, except post-event notes after a discharge or death. Archived and not-admitted
records take nothing.

Built in slice 4b: `GET` and `POST /v1/people/{id}/care-plans` (a draft, usually copied from the
active plan; one draft and one active plan per person), `GET /v1/people/{id}/care-plans/{planId}`,
`PUT .../sections/{domain}` for the 16 PCSP need domains (need, outcome in the person's words,
strengths, contingency), `POST .../sections/{domain}/actions` and `PUT .../actions/{actionId}`
(action, role, a `Recurrence` in the location's time zone, a task-generation flag for slice 5, an
optional linked risk assessment), `POST .../publish` (supersedes the active version and sets the
review date from `care_plan.review_interval_months`, or earlier) and `POST .../sign-off` (the
person, a representative with authority, or unable with the reason). The list returns what is due:
the first plan within `care_plan.initial_working_days` working days of admission, skipping the
nation's bank holidays (England only until other nations have a figure), then the review. An hourly
worker job raises one task and one alert to the nurse in charge for an overdue first plan, plan
review, risk assessment review or advance care record review. `GET /v1/care/risk-templates`, and
`GET`, `POST`, `PUT /v1/people/{id}/risk-assessments` with `/close`: fifteen code-constant
templates, rated with the NPSA matrix on the assessor's likelihood and severity (ADR-0032; falls are
never rated) and bed rail gaps checked against the MHRA figures in the rate table.
`POST /v1/people/{id}/assessments` runs MUST, Waterlow, Braden or the NG249 falls questions on the
server by tool key and stores the result with its version, workings, follow-ups and `next_due_on`;
MUST rescreens every `must.care_home.screening_interval_months` months and schedules weighing every
`weight.at_risk_interval_weeks` weeks at medium or high risk, otherwise every
`weight.default_interval_months` months (a recorded weight answers the check and sets the next);
Waterlow, Braden and the falls pathway repeat at the care plan review interval; a changed band or a
fall brings the plan review forward. Waterlow and Braden sit behind the `care.tool.*` flags (off by
default, on in the demo tenant, H-25). `GET` with `latest=true` returns the current result per tool.
`POST` and `GET /v1/people/{id}/activities` and `/visits` (Regulation 9A kinds; a restriction needs
its reason) are append-only with device ids. `GET`, `POST` and `PUT /v1/people/{id}/advance-care`
record ReSPECT, DNACPR, ADRT and advance care plans (a new record supersedes the active one of its
kind; withdrawal needs a reason), and the person summary carries the resuscitation status in force,
or `not_recorded` (HZ-015). `GET /v1/people/{id}/care-history/{table}/{recordId}` shows earlier
versions of the mutable records. Every write for a discharged, deceased or archived person is
refused, except activities, visits and assessments about an event at or before the exit, which
follow rule 3 as the charts do (slice 8). Outbox events `care.plan.published` and `care.assessment.completed` are written.

Built in slice 6 (`apps/api/src/routes/mca.ts`, `apps/api/src/services/mca.ts`; tables in
migrations 0018 and 0019): `GET` and `POST /v1/people/{id}/consents` and `POST
.../consents/{consentId}/withdraw`. The capacity status stored with a consent is found from the
person's assessments of that decision (`capacityFinding`), never taken from the request, and
`checkConsentRecord` refuses, in its words, a representative without authority (relatives,
appointees, IMCAs and advocates; a property and financial attorney; an unregistered attorney; a
deputy outside their order or past its end), the person's own consent while assessed as lacking
capacity, bed rails without the restraint conditions and covert medicines without a lack of capacity
and a best-interests decision (HZ-026). The list returns each decision's `consentStatus` with the
capacity found now: a later refusal or withdrawal replaces consent, expired consent is not valid, and
a representative's consent stops applying once the person has capacity. A withdrawal keeps the record
with its reason. `GET` and `POST /v1/people/{id}/capacity-assessments` and `/best-interests` are
append-only with device ids (a correction supersedes with a reason): `checkCapacityAssessment` stores
the outcome, the elements the person could not do and the reason in the Act's words, and
`checkBestInterests` needs every section 4 item, a consultation or why there was none, and a review
date, storing the IMCA prompt where nobody appropriate could be consulted. `GET`, `POST` and `PUT
/v1/people/{id}/dols` check the dates against Schedule A1 (`checkDolsAuthorisation`), England and
Wales only, and return the status, days left, reminders and the CQC notification; when the outcome
of a standard request or a court application is known (or it is withdrawn), the regulation 18(4A)
draft is created with its 18(4B) statement and `care.dols.outcome_known` is published (an urgent
authorisation is not notified on its own) (HZ-020). `GET /v1/dols/legal-change-review` lists, where
the tenant flag `dols.post_2026_review_workflow` is on, the authorisations granted before the
judgment and still in force with no review, soonest ending first, and the reviews under way; `POST
/v1/dols/legal-change-review/{authorisationId}` records each step through the workflow engine with
`legalChangeStepProblems` (the review before `reviewed`, the referral before closing when the person
is no longer deprived of liberty or there is doubt). An hourly job raises each expiry reminder once
(a task, an alert to the Registered Manager and `care.dols.expiring`), and none for an authorisation
that has ended or a closed record. The history route covers these mutable records through
`record_version`.

Built in slice 5 (`apps/api/src/services/plan-tasks.ts`, `services/handover.ts`, `routes/rounds.ts`,
`routes/handovers.ts`; tables in migrations 0027 and 0028; rules 8 and 14). Publishing a care plan
plans its rounds in the same transaction (`syncPlanTaskSeries`, audited as
`care.plan.tasks.generate` with the counts), and an hourly worker job (`care-plan-rounds`) does the
same for every person with an active plan or running plan rounds, as the system; a copied draft's
actions name the action they were copied from (`basedOnActionId`), and an action in the
medicines domain that generates tasks is refused when written and at publication. `POST
/v1/task-series/{id}/end` refuses a care plan series. `GET /v1/locations/{id}/round` returns the
round (`RoundView`: the shift, the window, when it was read, whether it lists every open task, and
the areas, stops and tasks with the point-of-care header and the plan action). `GET` and `POST
/v1/locations/{id}/handovers` list the location's handovers (default the last 7 days, at most 31)
and compile or refresh the one of the shift running at `at`; `GET .../handovers/{handoverId}`
returns one (`HandoverDetail`: the items the reader may see, counted over those, whether the view
is limited to their people, notes, acknowledgements, the people's headers and where the reader
stands with the seen token to acknowledge); `POST .../notes` and `POST .../acknowledgements` take a
client id, and an acknowledgement the reader's seen token (409 when it is old). A worker job every 5
minutes (`shift-handovers`) compiles and locks every shift of the offline window, appends late
additions and alerts the nurse in charge about handovers nobody on the incoming shift has
acknowledged; a failure in one organisation is audited (`platform.job.tenant_failed`) and the
others carry on. The care plan responses carry each action's notice ("Not a round: see the
medicines record" for a medicines action). Urgent alerts now carry `person_id` and
`location_id` (care triggers, overdue tasks, DoLS reminders, overdue statutory notifications and
their escalation copies). Audit events: `care.round.view`, `care.handover.list`,
`care.handover.view`, `care.handover.compile`, `care.handover.refresh`, `care.handover.lock`,
`care.handover.note.create`, `care.handover.acknowledge`, `care.handover.alert.unacknowledged` and
`care.plan.tasks.generate`; the
worker's writes are audited without an actor. Web and mobile screens follow in slices 9 and 10
part 2.

Built in slice 9 (web, part 1): the person's record in `apps/web/src/app/(shell)/people/[id]/` as
ten tabs (overview, care plan, assessments, risk assessments, notes, charts, body map, advance care,
activities and visits, history), each its own page with its own title. Every page renders the
point-of-care header through a shared server component (`RecordFrame`), so moving between tabs
reads it again; the header says when it was checked, refreshes when the window regains focus and
on a fixed interval, and has a refresh control (HZ-001, HZ-002). The header data is parsed with the
contract schemas at run time. The header adds the resuscitation decision in force as a word and
an icon with its source and review date, "not recorded" or "could not be read" as a warning
(HZ-015), and the prescribed IDDSI levels as number, name and colour, or says they are not
available to the viewer (HZ-016). Notes are grouped by correction chain, the
original struck through with who corrected it, when and why. Charts show the fluid day in UK time
as the API summed it; vital signs show the NEWS2 score, the RCP's wording and the workings as
stored; food and drink show the prescribed level beside the choice (HZ-014, HZ-016). The body map
has front and back drawings labelled with the person's left and right and a list of the same areas
for keyboard and screen reader users; the side is confirmed in words and the API's refusal of a
mismatch is shown word for word (HZ-019). Care plan versions carry their status in word and icon; a
draft is edited by need domain and published from a sheet that records who agreed it (HZ-024).
Assessments, risk assessments, advance care records, activities, visits and record history follow
the API. The web app never scores: every result, band and response is the API's. Playwright
journeys with axe are in `apps/web/e2e/care-record.spec.ts`.

After the accessibility and clinical reviews of slice 9, the web forms also:

- read typed event times with the shared domain rule `resolveRecordedUkTime`
  (`packages/domain/src/shared/time.ts`) through `DateInput` and `DateTimeInput` from `@harbour/ui`:
  a time left at "Now" is the instant the form is sent; a time in the repeated autumn hour asks
  "BST, before the clocks went back" or "GMT, after" with nothing chosen; a time in the skipped
  spring hour is refused; a time later than now beyond the clock-drift tolerance is refused
  (`DEFAULT_CLOCK_DRIFT_TOLERANCE_MINUTES` until the rate table value is served). The device's send
  time goes in `x-harbour-sent-at` so the API can flag drift (HZ-009, HZ-010, HZ-017);
- give each write a client UUIDv7 that is kept across retries of the same form, where the contract
  takes one (HZ-029);
- pre-select nothing in NEWS2 (air or oxygen, consciousness) or IDDSI choices, need a drink level
  whenever one is prescribed, and withhold the scale-dependent NEWS2 inputs when the care profile
  cannot be read (HZ-012, HZ-016);
- tie each refusal to its field (`aria-invalid`, `aria-describedby`, a linked summary), map known
  API refusals to catalogue wording by the domain rule messages (`apps/web/src/lib/refusals.ts`) and
  show the API's detail only for unknown ones;
- show a saved NEWS2 entry's total, the RCP's response and its workings as the API returns them on
  read, warn when follow-ups or workings rows cannot be read (with their codes), and put the late
  and clock-drift flags on the overview tiles (HZ-012, HZ-014, HZ-017).

Built in the care API follow-ups (the remaining findings of the #15 reviews; migrations 0043 and
0044; `apps/api/src/routes/care-settings.ts`, `services/staff.ts`, `services/escalation-policies.ts`):

- **IDDSI levels on the server** (rule 6; HZ-016, C3): a drink needs its level whenever a drink
  level is prescribed (food always carries one); refused from the web, kept and flagged from a device
  (`flags.iddsiProblem`, with the nurse in charge alerted when it may not be safe).
- **Escalation policy links** (rule 5; HZ-012, HZ-014): `GET`, `POST /v1/escalation-policies`,
  `PUT /v1/escalation-policies/{linkId}` (with the version read) and `POST .../{linkId}/remove`
  (soft delete). A link names a tool, optionally a band of that tool and a location, a title, a
  reference and one of the organisation's documents (never a person's); one live link per tool,
  band and place (409 otherwise). Every validated result returns `escalationPolicy`
  (`EscalationPolicyRef`): on `AssessmentItem` for MUST, Waterlow, Braden and the falls pathway,
  and on `ObservationItem` for vital signs scored with NEWS2 (null for other charts). Audited as
  `care.escalation_policy.link`, `.update` and `.remove` (tool, band and location; never the
  document).
- **Body-map side from the drawing** (rule 7; HZ-019): `CreateBodyMapMark` takes `drawnAt` and
  `drawnZone`; `drawnSide` is optional and, sent with a place, must be the side the server works
  out; sent alone (a phone from before), it is read as its zone and the mark flagged.
  `BodyMapMarkItem.drawnSide` returns the side (null on marks recorded before) and
  `drawnFromDeviceSide` the flag (migration 0045).
- **Review round 2 of #26** (migrations 0045 and 0046): an urgent result alert falls back when the
  location has no nurse in charge and is audited when no one can be told; the fluid day counts
  entries a device recorded deleting beside its totals (`FluidDay.flaggedEntries`,
  `flaggedIntakeMl`, `flaggedOutputMl`); a save sent again with its client id must carry the
  details the record holds (409 "This was already saved with different details: reload before
  changing it." otherwise) on advance care records, risk assessments, care plan drafts (their
  summary) and actions (and their domain), consents, DoLS and escalation policy links, and a
  removed link is never returned as live; handover notes, acknowledgements, capacity assessments
  and best-interests decisions take the client-id lock too, and an id another record has is
  refused in words, never a server error; escalation links and coded reasons follow the roles
  that carry their permission (section 3); `GET /v1/discard-reasons` needs `care.note.write`; the
  flag on entries is keyed by table and id; a deletion with an organisation's own code is audited
  as `other` with the reason's id, so the organisation's words never enter the hash-chained trail
  (`device_discard_record` keeps the code); a drink refused needs no IDDSI level; the policy
  document must be a current organisation document; the OpenAPI document names the DoLS create
  body `CreateDols` (it was `DolsInput`; the same fields plus `id`).
- **Review round 3 of #26** (migration 0047; 0046 amended before merging): an urgent result
  alert goes only to someone who can open the person's record, names the home, and the entry
  keeps who it reached (`flags.alertRoute`; rule 6); the unrouted audit carries a coded reason;
  a save sent again with other details is refused with its own code, `already_saved_differently`
  (409; the web says what was saved stands, to reload, check it and enter the change again),
  never `version_conflict`; a care plan draft sent again is compared on `copyFromActive` too,
  kept on the draft (`care_plan.copy_from_active`, null for drafts started before); the NEWS2
  result shown after saving names the escalation policy; a drink offered and refused adds
  nothing to the intake (`FluidDay.refusedEntries`, `refusedOfferedMl`); a refused copy of a
  pressure ulcer with no category, or one that cannot be read, is reviewed urgently; coded
  reasons are changed by id (`PUT /v1/discard-reasons/{reasonId}`, `DiscardReasonItem.id`) and
  audited by id only; `app.holds_permission_at` gives nothing from a role mixing portal and
  staff permissions, as at sign-in.
- **Coded discard reasons, the replay index and the flag on entries** (section 6, Device integrity
  part 8; HZ-040): `GET /v1/discard-reasons` (live reasons first, then retired), `POST` (a new code;
  409 when the organisation has it) and `PUT /v1/discard-reasons/{reasonId}` (relabel in English
  or Welsh, reorder, retire or bring back, with the version read; audited as
  `care.discard_reason.create`, `.update` and `.retire`, by the reason's id only, never its code;
  #26 review round 3). `SyncDiscard` keeps
  `reasonCode` as the five codes and adds `organisationReasonCode` (with `reasonCode` `other`).
  Every entry item returns `deviceDeletion` (`uploaded_after_deletion`, `deleted_after_upload` or
  null).
- **Staff names** (master prompt 5.5; Regulation 17 attribution): wherever a care response names a
  member of staff by id it also returns a `StaffName` (`id`, `displayName`, `jobTitle`; null when
  the member is not of the organisation, for example a system job): `recordedByStaff` and
  `handedOverByStaff` on every entry item (notes, observations, body-map marks, assessments,
  activities, visits), `CarePlanSignOff.recordedByStaff`,
  `CarePlanSummary.publishedByStaff`, `RecordVersion.changedByStaff` (care and person history),
  `TaskItem.assigneeStaff`, `completedBy` and `completedByStaff` (tasks, rounds), handover notes'
  `createdByStaff`, acknowledgements' `staff` and the handover summary's `staff`, consent, capacity
  and best-interests `recordedByStaff`, the legal-change review's `decidedByStaff`, and refused
  entry copies' `authorStaff` and `sentByStaff`. Names are read in the caller's transaction, so
  row-level security keeps them to the organisation, and only for records the route already lets
  the caller read; never the email. The opaque ids stay, so no output changed shape for an existing
  client.
- **Client ids** (HZ-029; master prompt section 6): `CreateAdvanceCareRecord`,
  `CreateRiskAssessment`, `CreateCarePlan` (a new draft), `CreateCarePlanAction`, `CreateConsent`
  and `CreateDols` take an optional `id` (a UUIDv7 kept across retries), as the entry routes
  already did. Every care create route that takes an id (notes, observations, body-map marks,
  assessments, activities, visits, advance care records, care plan drafts and actions, risk
  assessments, consents, capacity assessments, best-interests decisions, DoLS, handover notes and
  acknowledgements, escalation policy links) also takes it as the `Idempotency-Key` header; when
  both are sent they must be the same id. A save sent again with the same id returns the record
  already saved when it carries the same details (the id is locked for the transaction, so two
  racing sends record once); with other details it is refused with 409, so a changed CPR
  decision resent after a lost reply is never shown as saved (#26 review round 2, C5); an id
  already used for another person or another kind of record is refused ("That id is already
  used."). Entries a device sends (notes, observations, marks, activities, visits) and handover
  notes return the stored entry, as before. Create routes outside care that take no client id are
  listed in section 10.


Resources under `/v1/people/{personId}/...`: `care-plans`, `risk-assessments`, `assessments`,
`notes`, `observations`, `body-map`, `tasks`, `activities`, `visits`, `advance-care`, `consents`,
`capacity-assessments`, `best-interests`, `dols`; location views `/v1/locations/{id}/round`,
`/v1/locations/{id}/handovers`. Writes of append-only events accept a client UUID and are
idempotent. Outbox events: `care.note.recorded`, `care.observation.recorded`,
`care.plan.published`, `care.assessment.completed`, `care.task.overdue`, `care.dols.expiring`,
`care.dols.outcome_known`.

## 6. Offline behaviour (section 17.1)

| Data | On the device | Writes offline | Conflict handling |
| --- | --- | --- | --- |
| Care plan summary, risk assessments, advance care records, consents, DoLS status | Assigned people, never evicted while assigned | No (read only on the phone in Phase 1) | Not applicable |
| Notes, observations, body-map marks, activities, visits | Last `mobile.offline_window_days` days for assigned people | Yes, queued and idempotent | Append-only, so no conflict; late and drift flags computed on upload |
| Tasks | Today and tomorrow for assigned people | Complete or skip with reason | Last writer wins on status, both actions kept in history; a task completed on two devices shows in the conflict review |
| Assessments | Last result per tool | Yes | Append-only |

**As built (Phase 1 slice 10 part 1, `packages/sync` and `apps/mobile`).**

- **Streams** (`packages/sync/src/streams/sync-config.yaml`). The twelve care tables sync in the two
  scopes the people streams use: people assigned to the user (`person_assignment`, not ended) and,
  for managers and nurses, everyone receiving care at the token's location claims. Each family
  follows its own read permissions (ADR-0071 review rounds 1 and 2): the person and allergies
  `people.person.read` with `care.plan.read`, where both reach, so the phone never shows a
  resuscitation decision or IDDSI level as not recorded when the care reference is merely absent
  (`people_location_ids`, `people_assigned`), the care reference and plan details
  `care.plan.read` (`care_location_ids`, `care_assigned`) and recent entries `care.note.read`
  (`entries_location_ids`, `entries_assigned`); assigned people sync for a family only when a role
  scoped to them carries its permissions, and break-glass never syncs. The token also says where
  the phone may record (`entries_write_location_ids`, `entries_write_assigned`: `care.note.write`;
  with `entries_write_person_ids`, the people the user is assigned to, up to 100; read by no
  stream): the person screen offers notes, charts and the body map only there, deciding per person
  for the clients assigned to a coordinator who is also a carer, and otherwise says "You can read
  this record but cannot record in it. If something needs recording, tell the person in charge of
  this shift or your manager." Before its first token the phone offers recording only to a user
  whose permissions include `care.note.write` (review rounds 2 and 3, C2-M3 and C3-M2). Every
  location-scope stream (people, allergies and the care record) carries only people who are active,
  on leave or in hospital, so an enquiry, or a person discharged, deceased or archived, leaves
  managers' devices with their care record (security reviews S8 and round 3 L1). The tenant, the people and the offline window
  always come from the signed token, and the streams read no connection parameters; logical
  replication bypasses row-level security, so `packages/sync/test/care-streams.test.ts` proves
  through the real sync-rules engine that a person who is not assigned, an ended assignment, another
  tenant or a token without a tenant never reaches the device (HZ-011).
  - Reference data, never evicted while the person is in scope: `person_care_profile`, the active
    `care_plan` only (no drafts or superseded versions, HZ-024) with the sections and actions of that
    plan, active `risk_assessment` rows, every `assessment` result (summary columns only; the device
    shows the latest per tool, because a stream cannot pick the latest row) and active
    `advance_care_record` rows (HZ-015). Answers, workings and document ids are not sent.
  - Point-of-care entries (`care_note`, `observation`, `body_map_mark`, `activity_record`,
    `visit_log`) sync only for the days in the `offline_days` claim of the signed sync token,
    matched on the UTC date of `occurred_at`. `POST /v1/sync/token` builds the list (tomorrow, today
    and the days before it, `mobile.offline_window_days` days in all) with `offlineWindowDays` from
    the tenant's figure in the rate table, so a device cannot widen it: a window sent by the device
    is ignored, a script with a normal session gets the same claim, and a token without the claim
    gets no entries (security review S1; tests in `care-streams.test.ts` and `apps/api`). The
    token lasts 15 minutes and the device reconnects when the UTC day changes, so the oldest day
    leaves the device on time. The device reads the same figure through `GET /v1/rates/{key}` only
    to say how many days it keeps (HZ-028). A rate the seed or the token route finds outside 1 to
    31 days is refused at seeding, and at the token route the fail-safe window of one day is used
    with an alert carrying opaque ids only (security review round 3, L3). Entries for one person
    and day share a bucket across the five tables. `observation.values` arrives as `chart_values`
    (a reserved word in SQLite).
- **Writes** (`apps/mobile/src/care`, `apps/mobile/src/sync`). Every entry gets a UUIDv7 made on the
  device and is inserted, never updated, into its synced table in its own transaction, so it enters
  PowerSync's upload queue in the encrypted database and survives an app restart. The connector
  sends each entry to its own endpoint (`POST /v1/people/{id}/notes`, `/observations`, `/body-map`,
  `/activities`, `/visits`; `POST /v1/sync/upload` writes no care tables) with the id, `deviceTime`
  (the device clock when the entry was written) and the headers `x-harbour-tenant`,
  `x-harbour-device` (the PowerSync client id), `Idempotency-Key` (the entry id) and
  `x-harbour-sent-at` stamped as each request leaves, so the API flags late entries from the time
  written and clock drift from the time sent (HZ-010, HZ-017). A replay returns the saved copy and
  is treated as success. Network failures, 408, 425, 429 and 5xx retry with backoff and stay queued;
  a Retry-After is honoured up to 10 minutes, above the firewall's 300 seconds. A 403 is read from
  its RFC 9457 problem body (security reviews S6, round 3 H1 and round 4 H1). A session code
  (`not_a_member`, `mfa_enrolment_required`, `step_up_required`) ends the session. Any other code
  from the API (`missing_permission`, `feature_disabled`, or one the build does not know) on the
  sync token or a batch upload means the access Care mode needs was withdrawn, so the session ends
  for Care mode; on a single care entry it moves that entry to "needs attention". Only a 403 with
  no JSON body, an HTML page or the edge's `edge_blocked` asks `GET /v1/me` first, sending
  `x-harbour-tenant`: a 401, a session code or an answer without `people.person.read` ends the
  session; otherwise a care entry moves to "needs attention" and the sync token and batch uploads
  back off and try again, and if `/v1/me` cannot be reached the entry stays queued. Every request
  names the session's organisation. The web application firewall answers its blocks in the same
  shape: 403 with code `edge_blocked`, and 429 with code `rate_limited` and Retry-After.
  A typed event time goes through `resolveRecordedUkTime` from `@harbour/domain`, the rule the web
  uses, with the tenant's `sync.clock_drift_flag_minutes` as the tolerance (read and cached like
  the window; none until known): see Screens below.
- **When the session ends** (`apps/mobile/src/app-state/held-work.ts`; HZ-006, HZ-040). A 401, a
  403 with a session code, an API 403 on the sync token or a batch upload, or `/v1/me` answering
  without `people.person.read` ends the session. A session lasts 12
  hours while a device may work offline for the whole window, and the API answers an expired
  session with the same 401 as a revoked one, so the device first counts its unsent work:
  PowerSync's upload queue, `upload_issue` rows and `held_entry` rows.
  - Nothing unsent: it signs out and wipes (the database cleared, closed and deleted, the key
    destroyed).
  - Work unsent: it copies the upload queue into the local-only `held_entry` table, keeps
    `upload_issue`, and clears everything else synced (identities, NHS numbers, resuscitation
    decisions, care plans) with PowerSync's `disconnectAndClear`, keeping only the owner and the
    hold's time limit in `sync_meta` (security review S2). Uploads stop and the encrypted database
    and its key stay. The sign-in screen reads "Sign in again to send N entries" and names whose
    they are (C8).
  - Nothing is deleted automatically (security review round 3, M3; clinical review round 3, H2).
    Held entries stay, encrypted, until their owner sends them or the owner or a manager deletes
    them as below. At `mobile.held_entries_max_days` (rate table, tenant default 7, to-verify; one
    day until the figure has been read) the hold escalates: during its last day the sign-in screen
    shows a final warning with the count and the time, then it says a manager must resolve the
    entries. Local notifications (`expo-notifications`, scheduled on the device, no push service,
    no names or counts) fire when the last day starts and at the escalation, and are cancelled when
    the hold ends. A hold never acts on the device clock: a clock earlier than when the hold started
    or than the last time the server was reached changes nothing, and a clock that jumped forward
    only brings the escalation sooner. A marker without a usable deadline gets now plus the
    fail-safe day and is saved, never after a keystore error (L2).
  - When a hold starts the device reports its counts and the hold's start (below) at once, with the
    session that is ending, and again whenever the app comes back to the foreground or every few
    minutes for an hour; a report that cannot go waits in the keystore, counts and times only, for
    the next session in the tenant, even one refused because the entries are someone else's
    (clinical review round 4, H2). A report that could not be built is replaced by one from the
    marker's count, never taken as sent (round 5, C-M4). Once the report has gone, or the hour has
    passed, the ended session is signed out on the server, so access withdrawn does not leave a
    12-hour session alive (security review round 5, S-L3). A hold whose session ended with a 401,
    `not_a_member` or `mfa_enrolment_required` is reported only when someone signs in on that
    device again: the owner's own sign-in sends the waiting report, as does another member's in the
    organisation; until then the server knows only the last report (clinical review round 6, M3;
    human action H-141). The report names the hold's owner and the locations of the owner's sync
    scope (opaque ids kept in the hold's marker and the database's owner record), and is sent under
    the id of the device that held the entries, so in the forwarded case the task goes where the
    owner or that member works and the owner can close it (round 6, M1 and M2; below).
  - Ownership fails closed (security review S3). The owner (`tenant_user` id, sign-in id, tenant
    and name) is written into `sync_meta` inside the encrypted database when the database is made,
    and checked before the device connects. Only the owner resumes: their held entries go back into
    their tables, so into the upload queue with the same ids, each in its own transaction, and the
    queue drains under the new session. One that cannot go back moves to "needs attention" with
    its content; one that cannot even be moved stays held and is counted on the banner and Today.
    The held marker stays until every entry is back, so the next unlock tries again (clinical review
    round 3, M2). A restore that failed, or left entries held, is said in words on every screen until
    the next unlock puts them back, and a held count that cannot be read shows as needing attention
    (clinical review round 4, M4). The check before connecting is `admitToDatabase`, tested on its
    own (L4). Anyone else is refused ("Entries from another member of staff are waiting. They need
    to sign in to send them.") and their new session is ended. A keystore that cannot be read means
    "held, owner unknown". A database whose owner is someone else, unreadable or not recorded is
    never opened for the next person: its unsent work is held for its owner, or it is wiped when
    there is none.
  - Deleting unsent work (security reviews S4, S5, round 3 M1, M2 and L4 and round 4 M2 and M3;
    clinical reviews C2 and round 4 H1 and M3). Held entries are deleted from the sign-in screen:
    "Delete N unsent entries" asks for a coded reason, then the owner or a manager
    (`safety.incident.manage` in the same tenant; only a manager when the owner is unknown, and then
    only when the entries name the manager's organisation and no other) signs in on the device for
    this alone, the confirmation names the count, and device authentication follows; the device
    passcode alone is never enough, and the signer's session ends straight after. Sign-out from
    Settings or the lock screen with entries unsent (counted with `vault.countUnsent`, which
    includes refused and held entries; the count is unknown while the database is closed after a
    cold start, and the screen says so), and removing one refused entry, need a coded reason, a
    confirmation naming the count and device authentication.
  - A deletion always says which entries it removes, read before anything is deleted (clinical
    reviews round 4 M3 and round 5 C-M2; `readHeldIds`). Reading the key is the device
    authentication. A key that is there but could not be read this time (a cancelled prompt)
    refuses the deletion and asks to try again, and so do entries that could not be read with a key
    that was. A deletion goes ahead without ids only when nothing could ever be read: no key at all
    (`key_absent`) or a key kept that is not a valid one (`key_invalid`); the reason goes to the
    server (`idsMissing`). A sign-out from the lock screen after a cold start opens the database
    with its key to read them (human action H-144).
  - Every deletion is put on record as requested before anything is deleted, and its outcome
    after. A tombstone goes into the keystore with only a coded reason (`recorded_elsewhere`,
    `entered_in_error`, `staff_left`, `nurse_in_charge_informed`, `other`), its stage, the stages
    not yet acknowledged, opaque ids (tenant, owner, who deleted, up to 20 entry and 10 person ids,
    kind, and the device the entries were held on), a count and the time; a tombstone that cannot
    be written refuses the deletion, and so does a full list (40) of tombstones the server does not
    have yet: one is never dropped before the server has it. The device sends `POST /v1/sync/discards` for each stage, with the coded
    reason and no words, and the ids it has (up to 500, never more than the count). A member of
    staff's own entries may be deleted while the request waits to be sent; anyone else's, or entries
    whose owner is unknown, only once the server has acknowledged it, and a 403 or a refusal deletes
    nothing. Stages still waiting go again at each sync, in order; a record the session may not send
    (403), or that the server will not take, is skipped for that session and kept. A request sent
    at once carries up to 500 entry ids; one that has to wait keeps 20 in the keystore and sends
    those (each keystore item stays under 2 KB). At the API a later stage must match the first
    stage's kind and owner and come from its sender, the owner or a manager; an unknown deleter is
    recorded as unknown; each person may send 30 records an hour, start 20 new records a day
    (with or without ids) and list 2,000 new entry ids a day (security reviews round 5, S-L1, S-L2
    and S-M2, and round 6, M2). Every stage names the device the entries were held on
    (`deviceId`), so a stage sent from the device's next database still closes that device's task
    (clinical review round 6, M1).
  - Only the coded reason leaves the device (security review round 4, M3). Deleting held entries
    and signing out offer the listed codes without "Other" and without words, because the database
    the words would be kept in is deleted. Removing one refused entry also offers "Other" with the
    person's own words, kept in `sync_meta` inside the encrypted database (`discard-note:<id>`) until
    the server has the whole deletion, then deleted at the next sync (security review round 5,
    S-L4; human action H-146).
  - A deletion is checked, and its outcome means one thing (`discardHeldWork`; clinical reviews
    round 4 H1 and round 5 C-M1 and C-L1). It refuses if the database id cannot be read. With the
    request it marks the entries never to be uploaded (the held marker in the keystore); if that
    write fails, it records "failed" and deletes nothing. Then it clears the rows (on sign-out, where
    the database is open), deletes the file and destroys the key, each checked. "Failed",
    superseding the request at the server, is recorded only while the entries can still be read:
    the file, its key and the rows all remain. The entries then stay held and blocked: when their
    owner signs in they move to "needs attention" (code `held_discard_failed`), the device does not
    connect until they have, and if they cannot be moved every screen says they will never be sent.
    Otherwise it records "deleted", with any file or key left behind (`leftover`), which the server
    records as a separate security event (`sync.device.residue`), and the marker clears. Signing
    out with unsent entries uses the same steps (human action H-143).
  - The API keeps an entry uploaded after its own owner's device recorded deleting it ("deleted",
    and not later "failed"), and flags it with an audit event on the entry
    (`sync.entry.after_discard`); only a deletion whose owner is the uploader counts. An entry a
    deletion lists that had already reached the server, written by the deletion's owner (a response
    lost on the way back), is flagged the same way when the deletion is recorded as done
    (`sync.entry.before_discard`; clinical review round 5, C-L2). Each deletion record has one
    review task per kind and location for the Registered Manager there
    (`sync.entry_reported_deleted` or `sync.entry_deleted_after_upload`, source `device_discard`),
    so each location's managers see only their own people's entries (clinical review round 7, M4),
    whatever its number of entries: the first flagged entry there raises it, later ones add to its
    count, and its audit events (`sync.entry_flag.raised`, `sync.entry_flag.added`) carry the count
    and up to 20 opaque entry ids. A transaction-scoped lock on the tenant, kind, record and
    location, and a check for an open task, stop a second, and one owner's flags are taken in turn;
    an entry flagged before, under an earlier record or on its upload, is not flagged again, and
    every flagged entry is on a task. Each owner's deletions have at most 5 such tasks open at a
    location; past that the entries join the oldest of them (`added` with `merged`), the cap is
    audited (`sync.entry_flag.capped`, naming the task) and the location's Registered Managers get
    one notice a day (below): no cap stops a task (round 7, M2; human action H-149). The task is due
    at once when any of its entries is an observation (fluids, repositioning, vital signs and every
    other chart), because a possible duplicate counts towards the day's totals and can complete a
    round; otherwise 24 hours after it is raised, and an observation added later brings it forward
    (hazard HZ-008; clinical review round 7, M3; human actions H-147 and H-148). The deletion
    records' entry ids are read from `device_discard_entry`, never by scanning the audit trail
    (Device integrity, part 3, below; the HZ-040 go-live blocker).
  - A device a manager revokes is told at its next contact and wipes, keeping its unsent entries
    under these hold rules; a manager can hand over another member of staff's held entries, sending
    them under the owner's name with the manager recorded (Device integrity, parts 2 and 6, below;
    the H-68 go-live blockers). Until the API can tell a mistaken role edit from a real withdrawal,
    access withdrawn removes the care record from the phone at once, except the unsent work (human
    action H-145).
- **What the device tells the server** (security review round 3, queue depth; HZ-006).
  `POST /v1/sync/device-report` takes the device's unsent, refused, held and blocked counts (blocked:
  entries a failed deletion left), the age of the oldest and when the hold started, with no names
  and no care data, as an audit event whose resource is the device. It also names whose entries
  they are (`ownerTenantUserId`, which must be staff of the organisation) and the locations of
  the owner's sync scope (`locationIds`, opaque ids, at most 50). Any member of the organisation
  may send it, with MFA where their roles call for it; the device sends it after each sync when the
  counts have changed, every half hour while anything waits, and as soon as a hold starts. Reports
  for one device are handled one at a time. The named owner counts only when bound to the device:
  they have a `device_binding` row for it, written when a sync token was issued to it (the device
  sends its id with every token request) or when they sent a report from it, as the real owner has
  from syncing before the hold (Device integrity, part 1). A named owner who is not bound is recorded as a claim
  (`claimedOwnerTenantUserId`) and changes nothing: routing uses the reporter's assignments alone,
  the claim gives no right to close, and the owner taken for the hold stays the device's last bound
  owner (security review round 7, M1). The server takes the report's times as no later than it
  received them, and a hold's start as no earlier than the device's last report for that hold (still
  waiting, whoever is named as owner) said, nor than the server first heard from the device.
  While held, unsent or blocked entries wait, the server keeps the device's task (source
  `device_hold`) for a Registered Manager, due at the hold's start plus
  `mobile.held_entries_max_days`. It is raised at each location the report names where the reporter,
  or the owner when bound, has a live or most recent role assignment (any of the organisation's when
  the reporter is assigned across it), one task per location, closed together; with none left, at the
  reporter's live locations, then at their most recent one (including one just removed); with no
  location at all, one for each Registered Manager, assigned to them. A later report can bring the
  due time earlier, never later. Overdue, the task escalates only to holders of
  `safety.incident.manage` at its location; with no one there (a vacant post), it is assigned to the
  longest-serving live Registered Manager anywhere in the organisation (else holder of the
  permission anywhere), who alone is told and, as its assignee, can see and complete it; with no one
  at all it is not marked escalated, the gap is audited once a day (`sync.escalation_unrouted`) and
  the task waits a day before it is tried again (clinical reviews round 7 M5 and round 8 M1). A
  report with nothing waiting, or recording "deleted" for the device's whole hold,
  closes every copy when it comes from the hold's owner (as recorded when the task was raised or
  reopened), from whoever raised it, or from a holder of `safety.incident.manage` at one of its
  locations; anyone else's close is refused and audited. A task closed less than a day ago is
  reopened instead of a new one being raised. A new hold after a refused close, and a reopen of a
  task that had escalated, reset the escalation under one check, at most once a day
  (`DEVICE_HOLD_RESET_HOURS`) and with the due time never later; a reopen that finds the day's reset
  used is reset by a later report once it is due, once, so a new hold always signals (clinical
  reviews round 7 M1 and round 8 M2). Each reporter raises
  tasks for at most 3 devices in a rolling day, whatever became of them, counted under a
  per-reporter lock; past that, each further hold joins the reporter's one capped-holds task (source
  `device_hold_capped`, its source id the reporter), raised at the hold's locations when none is
  open, otherwise brought forward to the earliest capped hold's due time, escalating like a device
  task until a manager completes it (`sync.device_hold.merged`; round 7, M2). The cap is audited and
  the location's Registered Managers (else every Registered Manager) also get one notice
  (`sync.reporter_capped`, in-app, no personal data, linking to the task list) per reporter a day.
  Raises, reopens, moves, resets, merges, closes, refused closes, caps and notices are audited with
  opaque ids (clinical reviews round 4 H2, round 5 C-H1 and C-M3, round 6 M1 and M2 and round 7;
  security reviews round 5 S-M1, round 6 N2 and round 7 M1; human actions H-142 and H-149).
  Discards and reports each have a per-person limit, and `/v1/sync/*` bodies are limited to 64 KB
  (security review round 4, M4).
  The PowerSync client id is kept in the keystore so a deletion recorded from the sign-in screen,
  with no database open, still names the device.
- **Refused entries.** Any refusal of an entry moves it, with its content, to the local-only
  `upload_issue` table and the queue moves on, as does a `rejected` operation inside a 200 from
  `/v1/sync/upload`. Today and the person's record list them as "not saved: needs attention" with
  the API's reason, and the banner on every screen counts them and never reads "Up to date" while
  any is on the device (clinical review C1). A refusal recorded without a tenant is listed and
  removable. What was recorded stays with the refusal, encrypted, until someone removes it with a
  recorded reason, so it never ages out with the window (clinical review round 3, M1, replacing the
  security review S7 age-out). The device also sends the refused entry's content to the server,
  which keeps a copy and raises a review task (Device integrity, part 5), so a refused entry is
  never only on one phone (HZ-006).
- **Device integrity** (the follow-ups from the #15 reviews; HZ-006, HZ-008, HZ-010, HZ-011,
  HZ-040; human actions H-68, H-141, H-156 to H-159).
  1. **Device binding** (`device_binding`, migrations 0029 and 0030). One row per device and
     member of staff: the device id (the PowerSync client id, a UUID), the `tenant_user`, when the
     server first and last saw them together, and when the device was revoked, by whom and why.
     `POST /v1/sync/token` writes it (first seen kept, last seen moved on) whenever the request
     names the device, and `POST /v1/sync/device-report` writes it for the reporter, after the
     report has been judged, with the Better Auth session that did so (`device_session`, migrations
     0041 and 0042), while the device is not revoked; on a revoked device a new binding is revoked
     with the rest. Any other request naming the device binds the member and the session too, once
     per session (the tenant middleware; #25 review round 3, M2), except a hand-over, whose sender
     is bound by the report the device sends first; a member reads their own sessions and a job all
     of them, never a tenant-wide role. A hold report's named owner is bound when they have a row for the
     device (revoked or not: the row proves they used it); the start floor is the earliest first
     seen of any row for the device. Both replace reads of the audit trail. The migration fills
     the table from the audit trail's sync token and report events, so devices seen before keep
     their bindings and floors. Rows are written only in the system's view (tenant scope); a member
     reads their own rows, tenant-wide roles the organisation's, and a location role those of staff
     with a live, undeleted role assignment at one of its locations, as the API narrows them (#25
     review rounds 2 and 3).
     Mutable without a version history: every change that matters (a revocation) is audited.
     Retention class `audit_event`; the sessions are security records, not exported.
  2. **Revocation** (permissions `platform.device.read` and `platform.device.revoke`, the second
     with step-up; owner, Registered Manager and deputy; migration 0031 gives existing tenants'
     built-in role copies both, audited). `GET /v1/devices` lists the devices staff have used
     (device, member, first and last seen, revoked, by whom and why), optionally for one member;
     `POST /v1/devices/{deviceId}/revoke` with a coded reason (`lost_or_stolen`, `staff_left`,
     `access_withdrawn`, `replaced`, `other`) revokes every binding of the device at once and is
     audited (`platform.device.revoked`); a second revocation changes nothing and says so. The
     list gives each device's last reported waiting count (`entriesWaiting`: held, unsent,
     blocked, and refused with no server copy) and when it was reported (`lastReportedAt`), as the
     revocation does (#25 review round 3, M3); when the count is above
     zero the revocation needs `confirmEntriesWaiting` (409 `entries_waiting` otherwise), and once
     revoked the device's hold task (and any capped-holds task it joined) falls due at once,
     urgent, and the manager who revoked it is told (`sync.revoked_device_waiting`), because the
     hold can now drain only by a hand-over or a recorded deletion (#25 review round 2, M4); a
     second revocation hurries it again, moving only what is not yet due and urgent. A
     location role sees only devices used by staff whose live or most recent role assignment is at
     one of its locations (filtered before the list's limit), and revokes one only when every
     member bound to it is such staff (403 otherwise); any other device reads as not found. The
     sessions bound to the device (`device_session`) are not ended, since a device given a 401
     could not tell it was revoked; the tenant middleware refuses every request from one with 403
     `device_revoked`, whatever device it names or none, except `POST /v1/sync/device-report`,
     which may raise or hurry the hold's task but never close it (#25 review rounds 2 and 3, M1
     and M2). Mobile sessions live at the deploy that brings this in are ended then, so every live
     session is bound. A new sign-in naming the revoked device id is refused
     with a 403 whose code is `device_revoked` (distinct from an expired session's 401 and from
     `not_a_member`, `mfa_enrolment_required` and `step_up_required`) by `POST /v1/sync/token`,
     `POST /v1/sync/upload`, the five care entry uploads and `POST /v1/sync/refused-entries`,
     audited (`sync.device.refused_revoked`) at most once an hour per device; a hand-over of
     entries recorded before the revocation (part 6), a device report and a deletion record are
     still taken from it, so the server keeps hearing what it holds and what it deleted. The token keeps its claims (`sub`, `tenant_id`, `location_ids`,
     the per-family location and assigned claims and `offline_days`, already minted from the rate
     table); revocation is
     a check at issue, not a claim, so a revoked device never gets another token and the one it
     has lasts at most 15 minutes. The device reacts as to a remote wipe: with nothing unsent it
     deletes its database and key and says the device was withdrawn; with entries unsent it holds
     them under the hold rules above (everything else synced cleared, encrypted, escalating to a
     manager, deleted only with a recorded reason), marked revoked, and the session is signed out
     on the server once the hold is reported. A revoked hold never resumes uploading: the owner's sign-in is refused with words
     saying so, and the entries leave only by the hand-over (the owner's own, or a manager's) of
     those recorded before the revocation, or a recorded deletion. Whether a revoked device should instead delete its held entries at once is
     for the DPO and CSO (H-156).
  3. **Deletion lists** (`device_discard_entry`, migrations 0032 and 0033; the HZ-040 go-live
     blocker). Each stage of a deletion record writes one append-only row per entry id it lists:
     the deletion's id, the stage, the entry id and the owner. "Was this entry deleted by its
     uploader's device?" is one indexed read (the earliest deletion recorded as deleted, owned by
     the uploader, listing the entry, with no failed stage listing it), replacing the scan of the
     tenant's deletion events. The migration fills it from the existing deletion events. A member
     reads the rows of their own deletions; tenant-wide roles read the organisation's, and a
     location role those of owners with a role assignment at one of its locations.
     Retention class `audit_event`. A flagged entry is also marked on the entry itself
     (`entry_device_deletion_flag`, part 8).
  4. **One open sync task per source** (migrations 0034 and 0035). A partial unique index on
     `task` keeps one open (`open` or `in_progress`, not deleted) task per kind, source, location
     and assignee for the device-hold, flagged-entry and refused-entry review kinds, so two racing
     requests can never both raise one, whatever the advisory locks do; the locks stay, because
     they also serialise the caps and counts. A raise that meets the index takes the open task
     instead. 0034 first closes any duplicate an earlier race left (the oldest stays open and takes
     over the earliest due time, urgency, progress and flagged entries; the others are cancelled
     with a reason). 0035 builds the index inside the migration's transaction, locking `task`
     while it builds, accepted before go-live (CONCURRENTLY cannot run in a transaction). A flagged-entry task now carries its owner, its count and the
     entries (kind and id, up to 50, the rest counted) in `task.details`, which the task routes
     return, instead of in its audit events; the audit events keep how many were added.
  5. **Server copy of a refused entry** (`refused_entry`, migrations 0036 and 0037; HZ-006).
     `POST /v1/sync/refused-entries` takes the entry's id, table (one of the five entry tables),
     person, content (the request the device made for the entry, checked against that kind's own
     contract, `CreateCareNote` and the rest; its `id`, when present, must match), the refusal's
     HTTP status, code and reason, and when it was refused. Its author needs `care.note.write`; a
     manager sending another member's refusals during a hand-over follows part 6, and a revoked
     device's copies come only that way. A copy about a person is taken only when its author cared
     for them within the offline window (an assignment, or a tenant-wide or location role at their
     location); otherwise it is refused exactly as a copy about someone unknown here, so it never
     says whether a person exists (#25 review round 2, M2). The copy is written in the system's
     view, once per entry id (a replay returns it, a different author is refused), with the
     person's location; a copy about nobody is located by the author's most recent assignment. It
     is append-only, readable like the care record it would have been (`GET
     /v1/people/{id}/refused-entries`, a page of `limit` at a time before the copy `before` names,
     and `GET /v1/refused-entries/{id}`, `care.note.read`, the person in scope; every read audited),
     and retention class `care_record`. Each copy joins the person's one open review task
     (`care.refused_entry_review`, for the nurse in charge, `care.plan.write`, due at once, urgent
     when any copy is an observation or a body-map mark that may be harm (a pressure ulcer of
     category 2 or worse, or with no category or one that cannot be read, a bruise, skin tear,
     laceration, burn or wound; #26 review rounds 2 and 3),
     when the home's staff are told: the nurse in charge, as one definition serves result
     alerts, review notices and these reviews (`nurseInCharge`: the clinical leads and team
     leaders whose roles reach the home, at every home, with no rota checked, else its Registered
     Manager), whose `people.person.read` and `care.note.read` reach the person, so a team leader
     is told whether or not the home has a nurse; and the holders of `care.plan.write` who can see
     the person, to act (those who hold it at the home itself, and only with none of them those
     across the organisation, HZ-008). Only active staff are told. With neither, the fallback;
     with no one at all, `care.refused_entry.unrouted` is audited as the system (ADR-0071 review
     rounds 2 and 3, C2-M1)), whose details list each
     copy by kind, entry id, copy id, refusal code, time, device and author, never content;
     overdue, it escalates like the sync tasks, with the fallback when no one at its location can
     act (M3; H-157). Each author's copies count against 200 a day, after the replay check and the
     checks above, a hand-over's against the owner. The device sends each refusal's request as it
     records it, and again after each sync until the server has it (`upload_issue.server_copy`); an
     entry that cannot become a valid request, and one the server refuses, is marked refused,
     counted in the device's report (`copiesRefused`) and said in words on the needs-attention list,
     as "Harbour has a copy" is once the server does. Entries a failed deletion left are not sent,
     because their deletion is on record. No screen shows a copy yet, so a copy never takes an
     entry off the device (H-134).
  6. **Hand-over of held entries** (permission `care.held_entry.hand_over`, step-up and MFA; the
     Registered Manager, deputy and nurse, as for deleting held entries; migrations 0038, 0041 and
     0042). On the sign-in screen with entries held, "Send N entries" asks a manager (or, on a
     revoked device, the owner) to sign in on the device; the sign-in is the step-up. After device
     authentication the device opens the held database and sends its report from that sign-in,
     naming the owner (a report binds the reporter), then each held entry, in order, to its own
     endpoint with `x-harbour-device` naming the device that held it, `x-harbour-handover-owner`
     naming the owner and `x-harbour-handover` (an id for the hand-over), all three in the OpenAPI
     document. The API takes it only when (#25 review rounds 2 and 3, H1, item 1 and M1): the owner
     is staff of the organisation (whatever their status now) bound to that device; the sender is
     the owner or holds the permission, and is bound to the device too; the device's reports show
     an open hold for that owner (each since it began says entries wait and names them), and the
     hold's entries handed over since the latest report in it not sent by the sender (the owner's
     own preferred; when the owner sends their own, their own) stay within the count it gave, a
     replay not counting again; with no such report the hand-over is refused, since the sender's
     own reports never set the count (a second holder's confirmation is for the CSO and DPO,
     H-158); the entry's time, when it was written on the device (`deviceTime`, else its event
     time), is within `sync.clock_drift_flag_minutes` at or after the owner first used the device,
     at or before that report and, on a revoked device, at or before the revocation; the person
     was in the owner's care (an assignment, or a tenant-wide or location role at their location)
     within the offline window before the entry's own time; and the hand-over id names that owner,
     device and sender only. The entry is checked against the hold before its transaction and
     admitted in it (`app.admit_handed_over_entry`, which takes one hand-over id and then one hold
     at a time and records the entry in `handed_over_entry`), so an entry refused after its
     admission uses none of the count. A copy of a refused entry sent with a hand-over is checked
     and admitted the same way. The API writes the entry as the owner's (`created_by`) with the sender kept as
     `handed_over_by` and returned as `handedOverBy` ("Sent by") with every entry item, judges any
     task the entry completes on the owner's permission when the care was recorded (never the
     manager's), flags it against the owner's deletions, and audits `sync.entry.handed_over` (the
     sender as actor, the owner, the device and the hand-over id). The person must also be in the
     sender's scope. A hand-over the API will not take is a 422 `handover_refused` with the reason;
     on that or a 404 the device keeps the entry held with the reason (`held_entry.handover_refusal`,
     shown in the hand-over's result), never parked as refused, and sends the rest; any 403 stops
     it with the rest still held (H2; round 3, M1). An entry refused for what it is moves to needs
     attention and its copy is sent naming the owner; a network failure stops the hand-over with the
     rest still held. Before sending, the device holds anything still in its upload queue (a hold
     whose copy failed). Only when no held, needs-attention or queued entry remains, each counted,
     does the device report nothing waiting (closing its task), delete its database and key, and
     end the sender's session; a count that cannot be read keeps everything (round 3, M4); a refused entry keeps
     the database even with its copy on the server, until a screen shows the copies and the CSO
     closes H-134; otherwise the hold stays, with its count brought up to date. What the hand-over
     may do is for the CSO and DPO (H-158).
  7. **Shared quotas** (`request_quota`, migrations 0039 and 0040). The per-user limits on the sync
     routes (deletion records, entry ids, reports, refusal copies) and the transfer pack and
     handover compile limits are kept in Postgres, one row per member and limit holding the recent
     hits, updated under a row lock, so a limit holds across API instances. A member's row is read
     and written only in a view acting as that member (a hand-over's copies count in the owner's),
     never by a tenant-wide role (#25 review round 2). Operational, not exported; a row holds at
     most the window's hits.
  8. **Coded reasons, the replay index and the flag on entries** (care API follow-ups; migrations
     0043 and 0044; HZ-040, H-146, H-164).
     - *Coded reasons* (`discard_reason`): each organisation's own list of codes for deleting unsent
       entries, with English and Welsh labels and an order. A trigger on `tenant` seeds the five
       the phone offers (`recorded_elsewhere`, `entered_in_error`, `staff_left`,
       `nurse_in_charge_informed`, `other`; `DEFAULT_DISCARD_REASONS`) for every new organisation,
       and the migration seeds existing ones. Members holding `platform.tenant.manage` across the
       organisation add, relabel, reorder and retire codes (read from the roles and grants that
       carry it, in the API and the restrictive policies of migration 0046); a code is never
       deleted, and a retired code is still taken from a device that recorded it before, so a
       deletion is never stranded. `POST /v1/sync/discards` refuses a code the organisation never
       had. The contract keeps `reasonCode` as the five, so existing phones are unchanged; a code
       the organisation added travels as `organisationReasonCode` with `reasonCode` `other`, and is
       audited as `other` with the reason's id (`organisationReasonId`), never its code, so no name
       an organisation writes enters the hash-chained trail; the deletion record keeps the code.
       The phone offers the five until it reads the list (`GET /v1/discard-reasons`,
       `care.note.write`).
     - *The replay index* (`device_discard_record`): one append-only row per stage of each
       deletion record (the deletion id, stage, kind, coded reason, owner, who deleted, who sent it,
       device, count and when), unique on (deletion, stage). A stage sent twice, however two
       requests race, is recorded once: the insert meets the index and the request is answered as
       a replay. Earlier stages are read from it in the system's view (not from the audit trail),
       so a later stage is checked against the deletion it continues whoever sent the first. Only
       the system's view writes it; a member reads the rows they sent or owned, tenant-wide
       roles the organisation's, and a location role those of owners at its locations. The audit
       events stay the hash-chained record. Retention class `audit_event`.
     - *The flag on entries* (`entry_device_deletion_flag`): the server's own mark on an entry its
       device recorded deleting, one per entry (unique on table and id, migration 0045):
       `uploaded_after_deletion` (it arrived after its
       owner's device recorded deleting it) or `deleted_after_upload` (it had already reached
       Harbour when the deletion was recorded as done), with the person, location, owner, the
       deletion record and the review task. It is written in the system's view when the flag of
       part 3 is raised, read like the entry (`app.person_visible`), append-only, and returned as
       `deviceDeletion` on every entry item, so a screen can show the flag on the entry itself, not
       only on the Registered Manager's task. The web shows it on the entry with an icon and words,
       and the fluid day counts flagged entries beside its totals (rule 6; H-165). The "already
       reached Harbour" check reads this table instead of scanning audit events. Retention class
       `care_record`.
     - Migration 0044 fills both tables from the audit trail (each stage of each deletion once, the
       staff kept only when they are staff of the organisation; each flagged entry once).
- **Conflicts.** Entries are append-only, so they never conflict; a correction is a new entry with
  `supersedes_id` and a reason, uploaded after the original because the queue keeps its order.
  Reference data is read only on the phone. Tasks and the conflict review arrive with slice 10 part 2.
- **Screens** (`apps/mobile/src/app/(care)`). Today lists the user's people with their resuscitation
  status and spells out the last successful sync, the changes waiting to upload and any refused
  entries (HZ-002). Every screen about a person starts with the point-of-care header: photo, names,
  date of birth and NHS number, room, allergies, communication needs, the resuscitation status as
  word and icon or "not recorded", and the prescribed IDDSI levels, or "Food and drink levels are
  not on this device. Check with the nurse in charge." when the care profile is not on the device
  (HZ-001, HZ-015, HZ-016). Every form pins a compact identity bar (photo, name, allergies,
  communication needs, resuscitation status) while it scrolls, names the person in its title, and
  shows Save only once the person has loaded (clinical reviews C7 and round 3 M4; rendered in
  tests). A carer
  writes or corrects a note; records fluid intake and output (with a drink level prescribed, the
  level given is required), food (IDDSI level given beside the prescribed one, refused without a
  reason when they differ; with no care profile on the device a level, or a drink recorded with no
  level, needs the carer's confirmation that they checked it with the nurse in charge, HZ-016, C3
  and round 3 M3), repositioning, bowel
  (Bristol scale), weight and vital signs, where NEWS2 is calculated on the device by
  `calculateNews2` from `@harbour/domain` on the SpO2 scale the person's profile sets and shown with
  the formula, the published bands, the workings, the RCP chart 4 clinical response and a link to the
  source as they type; with no SpO2 scale on the device no total is shown and the server scores the
  readings on upload (C6). "When" is now, a time on a day the carer chooses within the window (today
  unless they choose another), or for a correction the original entry's instant, kept exactly,
  which is the default (C4). A typed time goes through `resolveRecordedUkTime` (clinical review
  round 3, H1): a time later than now beyond the tolerance is refused and never moved to yesterday,
  so 23:45 typed at 00:30 is refused unless the carer chooses yesterday; on the spring clock change
  a time that did not happen is refused; in the repeated autumn hour, once both have passed, the
  carer chooses "BST, before the clocks went back" or "GMT, after", with no default; and on a
  clock-change day times show BST or GMT. A
  body map mark is placed by tapping the drawing, read against the body's midline with a narrow
  centre band over the head and trunk only, and the side chosen in words must agree (HZ-019, C5).
  The carer reads the care plan summary and current risk assessments with the latest validated-tool
  results. Lists show each entry's state in words (waiting to upload, saved, late entry, device
  clock wrong), and a chart says how many days the device keeps even when it has no entries (C9).
- **Not yet on the device**: tasks, rounds and handover; writing assessments, activities and visits
  (the upload path takes activities and visits already); photos; incidents; the conflict review.
  Body-map marks and chart history older than the window are not on the device (HZ-028).
- **The round and the handover: streams (slice 10 part 2, first PR).** Six tables sync read-only,
  scoped as the API's views are (HZ-011; `packages/sync/test/task-handover-streams.test.ts`).
  `*_open_tasks` carry the open (`open`, `in_progress`) tasks due on a day of the offline window
  (the UTC day of `due_at`), as the round view shows them (`care.plan.read`, the care claims):
  about the people in that scope (at a location, only people active, on leave or in hospital),
  about nobody at the locations it reaches whole, and about nobody and given to the user. This
  replaces "today and tomorrow" in the table above: unfinished tasks from earlier rounds in the
  window stay on the round; one due before the window is on the web round and in the handover
  (HZ-028, H-301). A task done, skipped or cancelled leaves the device; `details` and
  `status_reason` are not sent; the title is free text (3 to 120 characters) as the round view
  shows it. `*_handovers` carry the handovers compiled for shifts ending on a day of the window,
  with their items, notes and acknowledgements, as the handover views show them
  (`care.handover.manage`, new token claims `handover_location_ids` and `handover_assigned`).
  A shift nobody has compiled yet has no handover on the phone, and an empty `locked_at` means
  not final; `refreshed_at` is not sent (the API shows it to whole readers only, and one synced
  row cannot differ by reader). Whole at the locations the permission reaches; otherwise only the
  handovers the user may open (where one of their assigned people lives, as
  `app.handover_location_visible`), and in them only the items and notes about those people and
  the notes on the whole handover, never an item about nobody or a note on one. A user with both
  also gets, in the handovers they see whole, the items and notes about their assigned people who
  have since moved elsewhere, as the API shows them. Each user gets their own acknowledgements
  with item keys (`handover_acknowledgement`); a whole reader also gets who acknowledged and when
  (`handover_staff_acknowledgement`), never another member's item keys, which name people and
  what happened to them (#33 review round 1, M1, L1 and L3). Items and notes about a person carry
  no status filter, as row-level security has none (a death in the shift reaches the incoming
  staff, HZ-018). `handover_item.key` arrives as `item_key`. The tables must join the `powersync`
  publication, with the sync role's read policy and grant, before anything arrives (migration
  0052, sequenced after #32). Still to do: completing or skipping a task and acknowledging a
  handover offline (queued against `POST /v1/tasks/{id}/transition` with the version seen, and
  `POST /v1/locations/{id}/handovers/{handoverId}/acknowledgements` with a device id and the seen
  token worked out over the items shown), then the round and handover screens.
- **Screens gate (#33 review round 1, clinical M2 and M3).** The round and handover screens on the
  phone do not ship until: (a) each handover item carries a worded summary, or its source
  (incidents, alerts, skipped-task reasons) is on the device (STATUS item 4; H-300); (b) the
  "From an earlier plan" notice reaches the phone, through the plan action reference or a
  computed flag (HZ-024; H-303); (c) the publication migration has landed; and (d) an empty list
  never reads as "nothing due" or "nothing to hand over" while the streams have no data (the
  screen says what the phone holds, from when, and that it may be incomplete; HZ-028).
- **API follow-ups**: the revocation signal, the manager hand-over and the server copy of refused
  entries are built (Device integrity, above), and so, with the care API follow-ups, are keeping an
  IDDSI entry from a device with a flag and an alert to the nurse in charge instead of refusing it
  (C3; rule 6), the server's own reading of the body-map side from the place drawn (rule 7; the
  phone sends the point tapped or the zone chosen), the coded reasons, replay index and flag on
  entries (Device integrity, part 8). Still to do: a stale-device check, now possible from
  `device_binding` (H-141); the phone offering the organisation's own coded reasons (H-164); the
  web screens for devices, refused-entry copies and flagged-entry details, and the settings screens
  for escalation policy links and coded reasons
  (slice 9).

## 7. Clinical safety

Hazards touched: HZ-001 (header on every screen), HZ-002 and HZ-006 (stale data and sync state on
every list), HZ-007 (allergies), HZ-008 (task and alert volume), HZ-010 (device and server time),
HZ-012 (validated tools), and the Phase 1 hazards added with this spec: HZ-014 (deterioration or
screening trigger not acted on), HZ-015 (resuscitation decision not visible), HZ-016 (IDDSI level),
HZ-017 (late entries), HZ-018 (handover omissions), HZ-019 (body-map side) and HZ-020 (DoLS
lapses), and, with the consent and capacity rules, HZ-026 (restrictive or covert care under consent
or authority that is not valid), and with offline Care mode HZ-028 (the history on a device mistaken
for the complete record) and HZ-040 (held entries deleted to get past the lockout). Slice 5 adds
controls to HZ-018 (the stored handover, its database guard, notes, acknowledgements over each
reader's scope and late additions), HZ-024 (rounds follow only the active plan's actions, and a new
version changes only the rounds it changed), HZ-003 (no rounds from the medicines domain; a plan
change takes the pause code off the old schedule's rounds), HZ-004 (round windows never overlap;
an unchanged action's rounds are carried forward rather than made again), HZ-008 (late additions
interrupt only for what cannot wait, and only people who can see them) and HZ-001 (every stop on
the round carries the point-of-care header). The care API follow-ups add controls to HZ-012 and
HZ-014 (every validated result links the organisation's own escalation policy, or says none is
configured), HZ-016 (the drink level required on the server; an entry from a device kept with a
flag and an alert rather than lost), HZ-019 (the side worked out on the server from the place
drawn), HZ-029 (client ids on the remaining care create routes and the `Idempotency-Key` header)
and HZ-040 (coded reasons per organisation, the replay index and the flag on entries).
Medical-device boundary: tools are calculated exactly as published and show the published
responses; no prediction or tenant-authored scoring; the escalation policy is the organisation's
own document, linked, never a Harbour recommendation (see
[medical-device-boundary.md](../compliance/medical-device-boundary.md)).

## 8. Data protection

Special category health data under Article 9(2)(h), the tenant as controller and Thapsus as
processor; retention class `care_record` ([retention.md](retention.md)). Photos of wounds and
skin are documents with their own access audit. Nothing here is shared outside the tenant except
through recorded sharing decisions ([people.md](people.md)).

## 9. Acceptance criteria and tests (written before code)

- Domain: `packages/domain/src/care/*.test.ts` table-driven tests for every rule above, NEWS2, MUST,
  Waterlow and Braden against the published worked examples, late entries, chart rules. Built in
  slice 6: `packages/domain/src/care/mca/consent.test.ts` (consent authority by representative
  type, validity over time; HZ-026), `capacity.test.ts` (capacity and best-interests completeness,
  the IMCA prompt; HZ-026) and `dols.test.ts` (Schedule A1 limits, status, expiry reminders, the
  CQC outcome notification and the legal-change review; HZ-020).
- Database: RLS coverage and HZ-011 isolation for every new table; append-only grants; supersedes
  chains.
- API: contract tests and audit events for every route; idempotent replays of offline writes.
  Built in slice 6: `packages/db/test/mca-and-incidents.test.ts` (HZ-011 person scope,
  append-only assessments, the consent and DoLS constraints) and `apps/api/test/mca.test.ts`
  (HZ-020, HZ-026).
- Built in slice 5: `packages/domain/src/care/plan-tasks.test.ts` (which series a plan needs,
  carried forward or ended; windows from real instants that never meet and are never nothing,
  table-driven over the 2026 and 2027 clock changes; merged and refused times; the earlier-plan and
  not-a-round notices; no medicines rounds; HZ-024, HZ-004, HZ-003), the slice 5 cases in
  `handover.test.ts` (the shift a handover is locked after, in 2026 and 2027; alerts as one item;
  each reader's acknowledgement by keys; the incoming shift's acknowledgement and the alert; the
  `handover` tag; notes; who hears of a late addition and how loudly; HZ-018, HZ-008),
  `packages/db/test/handover.test.ts` (HZ-011 location and person scope of items, notes and
  acknowledgements; system-only writes; items only added to; append-only items, notes and
  acknowledgements; one live series per action; the alert person and location and their
  backfill) and `apps/api/test/rounds-and-handover.test.ts` (HZ-024, HZ-004, HZ-003, HZ-008,
  HZ-001, HZ-011 and HZ-018 through the routes and the worker jobs).
- Web and mobile: Playwright journeys (care plan, notes, charts, body map, assessments, handover,
  capacity and DoLS) with axe; Maestro offline journey (notes and charts written offline, synced,
  conflict reviewed). Built in slice 10 part 1: `packages/sync/test/care-streams.test.ts` and
  `window.test.ts` (stream isolation, the window and never-evicted reference data; HZ-011, HZ-002),
  `apps/mobile/src/sync/*.test.ts` (UUIDv7, the upload mapping checked against the API's own
  schemas, the connector's headers, retries and refusals; HZ-006, HZ-010, HZ-017),
  `apps/mobile/src/care/*.test.ts` (notes, charts, IDDSI, NEWS2 on the device, body map sides,
  the header's resuscitation status, Today's sync summary, the local SQL; HZ-001, HZ-002, HZ-015,
  HZ-016, HZ-017, HZ-019), and the Maestro flow
  `apps/mobile/.maestro/hazard-HZ-006-offline-note-and-vitals.yaml` (a note and vital signs written
  offline survive a restart and upload when the network returns; the conflict review is part 2).
- Device integrity (section 6), tests written before the code:
  `packages/db/test/device-integrity.test.ts` (HZ-011 isolation of `device_binding`,
  `device_discard_entry`, `refused_entry`, `request_quota`, `device_session` and
  `handed_over_entry` across organisations and scopes, location roles narrowed to their staff;
  system-only writes; append-only deletion lists and copies; the backfills of 0030 and 0033 from
  the audit trail; the open-task index refusing a second device-hold, flagged-entry or refused-entry
  review task and allowing one after the first closes; 0034 closing duplicates; 0031 and 0038
  giving existing role copies their permissions once, audited); `apps/api/test/device-integrity.test.ts`
  (part 1: binding at each token and report, the bound owner, the first-seen floor from the table;
  part 2: listing and revoking by location, step-up, `device_revoked` on the token, uploads and
  care entries, a hand-over still taken, the sessions kept and each refused but for its report,
  which never closes the task, the confirmation of entries waiting, a replay hurrying again, refused
  entries with no copy counted as waiting; part 3: the flag from `device_discard_entry`; part 4: one
  task per source under racing raises, details on flagged tasks; part 5: the copy, its review task,
  its scope, the author's care of the person, replays, limits and pages; part 6: the hand-over
  rules, each refusal of #25 review round 2 H1 by name, and round 3's count basis, clock
  tolerance, back-dated entries, care judged from the entry's time and admission in the entry's
  transaction; part 7: quotas shared by two app
  instances); `apps/api/test/rate-limit.test.ts` (the sliding window);
  `apps/mobile/src/sync/connector.test.ts` (a `device_revoked` refusal), `app-state/held-work.test.ts` (wiping or holding a revoked device,
  a revoked hold refusing the owner's resume), `app-state/handover.test.ts` (the hand-over) and
  `sync/refused-copies.test.ts` (sending each refusal's copy, and again until the server has it).
- Care API follow-ups, tests written before the code: `packages/domain/src/care/iddsi.test.ts`
  (HZ-016: a drink without its level when one is prescribed; kept and flagged from a device),
  `body-map.test.ts` (HZ-019: the side from the place drawn and the view),
  `escalation-policy.test.ts` (HZ-014 and HZ-012: the order a link is found in, never another
  location's, the bands per tool, the link checks) and `discard-reasons.test.ts` (HZ-040: the
  seeded codes and the code checks); `packages/db/test/care-follow-ups.test.ts` (HZ-011
  isolation and scope of the four new tables, the seeding trigger, one live link per place, the
  replay index, append-only rows written only in the system's view, the drawing check on marks,
  and the backfill from the audit trail); `apps/api/test/care-follow-ups.test.ts` (HZ-016, HZ-019,
  HZ-014 and HZ-012, HZ-040, staff names, HZ-029 through the routes);
  `apps/mobile/src/care/body-map.test.ts` and `sync/care-upload.test.ts` (HZ-019: the point and
  zone sent, and an entry queued before sent as its zone); `apps/web/src/lib/body-map.test.ts`
  (HZ-019: every spot reads as its own side on the shared drawing) and
  `components/care/ObservationList.test.ts` (HZ-016: a kept entry's flag in words). Review round 2
  of #26: `packages/domain/src/platform/access.test.ts` (the places a permission is held),
  `escalation-policy.test.ts` (the onboarding coverage), `body-map.test.ts` (the zone a side
  names), `packages/db/test/care-follow-ups.test.ts` (S1: a merged scope never widens who changes
  links or reasons), `apps/api/test/care-follow-ups.test.ts` (C2 to C5 and S1 through the routes),
  `apps/web` (`EntryBadges.test.ts`, `ObservationList.test.ts`, `charts.test.ts`,
  `chart-entry.test.ts`) and the Playwright journeys for NEWS2 (a configured policy) and MUST (none
  configured), with axe. Review round 3 of #26: `packages/domain/src/care/fluid-balance.test.ts`
  (table-driven: a refused drink adds nothing); `packages/db/test/care-follow-ups.test.ts`
  (table-driven: who holds a permission, from roles and grants in force only: ended, future and
  deleted assignments, archived and mixed roles, expired, revoked and deleted grants);
  `apps/api/test/care-follow-ups.test.ts` (the alert only to someone who can open the record,
  naming the home, with its route kept and the unrouted reason coded; `already_saved_differently`;
  `copyFromActive` compared; refused drinks in the fluid day; the urgency of refused marks
  table-driven; reasons changed and audited by id); `apps/web` (`outcome.test.ts`,
  `charts.test.ts`, `ObservationList.test.ts` with the NEWS2 result after saving) and the NEWS2
  Playwright journey (the policy on the result after saving, and who the alert reached).

## 10. Open questions

- Slice 5 (tasks, rounds and handover):
  - Until rotas say who comes on each shift (Phase 2), the incoming staff are those who
    acknowledge; a handover nobody on the incoming shift has acknowledged is marked, and the nurse
    in charge alerted after the grace period (H-153). Which notes reach the handover beyond the
    fixed tags is for the CSO (H-155). Shift patterns come from the rate table's two shifts per nation
    until rotas define them per location (HZ-018 deployer control).
  - A care plan series keeps the location it was made at; a move to another location in the same
    organisation should move the person's rounds with them (people transfers), not yet done.
  - Handovers, their notes and acknowledgements do not yet sync to devices; the Care mode Today
    screen and offline acknowledgement come with slice 10 part 2 (the contracts already take
    client ids).
  - The handover lists items as references; the web and mobile screens (slices 9 and 10 part 2)
    read each source for its words. A worded summary per item would save a read per item.
  - An entry recorded offline against a round the plan has since cancelled is kept as late
    evidence on the cancelled round (care.md rule 13) while the new schedule's round at the same
    time stays open; the review of such entries is part of the conflict review (slice 10 part 2).

- Waterlow licence and authoritative source (H-25); until confirmed, the tool ships behind a flag
  defaulting off in production tenants, on in the demo tenant.
- Scale 2 SpO2 needs a clinician's record; Phase 1 stores who recorded it and when, Phase 5 links it
  to GP Connect.
- API gaps found building the web screens (slice 9), for the API owners:
  - Closed by the care API follow-ups: staff names (`StaffName` beside every staff id a care
    response returns; the screens still say "recorded by you" or "by a colleague" until they read
    it), the escalation policy link on every validated result (`escalationPolicy`; the phone shows
    it next), the drink IDDSI level on the server (HZ-016), the body-map side worked out on the
    server (HZ-019) and client ids on advance care records, risk assessments, new care plan drafts,
    care plan actions, consents and DoLS (HZ-029). See section 5. The web shows a food or drink
    entry kept from a device with its IDDSI problem in words, every validated result with the
    escalation policy or that none is configured, and the deletion flag on entries and beside the
    fluid total (#26 review round 2); it does not yet show staff names or `drawnFromDeviceSide`
    (slice 9 follow-ups).
  - The NEWS2 flags omit the RCP's chart 4 clinical response lines.
  - Validated tool citations (`VALIDATED_TOOLS`), body map regions, and the low-band MUST wording are
    not served, so the web keeps copies. Only the copies with tests are checked: body map regions
    and the drawn side (`body-map.test.ts`), tool sources and band wording (`assessments.test.ts`)
    and known refusals (`refusals.test.ts`) against `packages/domain`, and assessment answer options
    (`assessment-answers.test.ts`), chart entries (`chart-entry.test.ts`) and risk fields
    (`risk.test.ts`) against `packages/contracts`.
  - Problem details carry `code: "invalid"` and English `detail` text only. The web recognises known
    refusals by the domain rule's message; a rule code and the field it concerns would make this
    robust and translatable.
  - The clock-drift tolerance in `rate_table` is not served to clients, so the web form uses
    `DEFAULT_CLOCK_DRIFT_TOLERANCE_MINUTES` before the API applies the tenant's value.
  - The web sends a kept UUIDv7 wherever a contract takes one, now including advance care
    records, new risk assessments, care plan drafts and care plan actions. Create routes outside
    care still take no client id, so a retried save there can record twice
    (HZ-029), for their owners in `people` and `platform`: admission decisions, bed moves,
    reviews, care plan changes, sharing decisions, About Me share links, tasks and task series,
    exits and document uploads.
  - The NEWS2 total, the RCP's response and the workings are returned on read and shown on saved
    entries; this is not a gap.
  - Risk template titles and questions, and refusal details, come in English only, so a Welsh shell
    would show them in English.
  - A group activity is recorded per person, with a new session id each time; a route that records a
    group session for several people at once is needed to count attendance.
