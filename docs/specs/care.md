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
| `care_plan` | mutable, versioned | person, status (`draft`, `active`, `superseded`), `review_due_on`, `signed_off_by_person` (person, representative or `unable` with reason), `signed_off_at`, `published_version` | `care_record` |
| `care_plan_section` | mutable | plan, domain (one of the 16 PCSP domains), need, outcome in the person's words, strengths, contingency | `care_record` |
| `care_plan_action` | mutable | section, action, who (role), when (recurrence rule in the person's location time zone), task generation flag, linked risk assessment | `care_record` |
| `risk_assessment` | mutable, versioned | person, template key, hazard, who is at risk, likelihood, severity, controls, residual risk, positive-risk statement, review date | `care_record` |
| `assessment` | append-only | person, tool key and tool version, answers, score, band, workings (the calculation shown), triggers raised, assessor, `next_due_on` | `care_record` |
| `care_note` | append-only | person, category, text, tags, `occurred_at`, `device_time`, `recorded_at` (server), `device_id`, `late_entry` (derived), attachments, `supersedes_id` | `care_record` |
| `observation` | append-only | person, chart type, values (typed per chart), units, method, `occurred_at`, `device_time`, `recorded_at`, flags (for example NEWS2 component scores), `supersedes_id` | `care_record` |
| `body_map_mark` | append-only | person, view (`front`, `back`), region code, side (`left`, `right`, `midline`) stated separately from the drawing, mark type, pressure-ulcer category, size, photo document, linked incident or safeguarding concern, `supersedes_id` | `care_record` |
| `care_task` | mutable | person, source (action, chart rule, assessment trigger, manual), due window, status, completed by, evidence (note or observation id), escalation state | `care_record` |
| `handover` | mutable then locked | location, shift window, compiled items (references), free-text additions, acknowledged by and at | `care_record` |
| `activity_record` | append-only | person or group, activity, attendance, engagement rating, notes | `care_record` |
| `visit_log` | append-only | person, visitor (contact or free text), kind (Reg 9A: facilitated visit, visit out, accompaniment), times, restrictions applied and why | `care_record` |
| `advance_care_record` | mutable, versioned | person, kind (`respect`, `dnacpr`, `adrt`, `advance_care_plan`), clinician name and role, date completed, review date, document, status | `care_record` |
| `consent_record` | mutable, versioned | person, decision (care plan, photos, sharing, AI processing, bed rails, covert medicines), given by (person or representative with authority), capacity status, evidence, expiry, withdrawn at | `care_record` |
| `capacity_assessment` | append-only | person, decision, time specific, stage 1 (impairment or disturbance), stage 2 (understand, retain, use or weigh, communicate), practicable steps taken, outcome, assessor, review date | `care_record` |
| `best_interests_decision` | append-only | capacity assessment, section 4 checklist answers, people consulted, less restrictive options considered, decision, review date | `care_record` |
| `dols_authorisation` | mutable, versioned | person, type (`urgent`, `standard`, `court_order`), request date, granted from and to, extension, conditions, RPR, supervisory body, outcome, CQC notification link, objection evidence, legal-change review status | `care_record` |

New personal data fields are added to `docs/compliance/records-of-processing.md` and mapped in
`data-standards.md` (PRSB PCSP sections, SNOMED CT for chart concepts where a code exists) in the
same pull request as the table.

## 3. Permissions

From the catalogue in `packages/domain/src/platform/roles.ts` (matrix: [permissions.md](permissions.md)):
`care.plan.read`, `care.plan.write`, `care.note.read`, `care.note.write`, `care.assessment.write`,
`care.handover.manage`, `care.capacity.write`, `care.dols.manage`, `care.respect.record`. Scope
follows the person (tenant, location, assigned or break-glass). Care workers write notes, charts,
body-map marks and tasks for assigned people; nurses and seniors also complete assessments and
publish care plans; capacity assessments and DoLS need the senior or manager roles. Every read of
a person's care record is audited; writes are audited with the record id, never the content.

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
6. **Charts.** Fluid balance keeps a daily target per person and a running total from 00:00 in the
   location's time zone, with the shortfall visible by mid-afternoon; food intake records the IDDSI
   level (0 to 7) and shows the person's prescribed level beside it, refusing a mismatched level
   without an override reason; repositioning intervals default to
   `repositioning.interval_hours.at_risk` or `repositioning.interval_hours.high_risk` hours from the
   person's skin risk and raise overdue tasks; bowel uses the Bristol scale 1 to 7 with "no bowel
   movement" counted for the 3-day prompt; weight every `weight.default_interval_months` months, or
   every `weight.at_risk_interval_weeks` weeks when MUST is medium or high.
7. **Body maps.** Side is chosen in words (left, right, midline) as well as on the drawing, and the
   two must agree before saving. Pressure ulcers use the NPIAP and NHS England categories 1 to 4,
   unstageable, deep tissue injury, with device-related and moisture-associated damage recorded
   separately. A category 2 or worse, or any unexplained bruise, prompts an incident and the
   safeguarding decision guide (see [safety.md](safety.md)).
8. **Handover.** Compiled from the shift's late tasks, NEWS2 of 5 or more, incidents, new body-map
   marks, refusals, falls, and alerts; nothing safety-critical can be removed, only added to. Each
   incoming member of staff acknowledges it. As built (`packages/domain/src/care/handover.ts`):
   shifts start at `handover.day_shift_start_hour` and `handover.night_shift_start_hour` in UK local
   time, so a night shift over a clock change is 11 or 13 hours; an entry belongs to the shift it
   happened in and to the shift that received it late; NEWS2 is included for any band above "low",
   which also covers a single parameter scoring 3 (the RCP's urgent-response trigger), not only an
   aggregate of 5 or more; tasks still overdue at the end of the shift and MUST follow-ups raised
   in it are included; falls and refusals also come from notes tagged `fall` or `refusal`. Items
   that sync after compilation are appended as late additions, and an acknowledgement made before
   one no longer counts. The round view (`rounds.ts`) groups the shift's tasks by floor, then room
   in natural order, then due time, and keeps unfinished tasks from before the round on it.
9. **Capacity.** Assume capacity; a capacity assessment is decision-specific and time-specific, and
   records the practicable steps taken to support the person to decide. An outcome of "lacks
   capacity" is accepted only when stage 1 is met and at least one stage 2 element is not.
10. **Best interests.** The section 4 checklist is complete only when every item is answered
    (including "not applicable" with a reason) and at least one consultation is recorded or its
    absence explained; an IMCA prompt appears when nobody appropriate can be consulted for serious
    medical treatment or a change of accommodation.
11. **DoLS.** An urgent authorisation lasts `dols.urgent.days` days with one extension of
    `dols.urgent.extension_days` days; a standard authorisation lasts at most
    `dols.standard.max_months` months. Expiry tasks fire 28 days and 7 days before the end (tenant
    configurable). When the outcome is known, the CQC notification draft is created in
    [safety](safety.md). The legal-change switch (Supreme Court, 2 June 2026; DHSC interim guidance
    updated 22 September 2026) is a tenant setting that turns on the review-of-existing-authorisations
    workflow (multifactorial test, decision, date, local authority referral) and shows the current
    guidance link; England and Wales only.
12. **Deceased or discharged people** are read-only except for post-event records (after-death care,
    property return, medical examiner pack).

## 5. API and events

Built in slice 4a: `POST` and `GET /v1/people/{id}/notes`, `/observations` (typed values per chart;
vital signs scored with NEWS2 using the recorded SpO2 scale; food and drink checked against the IDDSI
levels), `GET /v1/people/{id}/charts/fluid?date=`, `POST` and `GET /v1/people/{id}/body-map`,
`GET` and `PUT /v1/people/{id}/care-profile`. Any entry may name the `taskId` it answers (for example
the 02:00 turn), which completes that task with the entry as evidence. A NEWS2 response band alerts
the nurse in charge and creates the response and repeat-observation tasks; a score of 0 schedules
nothing outside the care plan (HZ-008). Body marks that prompt an incident or the safeguarding guide
create those tasks for the manager. Charts and marks are refused for discharged, deceased and
archived people; post-event notes are allowed.


Resources under `/v1/people/{personId}/...`: `care-plans`, `risk-assessments`, `assessments`,
`notes`, `observations`, `body-map`, `tasks`, `activities`, `visits`, `advance-care`, `consents`,
`capacity-assessments`, `best-interests`, `dols`; location views `/v1/locations/{id}/round`,
`/v1/locations/{id}/handovers`. Writes of append-only events accept a client UUID and are
idempotent. Outbox events: `care.note.recorded`, `care.observation.recorded`,
`care.assessment.completed`, `care.task.overdue`, `care.dols.expiring`, `care.dols.outcome_known`.

## 6. Offline behaviour (section 17.1)

| Data | On the device | Writes offline | Conflict handling |
| --- | --- | --- | --- |
| Care plan summary, risk assessments, advance care records, consents, DoLS status | Assigned people, never evicted while assigned | No (read only on the phone in Phase 1) | Not applicable |
| Notes, observations, body-map marks, activities, visits | Last `mobile.offline_window_days` days for assigned people | Yes, queued and idempotent | Append-only, so no conflict; late and drift flags computed on upload |
| Tasks | Today and tomorrow for assigned people | Complete or skip with reason | Last writer wins on status, both actions kept in history; a task completed on two devices shows in the conflict review |
| Assessments | Last result per tool | Yes | Append-only |

## 7. Clinical safety

Hazards touched: HZ-001 (header on every screen), HZ-002 and HZ-006 (stale data and sync state on
every list), HZ-007 (allergies), HZ-008 (task and alert volume), HZ-010 (device and server time),
HZ-012 (validated tools), and the Phase 1 hazards added with this spec: HZ-014 (deterioration or
screening trigger not acted on), HZ-015 (resuscitation decision not visible), HZ-016 (IDDSI level),
HZ-017 (late entries), HZ-018 (handover omissions), HZ-019 (body-map side) and HZ-020 (DoLS
lapses). Medical-device boundary: tools are calculated exactly as published and show the published
responses; no prediction or tenant-authored scoring (see
[medical-device-boundary.md](../compliance/medical-device-boundary.md)).

## 8. Data protection

Special category health data under Article 9(2)(h), the tenant as controller and Thapsus as
processor; retention class `care_record` ([retention.md](retention.md)). Photos of wounds and
skin are documents with their own access audit. Nothing here is shared outside the tenant except
through recorded sharing decisions ([people.md](people.md)).

## 9. Acceptance criteria and tests (written before code)

- Domain: `packages/domain/src/care/*.test.ts` table-driven tests for every rule above, NEWS2, MUST,
  Waterlow and Braden against the published worked examples, late entries, chart rules, capacity
  and best-interests completeness, DoLS clocks.
- Database: RLS coverage and HZ-011 isolation for every new table; append-only grants; supersedes
  chains.
- API: contract tests and audit events for every route; idempotent replays of offline writes.
- Web and mobile: Playwright journeys (care plan, notes, charts, body map, assessments, handover,
  capacity and DoLS) with axe; Maestro offline journey (notes and charts written offline, synced,
  conflict reviewed).

## 10. Open questions

- Waterlow licence and authoritative source (H-25); until confirmed, the tool ships behind a flag
  defaulting off in production tenants, on in the demo tenant.
- Scale 2 SpO2 needs a clinician's record; Phase 1 stores who recorded it and when, Phase 5 links it
  to GP Connect.
