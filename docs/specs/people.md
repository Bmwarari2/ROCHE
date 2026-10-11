# Service-user lifecycle (`people`) - specification

Master prompt section 9.2 (service-user lifecycle), with section 4 (access, break glass and the
weekly report), section 15.1 (family portal and professional access), section 17 for offline
behaviour and section 18 for the data model. The domiciliary client and supported-living variants
(PEOP-011, PEOP-012) have their own sections in Phase 4. Status per feature lives in the
[feature register](feature-register.md).

## 1. Purpose and register rows

One person, one record, from first contact to archive: assess before admitting, admit into a
dated bed, keep the reviews on time, send the right information with the person when they go to
hospital, close the record properly when they leave or die, and share nothing with families or
professionals unless a recorded decision allows it.

| Phase 1 rows | Later rows |
| --- | --- |
| PEOP-001 person record (Phase 0 foundations); PEOP-002 communication needs (Phase 0); PEOP-003 About Me; PEOP-005 pre-admission assessment and decision; PEOP-007 admission, rooms and beds, property, keys and welcome checklist; PEOP-008 review scheduling; PEOP-009 hospital transfer pack; PEOP-010 discharge, transfer and death; PEOP-013 sharing rules; PLAT-006 weekly break-glass report | PEOP-004 enquiry pipeline and PEOP-006 CMA contracts (Phase 3); PEOP-011 domiciliary variant and PEOP-012 supported-living tenancy (Phase 4); family app mode (MOB-004, Phase 4) |

## 2. Schema

All tables carry `id` (UUIDv7), `tenant_id`, `created_at`, `created_by` and forced RLS through
`app.person_in_scope(person_id, location_id)` (ADR-0002). Mutable aggregates carry `version`,
`updated_at`, `updated_by`, `deleted_at` and write a `record_version` row on every change.
Append-only tables have no UPDATE or DELETE grant for the app; a correction is a new row with
`supersedes_id`.

### Built in Phase 0

- `person` (MODS-aligned demographics, validated NHS number, `allergy_status`, communication needs,
  national data opt-out, room label cache, status, `discharged_at`, `deceased_at`), `contact`
  (roles including LPA, deputy, IMCA, advocate, appointee, with authority reference, evidence and
  expiry), `allergy`, `placement`, `room`, `about_me` (PRSB About Me v2.01 sections as JSON),
  `person_assignment`, `break_glass_event`. Field mapping: [data-standards.md](data-standards.md).
- Scope: a person is visible to tenant-wide roles, to location-scoped roles at their location, to
  assigned staff, and to holders of an unexpired break-glass record (ADR-0002); contacts, allergies,
  placements and About Me follow the person.
- Point-of-care header data (HZ-001, HZ-007): `GET /v1/people` and `GET /v1/people/{id}` return
  names, date of birth, NHS number, photo link, allergy status and active allergies, and
  communication needs. Every view is audited.
- NHS number validation and display (`packages/domain/src/people/nhs-number.ts`).
- Demo tenant: Harbour House (60 rooms), six residents with invented details and test-range NHS
  numbers, a care worker assigned to three of them (`packages/db/src/seed/demo.ts`).

### Columns to add in the Phase 1 schema step (expand only)

| Table | Change | Why |
| --- | --- | --- |
| `person` | `status` enum gains `pre_admission` and `not_admitted` (`ALTER TYPE ... ADD VALUE`) | Lifecycle (rule 1). Devices one schema version behind never see these people: they are not assigned. |
| `person` | `status_changed_at` (timestamptz, not null, backfilled from `discharged_at`, `deceased_at` or `created_at`) | Rule 3 compares event times with the exit; rule 2 refuses changes dated before the current status. |
| `person` | `communication_needs_status` (`not_recorded`, `none_identified`, `recorded`, default `not_recorded`), `communication_needs_confirmed_by`, `communication_needs_confirmed_at` | An empty list must never read as "no needs" (HZ-023, as HZ-007 for allergies). |
| `placement` | `trial_ends_on`, `trial_reviewed_on`, `local_authority_funded`, `nhs_funded`, `admission_decision_id` | Trial review, local authority review tracker and exit notifications (rules 5, 8, 12). Funding detail moves to finance in Phase 3. |
| `room` | `status` values become `available`, `out_of_service`, `awaiting_clearance` (check constraint) | A room is held after a death until it is cleared (rule 6). |
| `contact` | `authority_scope` (`personal_welfare`, `property_affairs`, `both`) for deputies | Sharing checks what an authority covers (rule 13). |
| `break_glass_event` | `reason_code` (nullable, `BREAK_GLASS_REASON_CODES`) | The weekly report groups by reason (rule 14). The typed justification stays. |

