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

- **Files**: one CSV file and one JSON Lines file per table under `tables/`, named after the table
  (`tables/person.csv`, `tables/person.jsonl`), plus a `documents/` folder keyed by document ID
  (`documents/<id>.<extension>`, never the title or file name), `destroyed.csv` (records destroyed past
  retention, with their certificate ids), `current_summary.csv` (one row per person with the essentials
  as Harbour shows them, below), `schema.json` (JSON Schema 2020-12 for every table, generated from the
  same plan as the files, with a description for every column, a unit for every number and the codes of
  every coded column) and a `manifest.json` holding the export schema version (1.1.0), tenant ID, the
  snapshot instant, row counts and SHA-256 checksums (fields below). Only columns the export catalogue
  classifies as exported are written. Rules for held, deleted, destroyed, quarantined and sample
  records: [platform-completions.md](platform-completions.md) rule 11.
- **Snapshot**: every file is read in one transaction, so all tables are from the same moment
  (`snapshotAt` in the manifest, in UTC and UK time). A "changes since" export (manifest `kind`
  `changes_since`, `since` the earlier snapshot) holds only rows created, changed, recorded, deleted or
  destroyed at or after it, and has no current summary.
- **Encoding**: UTF-8, no byte order mark; CSV per RFC 4180 with a header row of column names.
- **CSV formulas**: in CSV files only, a text cell starting with `=`, `+`, `-`, `@`, a tab, a carriage
  return or an apostrophe gets one leading apostrophe so a spreadsheet does not run it as a formula;
  remove that one apostrophe when importing (`csvTextValue`). Numbers are never changed, and the JSON
  Lines files hold the exact values.
- **Column names**: identical to the database column names (`snake_case`); JSON uses the same names.
- **Identifiers**: `id` is a UUIDv7 string. Foreign keys keep their column names (`location_id`). On
  import, source IDs are kept in an `import_source_id` mapping and Harbour assigns new IDs and the
  importing tenant's `tenant_id`; an imported file's `tenant_id` is ignored.
- **Dates and times**: dates as `YYYY-MM-DD` and always UK calendar dates; timestamps as ISO 8601 in
  UTC with `Z` (`2026-10-11T09:30:00Z`). UK local time is the instant converted to Europe/London
  (+00:00 GMT, +01:00 BST); convert from UTC, never the other way, because the autumn clock change
  repeats an hour. Where an instant stands for a date (`person.deceased_at`, `person.discharged_at`) the
  export adds a derived `<column>_uk_date` column with the UK date, because the UTC date is a day early
  for anything after 23:00 in summer. Recurrence times and quiet hours are Europe/London wall-clock times
  (`HH:MM`), not instants. The UI shows dd/mm/yyyy and 24-hour time in Europe/London.
- **Corrections**: clinical and money entries are never edited. A correction is a new row whose
  `supersedes_id` names the row it corrects; the original and its correction are not two live facts, and
  the current value is the row no other row supersedes.
