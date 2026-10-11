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
| `consent_record` | mutable, versioned | person, decision (`CONSENT_DECISION_KINDS`: care plan, photos, social media, sharing, marketing, AI processing, bed rails, covert medicines), outcome (given or refused), given by (person or representative with authority: health and welfare or property and financial LPA with OPG reference and registration, deputy with order scope, decisions and end date, appointee, IMCA, advocate, family or friend), capacity status (assumed, or the capacity assessment), evidence, restraint conditions (bed rails), best-interests decision (covert medicines), expiry, withdrawn at | `care_record` |
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
   - **Shifts** follow the location's pattern in UK local time, to the minute and with two or more
     shifts (default day 08:00 and night 20:00 from `handover.day_shift_start_minute` and
     `handover.night_shift_start_minute`), so a shift over a clock change is an hour shorter or longer.
   - **Items**: falls (incidents, and notes tagged `fall`); NEWS2 in any band above "low", which is an
     aggregate of 5 or more or a single parameter scoring 3 (the RCP's urgent-response trigger), so
     wider than "5 or more"; incidents, with or without a person; urgent alerts raised in the shift
     or still unacknowledged at its end; new body-map marks; tasks overdue at the end of the shift;
     urgent or evidence-bearing tasks skipped or cancelled in it (with the reason); tasks due by the
     end of the shift that are not done though their window is still open; MUST follow-ups raised in
     it; refusals (food or drink refused, repositioning declined, notes tagged `refusal`).
     Medicines refusals join from the eMAR in Phase 2 (HZ-003).
   - **Tags** are a fixed vocabulary (`HANDOVER_NOTE_TAGS`) that the note form offers as choices;
     free-text tags are never matched.
   - **Late syncs**: an entry belongs to the shift it happened in and to the shift that received it;
     the API refreshes both handovers, locked ones included, appending late additions. A late
     addition reaches the incoming staff while their shift runs, otherwise the nurse in charge on
     duty.
   - **Acknowledgement** records how many items the person saw (server time alongside); a late
     addition makes them pending again and shows them only the new items.
   - **Round view** (`rounds.ts`): open tasks due before the round ends (unfinished ones from
     earlier rounds included) and later tasks whose window is already open, by floor, then room in
     natural order, then due time. Each stop shows the point-of-care header (photo, name,
     allergies; HZ-001), and offline views show the last sync time (HZ-002).
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
    property return, medical examiner pack).

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
create those tasks for the manager. Charts and marks are refused for discharged, deceased and
archived people; post-event notes are allowed. Slice 4a refuses them whatever the event time; the
people lifecycle step changes this to [people.md](people.md#4-rules-that-are-easy-to-get-wrong)
rule 3: an entry for an event at or before the exit (for example observations a phone recorded
offline before a death) is accepted and flagged as recorded after the exit (HZ-006).

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
refused. Outbox events `care.plan.published` and `care.assessment.completed` are written.


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
  for managers and nurses, everyone at the token's `people_location_ids`. The tenant and the people
  always come from the signed token; logical replication bypasses row-level security, so
  `packages/sync/test/care-streams.test.ts` proves through the real sync-rules engine that a person
  who is not assigned, an ended assignment, another tenant or a token without a tenant never reaches
  the device (HZ-011).
  - Reference data, never evicted while the person is in scope: `person_care_profile`, the active
    `care_plan` only (no drafts or superseded versions, HZ-024) with the sections and actions of that
    plan, active `risk_assessment` rows, every `assessment` result (summary columns only; the device
    shows the latest per tool, because a stream cannot pick the latest row) and active
    `advance_care_record` rows (HZ-015). Answers, workings and document ids are not sent.
  - Point-of-care entries (`care_note`, `observation`, `body_map_mark`, `activity_record`,
    `visit_log`) sync only for the days in the `offline_days` connection parameter, matched on the
    UTC date of `occurred_at`. The device builds the list (tomorrow, today and the days before it,
    `mobile.offline_window_days` days in all) from the rate table through `GET /v1/rates/{key}`,
    caches the figure for offline starts, keeps today only until it has read the figure once, and
    reconnects when the UTC day changes so the oldest day leaves the device. The parameter can only
    narrow data: a device that sends no window gets no entries, and a longer list still reaches
    nobody outside the token's scope. Entries for one person and day share a bucket across the five
    tables. `observation.values` arrives as `chart_values` (a reserved word in SQLite).
- **Writes** (`apps/mobile/src/care`, `apps/mobile/src/sync`). Every entry gets a UUIDv7 made on the
  device and is inserted, never updated, into its synced table in its own transaction, so it enters
  PowerSync's upload queue in the encrypted database and survives an app restart. The connector
  sends each entry to its own endpoint (`POST /v1/people/{id}/notes`, `/observations`, `/body-map`,
  `/activities`, `/visits`; `POST /v1/sync/upload` writes no care tables) with the id, `deviceTime`
  (the device clock when the entry was written) and the headers `x-harbour-tenant`,
  `x-harbour-device` (the PowerSync client id), `Idempotency-Key` (the entry id) and
  `x-harbour-sent-at` stamped as each request leaves, so the API flags late entries from the time
  written and clock drift from the time sent (HZ-010, HZ-017). A replay returns the saved copy and
  is treated as success. Network failures, 408, 425, 429 and 5xx retry with backoff and stay queued.
  A 401 or 403 from the sync token, an upload or `/v1/me` ends the session, and the device first
  counts its unsent work (PowerSync's upload queue plus `upload_issue` rows; HZ-006,
  `apps/mobile/src/app-state/held-work.ts`). With none it signs out and wipes as before. With some
  it does not wipe: uploads stop, the encrypted database and its key are kept (SQLCipher, key
  behind device authentication), the owner's `tenant_user` id is recorded and the sign-in screen
  reads "Sign in again to send N entries". Only that member of staff can resume, and the queue
  drains under the new session; anyone else is refused ("Entries from another member of staff are
  waiting. They need to sign in to send them.") and their new session is ended. "Sign out and
  delete N unsent entries", after a confirmation naming the count, deletes the file and destroys
  the key. This is because a session lasts 12 hours while a device may work offline for the whole
  window, and the API answers an expired session with the same 401 as a revoked one; until it
  signals revocation separately (follow-up: an API revocation signal distinct from expiry), a
  revoked device that still holds unsent entries keeps them encrypted rather than wiping them
  (human action H-68). Any other refusal moves the entry, with its content, to the local-only
  `upload_issue` table and the queue moves on: Today and the person's record list it as "not saved:
  needs attention" with the API's reason until someone removes it (HZ-006). The same applies to a
  `rejected` operation inside a 200 from `/v1/sync/upload`, which used to be completed silently.
- **Conflicts.** Entries are append-only, so they never conflict; a correction is a new entry with
  `supersedes_id` and a reason, uploaded after the original because the queue keeps its order.
  Reference data is read only on the phone. Tasks and the conflict review arrive with slice 10 part 2.
- **Screens** (`apps/mobile/src/app/(care)`). Today lists the user's people with their resuscitation
  status and spells out the last successful sync, the changes waiting to upload and any refused
  entries (HZ-002). Every screen about a person starts with the point-of-care header: photo, names,
  date of birth and NHS number, room, allergies, communication needs, the resuscitation status as
  word and icon or "not recorded", and the prescribed IDDSI levels (HZ-001, HZ-015, HZ-016). A carer
  writes or corrects a note; records fluid intake and output, food (IDDSI level given beside the
  prescribed one, refused without a reason when they differ, HZ-016), repositioning, bowel (Bristol
  scale), weight and vital signs, where NEWS2 is calculated on the device by `calculateNews2` from
  `@harbour/domain` on the SpO2 scale the person's profile sets and shown with the published response
  and workings as they type; adds a body map mark by tapping the drawing and choosing the side in
  words, which must agree (HZ-019); and reads the care plan summary and current risk assessments with
  the latest validated-tool results. Lists show each entry's state in words (waiting to upload, saved,
  late entry, device clock wrong).
- **Not yet on the device**: tasks, rounds and handover; writing assessments, activities and visits
  (the upload path takes activities and visits already); photos; incidents; the conflict review.
  Body-map marks and chart history older than the window are not on the device (HZ-028).

## 7. Clinical safety

Hazards touched: HZ-001 (header on every screen), HZ-002 and HZ-006 (stale data and sync state on
every list), HZ-007 (allergies), HZ-008 (task and alert volume), HZ-010 (device and server time),
HZ-012 (validated tools), and the Phase 1 hazards added with this spec: HZ-014 (deterioration or
screening trigger not acted on), HZ-015 (resuscitation decision not visible), HZ-016 (IDDSI level),
HZ-017 (late entries), HZ-018 (handover omissions), HZ-019 (body-map side) and HZ-020 (DoLS
lapses), and, with the consent and capacity rules, HZ-026 (restrictive or covert care under consent
or authority that is not valid), and with offline Care mode HZ-028 (the history on a device mistaken
for the complete record). Medical-device boundary: tools are calculated exactly as published and show the published
responses; no prediction or tenant-authored scoring (see
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

## 10. Open questions

- Waterlow licence and authoritative source (H-25); until confirmed, the tool ships behind a flag
  defaulting off in production tenants, on in the demo tenant.
- Scale 2 SpO2 needs a clinician's record; Phase 1 stores who recorded it and when, Phase 5 links it
  to GP Connect.