### Tables to add

| Table | Kind | Key columns | Retention class |
| --- | --- | --- | --- |
| `pre_admission_assessment` | mutable, versioned | person, placement type sought, service, status (`in_progress`, `complete`, `decided`), sections (JSON keyed by `PRE_ADMISSION_SECTIONS`: status, content, not-applicable reason, completed by and at), information sources, the person's involvement or the reason they could not take part, assessor | `care_record` |
| `admission_decision` | append-only | assessment, can meet needs (`yes`, `yes_with_conditions`, `no`), reasons, planned admission date, trial end, decided by and at, who was told and when, `supersedes_id` | `care_record` |
| `admission_condition` | mutable | decision, condition, met by and at | `care_record` |
| `bed_occupancy` | mutable, versioned | person, room, bed number, from date, to date (exclusive; null while occupied), reason, recorded by, backdated flag. Two exclusion constraints (btree_gist): no overlapping range per room and bed, none per person | `care_record` |
| `welcome_checklist_template` | mutable, versioned | the tenant's item definitions (no personal data), checked with `checkWelcomeChecklistDefinition` | tenant configuration |
| `welcome_checklist_item` | mutable | placement, item key, required, safety-critical, status (`pending`, `done`, `not_applicable`), reason, by and at | `care_record` |
| `property_item` | mutable, versioned | person, description, category, quantity, valuable, photo documents, received on, recorded by, acknowledgement (signer, typed name or reason unable, signed at), witness, status (`held`, `sent_with_person`, `returned`, `disposed`, `lost`), return (date, recipient name and capacity, signature, returned by, witness), disposal (date, reason, by, witness), loss (date, incident) | `care_record` |
| `key_issue` | mutable | person, label, issued on, issued to, returned on, reported lost on | `care_record` |
| `care_plan_change` | mutable | person, kind (`CARE_PLAN_CHANGE_KINDS`), occurred on, source record (incident, hospital transfer, note), reviewed on and the review that dealt with it | `care_record` |
| `review_record` | append-only | person, kind (`care_plan`, `la_review`, `family_involvement`, `trial_review`), held on, participants, family involvement kind, local authority reference, changes covered, outcome, document, `supersedes_id` | `care_record` |
| `hospital_transfer` | mutable, versioned | person, left at, hospital (name, ODS code), reason, pack snapshot (JSON) and rendered document, missing critical sections, acknowledgement (by, at, reason), items sent, returned at, return checks (key, by, at) | `care_record` |
| `exit_record` | mutable, versioned | person, kind (`discharge`, `transfer`, `death`), workflow instance, left or died at, the `ExitContext` flags; discharge and transfer: destination type, receiving provider (name, CQC location ID or ODS code), reason; death: place, expected or not, verified by (name, role) and at, who was present, funeral director and collection time, coroner referral (by, reference) | `care_record` |
| `exit_checklist_item` | mutable | exit record, item key, owner, status (`pending`, `done`, `not_required`), reason, by and at, evidence (notification, document or ledger entry id) | `care_record` |
| `sharing_decision` | mutable, versioned | person, recipient (contact, tenant user or share link), sections, care plan domains, basis, consent given by, capacity for the decision (with the capacity assessment), best-interests decision, authority (contact, role, reference, evidence document, valid until, and for a deputy the sections the order covers), valid from, valid to (required), withdrawn at and reason, suspended at and reason, recorded by; suspension periods in `sharing_decision_suspension` (from, to, reason) | `care_record` |
| `about_me_share_link` | mutable | person, sharing decision, token hash (never the token), expires at, revoked at, created by, last opened at | `care_record` |
| `break_glass_weekly_report` | append-only | location (or tenant), week start, generated at, summary (counts and opaque ids only), reviewed by and at, actions taken | `audit_event` |

New personal data fields are added to
[records of processing](../compliance/records-of-processing.md) and mapped in
[data-standards.md](data-standards.md) in the same pull request as the table.