- **Units**: every numeric column has its unit in `schema.json` (`x-unit`). Observation `values` follow
  a schema per chart (`OBSERVATION_VALUES_SCHEMA`: ml, kg, breaths per minute, % oxygen saturation,
  mmHg, beats per minute, degrees Celsius, Bristol stool type).
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
| `allergy_status` | code | MODS allergies and adverse reactions (the "no known allergies" statement; see `allergy` below) | `unknown` (nobody has recorded whether the person has allergies), `no_known_allergies` (checked and recorded: none known), `has_allergies` (one or more rows in `allergy`) | Defaults to `unknown`, which never means none (hazard HZ-007). Read with the `allergy` rows; go-live waits until no current person is `unknown` ([platform-completions.md](platform-completions.md) rule 26). |
| `national_data_opt_out` | boolean | National data opt-out | `true` when the person has opted out | Honoured when publicly funded care data is used beyond direct care. Checking against the national service is a Phase 5 item. |
| `deceased_at` | timestamp | NHS Data Dictionary PERSON DEATH DATE (the UK date of this instant) | ISO 8601 UTC | Sets `status` to `deceased`. The export adds `deceased_at_uk_date`. |
| `discharged_at` | timestamp | MODS discharge date (the UK date of this instant) | ISO 8601 UTC | Sets `status` to `discharged`. The export adds `discharged_at_uk_date`. |

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
| `hospital_transfer` pack sections | NHS England hospital transfer pathway (red bag) content; allergies as `allergy`; About Me as `about_me`; communication needs as AIS; resuscitation as the care module's advance care record (ReSPECT, DNACPR) | `photo`, `allergies`, `medicines`, `communication`, `resuscitation`, `about_me` (safety-critical); `reason_for_transfer`, `baseline`, `eating_and_drinking`, `capacity_and_legal`, `contacts`, `infection`, `items_sent`, `home_contact` | The snapshot is stored as JSON with its rendered PDF; medicines are dm+d-coded from Phase 2. |
| `exit_record.kind` | Harbour | `discharge`, `transfer`, `death` | |
| `exit_record` destination | MODS discharge destination (concept); NHS Data Dictionary discharge destination items to be checked | Destination type (`usual_residence`, `another_care_home`, `hospital`, `other`) and the receiving provider's CQC location ID or ODS code | Sets `person.discharged_at`. |
| `exit_record` death details | NHS Data Dictionary PERSON DEATH DATE (date part of `person.deceased_at`); place of death (concept) | Place `care_home`, `hospital`, `elsewhere`; expected or not; verified by (name, role) and at | Sets `person.deceased_at`. |
| `exit_checklist_item.status` | Harbour | `pending`, `done`, `not_required` (with a reason, only where allowed) | Item keys from `exitChecklist` in `packages/domain/src/people/exit.ts`. |
| `sharing_decision.sections` | Harbour | `about_me`, `daily_updates`, `photos`, `activities_and_visits`, `care_plan`, `health_summary`, `medicines`, `appointments`, `finance`, `documents`; care plan domains as the PCSP domains | |
| `sharing_decision.basis` | UK GDPR and Caldicott principle 7 (direct care) | `consent`, `legal_authority`, `best_interests`, `direct_care` | Consent covers optional processing only (records of processing B8). |
| `sharing_decision` authority role | Mental Capacity Act 2005 (Office of the Public Guardian registrations, Court of Protection orders); DWP appointeeship | `lpa_health_welfare`, `lpa_property_finance`, `deputy_personal_welfare`, `deputy_property_affairs`, `appointee` | From `contact.role` and `contact.authority_scope`, with reference, evidence document and end date. |
| `sharing_decision` capacity | Mental Capacity Act 2005 s.1(2) (presumption of capacity) | `presumed`, `assessed_has_capacity`, `assessed_lacks_capacity` | Links the capacity assessment where one exists. |
| `break_glass_event.reason_code` | Harbour | `emergency_care`, `covering_another_area`, `safeguarding`, `incident_or_complaint`, `request_from_professional`, `other` | Phase 1; the typed justification is kept as well. |

## Platform completions (Phase 1, slice 13)

Code lists for [platform-completions.md](platform-completions.md). None maps to a national standard.

