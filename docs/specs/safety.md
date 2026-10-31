# Safety and statutory notifications (`safety`) - specification

Master prompt section 11.1, with sections 5.2 (clinical safety) and 17 (offline capture). Phase 1
builds incident capture, the classifier, deadline clocks, drafts signed with step-up, the candour
workflow, investigations and the falls and pressure-ulcer protocols. Complaints, the safeguarding
log in full, whistleblowing, outbreaks, deaths and disclosure requests complete in Phase 2. Status
per feature: [feature register](feature-register.md).

## 1. Purpose and register rows

Turn an event on the floor into the records and notifications the law expects, on time, without
the person reporting it needing to know the law.

| Phase 1 rows | Phase 2 rows |
| --- | --- |
| SAFE-001 capture; SAFE-002 classifier and clocks; SAFE-003 CQC notifications; SAFE-004 RIDDOR; SAFE-005 s.42 referral drafts; SAFE-007 duty of candour; SAFE-008 medical examiner pack and LeDeR prompt; SAFE-009 falls and pressure-ulcer protocols; SAFE-010 investigations and learning | SAFE-006 safeguarding log; SAFE-011 onwards (complaints, whistleblowing, outbreaks, deaths register, missing person timeline in full, disclosure requests) |

## 2. Schema

Forced RLS and person scope as in [care.md](care.md). An incident involving several people is
visible to a user only for the people in their scope; the incident header (type, time, location)
is visible to anyone who can see one of them. As built
([ADR-0033](../decisions/0033-incident-scope.md)): an incident is visible to tenant-wide roles, to
the person who raised it, to anyone who can see one of the people using the service on it
(`incident.person_ids`, kept in step with `incident_person`), and, only when nobody using the service
is on it, to the people working at its location; a reader who cannot see every person gets it as
`restricted` (the header and their own people, never the narrative, the classifier's reasoning or
the notifications). Staff and visitors on an incident are visible to its location and reporter;
a notification about one person (a death, a DoLS outcome) also needs that person's scope; one about
a location (an outbreak) follows location scope.

| Table | Kind | Key columns | Retention class |
| --- | --- | --- | --- |
| `incident` | mutable, versioned | location, type (section 11.1 list), `occurred_at`, `device_time`, `recorded_at`, severity, harm grade, description, immediate actions, emergency services and GP contact, family informed (who, when), status (`open`, `under_review`, `closed`), raised by, closed by (must differ, separation of duties), classifier version | `serious_incident` where any notification applies, otherwise `care_record` |
| `incident_person` | mutable | incident, person or staff member, role (affected, witness, involved), injury details, body-map marks | as the incident |
| `classifier_answer` | append-only | incident, question key (`CLASSIFIER_QUESTION_KEYS`), answer (`yes`, `no`, `unsure`, a whole number of days or hours, or option values), answered by and at | as the incident |
| `statutory_notification` | mutable, versioned | incident (or person for deaths and DoLS outcomes), kind (`STATUTORY_NOTIFICATION_KINDS`: `cqc_reg16_death`, `cqc_reg18_serious_injury`, `cqc_reg18_abuse`, `cqc_reg18_police`, `cqc_reg18_service_disruption`, `cqc_reg18_dols_outcome`, `riddor_death`, `riddor_specified_injury`, `riddor_non_worker_hospital`, `riddor_over_7_day`, `riddor_dangerous_occurrence`, `safeguarding_s42`, `candour`, `leder`, `ukhsa_outbreak`, `medical_examiner`, `police_missing_person`), `due_at` (computed), provisional (rests on an "unsure" answer), status (`draft`, `ready`, `submitted`, `not_required` with reason), submitted by, submitted at, external reference, evidence document | `serious_incident`, RIDDOR kinds `riddor_report` |
| `candour_record` | mutable, versioned | incident, threshold decision and who made it, verbal notification (who, when, apology given), written notification (date, document), enquiries and results shared, outcome, correspondence documents | `serious_incident` |
| `investigation` | mutable, versioned | incident, lead, method (root-cause template), findings, contributing factors, actions (owner, due, status), lessons, bulletin and read receipts | `serious_incident` |

## 3. Permissions

`safety.incident.report` (every role that works with people, including agency staff, and the
non-care roles), `safety.incident.read` (the roles that work with people and the quality lead; a
care-record permission, so MFA applies), `safety.incident.manage` (nurses and managers),
`safety.notification.submit` (step-up required), `safety.safeguarding.manage`. Submitting a
notification and deciding "not required" both need step-up (ADR-0002, section 4) and are audited
with the reason. **Corrected**: the first draft gave `safety.notification.submit` to the deputy and
the quality lead and `safety.incident.manage` to seniors; master prompt section 4 gives submission
to "the Registered Manager and the Nominated Individual, extendable by a time-boxed acting-up grant"
and the team leader "incident reporting", and the master prompt wins, so the built-in roles follow
it ([permissions.md](permissions.md)).

## 4. Rules that are easy to get wrong

Each rule has a table-driven test named with HZ-013 (statutory notification missed or late).
Time limits come from `rate_table`; "without delay" kinds are due at `occurred_at` and shown as
overdue immediately until submitted. The rules below were checked against the sources on
11 October 2026; corrections to the first draft of this section are marked **Corrected**.

The classifier answers each kind three ways: **required** (a draft with its clock), **not required**
(with the reason, recorded for the audit trail), or **waiting** for a question to be answered. An
"unsure" answer makes the draft **provisional**: its clock shows, and a holder of
`safety.notification.submit` confirms it or marks it not required with a reason and step-up. An
unanswered question raises the task "Answer the notification questions", due when the incident
happened. Phase 1 checks incidents at locations in England; other nations return "not checked"
until their nation pack (Phase 7) and never a partial answer.