## 3. Permissions

From the catalogue in `packages/domain/src/platform/permissions.ts` (matrix:
[permissions.md](permissions.md)). Scope follows the person (tenant, location, assigned or
break-glass). Every read of a person's record is audited; writes are audited with the record id.

| Permission | Allows | Held by (built-in roles) |
| --- | --- | --- |
| `people.enquiry.manage` | Start a pre-admission assessment, close an enquiry as not admitted, record a re-referral | Owner, Registered Manager, deputy, administrator |
| `people.admission.manage` | The decision to admit, admission, bed moves, discharge and transfer, exit workflow moves, archive, correcting a discharge or a death (a death correction also needs step-up) | Owner, Registered Manager, deputy |
| `people.movement.record` (new) | Leave, hospital transfer, return, recording a death, printing and handing over the transfer pack | As above plus clinical lead and team leader (the nurse or senior in charge at night) |
| `people.property.manage` (new) | Property, valuables and keys in and out | As `people.movement.record` |
| `care.plan.write` or `people.admission.manage` | Writing pre-admission sections | Nurses and managers |
| `people.person.update`, `care.plan.write` or `comms.portal.self` | About Me (the person in their own portal, or staff with them) | Managers, nurses, the person |
| `people.sharing.manage` | Sharing decisions and About Me share links | Owner, Registered Manager, deputy |
| `platform.audit.read` | The weekly break-glass report | Owner, group executive, Registered Manager, deputy, quality lead |

Existing tenants' role copies gain the two new permissions through a data migration in the schema
step (roles are versioned per tenant; the migration adds a new version).

## 4. Rules that are easy to get wrong

Every rule has a table-driven test in `packages/domain/src/people/` (named with its hazard ID where
one applies). Figures come from `rate_table` by key, resolved with `resolvePeopleRates`.

1. **Statuses and what they allow** (`lifecycle.ts`). Discharged and deceased records are
   read-only except post-event records; archived and not-admitted records take nothing.

   | Status | Allows |
   | --- | --- |
   | `enquiry` | Contact details and the enquiry |
   | `pre_admission` | Demographics, the pre-admission assessment, About Me |
   | `active` | Everything; on rounds |
   | `on_leave` | Notes, care plan, property, transfer pack, sharing, room moves; off rounds; bed kept |
   | `in_hospital` | Notes, care plan, property, transfer pack, sharing; off rounds; bed kept |
   | `discharged`, `deceased` | Post-event records and property return only |
   | `archived`, `not_admitted` | Nothing |

2. **Status changes** run through `PERSON_LIFECYCLE` on the workflow engine (permission, reason,
   step-up) plus the lifecycle guards: the time of the change cannot be in the future beyond the
   clock-drift tolerance (`sync.clock_drift_flag_minutes`) or before the current status began;
   admission needs `checkAdmissionReadiness`; a discharge says whether it is a discharge or a
   transfer; archiving after an exit needs the exit workflow closed; a person who has died is
   never re-admitted. A discharge or death recorded in error is corrected with a reason (and
   step-up for a death, HZ-001); sharing stays closed until a manager reinstates it. Each change
   returns its side effects (pause or resume rounds, start the exit workflow, cancel future tasks,
   close sharing, release or hold the bed, start the retention clock) and one outbox event.
3. **Read-only after exit** (care.md rule 12). The post-event records are: after-death care and
   the medical examiner pack (deaths only), statutory notifications, exit checklist items,
   property, money and key returns, post-event notes, documents and correspondence. Care events
   (notes, observations, body-map marks, assessments, task completions, incidents) that happened
   at or before the discharge or death are still accepted afterwards and shown as recorded after
   it: a phone that recorded the last observations offline must be able to upload them (HZ-006),
   and the late-entry flag still applies (HZ-017). This refines the slice 4a API, which refuses
   every chart entry once a person has left.
4. **Pre-admission assessment** (`pre-admission.ts`). Twenty sections; eighteen are required
   before a decision (social, cultural and spiritual needs and the hospital passport are
   optional). Only equipment can be marked not applicable, with a reason: "not applicable" would
   hide a safety fact anywhere else, and allergies, resuscitation and IDDSI levels in particular
   are always recorded positively (HZ-007, HZ-015, HZ-016). At least one information source and
   the person's involvement (or why they could not take part, Regulation 9) are required.
