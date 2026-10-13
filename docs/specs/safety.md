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
    cannot close while a notification is a draft or ready, a classifier question is open, or the
    candour record is open (`incidentCloseProblems`).
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
warning chip and (part 2) the statutory notifications: each with its clock (overdue, due, or how
it ended), when it is due, its recipient and its warnings (provisional, no longer indicated, a
Harbour target); open questions, the kinds waiting for them, "not checked yet" and "outside
England" warn; "no notification found" is said only when nothing is open; kinds and recipients
are the catalogue's, checked against `NOTIFICATION_KINDS`. A draft stays `provisional` after the
answer that made it changes, so the web shows only "no longer indicated" on such a draft; the
questions' text, the exclusions, the reasoning and the tasks are English from the API and not
shown yet (the page gives the count). The page title
names the incident by its date; a location the reader cannot see reads "Location not shown to
you"; when the API's limit of 500 is reached the list fetches the open and under-review incidents
besides and says older incidents are not listed. Gaps logged, no API change: staff are "you" or
"a colleague" (no staff names, H-73); the list has no paging past 500; infection details are not
shown; the overdue alert links to `/notifications/statutory/{id}`, which the web does not have
until the notification pages.

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
  incident with its drafts, clocks and warnings, and the restricted view, with axe (slice 9).

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