| Harbour field | Standard mapping | Code list or format | Notes |
| --- | --- | --- | --- |
| `manifest.json` | Harbour export contract | `format` (`harbour-tenant-export`), `schemaVersion` (semantic version, `EXPORT_SCHEMA_VERSION`, 1.1.0), `kind` (`full`, `changes_since`), `since` (UTC or empty), `exportId`, `tenantId`, `requestedBy`, `generatedAt` (UTC), `snapshotAt` (UTC) and `snapshotAtUk` (local time with offset, zone `BST` or `GMT`), `schema` (path, SHA-256, bytes), `tables` (name as `schema.table`, rows, legal-hold rows, excluded soft-deleted and sample, files with path, format `csv` or `jsonl`, SHA-256, bytes, rows), `currentSummary` (path, SHA-256, bytes, rows; empty for a changes-since export), `notExported` (name, reason), `documents` (included, bytes, quarantined, excluded, destroyed, files with id, path, SHA-256, bytes), `destroyed` (path, count, by table, certificate ids), `auditChain` (verified, first broken position), `complete`, `problems` (`table_missing`, `unexpected_table`, `unclassified`, `file_missing`, `row_count_mismatch`, `foreign_tenant_rows`, `summary_missing`, `summary_row_count_mismatch`, `document_not_written`, `document_checksum_mismatch`), `warnings` (`audit_chain_broken`, `destroyed_without_certificate`) | An export with any problem is never offered (HZ-070, HZ-071). Version 1.1.0 added `kind`, `since`, the snapshot, the current summary, the `_uk_date` columns, units, codes and the CSV guard. |
| `current_summary.csv` | Harbour export contract | `person_id`, `allergy_status`, `allergies` (substance and severity, most severe first, separated by semicolons), `cpr_decision` (`attempt_cpr`, `do_not_attempt_cpr`, `not_recorded`, `conflicting`), `cpr_record_ids`, `cpr_review_overdue`, `iddsi_food` and `iddsi_drink` (level with name and colour, or `not recorded`), `communication_needs_status`, `communication_needs` (need and preferred format), `as_of` (UTC), `as_of_uk` | One row per exported person, worked out by the same functions as the point-of-care header and the transfer pack. `conflicting` lists every record in force. Check these first when moving a person to another system (HZ-071). |
| Export column classification | Harbour (`EXPORT_TABLES`) | `exported`, `internal`, `secret` | Only `exported` columns are written; only the `public` schema is read. Internal and secret columns (`document.storage_key`, `tenant_user.auth_user_id`, `integration_connection.secret_ref`) never leave (HZ-070). |
| `destroyed.csv` | Harbour | `table`, `id`, `destroyed_at` (UTC), `certificate_id` | Records destroyed past retention; their rows are not in the table files. |
| `tenant_export.status` | Harbour | `queued`, `running`, `ready`, `failed`, `expired`, `revoked` | A ready export past its expiry reads as `expired`. |
| `dpia.status` | Harbour | `draft`, `prepared`, `signed`, `superseded` | The onboarding state adds `not_started` and `review_due`. |
| DPIA risk ratings | ICO DPIA template terms | Likelihood `remote`, `possible`, `probable`; severity `minimal`, `significant`, `severe`; overall and residual `low`, `medium`, `high` | Risk ids R1 to R12 as the DPIA template. |
| DPIA review triggers | Harbour | `new_purpose`, `new_sub_processor`, `new_data_category`, `feature_enabled`, `yearly_review` | |
| `retention_decision.kind` | Harbour | `accepted`, `lengthened`, `period_set`, `not_used` | The last two only for classes set by tenant policy. |
| `sub_processor_notice.kind` | Harbour | `new`, `replacement` | |
| Sub-processor objection resolution | Harbour (DPA clause 6.2) | `objection_withdrawn`, `not_used_for_tenant`, `services_ended` | |
| Sample flag | Harbour | `is_sample` (boolean), `sample_batch_id` (UUID) | Sample people: family name `Example`, 999-range NHS numbers that pass the check digit, `example.invalid` emails, Ofcom drama telephone numbers (to verify, H-123), invented addresses (an "Example" street, no postcode or `ZZ99`). Shown with a "Sample" badge; prints carry the watermark "SAMPLE DATA: NOT A REAL PERSON" (HZ-072). |
| `person.national_data_opt_out_checked_at` | Harbour; NHS national data opt-out | Timestamp (UTC) or empty for "not checked" | The existing boolean cannot say "not checked". |
| Search audit scope | Harbour | `queryKind` (`text`, `nhs_number`), `termCount`, `entityTypes` (`person`, `staff`, `document`, `note`), `omitted` (kind and reason `not_permitted`, `no_scope`, `mfa_required`, `not_applicable`), `includeArchived`, `personScope` (`tenant`, `locations`, `assigned`, or empty when no person record was searched), `locationIds`, `validUntil` (UTC), `resultCounts`, `total`, `resultIds`, `personIds`, `careRecordView`; break-glass: `breakGlassRecordId`, `reasonCode` | Never the words typed or the typed break-glass reason, which stays in the break-glass record (HZ-011). |
| Search match quality | Harbour | `exact` (every term a whole word), `prefix` | Ranks results; a break-glass search shows only `exact` matches. |

## Platform operational tables (not part of the MODS export)

These tables support running the service and are exported in the full tenant export (section 5.1) but
map to no national data standard: `audit_event` (hash-chained), `record_version`, `outbox_event`,
`notification`, `notification_delivery`, `escalation_chain`, `feature_flag`, `form_template`,
`form_submission`, `integration_connection`, `integration_inbound`, `support_access_request`,
`break_glass_event`, `person_assignment`, `role`, `role_assignment`, `access_grant`, and from
Phase 1 `break_glass_weekly_report`, `about_me_share_link`, `welcome_checklist_template`, `tenant_export`,
`dpia`, `sub_processor_response`, `tenant_setting_decision` and `retention_decision` (the global
`sub_processor_notice` table is Thapsus's and is not exported). Every exported table is described in
`EXPORT_TABLES` (`packages/domain/src/platform/export.ts`), which a test keeps in step with the schema. Field-level
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