5. **Decision to admit.** "Can we meet needs" is `yes`, `yes_with_conditions` or `no`, with reasons
   of at least a sentence, conditions when conditional, who decided (holding
   `people.admission.manage`) and when; it cannot predate the last completed section. A trial
   period must end after the planned admission. Admission waits until every condition is
   confirmed met and, for residential and nursing placements, a bed is free.
6. **Rooms, beds and moves** (`occupancy.ts`). Occupancy is a dated half-open range per bed. A bed
   never has two occupants on the same day, a person never has two beds, every move has a reason
   and a date that is not in the future, not before the current bed and not the same day as it;
   a move recorded after the day it happened is flagged as backdated. A person in hospital or on
   leave keeps their bed. After a death the room is held for clearance. The header's room label
   comes from this history (HZ-001).
7. **Property, valuables and keys** (`property.ts`). Every item in is described, dated, counted in
   whole numbers and acknowledged by the person or their representative; valuables (jewellery,
   watches, electronics, documents, or anything marked valuable) and items nobody could sign for
   need a second member of staff as witness. Cash is never an inventory item: residents' money
   goes to the ledger (finance) with its own two-person rules. Each item leaves once: returned
   (after a death, only to the personal representative), disposed of (reason and witness) or
   lost (with an incident). Glasses, hearing aids, dentures and walking aids are offered for the
   transfer pack. Keys and fobs not returned or reported lost block the exit.