1. **CQC Regulation 16** (death of a person using the service): draft for every death, due without
   delay. Regulation 16(1) covers a death "whilst services were being provided" or one "which has,
   or may have, resulted from the carrying on of a regulated activity", so expected and unexpected
   deaths both notify; a death in neither limb (for example in hospital weeks after discharge) is
   marked not required with the reason. The notification "must include a description of the
   circumstances of the death" (16(3)). The medical examiner pack is generated too.
   ([Regulation 16](https://www.legislation.gov.uk/uksi/2009/3112/regulation/16))
2. **CQC Regulation 18** (other incidents), due without delay
   ([Regulation 18](https://www.legislation.gov.uk/uksi/2009/3112/regulation/18)):
   - **Serious injury**, 18(2)(a) and (b), in the regulation's words: any injury which, in the
     reasonable opinion of a health care professional, has resulted in an impairment of the
     sensory, motor or intellectual functions which is not likely to be temporary; changes to the
     structure of the body; prolonged pain or prolonged psychological harm; or the shortening of
     life expectancy; or which requires treatment by a health care professional to prevent death or
     an injury that would lead to one of those outcomes. "Prolonged" and "not temporary" mean a
     continuous period of at least `cqc.reg18.prolonged_harm_days` days (18(5)(g)). **Corrected**:
     the regulation has no list of fractures, dislocations, loss of consciousness or burns; that list
     resembles RIDDOR's specified injuries to workers (RIDDOR 2013 reg 4(1)). A fracture usually
     meets 18(2)(a)(ii) (changes to the structure of the body), which the question asks directly.
   - **Abuse or allegation of abuse**, 18(2)(e). Abuse is defined in 18(5)(b) as sexual abuse;
     physical or psychological ill-treatment; theft, misuse or misappropriation of money or
     property; and neglect and acts of omission which cause harm or place at risk of harm.
     Self-neglect on its own is a Care Act concern (rule 4) but not regulation 18 abuse (human
     action H-63 confirms this reading with CQC).
   - **Police**, 18(2)(f): any incident reported to, or investigated by, the police. CQC's form says
     to use the death, serious injury or abuse form instead when one of those applies, so the
     classifier folds police involvement into that notification.
   - **DoLS outcome**, 18(4A) and (4B): a request to the supervisory body for a standard
     authorisation, or an application to the court, is notified "once the outcome ... is known or,
     if the request or application is withdrawn, at the point of withdrawal", with the date and
     nature of the request, whether an urgent authorisation preceded it, the outcome or reason for
     withdrawal, and its date. An urgent authorisation is not notified on its own. Drafted from the
     DoLS register (`dolsCqcNotification`, [care.md](care.md) rule 11), not from an incident.
   - **Events that stop the service running safely**, 18(2)(g): anything that prevents, or appears
     likely to threaten to prevent, safe running (fire, flood), insufficient staff, and utility,
     fire alarm or safety device failures "longer than a continuous period of"
     `cqc.reg18.interruption_hours` hours.
3. **RIDDOR** asks one question first: did the accident arise out of or in connection with work
   (how the work was carried out, organised or supervised, the plant or substances used, or the
   condition of the premises: RIDDOR reg 2(1) and (2)), rather than the person's own condition?
   Only "yes" (or "unsure", as a provisional draft) continues. Then: a death of any person
   (reg 6(1)), a specified injury to a worker (reg 4(1)), a person not at work taken from the place
   of the accident directly to hospital for treatment (reg 5(a); examinations and tests are not
   treatment), and a dangerous occurrence in Schedule 2 (reg 7, for example a hoist collapsing)
   are notified to the enforcing authority without delay, and the report must be received within
   `riddor.report_days` days (Schedule 1 para 1(1); reporting online does both). **Corrected**: the
   without-delay notification applies to non-workers taken to hospital too, not only to deaths and
   specified injuries ([HSE](https://www.hse.gov.uk/riddor/when-do-i-report.htm)). A worker
   incapacitated for more than `riddor.over_7_day.threshold_days` consecutive days, not counting the
   day of the accident but counting weekends and rest days, is reported within
   `riddor.over_7_day.report_days` days (reg 4(2)); until that is known a task checks on the day
   after the threshold passes. Not reportable, with the reasoning recorded (HSE information sheet
   [HSIS1](https://www.hse.gov.uk/pubns/hsis1.pdf)): falls caused by the person's own condition with
   no failing in premises, equipment or the way work was done; suicide and deliberate self-harm
   (not accidents); physical violence to a person not at work (reg 2(1) counts violence only to a
   person at work); injuries from an operation, examination or treatment by or under the
   supervision of a doctor or dentist. A worker hurt while helping someone who self-harmed has had
   an accident at work.
4. **Safeguarding (Care Act s.42)**: abuse or neglect of any of the ten types in the Care and
   support statutory guidance (14.17: physical, domestic, sexual, psychological, financial or
   material, modern slavery, discriminatory, organisational, neglect and acts of omission,
   self-neglect) produces a concern draft to the local authority, due without delay (the s.42 duty
   is the local authority's; the time is Harbour's, so the draft says so), and, where abuse is
   alleged, the Reg 18 notification. Pressure ulcers: **Corrected**: the DHSC 2018 protocol was
   withdrawn on 26 June 2023; the current one is
   [Pressure ulcers: how to safeguard adults](https://www.gov.uk/government/publications/pressure-ulcers-how-to-safeguard-adults)
   (January 2024, updated June 2025). Its adult safeguarding decision guide is completed
   "immediately or within 48 hours" (`pressure_ulcer.decision_guide_hours`) where severe damage is
   suspected, which "may be indicated in some cases by multiple category 2 or single category 3 or
   4 ulcers, but could also be indicated by the impact the pressure damage has on the person
   affected (for example, pain)". Harbour runs it for category 3, 4, unstageable, deep tissue
   injury, more than one category 2, or a single category 2 with a concern of abuse or neglect or a
   severe impact (unstageable and deep tissue injury are Harbour's reading, for the CSO, H-66).
5. **Duty of candour (Regulation 20)**: **Corrected**: an adult social care provider is "any other
   registered person", so the notifiable safety incident is defined by
   [regulation 20(9)](https://www.legislation.gov.uk/uksi/2014/2936/regulation/20), not 20(8)
   ("severe harm, moderate harm" and "could result in" apply only to health service bodies). It is
   an unintended or unexpected incident that, in the reasonable opinion of a health care
   professional, appears to have resulted in a death relating directly to the incident; an
   impairment lasting, or likely to last, at least `candour.prolonged_harm_days` days; changes to
   the structure of the body; prolonged pain or prolonged psychological harm (the same number of
   days, 20(7)); or the shortening of life expectancy; or that requires treatment by a health care
   professional to prevent death or such an injury. Verbal notification in person with an apology
   as soon as reasonably practicable (20(2) and (3)); written notification within
   `candour.written_notification.working_days` working days as a tenant target from the threshold
   decision (ADR-0021, marked to verify, never "statutory deadline"); 20(5) where the person cannot
   be contacted or declines; copies of all correspondence (20(6)). The candour record's threshold
   decision wins over the classifier's answers.
6. **LeDeR**: the death of an adult (18 or over) with a learning disability or an autistic adult
   prompts a LeDeR notification with the reporting link ([leder.nhs.uk/report](https://leder.nhs.uk/report),
   "Anyone can use this online form"); a child's death goes to Child Death Review instead.
7. **UKHSA outbreak**: `outbreak.ari_cases` or more people with acute respiratory infection whose
   symptoms "started within `outbreak.ari_window_days` days of each other" (read as onset dates at
   most that many UK calendar days apart), counting only cases that "could be linked by spread
   within your setting" ("If in doubt, report as an outbreak"); a single confirmed case of flu
   (`outbreak.flu_confirmed_cases`); or `outbreak.diarrhoea_vomiting_cases` or more linked
   diarrhoea and vomiting cases (linkage is a staff decision; unreviewed cases raise a review task;
   no national time window was found, H-65). Computed across the location's incidents and
   observations (`detectOutbreaks`); the clock starts when the threshold was reached.
   ([UKHSA](https://www.gov.uk/guidance/report-an-outbreak-of-acute-respiratory-infection-in-an-adult-social-care-setting))
8. **Medical examiner**: every death generates the information pack (`MEDICAL_EXAMINER_PACK_SECTIONS`:
   demographics, diagnoses, recent notes, recent observations, medicines, advance care records,
   circumstances and who was present). Since 9 September 2024 every death in England and Wales is
   scrutinised by a medical examiner or investigated by a coroner
   ([DHSC](https://www.gov.uk/government/publications/changes-to-the-death-certification-process/an-overview-of-the-death-certification-reforms)).
9. **Missing person**: Herbert Protocol profile pre-filled from the record (photo, description,
   places, routines), police reference, search log, return welfare check. CQC: reporting the person
   missing to the police makes it a Reg 18(2)(f) notification, so it applies to every missing
   person reported to the police, not only those subject to DoLS or the Mental Health Act; for a
   person subject to either, the classifier drafts it even before the police answer is recorded
   (master prompt 11.1). Regulation 17 (unauthorised absence) applies only to services with a low,
   medium or high security designation
   ([CQC](https://www.cqc.org.uk/guidance-regulation/registration/unauthorised-absence-notification-form)).
10. **Clocks**: every draft shows its due time and is listed on the manager dashboard; overdue
    drafts escalate through the notification centre's escalation chain until submitted or marked
    not required with a reason. Without-delay kinds that the law does not time (s.42 concern,
    LeDeR, medical examiner pack, Herbert Protocol, UKHSA report) say that Harbour set the time.
    Day clocks keep the UK wall-clock time across clock changes; working-day clocks skip the
    nation's bank holidays.
11. **Separation of duties**: the person who raised an incident cannot close it, and an incident
    cannot close while a notification is a draft or ready, a classifier question is open, the
    candour record is open, the duty of candour may apply (Harbour found it, or the decision says
    notifiable) and no candour record has finished, or any person we support affected has no
    finished candour record of their own: one record covers only the person it names, whatever it
    decides (`incidentCloseProblems`, `candourCloseBlock`; #120 review H1 and H2, round 2 M1 and
    M2). A finished record keeps its decision until it is reopened with a reason, which blocks
    closing again; a closed incident's record never changes (round 3 H1). An incident the duty of
    candour holds open longer than `candour.close_blocked_days` days after it happened gives its
    Registered Manager an urgent task, told to Registered Managers and then owners who manage
    incidents, every day until it is resolved (round 2 M4, round 3 M2).
12. **Falls protocol**: a fall creates the post-fall checklist (injury check, observations, GP
    contact, the NG249 falls pathway, bone health) as tasks. Head injury, or current anticoagulant
    or antiplatelet treatment other than aspirin alone (NICE NG232 1.2.4), or either not yet ruled
    out, prompts urgent medical advice under the tenant's post-fall policy and replaces general
    monitoring for `falls.monitoring_hours` hours with timed observations
    (`falls.head_injury_obs.*`, defaults from NG232 1.9.11, which NICE wrote for people admitted to
    hospital; to verify by the CSO, H-66). Hazard HZ-027.

### Domain modules (slice 7)

`packages/domain/src/safety/`, exported from `@harbour/domain`; pure functions with no I/O:

| Module | Main exports | For |
| --- | --- | --- |
| `classifier.ts` | `classifyIncident(input)`, `CLASSIFIER_VERSION` | Outputs with `dueAt`, deadlines, reasons, sources and provisional flag; exclusions; pending kinds; tasks; open questions |
| `questions.ts` | `CLASSIFIER_QUESTION_KEYS`, `CLASSIFIER_QUESTIONS`, `classifierAnswerProblem` | The stored question keys, their wording, options and sources, and answer validation |
| `incident.ts` | `INCIDENT_TYPES`, `IncidentFacts`, `INCIDENT_WORKFLOW`, `incidentCloseProblems` | Classifier facts, the incident workflow and close checks |
| `notifications.ts` | `STATUTORY_NOTIFICATION_KINDS`, `NOTIFICATION_KINDS`, `STATUTORY_NOTIFICATION_WORKFLOW`, `submissionEvidenceProblems`, `notificationClockState` | Kinds, recipients, clocks, retention class; draft, ready, submitted, not required |
| `candour.ts` | `CANDOUR_WORKFLOW`, `candourStepProblems`, `candourClocks` | Regulation 20 steps and the ADR-0021 target |
| `outbreak.ts` | `detectOutbreaks` | UKHSA thresholds over a location's cases |
| `post-fall.ts` | `postFallChecklist` | Post-fall tasks and observation times |
| `medical-examiner.ts` | `MEDICAL_EXAMINER_PACK_SECTIONS`, `missingPackSections` | Pack sections |
| `rates.ts` | `SAFETY_RATE_KEYS`, `resolveSafetyRates` | Every safety figure from `rate_table` |

### Phase 2 rules (plan slice 7: SAFE-006, SAFE-011, SAFE-012, SAFE-014, SAFE-015, SAFE-016, MEDS-012)

New files under `packages/domain/src/safety/` (lane D adds files, never edits the Phase 1 ones),
pure functions with table-driven tests. Tenant targets that no law sets are rate-table rows marked
to verify, shown as targets, never as statutory deadlines. Figures come through
`resolveSafetyPhase2Rates` (`phase2-rates.ts`).

1. **Safeguarding log** (`safeguarding.ts`; Care Act 2014 s.42; SAFE-006). A concern moves through
   `concern`, then either `no_referral` (a reason and who decided, never silently) or `referred`
   (the local authority, how and when, its reference), then `enquiry` (the local authority's s.42
   enquiry, or the provider's caused enquiry), then `outcome` (the enquiry's finding), then `closed`.
   The referral target is `safeguarding.referral_hours` after the concern is raised (a tenant
   target: the law says without delay). Closing needs the Making Safeguarding Personal record: what
   the person (or their advocate) wanted, and whether it was achieved fully, partly or not, or why
   they were not asked. Where a member of staff was removed from regulated activity, or would have
   been, because they harmed or posed a risk of harm, a DBS referral decision (referred with the
   date, or not required with the reason) is recorded before closing.
2. **Complaints** (`complaints.ts`; Regulation 16; SAFE-011). `received`, `acknowledged`,
   `investigating`, `responded`, `closed`, with `appealed` and `appeal_responded`. Acknowledgement
   target `complaint.acknowledge_working_days` and response target
   `complaint.response_working_days` (tenant targets: Regulation 16 sets none for independent
   providers), counted in working days with the nation's bank holidays, paused while waiting for the
   complainant's consent or information. The final response must say how to go to the Local
   Government and Social Care Ombudsman, and that it must normally be within
   `lgsco.time_limit_months` of the complainant knowing of the matter. A compliment is recorded
   separately and never runs a clock.
3. **Whistleblowing and speak-up** (`whistleblowing.ts`; SAFE-012; ADR-0089 for the silo). A concern
   is named, confidential (named to the Freedom to Speak Up lead only) or anonymous (no identity
   stored, a reply token instead). `received`, `acknowledged`, `under_review`, `outcome_shared`,
   `closed`, with the acknowledgement target `whistleblowing.acknowledge_working_days`. The
   outcome is shared with the person who raised it before closing, unless anonymous with no reply
   token.
4. **Deaths** (`deaths.ts`; SAFE-014). Expected or unexpected is the clinician's recorded
   judgement, never decided by Harbour. The steps each needs: verification of death, family told,
   the medical examiner information pack, the notification under Regulation 16 of the CQC (Registration) Regulations 2009, a LeDeR notification for a
   person with a learning disability or autism; for an unexpected death, also the police (where the
   cause may be unnatural or suspicious) and leaving the room and equipment as they are until told
   otherwise. A mortality review is due `mortality_review.due_days` days after the death (a tenant
   target).
5. **Missing person** (`missing-person.ts`; SAFE-015). The timeline: last seen, noticed missing,
   search started, police called (with reference), found or returned, welfare check, debrief.
   Police are called no later than `missing_person.police_call_minutes` after the person is noticed
   missing (a tenant target; immediately when the tenant's risk assessment says so). The Herbert
   Protocol profile is out of date `herbert_protocol.review_months` after its last review, and the
   pack says so. The return needs a welfare check and a debrief before the episode closes; a CQC
   notification is prompted where the person is under a DoLS authorisation or the Mental Health Act.
6. **Disclosure requests** (`disclosure.ts`; SAFE-016). Types with their legal basis: coroner
   (Coroners and Justice Act 2009 Schedule 5), Safeguarding Adults Review (Care Act 2014 s.44 and
   s.45), Domestic Homicide Review (Domestic Violence, Crime and Victims Act 2004 s.9), police and
   solicitor requests (Data Protection Act 2018 Schedule 2 paragraph 2 and paragraph 5), and Access
   to Health Records Act 1990 requests about a person who has died. Every disclosure is approved by a
   holder of `safety.disclosure.approve` who is not the requester, before release, and logged with the
   basis. Access to Health Records requests are answered within `ahra.response_days` days, or
   `ahra.recent_record_response_days` days where the records were added in the last
   `ahra.recent_record_days` days.
7. **Medication errors and near misses** (`medication-error.ts`; MEDS-012). Questions: what went
   wrong (omitted dose, wrong dose, wrong medicine, wrong person, wrong time, wrong route, given after
   it was stopped, other), whether it reached the person (a near miss if not), whether a controlled
   drug was involved, and whether it may be deliberate or repeated. Tasks: get clinical advice (GP,
   pharmacist or NHS 111) whenever it reached or may have reached the person; report a controlled drug
   incident to the area's NHS England Controlled Drugs Accountable Officer; consider safeguarding when
   deliberate or repeated. Harm and the statutory notifications come from the existing classifier
   questions. Joining these questions to the incident classifier needs a migration
   (`classifier_answer.question_key` is checked against the list in the database), so the module is
   built now and wired in by a later schema slice.

Rate keys: `safeguarding.referral_hours`, `complaint.acknowledge_working_days`,
`complaint.response_working_days`, `lgsco.time_limit_months`,
`whistleblowing.acknowledge_working_days`, `mortality_review.due_days`,
`missing_person.police_call_minutes`, `herbert_protocol.review_months`, `ahra.response_days`,
`ahra.recent_record_response_days`, `ahra.recent_record_days`.

Permissions used (all in the catalogue): `safety.safeguarding.manage`, `safety.complaint.manage`,
`safety.whistleblowing.read` (a read permission moves a speak-up concern today because the catalogue
has no other; slice 24 must add the Freedom to Speak Up lead's own manage permission and move
`SPEAK_UP_WORKFLOW` to it before any route uses it, ADR-0089), `safety.incident.manage` (deaths, missing person, disclosure requests),
`safety.disclosure.approve`.

Tests: `safeguarding.test.ts`, `complaints.test.ts`, `whistleblowing.test.ts`, `deaths.test.ts`,
`missing-person.test.ts`, `disclosure.test.ts`, `medication-error.test.ts`, `phase2-rates.test.ts`:
every transition and its refusals, every clock across a bank holiday and both clock changes, every
step list.

## 5. API and events

`/v1/incidents` (create, list in scope, get, update, close), `/v1/incidents/{id}/classifier`
(answer questions; returns the required outputs and their due times), `/v1/notifications/statutory`
(list with clocks, get, prepare, submit with step-up, mark not required with step-up),
`/v1/incidents/{id}/candour`, `/v1/incidents/{id}/investigation`. Outbox events:
`safety.incident.recorded`, `safety.notification.due`, `safety.notification.overdue`,
`safety.notification.submitted`. Submission to CQC, HSE and local authorities is by the manager on
the regulator's own portal in Phase 1 (Harbour prepares and records); direct submission APIs are
integrations for later phases where they exist.

Built in slice 7 (`apps/api/src/routes/incidents.ts`, `statutory-notifications.ts`,
`apps/api/src/services/safety.ts`; tables in migrations 0018 and 0019): `POST /v1/incidents` takes a
device-generated id, so a replayed offline upload returns the earlier copy with no side effects; the
event time, device time and late-entry and clock-drift flags are kept, and a reporter may answer only
the falls questions at capture (`safety.incident.manage` answers the rest). `GET /v1/incidents`
(filters by status, type, location, person and time) and `GET /v1/incidents/{id}` need
`safety.incident.read`; `PUT /v1/incidents/{id}` (the reporter or a manager, with `version`) changes
the narrative and the people; `POST .../review` and `POST .../close` move the `safety.incident`
workflow, and closing is refused while `incidentCloseProblems` finds open drafts, questions or
candour (counting drafts about people the closer cannot see) and to the person who raised it (also a
database check). The classifier runs on the server on every create, change and answer, with
tenant-wide scope inside the request (ADR-0033): it stores `CLASSIFIER_VERSION`, the reasoning lines,
the open questions and the retention class on the incident, and writes or refreshes one draft per
incident and kind (or per person for deaths, LeDeR, the medical examiner pack and missing people)
with its deadlines from `occurred_at`, never the sync time; "not sure" makes a draft provisional, and
a draft a later answer no longer supports is flagged, never closed, until a holder of
`safety.notification.submit` marks it not required. Outside England the result says
`nationSupported: false` and drafts nothing. Its tasks go through the task engine (generic titles),
and a fall gets the post-fall checklist in every nation, with one task per timed observation from
`postFallChecklist` counted from when the person was found; answering "no" to both risks cancels the
timed observations and starts general monitoring. Body-map marks name their incident
(`incidentId` on the body map, checked against the people on it) or are linked by id, and their
pressure ulcer categories reach the classifier. `/v1/notifications/statutory` lists drafts with
their clock (`notificationClockState`) for `safety.incident.manage`; `POST .../prepare` fills the
regulator's form and moves draft and ready; `POST .../submit` (the submission time and the
regulator's reference or the form, `submissionEvidenceProblems`) and `POST .../not-required` (with
the reason, kept and audited) need `safety.notification.submit` with step-up and acknowledge the
overdue alerts. `GET` and `PUT /v1/incidents/{id}/candour` record the threshold decision (which the
classifier then follows), the notifications and the correspondence, and `POST .../candour/step`
takes the `CANDOUR_WORKFLOW` steps that `candourStepProblems` allows; `GET` and `PUT
/v1/incidents/{id}/investigation` record the method, findings, actions (an action with an owner and
date becomes a task) and lessons. Worker jobs: every minute, each overdue draft alerts the holders of
`safety.notification.submit` at its location (role or acting-up grant) once, through the tenant's
`safety.notification.overdue` escalation chain (by default the Nominated Individual after
`statutory_notification.escalation_minutes`, H-69), and publishes `safety.notification.overdue`;
hourly, outbreak detection classifies the latest infection incident at each English location again
with the location's cases (from incident people's infection details since the last decided report),
which drafts the UKHSA report once per threshold. Observations carry no infection case yet, so cases
come from infection incidents until a chart records them. Statutory notifications, candour and
investigations are server-only; incidents and their people are published for sync streams (offline
slice).

Web read views, slice 9 part 1 (`apps/web/src/app/(shell)/incidents/`,
`apps/web/src/lib/incidents.ts`): an Incidents item in the sidebar for holders of
`safety.incident.read`; the list for the chosen location, newest first, each incident named by
its type and time with its status (icon and word), its open questions and whether part of it is
hidden from the reader; and an incident page with what happened (severity and harm as staff
judged them), who was told and the people on it (named from the reader's own people list, or by
kind, with their communication needs). A restricted reader is told part of it is hidden, sees
"About this incident" (times, who raised it, severity and harm) and no narrative or contacts.
Types, statuses and labels are the catalogue's, never the API's English. After review round 1
(#42): the incident page shows the questions about statutory notifications still to answer as a
warning chip and (part 2) the statutory notifications, before the people, with an overdue chip
at the top linking to them: each with its clock (overdue for how long, due, submitted, not
required), its status as its own chip, its deadlines in the law's terms from the classifier's
outputs (without delay from when the clock started; RIDDOR's second deadline), who it is about
for one person, its recipient and, on a draft still open, its warnings with a next step
(provisional; waiting for answers; no longer indicated; a Harbour target, as soon as possible
for a safeguarding concern or a missing person). Open questions, the kinds waiting for them,
checks that decide whether one is needed (RIDDOR's absence check, the safeguarding decision
guide, an outbreak's links, the candour decision), outputs drafted on another record, "not
checked yet" and "outside England" warn; "no notification found" is said only when none of these
is there (#49 review round 1). Kinds and recipients are the catalogue's, checked against
`NOTIFICATION_KINDS`; RIDDOR's threshold is read from `/v1/rates`. A draft stays `provisional`
after the answer that made it changes, so the web shows only "no longer indicated" on such a
draft; the questions' text, the exclusions, the reasoning and the tasks' own words are English
from the API and not shown (the page gives the count and its own words). The page title
names the incident by its date; a location the reader cannot see reads "Location not shown to
you"; when the API's limit of 500 is reached the list fetches the open and under-review incidents
besides and says older incidents are not listed. Gaps logged, no API change: staff are "you" or
"a colleague" (no staff names, H-73); the list has no paging past 500; infection details are not
shown; the overdue alert links to `/notifications/statutory/{id}`, which the web does not have
until the notification pages.

Web statutory notification pages, slice 9 part 3, read only (`apps/web/src/app/(shell)/
notifications/statutory/`, `apps/web/src/lib/statutory-notifications.ts`): for holders of
`safety.incident.manage`, as the API's reads require (anyone else is told the page is not for
them), and kept under Incidents in the sidebar, never the notification centre.
`/notifications/statutory` lists the notifications for the chosen location in two sections, still
to do (an unknown clock, then overdue, then due soonest) and submitted or not required, each with
its kind linking to its page, its clock and status (icons and words), who it is about (people the
reader cannot see are numbered consistently across the list, and the list says so), its due time,
location, recipient, warnings and the person's communication needs; each status is read on its
own, so finished ones never push an unfinished one past the API's limit of 1,000, and a cut
unfinished read warns that unfinished notifications may be missing (#52 review).
`/notifications/statutory/{id}`, the page the overdue alert links to, shows the clock, status,
who it is about (unnumbered when not shown), warnings (waiting for answers read from its
incident), every deadline in the law's terms (kept once done), the record it was drafted on (the
incident, named and linked with its status; the person's DoLS register; or their record), why
Harbour drafted it, what it must include and the sources (the API's English, marked as English;
a source is linked only on https) and how it ended (when and by whom it was submitted, the
regulator's reference, whether a document is attached, why it is not required). Both pages and the
incident page say when the clocks were worked out; on the incident page each notification links to
its page for a holder of `safety.incident.manage`. Not shown yet: the prepared form, the DoLS
statement and the API's reason a draft is no longer indicated; the forms follow.

Web incident forms, slice 9 part 4a (`apps/web/src/app/(shell)/incidents/new/`,
`apps/web/src/components/safety/`, `apps/web/src/lib/incident-forms.ts`): `/incidents/new` records
an incident for holders of `safety.incident.report`, from the incidents list (a location where the
member works) or from a person's record, offered there only when the person's `access.reaching`
lists the permission (ADR-0071). Emergency services, GP and, for a person, whether they died are
yes or no questions with nothing chosen (`CreateIncident` defaults the first two to false, so the
form never leaves them out, HZ-090); a fall asks the two point-of-care questions, each needing an
answer. The incident's UUIDv7 is made by the form and sent with every attempt. On the incident
page the open questions are offered in the catalogue's words, which repeat `CLASSIFIER_QUESTIONS`
word for word (a question or option the catalogue does not know is shown in the API's English,
marked): every question to a holder of `safety.incident.manage`, the falls questions to the person
who raised it, none on a closed or partly hidden incident. Gaps logged, no API change: the web
cannot tell where each permission reaches (no per-permission locations in `/v1/me`, no `access` on
`IncidentDetail`), so the API's refusal is the last word; answers have no client id; "when found",
other people, body-map marks, infection details, the family told and LeDeR facts are not on the
form yet (STATUS item 19, H-262).

Web review and notification forms, slice 9 part 4b (`apps/web/src/lib/incident-review.ts`,
`apps/web/src/components/safety/IncidentManage.tsx` and `NotificationManage.tsx`; HZ-091): the
incident page's "Review and close", for a holder of `safety.incident.manage` on an incident seen
whole and not closed, starts the review, sends it back to open with a reason, or closes it with a
reason; close is never offered to the person who raised it (rule 11, the domain's
`INCIDENT_WORKFLOW`), and while a notification is a draft or ready or a question is open the card
lists what to do first, linked, instead of the form. The notification page prepares it (one
answer per line of `requiredContent`, stored under that line cut to 80 characters, plus "Other
details"; marking it ready needs every line answered), records it as submitted once ready (when,
chosen every time, and the regulator's reference) and decides "not required" with a reason. Each
form needs its permission held and, for a notification about a person, listed in that person's
`access.reaching` (ADR-0071); submitting and "not required" ask for a fresh sign-in as break-glass
does (sign in again, then back to the page). Every write sends the version the page was drawn
from; a stale page is refused in words that do not blame anyone else. Gaps logged, no API change:
no `access` on `IncidentDetail`, no candour state on the incident, no upload for the submitted
form, and no stable key for a line of required content (STATUS item 19, H-266).

Web incident follow-up, slice 9 part 5 (`apps/web/src/lib/candour.ts`, `investigation.ts`,
`after-death.ts`, `incident-trends.ts`; `apps/web/src/components/safety/CandourSection.tsx`,
`CandourForms.tsx`, `InvestigationSection.tsx`, `InvestigationForm.tsx`, `AfterDeath.tsx`;
`apps/web/src/app/(shell)/incidents/trends/`; HZ-013 and HZ-091). On an incident seen whole, after
the statutory notifications:

- **After a death** (SAFE-008, rules 6 and 8), for each person we support who died on it, with
  their communication needs: the medical examiner pack's notification with its clock and status
  (linked to its page for a holder of `safety.incident.manage`) and the pack's seven sections in
  `MEDICAL_EXAMINER_PACK_SECTIONS` order, each with what it holds (the catalogue repeats the
  domain's words) and where it is kept (their record's Overview, Notes, Charts and Assessments or
  Advance care; this incident), or "not shown on Harbour's web pages yet" (diagnoses, medicines).
  The LeDeR prompt: with a LeDeR draft, "report the death on LeDeR's online form, which anyone can
  use" linked to `SOURCES.leder`, then record it on the notification; when the incident does not
  record whether the person had a learning disability or was autistic, "check whether LeDeR
  applies" with the same link and the Child Death Review exception; nothing when both are
  recorded as no. The medical examiner and LeDeR notification pages show the pack and the link
  too. Nothing judges the death.
- **Duty of candour** (SAFE-007, rule 5), shown with a candour record or a person we support on the
  incident: its stage as an icon and words; the clocks from `CandourItem.clocks`, telling the person
  "as soon as reasonably practicable: the clock started" (due now, then told in person, or not told
  in person after `no_contact`) and the written notification as "your organisation's target is
  N working days from the decision, by" its time, N read from `/v1/rates` on the incident's date
  (`candour.written_notification.working_days`), always followed by "This is a target, not a
  legal deadline" (ADR-0021; past the target it says so in words and an icon); until the threshold
  decision, that the times count from when the incident happened; none once it is not notifiable.
  The record (who it happened to with their communication needs, the decision and whose opinion it
  records, telling them, attempts, the letter, results shared, correspondence, outcome) is read by
  anyone who may read the incident. A holder of `safety.incident.manage`, on an incident not
  closed, gets the forms for the stage (`candourForms`): the threshold decision (who it happened
  to, from the people we support on it; yes or no and when, nothing chosen; whose opinion), then
  telling them in person (when, who, in person asked, the account, the enquiries and the apology
  ticked, the written record) and attempts to contact them, then the written notification (when,
  what it included, its copy) and the results and correspondence. A time is chosen every time:
  as recorded, just now (the server's time) or earlier, never later than now. Documents are
  chosen from the relevant person's available PDFs (`/v1/documents`, letters sent and documents
  added), with a link to their letters. The steps are the workflow's (`availableTransitions` on
  `CANDOUR_WORKFLOW`), from the threshold only the one its decision points to, each offered only
  when `candourStepProblems` finds nothing missing, otherwise the missing items listed in the
  catalogue's words; not notifiable, no contact and closing take a reason. The API's candour
  refusals are recognised (`refusals.ts`). "Review and close" lists an open candour record (any
  stage but closed, not notifiable or no contact) among what must happen first, as
  `incidentCloseProblems` does.
- **Investigation** (SAFE-010): its status, lead, method, findings, contributing factors, lessons,
  whether the lessons were marked published as a bulletin and when, and each action with its
  status (open, open past its date, done or cancelled, icon and word), owner, due date and whether
  a task was made. Staff are named from `/v1/members` for those who manage the team, else "you"
  or "a colleague". A holder of `safety.incident.manage`, on an incident seen whole (closed or
  not, as the API allows), records it: lead, method, findings, factors one per line, lessons, each
  action's status, one new action at a time with its owner and date (a task for the owner), the
  bulletin mark, and save, complete (needs the findings and the lessons) or reopen. **Changed in
  the API** (`PUT /v1/incidents/{id}/investigation`): an open action with an owner and a date
  becomes a task only for an owner who may be given it (`mayBeGiven` with
  `safety.incident.manage` at the incident's location), as the task engine requires of every
  assignee; otherwise the save is refused in words.
- **Incident trends** (`/incidents/trends`, from the incidents list, for `safety.incident.read`):
  incidents and near misses counted by type in each of the last six UK calendar months at the
  chosen location, from one `GET /v1/incidents` read per month, with a row of totals, said as
  "counts only, as recorded"; a month whose read reached the API's limit of 500 is said as "500 or
  more". It interprets nothing (medical-device boundary section 4).

Every write sends the version the page was drawn from (0 starts a record); a stale page is refused
in words; after a save the page opens again with focus on its heading and says what was done.

**Review round 1 (#120)**, fail safe:

- **Closing waits for the duty of candour** (`candourCloseBlock` in `incidentCloseProblems`, so the
  API refuses and the web lists it first): where Harbour found the duty may apply (a candour output
  on the last classification, or a candour notification neither decided not required nor flagged
  no longer indicated) or the threshold decision says notifiable, the incident cannot close until a
  candour record has finished; and since one candour record covers one relevant person, with two
  or more people we support affected every person without a finished record of their own is named
  as still to be told and the incident cannot close. One record per person is the follow-up (it
  needs a migration; H-480). A closed incident without a record says so plainly.
- **Unknown is not none**: a candour or investigation read that fails says so, asks to reload,
  offers no form, and keeps closing blocked.
- **The threshold question** repeats regulation 20(9) (unintended or unexpected, during the
  provision of a regulated activity; a death relating directly to the incident; an impairment of
  sensory, motor or intellectual functions; the prolonged period read from the rate table as
  `candour.prolonged_harm_days`), with Harbour's finding on the answers beside it. A decision that
  differs from the finding, or changes a recorded one, takes a confirmation and a reason of at
  least 20 characters (as H-265) and moves the record on at once with that reason as the step's;
  "not notifiable" after Harbour drafted a candour notification asks the same. The relevant person's
  hint gives only regulation 20(7)'s cases for a representative.
- **Clocks**: telling the person counts only in person (a conversation recorded not in person keeps
  "Due now" and says so); a target at UK midnight reads "by the end of" the day before.
- **The candour notification** is recorded as submitted with the written notification's copy on the
  candour record as its evidence, never a regulator's reference; without a copy the page sends the
  reader to the candour record first.
- **LeDeR** follows its notification: an open draft says to report it (the incident records the
  learning disability or autism); one recorded as submitted says when; one recorded as not required
  says only that; with nothing recorded on the incident the check stays, and on a closed incident
  it says it was not answered (H-482).
- **API** (`PUT /v1/incidents/{id}/candour`): times later than now, a decision dated before the
  incident and a document cited that is not on the relevant person's record (as the caller sees
  it) are refused in words; (`PUT .../investigation`) an action reopened gets a new task for its
  owner.
- **Trends**: "500 or more" throughout; a reader who sees only their own people is told the counts
  leave out incidents they cannot see.

**Review round 2 (#120, clinical re-check)**, fail safe:

- **One decision, one person** (M1): a candour record covers only the person it names, whatever it
  decides, so "not notifiable" for one person never clears another. Every person affected without a
  finished record of their own is named as still to be told and the incident cannot close; with one
  record per incident, an incident that affected two or more people cannot close here until one
  record per person is built (H-480).
- **The relevant person is one of those affected** (M2), with one person affected as with several:
  `PUT /v1/incidents/{id}/candour` refuses a relevant person who is not one of the people we support
  recorded as affected (someone lawfully acting on their behalf is told in their place under
  regulation 20(7) and recorded on the same record, not named as the relevant person); the record
  moves on (`POST .../candour/step`) only while it names one of them; a finished record's person
  cannot change. The web's picker lists only the people affected.
- **Reasons in the API** (M3): a threshold decision that differs from Harbour's finding
  (`candourFindingOf` on the stored classification, the function the web uses) or changes a
  recorded decision is refused without `thresholdConfirmed` and a `thresholdReason` of at least 20
  characters (`candourReasonProblems`, `CANDOUR_REASON_MIN`); the reason is kept in the audit event.
  The "not notifiable" step after Harbour drafted a candour notification needs `confirmed` and the
  same reason.
- **Leaving the candour check** (M4; widened in round 3 M1, below): once a threshold decision is
  recorded, `PUT /v1/incidents/{id}` refuses a change that removes someone affected, or changes their kind or role
  so they are no longer affected, unless `candourReason` has at least 20 characters, and audits
  `safety.incident.candour_person_dropped` with the person's opaque id, the reason and the
  incident.
- **Stuck incidents have an owner** (M4): the worker's hourly `candour-blocked-incidents` job gives
  each incident not closed, more than `candour.close_blocked_days` days after it happened (rate
  table; Harbour default 14, to verify, H-480), that the duty of candour holds open
  (`candourCloseBlock`) one urgent task (`safety.candour_close_blocked`, for `safety.incident.manage`
  holders in the Registered Manager role), escalated on its own ladder since round 3 (M2, below). Closing the
  incident finishes it, and so does the next run once nothing holds the incident. Submitting the
  candour notification ends that notification's overdue alerts, never this task.
- **Times** (L5): the times they were told, the letter was sent and an attempt was made cannot be
  earlier than the incident.
- **The threshold question** follows regulation 20(9) closely: an impairment "which has lasted, or
  is likely to last" for the continuous period; prolonged pain or psychological harm "which they
  have experienced, or are likely to experience" for it; and (b) treatment to prevent their death,
  "or any injury which, if left untreated, would lead to one or more of the outcomes in (a)".
- **The family feed** (`apps/api/src/services/feed-publish.ts`) holds publishing for a person with
  an open incident whose family is not recorded as told, or with their own candour record open. It
  is not a candour control: a person still to be told with no record of their own, on an incident
  whose family is recorded as told, does not hold it (for H-480).
- **Across pull requests**: `incidentManageView(incident, viewer, candourRecord)` now requires the
  candour record (`null` for none, `"unread"` when the read failed), so a page that leaves it out
  fails to type-check rather than offering close while someone is still to be told. #130's approvals
  list (`GET /v1/workflows`, merged first) builds its forms from the API's `incident.closeBlocked`,
  which now comes from the close route's own reading and rules (`incidentCloseView`,
  `incidentCloseProblems`, the duty of candour included), so the list never offers a close the API
  would refuse.

**Review round 3 (#120, clinical re-check)**, fail safe:

- **A finished record keeps its decision** (H1): `PUT /v1/incidents/{id}/candour` refuses a threshold
  decision on a record finished as not notifiable, no contact or closed (code `candour_finished`):
  the stage would stay finished, the candour draft stay not required, and the incident close with
  the person never told. **Reopening** (`POST /v1/incidents/{id}/candour/reopen`, `safety.incident.
  manage`) takes a record finished as not notifiable back to the threshold decision, or one finished
  as no contact back to telling the person (`CANDOUR_REOPEN_TO`), with a reason of at least 20
  characters (`candourReopenProblems`), kept on the workflow transition and audited
  (`safety.candour.reopened`). A candour notification decided not required becomes a draft again
  with its clock (`safety.notification.reopened`), and the unfinished record blocks closing again
  (and the stuck-incident job sees it). A record closed after the person was told and written to
  stays closed. The web offers reopening, with the reason, on a record finished as not notifiable or
  no contact.
- **A closed incident's record never changes** (H1): the candour `PUT`, step and reopen are refused
  on a closed incident. A decision found after closing has no route yet (H-480 (d)).
- **Taking someone out of those affected** (M1): any change that removes a person we support from
  "affected" (removed, or their kind or role changed) needs `safety.incident.manage` and
  `candourReason` of at least 20 characters, whether or not a threshold decision is recorded, and
  is audited with the person's opaque id (`safety.incident.candour_person_dropped`). The person who
  raised an incident without that permission cannot do it: before a decision, a change of role would
  otherwise drop the duty of candour from the classifier unseen.
- **Stuck incidents go up, daily** (M2; `services/candour-blocked.ts`): the task is not the task
  engine's to escalate (`SELF_ESCALATED_TASK_KINDS`; it tells clinical leads and team leaders first,
  once). On the day it is raised, the Registered Managers who hold `safety.incident.manage` at the
  location are told (with none, the owners); from the next day, every day until nothing holds the
  incident, the Registered Managers and the owners (founder, director or Nominated Individual) who
  hold it. Only holders of `safety.incident.manage` are told. Raising
  (`safety.candour.close_blocked_raised`), each day's escalation (`..._escalated`, with the day,
  the tier and how many were told, or `..._unrouted` once a day when no one could be) and finishing
  (`..._finished`, closed by whom or no longer held) are audited with opaque ids.
- **Lows**: the API test proves told, sent and attempt times before the incident are refused; a
  finished record's relevant person cannot change (tested); the classifier tests read the Reg 18 and
  candour thresholds apart, at and below each figure, and prove the recorded decision wins either way;
  the "other" reason error says the shortest reason the form takes.

Gaps logged, no API change: the API does not assemble the medical examiner pack or record which
sections were sent (`missingPackSections` is unused), and the web has no medicines or diagnoses
pages to link; duty of candour letters are refused by the letters API until it reads the candour
record, so the written notification's copy is a document chosen from the person's record, and the
web cannot upload one (PLAT-009); one candour record per incident (above); the incident form does
not ask about learning disability or autism (H-482), hence the LeDeR check; no candour forms on a
closed incident (a decision found after closing has no route); bulletins are a date only (no
distribution, read receipts or list of lessons across incidents: no API lists investigations); the
lead is not checked against any permission; communication needs show only for people in the
reader's own list, never for a representative; trends count only what the reader can list, at most
500 a month, by type only (no harm or severity breakdown yet). For the CSO: H-480 (candour wording,
the evidence model, one record per person, a decision after closing, separation of duties, dated
actions), H-481 (the pack listed, not assembled; its clock; the LeDeR check) and H-482 (the
learning disability and autism question on the form).

## 6. Offline behaviour

Incident capture works fully offline (section 17.1): the record, people, body-map marks and photos
are stored encrypted and queued. The classifier runs on the server when the incident syncs, and the
reporter sees "notifications will be checked when you are back online" until it does. The
manager's clocks start from `occurred_at`, not from sync time, so late syncs show as late.

## 7. Clinical safety

HZ-013 (statutory notification missed or late) is the main hazard: controls are the classifier,
due-time clocks, escalation, the dashboard list and the step-up "not required" decision with a
reason, including classifier errors and incidents captured offline that sync late (HZ-006).
HZ-001 and HZ-007 apply to the capture screen header; HZ-019 to body-map marks on incidents; HZ-020
to DoLS outcome notifications; HZ-027 (head injury after a fall not observed or escalated) to the
post-fall checklist. Medical-device boundary: the classifier records a health care professional's
opinion of harm and applies the regulations' tests to it; the post-fall checklist applies
tenant-configurable figures and published guidance and links the tenant's escalation policy.
Neither assesses an injury, scores risk or recommends treatment
([medical-device-boundary.md](../compliance/medical-device-boundary.md)).

## 8. Data protection

Incidents hold special category data and sometimes third-party data (witnesses, staff). Retention
`serious_incident` or `riddor_report` as applicable; disclosure to regulators, police and local
authorities is a legal obligation (Article 6(1)(c)) recorded on the notification.

## 9. Acceptance criteria and tests

- Domain (built in slice 7): `packages/domain/src/safety/classifier.test.ts` table-driven over the
  rules above (every output kind in a scenario, every exclusion with its reason, RIDDOR's
  own-condition test, candour and Reg 18 thresholds from the rate table, provisional drafts, open
  questions, tasks, clocks across bank holidays and both clock changes);
  `outbreak.test.ts` (thresholds and windows); `post-fall.test.ts` (HZ-027);
  `workflows.test.ts` (incident close, step-up submission, candour steps, evidence, pack sections).
- Database and API: isolation for incidents involving people in different scopes; step-up on
  submit and "not required"; separation of duties on close; audit events. Built in slice 7:
  `packages/db/test/mca-and-incidents.test.ts` and `apps/api/test/incidents.test.ts`.
- Web and mobile: Playwright journey from a fall to a submitted Reg 18 draft; Maestro offline
  incident capture. Built so far: `apps/web/e2e/incidents.spec.ts` reads the list and an
  incident with its drafts, clocks and warnings, and the restricted view, with axe (slice 9);
  `candour.spec.ts` (the candour record from the threshold decision to closing it; not notifiable
  and a stale page), `investigation.spec.ts` (an investigation with an action as a task, the
  lessons and a bulletin; a stale page; the trend view) and `after-death.spec.ts` (the medical
  examiner pack and the LeDeR prompt), each with axe in both themes (slice 9 part 5).

## 10. Open questions

- Candour written-notification timescale (H-50); default as ADR-0021.
- CQC readings to confirm (H-63): self-neglect alone is not regulation 18 abuse; every missing person
  reported to the police is a Reg 18(2)(f) notification; a death outside both limbs of regulation
  16(1) may be marked not required; unstageable and deep tissue injury run the decision guide.
- Outbreak definitions (H-65): no national definition or window for linked diarrhoea and vomiting
  cases in adult social care was found; ARI "within 5 days of each other" is read as onsets at most
  5 UK calendar days apart.
- Post-fall observation defaults (H-66): NICE NG232 gives a hospital schedule only.
- Which notifications can be submitted electronically to which regulator (CQC portal, HSE RIDDOR
  online form) without a public API: Phase 1 prepares and records only.
