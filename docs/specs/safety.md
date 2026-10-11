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
is visible to anyone who can see one of them.

| Table | Kind | Key columns | Retention class |
| --- | --- | --- | --- |
| `incident` | mutable, versioned | location, type (section 11.1 list), `occurred_at`, `device_time`, `recorded_at`, severity, harm grade, description, immediate actions, emergency services and GP contact, family informed (who, when), status (`open`, `under_review`, `closed`), raised by, closed by (must differ, separation of duties), classifier version | `serious_incident` where any notification applies, otherwise `care_record` |
| `incident_person` | mutable | incident, person or staff member, role (affected, witness, involved), injury details, body-map marks | as the incident |
| `classifier_answer` | append-only | incident, question key, answer, answered by and at | as the incident |
| `statutory_notification` | mutable, versioned | incident (or person for deaths and DoLS outcomes), kind (`cqc_reg16_death`, `cqc_reg18_*`, `riddor_*`, `safeguarding_s42`, `candour`, `leder`, `ukhsa_outbreak`, `medical_examiner`, `police_missing_person`), `due_at` (computed), status (`draft`, `ready`, `submitted`, `not_required` with reason), submitted by, submitted at, external reference, evidence document | `serious_incident`, RIDDOR kinds `riddor_report` |
| `candour_record` | mutable, versioned | incident, threshold decision and who made it, verbal notification (who, when, apology given), written notification (date, document), enquiries and results shared, outcome, correspondence documents | `serious_incident` |
| `investigation` | mutable, versioned | incident, lead, method (root-cause template), findings, contributing factors, actions (owner, due, status), lessons, bulletin and read receipts | `serious_incident` |

## 3. Permissions

`safety.incident.report` (every role that works with people, including agency staff), 
`safety.incident.manage` (seniors, nurses, managers), `safety.notification.submit` (Registered
Manager, deputy, quality lead; step-up required), `safety.safeguarding.manage`. Submitting a
notification and deciding "not required" both need step-up (ADR-0002, section 4) and are audited
with the reason.

## 4. Rules that are easy to get wrong

Each rule has a table-driven test named with HZ-013 (statutory notification missed or late).
Time limits come from `rate_table`; "without delay" kinds are due at `occurred_at` and shown as
overdue immediately until submitted.

1. **CQC Regulation 16** (death of a person using the service): draft for every death, due without
   delay. Expected and unexpected deaths both notify; the medical examiner pack is generated too.
2. **CQC Regulation 18** (other incidents): serious injury (the regulation's list: a fracture,
   dislocation, loss of consciousness, burn, an injury needing treatment to prevent death or
   serious harm, and the others in Reg 18(2)(a) and (b)); abuse or allegation of abuse; an incident
   reported to or investigated by the police; a DoLS application outcome (Reg 18(4A), drafted from
   [care.md](care.md) when the outcome is known); events that stop or may stop the service running
   safely (insufficient staff, utilities, fire, flood). Due without delay.
3. **RIDDOR** asks one question first: did the injury arise from work activity, the premises or
   equipment, rather than the person's own condition? Only "yes" continues. Then: a death or a
   specified injury to a worker, or a non-worker taken from the premises to hospital for treatment,
   is reported within `riddor.report_days` days (a death or specified injury also needs prompt
   notification); a worker incapacitated for more than `riddor.over_7_day.threshold_days`
   consecutive days is reported within `riddor.over_7_day.report_days` days. Falls caused by the
   person's own condition, with no failing in premises, equipment or the way work was done, are not
   reportable; the classifier records that reasoning.
4. **Safeguarding (Care Act s.42)**: abuse or neglect of any kind, including financial and
   self-neglect, produces a referral draft to the local authority and, where abuse is alleged, the
   Reg 18 notification. Pressure ulcers of category 3, 4, unstageable or deep tissue injury, and
   any category 2 with concern about care, run the DHSC 2018 safeguarding decision guide.
5. **Duty of candour (Regulation 20)**: notifiable when, in the reasonable opinion of a health
   professional, the incident caused or could cause death, severe or moderate harm, or prolonged
   psychological harm (`candour.prolonged_harm_days` days or more), or prolonged pain. Verbal
   notification and apology as soon as reasonably practicable; written notification within
   `candour.written_notification.working_days` working days (tenant setting, ADR-0021, marked to
   verify); records of enquiries and correspondence kept.
6. **LeDeR**: the death of a person with a learning disability or an autistic person prompts a
   LeDeR notification with the reporting link.
7. **UKHSA outbreak**: `outbreak.ari_cases` or more acute respiratory infection cases within
   `outbreak.ari_window_days` days, or `outbreak.diarrhoea_vomiting_cases` or more linked diarrhoea
   and vomiting cases, at one location prompts the health protection team notification (computed
   across incidents and observations, not only the incident being recorded).
8. **Medical examiner**: every death generates the information pack (demographics, diagnoses,
   recent notes and observations, medicines, advance care records, who was present).
9. **Missing person**: Herbert Protocol profile pre-filled from the record (photo, description,
   places, routines), police reference, search log, return welfare check; a CQC notification where
   the person is subject to DoLS or the Mental Health Act.
10. **Clocks**: every draft shows its due time and is listed on the manager dashboard; overdue
    drafts escalate through the notification centre's escalation chain until submitted or marked
    not required with a reason.
11. **Separation of duties**: the person who raised an incident cannot close it.
12. **Falls protocol**: a fall creates the post-fall checklist (injury check, observation schedule,
    GP contact, NG249 multifactorial review, bone health) as tasks; head injury or anticoagulants
    shorten the observation schedule and prompt urgent medical advice.

## 5. API and events

`/v1/incidents` (create, list in scope, get, update, close), `/v1/incidents/{id}/classifier`
(answer questions; returns the required outputs and their due times), `/v1/notifications/statutory`
(list with clocks, get, prepare, submit with step-up, mark not required with step-up),
`/v1/incidents/{id}/candour`, `/v1/incidents/{id}/investigation`. Outbox events:
`safety.incident.recorded`, `safety.notification.due`, `safety.notification.overdue`,
`safety.notification.submitted`. Submission to CQC, HSE and local authorities is by the manager on
the regulator's own portal in Phase 1 (Harbour prepares and records); direct submission APIs are
integrations for later phases where they exist.

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
to DoLS outcome notifications.

## 8. Data protection

Incidents hold special category data and sometimes third-party data (witnesses, staff). Retention
`serious_incident` or `riddor_report` as applicable; disclosure to regulators, police and local
authorities is a legal obligation (Article 6(1)(c)) recorded on the notification.

## 9. Acceptance criteria and tests

- Domain: `packages/domain/src/safety/classifier.test.ts` table-driven over the rules above (every
  output kind, every exclusion, RIDDOR's own-condition test, outbreak thresholds from the rate
  table, candour thresholds, clocks across bank holidays and the clock change).
- Database and API: isolation for incidents involving people in different scopes; step-up on
  submit and "not required"; separation of duties on close; audit events.
- Web and mobile: Playwright journey from a fall to a submitted Reg 18 draft; Maestro offline
  incident capture.

## 10. Open questions

- Candour written-notification timescale (H-50); default as ADR-0021.
- Which notifications can be submitted electronically to which regulator (CQC portal, HSE RIDDOR
  online form) without a public API: Phase 1 prepares and records only.