8. **Review scheduler** (`reviews.ts`). The first care plan is due within
   `care_plan.initial_working_days` working days of admission (the location's bank holidays);
   then every `care_plan.review_interval_months` months from the last review. Changes (return
   from hospital, a fall, a change in needs) raise one review on change covering all of them
   (HZ-008), due on the first change's date; a regular review on a later day covers them. Care
   plan reviews pause while the person is in hospital. Council-funded permanent and trial
   placements get the local authority review window (`la_review.first_min_weeks` to
   `la_review.first_max_weeks` weeks after the start), then every `la_review.interval_months`
   months. Family involvement falls due every `family_involvement.interval_months` months unless
   the person has declined it or has nobody. A trial placement's review is due by its end. People
   not receiving care have no schedule.
9. **About Me** (`about-me.ts`). The seven PRSB About Me v2.01 sections, each optional; media is a
   document reference, never inline; when the person did not write it alone, "Supported to write
   this by" is required. Sharing it outside the home needs a sharing decision (rule 13).
10. **Hospital transfer pack** (`transfer-pack.ts`). Assembled from supplied record data, never
    interpreted. Refused only when the person is not receiving care, the name or date of birth is
    missing, or any section belongs to another person (HZ-001). Otherwise always produced, because
    a transfer never waits for paperwork: photo, allergies (HZ-007), medicines, communication
    needs, resuscitation status (HZ-015) and About Me are safety-critical and, when missing, read
    "not recorded" on the first page (HZ-023). "None" is a positive statement with who confirmed
    it and when; an empty list is not. Only active resuscitation records print; allergies print
    most severe first and time-critical medicines first; every section shows its "as of" time.
    Recording the hand-over of an incomplete pack needs a named acknowledgement and reason. On
    return, the checks re-confirm medicines, allergies, resuscitation decisions and IDDSI levels
    (hospitals change them), skin, and belongings that went with the person.
11. **Exit workflows** (`exit.ts`). Discharge and transfer: `planned`, `left`, `awaiting_return`,
    `closed` (or `cancelled` before leaving). Death: `recorded`, `awaiting_return`, `closed` (or
    `cancelled` with step-up when recorded in error). The `awaiting_return` state escalates after
    `exit.money_and_property_return_days` days; a deposit is due back within
    `cma.deposit_return_days` days of the exit.
12. **Exit checklist and notifications.** Death: verification, next of kin, after-death care, the
    regulator's death notification (CQC Regulation 16 in England), GP, the medical examiner
    (unless the death was in hospital), the coroner referral for an unexpected death, LeDeR for a
    person with a learning disability or autistic person, the council and ICB when they fund, the
    DoLS supervisory body, DWP when the home is the appointee, pharmacy, medicines, the funeral
    director's collection, then property, keys, money, deposit and loan equipment. Discharge and
    transfer: destination, the person's involvement, next of kin, the discharge or transfer of care
    summary (before leaving), medicines, GP, the same funders and bodies, then returns. Statutory
    notifications are drafted and submitted in [safety](safety.md) (HZ-013); "not required" needs
    a reason and is allowed only where marked. Property, keys and money are counted from their own
    records, so the exit cannot close while anything is still held.
13. **Sharing** (`sharing.ts`, HZ-022). Every section is closed to family members, professionals
    and share links until a decision covers that section (and, for the care plan, that domain) for
    that recipient and is in force. Bases: the person's consent (unless assessed as lacking
    capacity for it); consent by an attorney or deputy whose authority covers the section; a legal
    authority held by the recipient (property and finance authorities cover `finance` and
    `benefits`, a DWP appointee `benefits` only, never finance statements; welfare authorities
    everything else; a deputy only the sections their Court of Protection order covers, recorded
    with the authority); a recorded best-interests decision; or direct care, for professionals and
    clinical sections only. A decision that rests on the person lacking capacity (a welfare
    authority, a representative's consent or a best-interests decision) applies only while the
    current capacity finding, passed in at each check, says the person lacks capacity for it;
    without a finding capacity is presumed and the decision stays closed (`capacity_regained`).
    Authorities need evidence and lapse at their end date. Every decision expires; withdrawn or
    suspended (for example during a safeguarding enquiry) decisions close at once. Suspensions are
    stored as periods, and `decisionInForceAt` says whether a decision was in force and not
    suspended at an earlier instant, so the family feed keeps closed what happened during a
    suspension (comms.md rule 2). Sharing closes at discharge or death. A share link carries About
    Me only and never outlives its decision. Family members see shared sections only in a portal
    session, never through a person assignment (ADR-0061).
14. **Break-glass weekly report** (`break-glass-report.ts`, PLAT-006, HZ-011). Monday 00:00 to
    Monday 00:00 UK time, built every Monday for the week before: totals, by user, by person and
    by reason, unreviewed openings, and flags for a user reaching
    `break_glass.weekly_repeat_threshold` openings, a user reopening the same person (their scope
    may be wrong), and a person opened by that many different users. It goes to the Registered
    Manager and the data protection lead and holds counts and opaque ids only.
15. **Phase 0 rules still in force.** One person, many placements over time under one record; the
    NHS number is the consistent identifier but never the only one; "no known allergies" is a
    recorded fact and "unknown" is never displayed as calm (HZ-007); demographic edits are
    versioned and nothing is hard-deleted by the app.

## 5. Domain functions for the schema and API step

All pure, in `packages/domain/src/people/` and exported from `@harbour/domain`.

| Module | Functions and constants | Input | Output |
| --- | --- | --- | --- |
| `lifecycle.ts` | `PERSON_STATUSES`, `PERSON_STATUS_RULES`, `personStatusAllows`, `PERSON_RECORD_KINDS`, `POST_EVENT_RECORD_KINDS`, `checkPersonRecordWrite`, `PERSON_LIFECYCLE`, `checkPersonStatusChange` | Status, status change time, record kind and event time; or the person (status, creator, status time, death time) and the request (to, actor, permissions, reason, step-up, effective and server time, exit kind, admission readiness, exit closed) | Allowed or a problem; for changes the rule, effects, exit kind, outbox event and correction flag |
| `pre-admission.ts` | `PRE_ADMISSION_SECTIONS`, `preAdmissionCompleteness`, `checkAdmissionDecision` | Section states, sources, involvement; decision input | Outstanding sections; a normalised `AdmissionDecision` or every problem |
| `admission.ts` | `checkAdmissionReadiness`, `DEFAULT_WELCOME_CHECKLIST`, `checkWelcomeChecklistDefinition`, `welcomeChecklistStatus` | Decision, conditions met, placement, bed plan; checklist definition and item states | Ready or problems; checklist completeness with safety-critical items first |
| `occupancy.ts` | `checkOccupancyHistory`, `planBedMove`, `planBedRelease`, `bedOccupantOn`, `personBedOn`, `roomLabelOn`, `moveHistory` | Occupancy periods, rooms, a move request, the location's date | Problems; the period to close and the one to open, with the backdated flag |
| `property.ts` | `checkPropertyItemIn`, `checkPropertyReturn`, `checkPropertyDisposal`, `checkPropertyLoss`, `outstandingProperty`, `propertyToSendWithPerson`, `propertyAwayWithPerson`, `outstandingKeys` | Item, return, disposal or loss details; person status | Ok or every problem; item lists |
| `about-me.ts` | `ABOUT_ME_SECTIONS`, `validateAboutMe`, `aboutMeFilledSections`, `summariseAboutMe` | The stored JSON and whether the person wrote it alone | Issues; filled and missing sections, last update |
| `reviews.ts` | `scheduleReviews`, `REVIEW_KINDS`, `CARE_PLAN_CHANGE_KINDS`, `FAMILY_INVOLVEMENT_KINDS` | Status, admission time, placement, care plan dates, council reviews, changes, family records, today, bank holidays, rates | Due items (due date, window, exact deadline, state, changes covered, rate keys) and the family involvement state |
| `transfer-pack.ts` | `TRANSFER_PACK_SECTIONS`, `assembleHospitalTransferPack`, `checkTransferPackHandover`, `RETURN_FROM_HOSPITAL_CHECKS`, `returnFromHospitalChecks` | Identity and each section's data with its person and "as of" time, property, items to send | The pack (section statuses, content, missing critical and expected, items left behind) or a refusal; hand-over check; return checks |
| `exit.ts` | `DISCHARGE_WORKFLOW`, `TRANSFER_WORKFLOW`, `DEATH_WORKFLOW`, `exitChecklist`, `exitNotifications`, `exitChecklistStatus`, `checkExitWorkflowMove`, `exitReturnDeadlines` | `ExitContext`; item states; property, keys and money balance | Checklist with owners and notifications; readiness for return and closure |
| `sharing.ts` | `SHARING_SECTIONS`, `checkSharingDecision`, `checkSectionVisibility`, `visibleSharingSections`, `checkAboutMeShareLink` | A decision and the person's status; decisions plus a recipient, section, domain and time | Ok or problems; visible with the decision and expiry, or hidden with the reason |
| `break-glass-report.ts` | `breakGlassReportWeek`, `previousBreakGlassReportWeek`, `breakGlassWeeklyReport` | Events (user, person, reason code, opened, reviewed), the week, the threshold | Totals, lines by user, person and reason, unreviewed ids, flags |
| `rates.ts` | `PEOPLE_RATE_KEYS`, `resolvePeopleRates` | Rate rows, nation, date, tenant | Every people figure, or a loud failure |

## 6. API and events

Resources under `/v1/people/{personId}/...` for the schema and API step: `status` (POST a change),
`pre-admission` (GET, PUT sections), `admission-decisions`, `admission`, `bed-moves`,
`welcome-checklist`, `property` (with `return`, `dispose`, `lose`), `keys`, `about-me` and
`about-me/links`, `reviews` (the schedule and review records), `care-plan-changes`,
`hospital-transfers` (create with the pack, PDF, hand-over, return), `exit` (checklist, items,
moves), `sharing-decisions` (create, withdraw, suspend). Location views: `/v1/locations/{id}/beds`
(bed board on a date) and `/v1/locations/{id}/reviews` (due and overdue). The break-glass report:
`GET /v1/break-glass/weekly-report?week=` (`platform.audit.read`) and a Monday worker job that
stores the report and notifies the Registered Manager and data protection lead with a generic
title. Every route is audited.

Outbox events: `people.person.assessment_started`, `people.person.admitted`,
`people.person.not_admitted`, `people.person.re_referred`, `people.person.went_on_leave`,
`people.person.went_to_hospital`, `people.person.returned`, `people.person.discharged`,
`people.person.died`, `people.person.status_corrected`, `people.person.archived`,
`people.sharing.changed`, `people.transfer_pack.handed_over`, `people.review.due`. Safety drafts
the death notifications from `people.person.died` and withdraws them on `status_corrected`; care
cancels and resumes rounds; comms recomputes the family feed on `people.sharing.changed`.

## 7. Offline behaviour (section 17.1)

| Data | On the device | Writes offline | Conflict handling |
| --- | --- | --- | --- |
| Status, room label, About Me, communication needs, photo, allergies, advance care records | Assigned people, never evicted while assigned | No (status changes, property, sharing and exits are online in Phase 1) | Not applicable |
| Hospital transfer pack | Built on the device from synced data with the same domain function | Printing only | Every page shows the last sync time (HZ-002); the server rebuilds it on hand-over |
| Care events for a person who has since left or died | Queued as usual | Yes | Accepted on upload when they happened before the exit (rule 3); the person leaves the device only after its queue has uploaded (HZ-006) |

## 8. Clinical safety

Hazards touched: HZ-001 (wrong person: transfer pack identity check, room from move history,
correcting a death recorded in error), HZ-006 (queued uploads after an exit), HZ-007 and HZ-015
(allergies and resuscitation status in the pack and at pre-admission), HZ-008 (one review on
change), HZ-011 (sharing expiry, the weekly break-glass report), HZ-013 (death notifications from
the exit checklist), HZ-016 (IDDSI levels at pre-admission, in the pack and re-checked on return),
HZ-017 (care events recorded after an exit) and HZ-020 (the DoLS supervisory body told at exit).
New with this spec: HZ-022 (a section shown to a family member or professional without a sharing
decision in force) and HZ-023 (essential information missing from the hospital transfer pack). See
the [hazard log](../clinical-safety/hazard-log.md).

Medical-device boundary: the transfer pack copies recorded information and says what is missing;
the review scheduler applies rate-table intervals; nothing scores, predicts or recommends (see
[medical-device-boundary.md](../compliance/medical-device-boundary.md)).

## 9. Data protection

Special category health data under Article 9(2)(h), the tenant as controller and Thapsus as
processor (records of processing B1). Property inventories, transfer packs, exit records, review
records and sharing decisions are `care_record` (8 years after care ends); the weekly break-glass
report is `audit_event` ([retention.md](retention.md)). Sharing with family members uses consent
only for optional processing (photos and updates, B8); sharing under a legal authority,
best-interests decision or for direct care uses B1's basis, which the DPO confirms (human action
H-38). The transfer pack is a disclosure to the hospital for direct care, audited with its
recipient. Death and discharge notifications to CQC and the medical examiner are legal
obligations (B7). Nothing about a person is shared by a share link except About Me, and links
carry a token whose hash only is stored.

