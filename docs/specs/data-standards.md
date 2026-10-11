# Data standards mapping

**Status**: Phase 0 initial mapping (platform and people), extended in Phase 1 slice 4b (care planning). **Owner**: whoever changes a mapped field
updates this file in the same PR (master prompt section 20, item 7).

This document is the **contract for import and export**. The migration import wizard (PLAT-014) accepts
data in this shape, and the free full tenant export (PLAT-015) produces it. It maps Harbour fields to
the Minimum Operational Data Standard (MODS), the NHS Data Dictionary, SNOMED CT, the Organisation Data
Service (ODS), PRSB About Me and the PRSB personalised care and support plan (section 18, "Data-standard
alignment"). A change to a mapped field, a code list or the export shape is a contract change: it bumps
the export schema version and is listed in the release notes. Later phases extend this file with dm+d and
the DSCR data migration schema.

## Export and import conventions

- **Files**: one CSV file and one JSON Lines file per table, named after the table (`person.csv`,
  `person.jsonl`), plus a `documents/` folder keyed by document ID and a `manifest.json` holding the export
  schema version, tenant ID, export time (UTC), row counts and SHA-256 checksums.
- **Encoding**: UTF-8, no byte order mark; CSV per RFC 4180 with a header row of column names.
- **Column names**: identical to the database column names (`snake_case`); JSON uses the same names.
- **Identifiers**: `id` is a UUIDv7 string. Foreign keys keep their column names (`location_id`). On
  import, source IDs are kept in an `import_source_id` mapping and Harbour assigns new IDs and the
  importing tenant's `tenant_id`; an imported file's `tenant_id` is ignored.
- **Dates and times**: dates as `YYYY-MM-DD`; timestamps as ISO 8601 in UTC with `Z`
  (`2026-10-11T09:30:00Z`). The UI shows dd/mm/yyyy and 24-hour time in Europe/London.
- **Codes**: coded values are stored as the code (`ethnic_category_code = "A"`). Where the code system is
  not implied by the column, the JSON carries `{ "code", "display", "system" }` with `system` as a URI
  (`http://snomed.info/sct` for SNOMED CT).
- **Empty values**: an empty CSV cell and JSON `null` both mean "not recorded". "Not known" and "not
  stated" are real codes where the code list has them, and are never the same as empty.
- **Validation**: every inbound row is validated with the Zod schema in `packages/contracts`; rows that
  fail are quarantined with the reason, never silently dropped (section 15.3 rules).
- **Personal data**: exports are encrypted at rest, delivered by expiring link and audited. Examples in
  this document use invented values only.

## Standards referenced

| Standard | Used for | Version or status |
| --- | --- | --- |
| Adult social care DSCR Minimum Operational Data Standard (MODS) | Person demographics and record content carried between systems | Published NHS standard. MODS element names in this file are concept-level and must be cross-checked against the published specification before the Phase 5 assurance pack |
| NHS Data Dictionary | NHS number, ethnic category, person stated gender code, phenotypic sex, birth date, death date, GP practice code, postcode | Current Dictionary; sex and gender items are being revised nationally, so re-check item names at each phase |
| SNOMED CT UK edition | Accessible Information Standard needs, allergies, About Me section codes | Loaded from NHS TRUD; never hard-coded beyond the About Me headings below |
| Accessible Information Standard (DAPB1605) | Communication and information needs | Identify, record, flag, share and meet needs |
| Organisation Data Service (ODS) | GP practice and location organisation codes | Lookups through the ODS API arrive with the NHS adapters (Phase 5); Phase 0 validates format only |
| PRSB About Me | `about_me` sections | v2.01 (May 2025), model downloaded from theprsb.org on 2026-10-11 |
| PRSB Personalised Care and Support Plan | `care_plan`, `care_plan_section`, `care_plan_action`; additional support plans | v2.0 (December 2021), [theprsb.org](https://theprsb.org/standards/personalisedcareandsupportplan/); section list checked on 2026-10-11, element-level mapping still to verify |
| ISO 639-1 and ISO 639-3 | `first_language` | Two-letter code where one exists, otherwise three-letter |
| CQC identifiers | Provider and location IDs | Format `1-` followed by digits |

## Platform: tenant, location and service

Field names for the platform tables are defined with the schema in `docs/specs/platform.md`; the
names below are the concepts this contract carries and must be kept in step with that file.

| Harbour field | Standard | Format and validation | Notes |
| --- | --- | --- | --- |
| `tenant.cqc_provider_id` | CQC provider ID | `^1-[0-9]+$` | One tenant is one CQC provider (section 4). Null for tenants regulated elsewhere (nation packs). |
| `location.cqc_location_id` | CQC location ID | `^1-[0-9]+$` | Shown on CQC notifications and the Capacity Tracker prefill. |
| `location.ods_code` | ODS organisation code | Upper-case letters and digits, 3 to 10 characters | Format check only in Phase 0; ODS lookup in Phase 5. Used for NHS integrations and UKHSA outbreak reports. |
| `location.nation` | Harbour code list | `england`, `wales`, `scotland`, `northern_ireland` | Selects the rate table rows and nation pack (`docs/specs/rates.md`). |
| `location.regulator` | Harbour code list | `cqc`, `ciw`, `care_inspectorate`, `rqia`, `ofsted` | Drives the compliance framework version. |
| `location.postcode` | NHS Data Dictionary POSTCODE format | Upper case, single space before the inward code | Also used for UKHSA outbreak reports. |
| `service.service_type` | Harbour code list | `residential`, `nursing`, `supported_living`, `domiciliary`, `complex_care`, `live_in`, `respite`, `day_service` | Section 4 service types; drives which modules are active. |

## Person

| Harbour column | Type | Standard mapping | Code list or format | Notes |
| --- | --- | --- | --- | --- |
| `id` | UUIDv7 | - | - | Harbour identifier; never shown as the person's identifier. |
| `tenant_id` | UUIDv7 | - | - | Ignored on import (see conventions). |
| `location_id` | UUIDv7 | - | - | The location currently responsible for the person. |
| `status` | enum | - | `enquiry`, `pre_admission`, `active`, `on_leave`, `in_hospital`, `discharged`, `deceased`, `archived`, `not_admitted` | Harbour lifecycle (section 9.2; [people.md](people.md) rule 1). `pre_admission` and `not_admitted` arrive with the Phase 1 schema step. `discharged` and `deceased` make the record read-only except post-event records. |
| `status_changed_at` | timestamp | - | ISO 8601 UTC | When the current status began (Phase 1). For `discharged` and `deceased` it equals `discharged_at` or `deceased_at`. |
| `nhs_number` | 10 digits | NHS Data Dictionary NHS NUMBER; MODS person identifier | Modulus 11 check (below); stored without spaces, shown as `999 000 0018` | The consistent identifier (Health and Social Care (Safety and Quality) Act 2015) but never the only one. PDS verification arrives in Phase 5. |
| `local_identifier` | text | MODS local identifier | Tenant's own reference | Required when there is no NHS number. |
| `title` | text | MODS person name | Free text (Mr, Mrs, Ms, Mx, Dr and others) | |
| `given_name` | text | NHS Data Dictionary PERSON GIVEN NAME | Free text | |
| `family_name` | text | NHS Data Dictionary PERSON FAMILY NAME | Free text | |
| `preferred_name` | text | MODS preferred name | Free text | Shown first on point-of-care screens with the legal name beneath. |
| `date_of_birth` | date | NHS Data Dictionary PERSON BIRTH DATE | `YYYY-MM-DD` | |
| `sex_code` | code | NHS Data Dictionary PERSON PHENOTYPIC SEX | See sex codes below | Used only where a published validated tool or reference needs it. |
| `gender_identity` | code | NHS Data Dictionary PERSON STATED GENDER CODE | See gender codes below | How the person describes their gender. A self-description in the person's own words belongs in About Me. |
| `ethnic_category_code` | code | NHS Data Dictionary ETHNIC CATEGORY | A to S, Z, 99 (below) | |
| `religion` | text | NHS Data Dictionary religious or other belief affiliation (SNOMED CT coded nationally) | Free text in Phase 0 | SNOMED coding of religion is a Phase 5 mapping item. |
| `first_language` | code | MODS preferred language | ISO 639-1, else ISO 639-3 (`en`, `cy`, `pl`, `bfi` for British Sign Language) | NHS Data Dictionary language codes differ in places; map on NHS export (Phase 5). |
| `interpreter_required` | boolean | AIS communication professional need | `true` or `false` | Also recorded as a coded need in `communication_needs` so it flags with the others. |
| `address_line1` | text | MODS usual address | Free text | |
| `address_line2` | text | MODS usual address | Free text | |
| `town` | text | MODS usual address | Free text | |
| `postcode` | text | NHS Data Dictionary POSTCODE OF USUAL ADDRESS | Upper case, single space | For domiciliary clients this is also the visit address. |
| `gp_practice_ods_code` | code | NHS Data Dictionary GENERAL MEDICAL PRACTICE CODE (PATIENT REGISTRATION); ODS | `^[A-Z][0-9]{5}$` for practices in England and Wales | Format for Scotland and Northern Ireland practices to be confirmed with the Phase 7 packs. |
| `legal_status` | enum | - | Harbour code list, defined in `docs/specs/people.md` | Legal frameworks that apply (for example DoLS, Mental Health Act, Court of Protection order). |
| `photo_document_id` | UUIDv7 | - | Reference to `document` | Photo shown on every point-of-care screen (wrong-person hazard). Exported in `documents/`. |
| `communication_needs` | JSON array | Accessible Information Standard; SNOMED CT | `[{ "code", "display", "preferredFormat" }]` (below) | Flags on every screen and print (section 5.4). |
| `communication_needs_status` | code | Accessible Information Standard (identify and record) | `not_recorded`, `none_identified`, `recorded` | Phase 1. An empty list is never read as "no needs": `none_identified` is recorded positively with `communication_needs_confirmed_by` and `_at` (hazard HZ-023). |
| `national_data_opt_out` | boolean | National data opt-out | `true` when the person has opted out | Honoured when publicly funded care data is used beyond direct care. Checking against the national service is a Phase 5 item. |
| `deceased_at` | timestamp | NHS Data Dictionary PERSON DEATH DATE (date part) | ISO 8601 UTC | Sets `status` to `deceased`. |
| `discharged_at` | timestamp | MODS discharge date | ISO 8601 UTC | Sets `status` to `discharged`. |

### Sex codes (`sex_code`, NHS Data Dictionary PERSON PHENOTYPIC SEX)

| Code | Meaning |
| --- | --- |
| 1 | Male |
| 2 | Female |
| 9 | Indeterminate (unable to be classified as either male or female) |
| X | Not known (not recorded) |

### Gender codes (`gender_identity`, NHS Data Dictionary PERSON STATED GENDER CODE)

| Code | Meaning |
| --- | --- |
| 1 | Male |
| 2 | Female |
| 9 | Indeterminate (unable to be classified as either male or female) |
| X | Not known (not recorded) |

### Ethnic category codes (`ethnic_category_code`, NHS Data Dictionary ETHNIC CATEGORY)

| Code | Meaning |
| --- | --- |
| A | White: British |
| B | White: Irish |
| C | White: any other White background |
| D | Mixed: White and Black Caribbean |
| E | Mixed: White and Black African |
| F | Mixed: White and Asian |
| G | Mixed: any other mixed background |
| H | Asian or Asian British: Indian |
| J | Asian or Asian British: Pakistani |
| K | Asian or Asian British: Bangladeshi |
| L | Asian or Asian British: any other Asian background |
| M | Black or Black British: Caribbean |
| N | Black or Black British: African |
| P | Black or Black British: any other Black background |
| R | Other ethnic groups: Chinese |
| S | Other ethnic groups: any other ethnic group |
| Z | Not stated (the person was asked and chose not to say) |
| 99 | Not known (the person was not asked or could not say) |

Letters not listed are not used. The list follows the 2001 census groups; if NHS England adopts the
2021 census groups, a new code list version is added and existing values are kept.

### NHS number check (modulus 11)

1. The NHS number has exactly 10 digits. Strip spaces before checking; reject anything else.
2. Multiply each of the first nine digits by a weight: 10 for the first digit, 9 for the second, down to
   2 for the ninth. Add the results.
3. Divide the total by 11 and take the remainder. Subtract the remainder from 11 to get the check value.
4. If the check value is 11, use 0. If it is 10, the number is invalid. Otherwise the check value must
   equal the tenth digit.

Worked example with the test number 9990000018: 9×10 + 9×9 + 9×8 + 0×7 + 0×6 + 0×5 + 0×4 + 0×3 + 1×2 =
245; 245 mod 11 = 3; 11 − 3 = 8, which matches the last digit. Fixtures use only the 999 test range
(9990000018, 9990000026, 9990000034, 9990000042, 9990000050, 9990000069, 9990000077, 9990000085,
9990000093, 9990000107). A valid check digit does not prove the number belongs to the person; PDS tracing
(Phase 5) does that.

### Communication needs (`communication_needs`)

The Accessible Information Standard groups needs as contact method, information format, communication
support and communication professional. Each need is recorded with its SNOMED CT concept from the UK
edition (loaded from TRUD, never typed by hand) and the format Harbour should use. The example below is
illustrative: the display text is whatever the loaded concept's preferred term is.

```json
[
  { "code": "<SNOMED CT concept ID>", "display": "Requires information in large print", "preferredFormat": "large_print" },
  { "code": "<SNOMED CT concept ID>", "display": "Requires British Sign Language interpreter", "preferredFormat": "in_person" }
]
```

| Field | Meaning |
| --- | --- |
| `code` | SNOMED CT concept ID (string of digits) for the need. Validated against the loaded AIS concepts. |
| `display` | The SNOMED CT preferred term at the time of recording. |
| `preferredFormat` | Harbour code for how to deliver information: `standard_print`, `large_print`, `easy_read`, `braille`, `audio`, `electronic`, `email`, `telephone`, `text_message`, `in_person`, `other`. Must match the Zod schema in `packages/contracts`; change both in the same PR. |

## Related tables

### `contact`

| Harbour field | Mapping | Notes |
| --- | --- | --- |
| `role` | Harbour code list, aligned to MODS related-person roles and MCA 2005 | `next_of_kin`, `lpa_health_welfare` (lasting power of attorney for health and welfare), `lpa_property_finance` (lasting power of attorney for property and financial affairs), `deputy` (Court of Protection deputy), `imca` (independent mental capacity advocate), `advocate`, `appointee` (DWP appointee), `other` |
| Authority evidence | Document reference, OPG reference where registered, expiry | An attorney or deputy sees only what the authority covers (section 15.1). Evidence is required before a legal role grants portal access. |
| `authority_scope` | Mental Capacity Act 2005 (Court of Protection deputyship orders) | `personal_welfare`, `property_affairs`, `both`; null for other roles | Phase 1, deputies only. Sharing checks what the authority covers (people.md rule 13). |

### `allergy`

| Harbour field | Mapping | Code list or format |
| --- | --- | --- |
| `substance` | MODS allergies and adverse reactions; free text as recorded | Free text |
| `snomed_code` | SNOMED CT substance or product concept for the cause | SNOMED CT concept ID (string); null when only free text is known |
| `reaction` | Manifestation as recorded | Free text in Phase 0; SNOMED CT clinical finding in a later phase |
| `severity` | Aligned to HL7 FHIR UK Core AllergyIntolerance reaction severity | `mild`, `moderate`, `severe` |
| `status` | Aligned to FHIR AllergyIntolerance clinical status | `active`, `inactive`, `resolved` |

"No known allergies" must be recorded explicitly (as a dated, attributed statement) so that an empty
list is never displayed as "no allergies": this mitigates hazard HZ-007 (incorrect or missing allergy
display) in `docs/clinical-safety/hazard-log.md`. The coded form uses the SNOMED CT "no known allergy" situation
concept from the loaded UK edition.

### `placement`

| Harbour field | Mapping | Code list |
| --- | --- | --- |
| `type` | Harbour code list | `permanent`, `respite`, `trial`, `package` (domiciliary or supported-living package of care) |
| Admission and end dates, end reason | MODS admission and discharge | One person can hold several placements over time under one record (section 9.2). |
| `trial_ends_on`, `trial_reviewed_on` | Harbour | `YYYY-MM-DD` | Phase 1. A trial placement's review is due by its end. |
| `local_authority_funded`, `nhs_funded` | Harbour | `true` or `false` | Phase 1 flags for the review scheduler and exit notifications; funding detail moves to finance in Phase 3. |

### `about_me` (PRSB About Me v2.01)

Stored as one JSON document per person. Each section holds the person's own words and optional
multimedia; the SNOMED CT codes are the record entry headings from the PRSB model.

| Section (PRSB name) | JSON key | SNOMED CT heading |
| --- | --- | --- |
| What is most important to me | `what_is_most_important_to_me` | 1515861000000103 |
| People who are important to me | `people_who_are_important_to_me` | 1515871000000105 |
| How I communicate and how to communicate with me | `how_i_communicate` | 1515881000000107 |
| My wellness | `my_wellness` | 1515891000000109 |
| Please do and please do not | `please_do_and_please_do_not` | 1515901000000105 |
| How and when to support me | `how_and_when_to_support_me` | 1515911000000107 |
| Also worth knowing about me | `also_worth_knowing_about_me` | 1515921000000101 |

Two record-level items complete the PRSB model: **Supported to write this by** (name, relationship or
role and contact details of whoever helped) and **Date last updated**.

```json
{
  "what_is_most_important_to_me": {
    "text": "Seeing my granddaughter on Sundays.",
    "media": [{ "documentId": "<uuid>", "mimeType": "audio/mp4", "filename": "sundays.m4a" }]
  },
  "supported_to_write_this_by": "Ada Example, daughter, ada@example.invalid",
  "date_last_updated": "2026-10-11T09:30:00Z"
}
```

Every section is optional. Media is stored as documents (never inline) and exported in `documents/`.

## Care planning (Phase 1, slice 4b)

### Personalised care and support plan (PRSB PCSP v2.0)

The PRSB standard has four main sections (About Me, Care and support plan, Contingency plans and
Additional support plans) and supporting sections (person demographics, GP practice, professional
contacts, personal contacts and, where appropriate, formulation). Harbour maps them as follows. A plan
version is one `care_plan` row: drafts are edited, publishing makes a draft `active` and the previous
version `superseded`, and every change is kept in `record_version`.

| PRSB PCSP section | Harbour | Notes |
| --- | --- | --- |
| About Me | `about_me` (PRSB About Me, above) | Linked by person, not copied into the plan |
| Care and support plan | `care_plan` (status, `published_version`, `review_due_on`, sign-off) with one `care_plan_section` per need domain (`need`, `outcome` in the person's words, `strengths`) and its `care_plan_action` rows (`action`; who: `role_key`; when: `recurrence` or `when_text`) | "Who is responsible for delivery" is a role, so the plan survives staff changes; `generates_tasks` marks actions that become scheduled tasks |
| Contingency plans | `care_plan_section.contingency` | Per need domain: what to do and whom to contact if things get worse |
| Additional support plans | `risk_assessment`, `advance_care_record` and the stored validated tool results (`assessment`) | Linked by person; an action may name the risk assessment it controls (`risk_assessment_id`) |
| Person demographics, GP practice, personal and professional contacts | `person`, `contact` | See Person and Related tables |
| Formulation | Not held in Phase 1 | Mental health formulation; considered with the PBS and mental health work in Phase 5 |

Need domains (`care_plan_section.domain`), from master prompt 10.1. SNOMED CT record headings for the
domains are not hard-coded; they are mapped from the PRSB model loaded from TRUD before the Phase 5
assurance pack (open item below).

| Code | Display |
| --- | --- |
| `mobility` | Mobility |
| `skin` | Skin |
| `nutrition_and_hydration` | Nutrition and hydration |
| `continence` | Continence |
| `communication` | Communication |
| `cognition` | Cognition |
| `mood` | Mood |
| `behaviour` | Behaviour |
| `sleep` | Sleep |
| `pain` | Pain |
| `breathing` | Breathing |
| `medicines` | Medicines |
| `personal_care` | Personal care |
| `social_and_spiritual` | Social and spiritual |
| `sexuality_and_relationships` | Sexuality and relationships |
| `end_of_life` | End of life |

Sign-off (`care_plan.sign_off_kind`): `person` (the person agreed), `representative` (with
`sign_off_representative_name`, `sign_off_authority` and optionally the `contact`), or `unable` (with
`sign_off_unable_reason`). Authority codes: `lpa_health_welfare`, `deputy`, `imca`, `advocate`,
`next_of_kin`, `other`. Plan status: `draft`, `active`, `superseded`.

### `risk_assessment`

| Field | Code list or format | Notes |
| --- | --- | --- |
| `template_key`, `template_version` | `moving_and_handling`, `falls`, `choking`, `skin`, `bed_rails`, `smoking`, `going_out_alone`, `financial`, `environmental`, `self_harm_and_suicide`, `sexual_safety`, `fire_setting`, `absconding`, `substance_and_alcohol_use`, `general`; version `harbour-2026-10` | Templates are code constants (`packages/domain/src/care/risk-assessment.ts`); `answers` is keyed by the template's question keys |
| `likelihood`, `severity`, `residual_likelihood`, `residual_severity` | Whole numbers 1 to 5 | Assessor's judgements: likelihood rare, unlikely, possible, likely, almost certain; severity negligible, minor, moderate, major, catastrophic. Null for `falls` (never rated, NICE NG249 1.1.1) |
| `risk_rating`, `residual_rating`, `risk_band`, `residual_band` | Product of the two; `low`, `moderate`, `high`, `extreme` | NPSA risk matrix (2008), [ADR-0032](../decisions/0032-risk-assessment-rating.md) |
| `findings` | `[{ questionKey, valueMm, rateKey, limitMm, rule, withinLimit }]` | Bed rail gaps against the MHRA figures in the rate table |
| `status` | `active`, `closed` (with `closed_reason`) | |

### `assessment` (stored results of the validated tools)

| Field | Code list or format | Notes |
| --- | --- | --- |
| `tool_key`, `tool_version` | `must` (`bapen-2011`), `waterlow` (`waterlow-2005`), `braden` (`braden-1988`), `ng249_falls` (`nice-ng249-2025`) | The version calculated is stored with every result |
| `answers` | The tool's inputs as entered | JSON matching the `CreateAssessment` contract |
| `score`, `band` | Whole number; the publisher's band | Both null for `ng249_falls`, which never scores |
| `workings` | `[{ item, value, points }]` | The calculation as shown to staff |
| `triggers` | The follow-ups raised (tasks, alerts, the next screening, the weighing interval) | |
| `next_due_on` | `YYYY-MM-DD` | MUST from the screening interval; the others at the care plan review interval |

SNOMED CT codes for the tools' findings are not exported in Phase 1 (open item below).

### `activity_record` and `visit_log`

| Field | Code list |
| --- | --- |
| `activity_record.format` | `group` (with `group_session_id`), `one_to_one` |
| `activity_record.attendance` | `attended`, `partly_attended`, `declined`, `not_able` |
| `activity_record.engagement` | `engaged_throughout`, `engaged_some_of_the_time`, `engaged_briefly`, `did_not_engage` (only when the person took part) |
| `visit_log.kind` | `facilitated_visit`, `visit_out`, `accompaniment` (Regulation 9A of the 2014 Regulations) |
| `visit_log` visitor | `contact_id` (one of the person's contacts) or `visitor_name` and `visitor_relationship` in free text |
| `visit_log.restrictions_applied`, `restriction_reason` | A restriction always has its reason |

### `advance_care_record`

| Field | Code list or format | Notes |
| --- | --- | --- |
| `kind` | `respect`, `dnacpr`, `adrt`, `advance_care_plan` | At most one active record of each kind per person |
| `status` | `active`, `withdrawn` (with `withdrawn_reason`), `superseded` (with `superseded_by_record_id`) | |
| `cpr_decision` | `attempt_cpr`, `do_not_attempt_cpr` | ReSPECT and DNACPR only; a DNACPR record is always `do_not_attempt_cpr` |
| `clinician_name`, `clinician_role`, `completed_on`, `review_due_on`, `document_id` | Free text; `YYYY-MM-DD`; reference to `document` | The scanned form is exported in `documents/` |

CPR decisions map to the SNOMED CT concepts in the NHS "EOL CPR Status Code" value set (HL7 UK, FHIR
STU3 assets), checked on 2026-10-11 and to be confirmed against the UK edition loaded from TRUD:

| `cpr_decision` | SNOMED CT | Display |
| --- | --- | --- |
| `attempt_cpr` | 450475007 | For cardiopulmonary resuscitation (finding) |
| `do_not_attempt_cpr` | 450476008 | Not for cardiopulmonary resuscitation (finding) |

The point-of-care header shows the decision in force from an active ReSPECT or DNACPR record, or "not
recorded" when there is none (hazard HZ-015).

## Consent, capacity and DoLS (Phase 1, slice 6)

Code lists for the tables in [care.md](care.md) section 2. They mirror the domain constants in
`packages/domain/src/care/mca/`; the database CHECKs and the API tests keep them in step. Mental
Capacity Act 2005 concepts have no national code list; SNOMED CT concepts for capacity and DoLS
findings are an open item below.

| Harbour field | Standard mapping | Code list or format | Notes |
| --- | --- | --- | --- |
| `consent_record.decision` | Harbour (master prompt 5.1, 9.2, 10.4) | `care_plan`, `photos`, `social_media`, `sharing`, `marketing`, `ai_processing`, `bed_rails`, `covert_medicines` | `CONSENT_DECISION_KINDS`; also `capacity_assessment.decision_kind` |
| `consent_record.outcome` | Harbour | `given`, `refused` | A refusal is a record too |
| `consent_record.given_by_kind`, `representative_kind` | Mental Capacity Act 2005 s.9, s.16, s.20; DWP appointeeship | `person`, `representative`; `lpa_health_welfare`, `lpa_property_financial`, `deputy`, `appointee`, `imca`, `advocate`, `family_or_friend` | With the OPG reference and registration, or the deputy's `personal_welfare` or `property_and_affairs` scope, decisions, end and court reference |
| `consent_record.capacity_status` | Mental Capacity Act 2005 s.1(2) | `assumed`, `has_capacity`, `lacks_capacity` | Found from the assessments of the decision, with the assessment id |
| `capacity_assessment.practicable_steps` | Mental Capacity Act 2005 s.1(3) | `[{ step, detail }]`, step one of `simple_language`, `visual_aids`, `best_time_or_place`, `interpreter_or_communication_aid`, `trusted_person_present`, `information_repeated`, `other` | |
| `capacity_assessment.stage2`, `unable_to` | Mental Capacity Act 2005 s.3(1) | `understand`, `retain`, `useOrWeigh`, `communicate`, each `{ able, evidence }` | The outcome is `has_capacity` or `lacks_capacity` with the reason in the Act's words |
| `best_interests_decision.checklist` | Mental Capacity Act 2005 s.4 and s.1(6) | Keyed by `no_unjustified_assumptions`, `relevant_circumstances`, `regaining_capacity`, `participation`, `life_sustaining_treatment`, `wishes_and_feelings`, `beliefs_and_values`, `other_factors`, `views_of_others`, `less_restrictive_option`; each `considered` with a note or `not_applicable` with a reason | |
| `best_interests_decision.consultations` | Mental Capacity Act 2005 s.4(7) | `[{ consultee, name, contactId, views, consultedAt }]`, consultee one of `named_by_person`, `family_or_friend`, `lpa_donee`, `deputy`, `paid_carer_or_professional`, `imca` | Or `no_consultation_reason` |
| `dols_authorisation.type`, `outcome`, `nation` | Mental Capacity Act 2005 Schedule A1; s.16(2)(a) | `urgent`, `standard`, `court_order`; `pending`, `granted`, `not_granted`, `withdrawn`; `england`, `wales` | `extensions` are `[{ requestedAt, outcome (pending, granted, refused), extendedTo }]`; the end (`granted_to`) is exclusive |
| `dols_legal_change_review.state`, `decision`, `objection` | DHSC interim guidance on [2026] UKSC 16 (updated 22 September 2026) | `awaiting_review`, `reviewed`, `referred`, `closed`; `still_deprived`, `no_longer_deprived`, `in_doubt`; `objects`, `does_not_object`, `fluctuates`, `unclear` | `factors` keyed by `type`, `duration`, `effects`, `manner`, `prison_cell_comparison`, `normality`, `purpose`; `objection_forms` from `attempts_to_leave`, `refusing_care_or_treatment`, `restraint_or_one_to_one_care`, `covert_medication`, `sedating_medication` |

## Incidents and statutory notifications (Phase 1, slice 7)

Code lists for the tables in [safety.md](safety.md) section 2. They mirror the domain constants in
`packages/domain/src/safety/`; the database CHECKs and the API tests keep them in step. Harm grades
follow the NHS England Learn from Patient Safety Events (LFPSE) physical harm levels and severity
the NPSA consequence scale, both as staff judge them (Harbour never computes them). A national
mapping of incident types to LFPSE categories is an open item below.

| Harbour field | Standard mapping | Code list or format | Notes |
| --- | --- | --- | --- |
| `incident.type` | Harbour (master prompt 11.1) | `fall`, `medication`, `skin`, `behaviour`, `missing_person`, `safeguarding_concern`, `injury`, `near_miss`, `environmental`, `ipc`, `staff_injury`, `violence_to_staff`, `self_harm`, `sexual_safety`, `absconding`, `fire_setting`, `substance_use`, `data_breach` | `INCIDENT_TYPES` |
| `incident.severity` | NPSA risk matrix consequence scale (2008) | `negligible`, `minor`, `moderate`, `major`, `catastrophic` | Staff judgement |
| `incident.harm_grade` | LFPSE physical harm | `none`, `low`, `moderate`, `severe`, `fatal` | Staff judgement |
| `incident.status` | Harbour (`INCIDENT_WORKFLOW`) | `open`, `under_review`, `closed` | Closed by someone other than `raised_by` |
| `incident.retention_class` | [retention.md](retention.md) | `care_record`, `serious_incident` | `serious_incident` once any notification applies |
| `incident_person.kind`, `role` | RIDDOR 2013 reg 4 and 5 (worker, person not at work) | `service_user`, `worker`, `other_not_at_work`; `affected`, `witness`, `involved` | `infection` is `{ syndrome (acute_respiratory, diarrhoea_vomiting), onsetAt, couldBeLinkedWithinSetting, fluConfirmedAt, link ({ group } or not_linked) }` |
| `classifier_answer.question_key`, `value` | The regulations each question quotes (`CLASSIFIER_QUESTIONS`) | `CLASSIFIER_QUESTION_KEYS`; `yes`, `no`, `unsure`, a whole number of days or hours, or option values | Append-only; the latest answer per key counts |
| `statutory_notification.kind` | CQC Registration Regulations 2009 regs 16 and 18; RIDDOR 2013; Care Act 2014 s.42; regulation 20 of the 2014 Regulations; LeDeR; UKHSA; death certification reforms | `cqc_reg16_death`, `cqc_reg18_serious_injury`, `cqc_reg18_abuse`, `cqc_reg18_police`, `cqc_reg18_service_disruption`, `cqc_reg18_dols_outcome`, `riddor_death`, `riddor_specified_injury`, `riddor_non_worker_hospital`, `riddor_over_7_day`, `riddor_dangerous_occurrence`, `safeguarding_s42`, `candour`, `leder`, `ukhsa_outbreak`, `medical_examiner`, `police_missing_person` | `STATUTORY_NOTIFICATION_KINDS` |
| `statutory_notification.status` | Harbour (`STATUTORY_NOTIFICATION_WORKFLOW`) | `draft`, `ready`, `submitted` (time and reference or form), `not_required` (reason) | `deadlines` are `[{ key, dueAt, wording, statutory }]` |
| `candour_record.state` | Regulation 20 of the 2014 Regulations (`CANDOUR_WORKFLOW`) | `threshold_assessment`, `not_notifiable`, `verbal_due`, `no_contact`, `written_due`, `enquiries_open`, `closed` | |
| `investigation.method`, `status`, `actions` | Harbour | `root_cause_analysis`, `five_whys`, `fishbone`, `after_action_review`, `swarm_huddle`, `other`; `open`, `completed`; actions `[{ id, action, ownerTenantUserId, dueOn, status (open, done, cancelled), taskId }]` | |

## Lifecycle records (Phase 1)

Code lists for the tables in [people.md](people.md) section 2. MODS and NHS Data Dictionary
alignments are concept-level, like the rest of this file, and are cross-checked before the Phase 5
assurance pack.

| Harbour field | Standard mapping | Code list or format | Notes |
| --- | --- | --- | --- |
| `pre_admission_assessment.sections` | Harbour; content aligned to the PRSB personalised care and support plan headings where they exist | JSON keyed by `PRE_ADMISSION_SECTIONS` (`personal_details_and_contacts`, `views_and_wishes`, `health_and_medical_history`, `medicines`, `allergies`, `communication`, `mobility_and_falls`, `eating_drinking_and_swallowing`, `skin_integrity`, `continence_and_personal_care`, `cognition_and_mental_health`, `capacity_and_legal_status`, `resuscitation_and_advance_care`, `infection_status`, `equipment`, `risks`, `dependency`, `funding`, `social_cultural_and_spiritual`, `hospital_passport`) with `status` (`in_progress`, `complete`, `not_applicable`), reason, completed by and at | Allergies follow the `allergy` mapping; IDDSI levels the care profile; communication needs the AIS mapping above. |
| `pre_admission_assessment.sources` | Harbour | `person`, `family_or_representative`, `hospital`, `gp`, `social_worker`, `previous_provider`, `other` | At least one. |
| `admission_decision.can_meet_needs` | Harbour | `yes`, `yes_with_conditions`, `no` | With reasons, conditions, decided by and at. |
| `placement.start_date` | MODS admission date (concept) | `YYYY-MM-DD` | The admission date of the current placement. |
| `bed_occupancy.from_date`, `to_date` | Harbour | `YYYY-MM-DD`, `to_date` exclusive | The person's room and bed over time; `person.room_label` is a display cache of the current one. |
| `property_item.category` | Harbour | `clothing`, `jewellery`, `watch`, `electronics`, `mobility_aid`, `sensory_aid`, `dentures`, `documents`, `furniture`, `ornament_or_picture`, `toiletries`, `other` | Cash is never an inventory item (residents' money ledger). |
| `property_item.status` | Harbour | `held`, `sent_with_person`, `returned`, `disposed`, `lost` | |
| `property_item` recipient capacity | Harbour | `person`, `representative`, `personal_representative`, `receiving_provider` | After a death only `personal_representative` (executor or administrator). |
| `property_item` signatures | Harbour typed-name signature | Signer `person`, `representative` or `unable_to_sign` with a reason; typed name; time | A second staff member witnesses valuables and unsigned items. |
| `care_plan_change.kind` | Harbour | `return_from_hospital`, `fall`, `change_in_needs`, `new_diagnosis`, `safeguarding`, `end_of_life`, `other` | Raises the care plan review on change. |
| `review_record.kind` | Harbour | `care_plan`, `la_review`, `family_involvement`, `trial_review` | |
| `review_record` family involvement | Harbour | `attended_review`, `contributed`, `invited_declined`, `person_declines_involvement`, `no_family_or_representative` | The last two stop the family involvement clock. |
| `hospital_transfer` pack sections | NHS England hospital transfer pathway (red bag) content; allergies as `allergy`; About Me as `about_me`; communication needs as AIS; resuscitation as the care module's advance care record (ReSPECT, DNACPR) | `photo`, `allergies`, `medicines`, `communication`, `resuscitation`, `about_me` (safety-critical); `reason_for_transfer`, `baseline`, `eating_and_drinking`, `capacity_and_legal`, `contacts`, `infection`, `items_sent`, `home_contact` | The snapshot is stored as JSON (`pack`) with the missing critical sections; the PDF is rendered from it on request (ADR-0040), never from the live record. Medicines are dm+d-coded from Phase 2. |
| `exit_record.kind` | Harbour | `discharge`, `transfer`, `death` | |
| `exit_record` destination | MODS discharge destination (concept); NHS Data Dictionary discharge destination items to be checked | Destination type (`own_home`, `family_home`, `care_home`, `hospital`, `hospice`, `supported_living`, `other`) and the receiving provider's CQC location ID or ODS code | Sets `person.discharged_at`. |
| `exit_record` death details | NHS Data Dictionary PERSON DEATH DATE (date part of `person.deceased_at`); place of death (concept) | Place `care_home`, `hospital`, `elsewhere`; expected or not; verified by (name, role) and at | Sets `person.deceased_at`. |
| `exit_record.state` | Harbour (`DISCHARGE_WORKFLOW`, `TRANSFER_WORKFLOW`, `DEATH_WORKFLOW`) | `planned`, `left`, `recorded`, `awaiting_return`, `closed`, `cancelled` (with a reason) | Mirrors the exit workflow instance; `regulator` is `cqc`, `ciw`, `care_inspectorate` or `rqia`. |
| `exit_checklist_item.status` | Harbour | `pending`, `done`, `not_required` (with a reason, only where allowed) | Item keys from `exitChecklist` in `packages/domain/src/people/exit.ts`. |
| `sharing_decision.sections` | Harbour | `about_me`, `daily_updates`, `photos`, `activities_and_visits`, `care_plan`, `health_summary`, `medicines`, `appointments`, `finance`, `documents`; care plan domains as the PCSP domains | |
| `sharing_decision.basis` | UK GDPR and Caldicott principle 7 (direct care) | `consent`, `legal_authority`, `best_interests`, `direct_care` | Consent covers optional processing only (records of processing B8). |
| `sharing_decision` authority role | Mental Capacity Act 2005 (Office of the Public Guardian registrations, Court of Protection orders); DWP appointeeship | `lpa_health_welfare`, `lpa_property_finance`, `deputy_personal_welfare`, `deputy_property_affairs`, `appointee` | From `contact.role` and `contact.authority_scope`, with reference, evidence document and end date. |
| `sharing_decision` capacity | Mental Capacity Act 2005 s.1(2) (presumption of capacity) | `presumed`, `assessed_has_capacity`, `assessed_lacks_capacity` | Links the capacity assessment where one exists. |
| `about_me_share_link.token_hash` | Harbour | Lower-case hex SHA-256 of the link token (64 characters) | The token itself is shown once and never stored; expiry no later than the sharing decision's end. |
| `recorded_after_exit` on `care_note`, `observation`, `body_map_mark`, `assessment`, `activity_record` and `visit_log` | Harbour | `true` or `false` | Phase 1. True when an entry about an event at or before a discharge, death or move to hospital is accepted after it (people.md rule 3, HZ-006); shown with the late-entry flag. |
| `break_glass_event.reason_code` | Harbour | `emergency_care`, `covering_another_area`, `safeguarding`, `incident_or_complaint`, `request_from_professional`, `other` | Phase 1; the typed justification is kept as well. |

## Platform operational tables (not part of the MODS export)

These tables support running the service and are exported in the full tenant export (section 5.1) but
map to no national data standard: `audit_event` (hash-chained), `record_version`, `outbox_event`,
`notification`, `notification_delivery`, `escalation_chain`, `feature_flag`, `form_template`,
`form_submission`, `integration_connection`, `integration_inbound`, `support_access_request`,
`break_glass_event`, `person_assignment`, `role`, `role_assignment`, `access_grant`, and from
Phase 1 `break_glass_weekly_report`, `about_me_share_link` and `welcome_checklist_template`. Field-level
detail is in `packages/db/src/schema/`; purposes and lawful bases are in
[records of processing](../compliance/records-of-processing.md).

## Open items to verify

- MODS element names and any mandatory items, against the published MODS specification (before the
  Phase 5 assurance evidence pack).
- The DSCR data migration schema: confirm that this export shape satisfies it, or add a mapping layer.
- Current NHS Data Dictionary items for sex and gender (national revisions are in progress).
- SNOMED CT concepts for Accessible Information Standard needs and "no known allergy", loaded from TRUD.
- ODS code formats for Scottish and Northern Irish GP practices (Phase 7).
- PRSB PCSP v2.0 element-level names and SNOMED CT record headings for the care plan sections and
  need domains, from the PRSB viewer and TRUD (before the Phase 5 assurance pack).
- SNOMED CT concepts for ReSPECT, ADRT and advance care plan documents, and for the validated tools'
  findings.
- MODS and NHS Data Dictionary items for admission date, discharge destination and place of death
  (people lifecycle, Phase 1).
- SNOMED CT concepts for mental capacity findings, consent decisions and DoLS status, and a mapping
  of incident types and harm grades to LFPSE for national reporting (slices 6 and 7).