## 10. Acceptance criteria and tests (written before code)

- Domain (built): `packages/domain/src/people/*.test.ts` table-driven tests for every rule above:
  `lifecycle`, `pre-admission`, `admission`, `occupancy`, `property`, `about-me`, `reviews` (with
  the rate-table figures), `transfer-pack`, `exit`, `sharing`, `break-glass-report`.
- Database (schema step): RLS coverage and HZ-011 isolation for every new table; bed occupancy
  exclusion constraints; append-only grants for `admission_decision`, `review_record` and
  `break_glass_weekly_report`; share-link tokens stored hashed.
- API: contract tests and audit events for every route; `hazard HZ-022` tests that the family feed
  and professional views return nothing without a decision in force; the transfer pack built for
  the right person only; uploads for a person who has died accepted for events before death.
- Web and mobile: Playwright journeys (pre-admission to admission, bed move, property in and out,
  hospital transfer and return, death checklist to archive, sharing decision and the family view)
  with axe; Maestro: print the transfer pack offline with the last sync time shown.

## 11. Open questions

- NHS Continuing Healthcare reviews (the ICB's first review and annual reviews) are not tracked;
  add `chc_review.*` rows and a review kind when a first client needs it.
- Wales, Scotland and Northern Ireland have no rows yet for `care_plan.initial_working_days` and
  `la_review.*`, so the scheduler fails loudly for those nations until the nation packs (Phase 7).
- Tenant defaults to confirm: the family involvement interval, the break-glass repeat threshold
  and the money and property return period (H-58).
- Retention of enquiries and pre-admission records for people never admitted (H-39).
- The lawful basis for sharing under a legal authority or best-interests decision (H-38) and
  whether every sharing decision should have a maximum length.
- The care module's advance care record needs a positive "no resuscitation decision in place"
  statement (who checked, when) for the pack; until then the pack shows "not recorded".
- Whether the weekly report should also flag repeated use across consecutive weeks.
- The transfer pack PDF renderer is the Phase 1 PDF decision (ADR to come with the API step).
