# Data standards mapping

**Status**: Phase 0 initial mapping (platform and people), extended in Phase 1 slice 4b (care planning) and slice 10 (device copies). **Owner**: whoever changes a mapped field
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
| `invitation.email` | RFC 5321 address | Printable ASCII, shaped like local@domain.tld, at most 254 characters (`isPlausibleEmail`), stored normalised | Migration 0054 (platform.md, Invitations and MFA enrolment). Copied from the member's record by a trigger, never taken from a request; required while the invitation is open and cleared when it is accepted, revoked or lapses (#43 review M4). The sign-in is created only for exactly this address. Never in the audit trail or logs. Handed with the link to the organisation's email adapter when the invitation is sent, never queued in `notification_delivery`; masked (first character and domain) on the link's page. |
| `invitation.token_hash` | SHA-256 | 64 lower-case hex characters of the hash of a 256-bit random token | Migration 0054. The token travels only in the link's URL fragment and POST bodies, never stored or logged; the application role may insert the hash but cannot read it back. |
| `invitation.expires_at`, `accepted_at`, `revoked_at`, `revocation_reason` | ISO 8601 UTC; Harbour code list | `expires_at` after `created_at` by `invitation.expiry_hours`, at most `invitation.expiry_hours_max`; reason `superseded`, `revoked`, `member_removed`, `member_changed`, `expired` | Migration 0054. Single use: accepted or revoked is final. Retention class `invitation`. |
| `invitation.claimed_auth_user_id`, `claimed_at` | Better Auth user id; ISO 8601 UTC | Text; set once (again only if that sign-in no longer exists), in its own transaction before the sign-in is linked; only a sign-in at the invitation's address created after the invitation | Migration 0054 (#48 review H1, M1). The sign-in an acceptance created, recorded so the nightly sweep can delete one left unlinked, and never a sign-in any membership or operator record names. Audited as `platform.invitation.claimed` (opaque ids). Internal: never exported. |

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
| `communication_needs_status` | code | Accessible Information Standard (identify and record) | `not_recorded`, `none_identified`, `recorded` | Phase 1. An empty list is never read as "no needs": `none_identified` is recorded positively, and `communication_needs_confirmed_by` and `_at` name who recorded the needs, or that there are none, on every change (hazard HZ-023). |
| `allergy_status` | code | MODS allergies and adverse reactions (the "no known allergies" statement; see `allergy` below) | `unknown` (nobody has recorded whether the person has allergies), `no_known_allergies` (checked and recorded: none known), `has_allergies` (one or more rows in `allergy`) | Defaults to `unknown`, which never means none (hazard HZ-007). Read with the `allergy` rows; go-live waits until no current person is `unknown` ([platform-completions.md](platform-completions.md) rule 26). |
| `allergy_status_confirmed_by`, `allergy_status_confirmed_at` | UUIDv7, timestamp | - | Reference to `tenant_user`; ISO 8601 UTC | Phase 1 (migration 0023). Who set the allergy status and when, kept by a database trigger on every write that touches the status or either of these columns: always the signed-in user (`app.current_user_id()`) and the time of the write, never values the client sends, and null when no user is signed in; cleared when the status returns to `unknown`; never the last person to edit the row. Null for statuses set before the migration (printed as "who confirmed this is not recorded"). |
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
| `authority_scope` | Mental Capacity Act 2005 (Court of Protection deputyship orders) | `personal_welfare`, `property_affairs`, `both`; null for other roles | Phase 1, deputies only. Sharing checks what the authority covers (people.md rule 13). |

### `allergy`

| Harbour field | Mapping | Code list or format |
| --- | --- | --- |
| `substance` | MODS allergies and adverse reactions; free text as recorded | Free text |
| `snomed_code` | SNOMED CT substance or product concept for the cause | SNOMED CT concept ID (string); null when only free text is known |
| `reaction` | Manifestation as recorded | Free text in Phase 0; SNOMED CT clinical finding in a later phase |
| `severity` | Aligned to HL7 FHIR UK Core AllergyIntolerance reaction severity | `mild`, `moderate`, `severe` |
| `status` | Aligned to FHIR AllergyIntolerance clinical status | `active`, `inactive`, `resolved` |

"No known allergies" must be recorded explicitly (as a dated, attributed statement: `person.allergy_status_confirmed_by`
and `_at`) so that an empty list is never displayed as "no allergies": this mitigates hazard HZ-007 (incorrect or missing allergy
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
| Care and support plan | `care_plan` (status, `published_version`, `review_due_on`, sign-off) with one `care_plan_section` per need domain (`need`, `outcome` in the person's words, `strengths`) and its `care_plan_action` rows (`action`; who: `role_key`; when: `recurrence` or `when_text`) | "Who is responsible for delivery" is a role, so the plan survives staff changes; `generates_tasks` marks actions that become scheduled tasks (slice 5: a task series of kind `care.plan_action`, never in the medicines domain) |
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

## Tasks, rounds and handover (Phase 1, slice 5)

Code lists for the tables in [care.md](care.md) section 2 (rules 8 and 14). They mirror the domain
constants in `packages/domain/src/care/handover.ts` and `plan-tasks.ts`; no national standard
codes a shift handover or a care round, so these are Harbour code lists, exported with their
meanings in `schema.json`.

| Harbour field | Code list or format | Notes |
| --- | --- | --- |
| `task.kind`, `task_series.kind` | `care.plan_action` for a round a care plan action generates | `source_type` `care_plan_action` and `source_id` the action; `title` "Care plan: " and the need domain in lower case; `assignee_role_key` the action's role; one live series per action |
| `care_plan_action.based_on_action_id` | Reference to `care_plan_action` | The action of the earlier version a copied draft's action came from; an unchanged action takes over its series |
| `handover.shift_name`, `shift_start`, `shift_end` | The shift's name in the location's pattern (`day`, `night` until rotas define others); instants in UTC, the end exclusive | Patterns are UK local time (`handover.day_shift_start_minute`, `handover.night_shift_start_minute`), so a shift over a clock change is an hour shorter or longer |
| `handover_item.key`, `position`, `kind`, `person_id`, `source_type`, `source_id`, `at`, `late_addition`, `added_at` | One row per item: `kind` one of `fall`, `news2`, `incident`, `alert`, `body_map_mark`, `flagged_note`, `overdue_task`, `skipped_task`, `unfinished_task`, `must_follow_up`, `refusal` (`HANDOVER_ITEM_KINDS`, in order of urgency; a CHECK); `source_type` one of `task`, `observation`, `incident`, `body_map_mark`, `care_note`, `notification` (a CHECK); `position` the order compiled and added, from 0; instants in UTC | References only, never the source's words; append-only (never removed or changed); unique key and position per handover; readable only by those who can see the person |
| `handover.compiled_at`, `refreshed_at`, `locked_at` | Instants in UTC | Notes close at `locked_at` or the shift's end; late additions and acknowledgements continue |
| `handover_note.item_key`, `person_id`, `body` | The key of a `handover_item` of the same handover (a composite foreign key), or empty for the whole handover; the item's person, set from the item by a trigger; free text up to 2,000 characters | Append-only |
| `handover_acknowledgement.item_keys`, `acknowledged_at` | The keys of the items the person could see when they acknowledged (recorded by the server, never sent by the device); server time in UTC | Append-only; one row per acknowledgement, so a late addition asks again |
| `care_note.tags` value `handover` | Fixed tag "Include in handover" (`HANDOVER_NOTE_TAGS`, beside `fall` and `refusal`) | A tagged note is compiled as a `flagged_note` item; an untagged note never reaches the handover (H-155) |
| `notification.person_id`, `location_id` | References to `person` and `location`, each a composite foreign key with the tenant | Set on urgent alerts (care triggers, overdue tasks, DoLS reminders, overdue statutory notifications and their escalation copies); migration 0028 filled them for earlier alerts from their source |
| `notification.kind` `care.handover.updated`, `care.handover.unacknowledged` | Staff notices about a handover: late additions, and the alert to the nurse in charge when nobody on the incoming shift has acknowledged by `handover.acknowledgement_grace_minutes` | Generic titles naming nobody; never items of a handover |
| `PersonSummary.iddsiFoodLevel`, `iddsiDrinkLevel` (API) | IDDSI food `3`, `4`, `5`, `6`, `7EC`, `7`; drink `0` to `4`; or `not_recorded` | The prescribed levels from `person_care_profile`, on every point-of-care header (round stops, handover people); never read as a normal diet when not recorded (HZ-016) |

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
| `admission_condition` | Harbour | `condition` (free text, never blank), `position` (from 0); met by and at, both or neither | One row per condition of a "yes, with conditions" decision, confirmed as met before admission. |
| `welcome_checklist_item.status` | Harbour | `pending`, `done`, `not_applicable` (with a reason, only where the item allows it); `required`, `safety_critical` flags | Copied from `welcome_checklist_template` at admission; item keys stay as the template set them. |
| `key_issue.issued_to` | Harbour | `person`, `representative`; `issued_on`, then `returned_on` or `reported_lost_on` (`YYYY-MM-DD`, never both, never before issue) | A key neither returned nor reported lost blocks the exit. |
| `placement.start_date` | MODS admission date (concept) | `YYYY-MM-DD` | The admission date of the current placement. |
| `bed_occupancy.from_date`, `to_date` | Harbour | `YYYY-MM-DD`, `to_date` exclusive | The person's room and bed over time; `person.room_label` is a display cache of the current one. |
| `property_item.category` | Harbour | `clothing`, `jewellery`, `watch`, `electronics`, `mobility_aid`, `sensory_aid`, `dentures`, `documents`, `furniture`, `ornament_or_picture`, `toiletries`, `other` | Cash is never an inventory item (residents' money ledger). |
| `property_item.status` | Harbour | `held`, `sent_with_person`, `returned`, `disposed`, `lost` | |
| `property_item` recipient capacity | Harbour | `person`, `representative`, `personal_representative`, `receiving_provider` | After a death only `personal_representative` (executor or administrator). |
| `property_item` signatures | Harbour typed-name signature | Signer `person`, `representative` or `unable_to_sign` with a reason; typed name; time | A second staff member witnesses valuables and unsigned items. |
| `care_plan_change.kind` | Harbour | `return_from_hospital`, `fall`, `change_in_needs`, `new_diagnosis`, `safeguarding`, `end_of_life`, `other` | Raises the care plan review on change. |
| `review_record.kind` | Harbour | `care_plan`, `la_review`, `family_involvement`, `trial_review` | |
| `review_record` family involvement | Harbour | `attended_review`, `contributed`, `invited_declined`, `person_declines_involvement`, `no_family_or_representative` | The last two stop the family involvement clock. |
| `hospital_transfer` pack sections | NHS England hospital transfer pathway (red bag) content; allergies as `allergy`; About Me as `about_me`; communication needs as AIS; resuscitation as the care module's advance care record (ReSPECT, DNACPR); IDDSI levels as the care profile | `photo`, `allergies`, `medicines`, `communication`, `resuscitation`, `about_me`, `eating_and_drinking` (safety-critical); `reason_for_transfer`, `baseline`, `capacity_and_legal`, `contacts`, `infection`, `items_sent`, `home_contact` | The snapshot is stored as JSON (`pack`) with the missing critical sections and `attention` (codes `resuscitation_conflict`, `resuscitation_review_overdue`, `medicines_need_checking`, `photo_not_printable`, `allergy_confirmation_not_recorded`); the resuscitation section holds the CPR `decision` in force, `conflicting`, the review date and the ReSPECT and DNACPR records; the PDF is rendered from it on request (ADR-0040), never from the live record. Packs stored before the review keep their older shape and print as they were. Medicines are dm+d-coded from Phase 2. |
| `exit_record.kind` | Harbour | `discharge`, `transfer`, `death` | |
| `exit_record` destination | MODS discharge destination (concept); NHS Data Dictionary discharge destination items to be checked | Destination type (`own_home`, `family_home`, `care_home`, `hospital`, `hospice`, `supported_living`, `other`) and the receiving provider's CQC location ID or ODS code | Sets `person.discharged_at`. |
| `exit_record` death details | NHS Data Dictionary PERSON DEATH DATE (date part of `person.deceased_at`); place of death (concept) | Place `care_home`, `hospital`, `elsewhere`; expected or not; verified by (name, role) and at | Sets `person.deceased_at`. |
| `exit_record.learning_disability_or_autism` | LeDeR (concept) | `true` or `false`, no default (migration 0023) | An explicit answer for every death, never assumed; a discharge or transfer that does not say records `false`. Decides the LeDeR notification. |
| `exit_record.status_before`, `status_before_since` | Harbour | `active`, `on_leave`, `in_hospital`; ISO 8601 UTC | Phase 1 (migration 0023). The person's status when the exit was recorded and when it began: a correction of the exit as recorded in error returns the person to it (people.md rule 2). Null for exits recorded before the migration, which return to `active`. |
| `exit_record.state` | Harbour (`DISCHARGE_WORKFLOW`, `TRANSFER_WORKFLOW`, `DEATH_WORKFLOW`) | `planned`, `left`, `recorded`, `awaiting_return`, `closed`, `cancelled` (with a reason) | Mirrors the exit workflow instance; `regulator` is `cqc`, `ciw`, `care_inspectorate` or `rqia`. |
| `exit_checklist_item.status` | Harbour | `pending`, `done`, `not_required` (with a reason, only where allowed) | Item keys from `exitChecklist` in `packages/domain/src/people/exit.ts`. |
| `sharing_decision.sections` | Harbour | `about_me`, `daily_updates`, `photos`, `activities_and_visits`, `care_plan`, `health_summary`, `medicines`, `appointments`, `finance`, `benefits`, `documents`; care plan domains as the PCSP domains | `benefits` is the only section a DWP appointee covers; `finance` and `benefits` need a property and financial affairs authority. |
| `sharing_decision.basis` | UK GDPR and Caldicott principle 7 (direct care) | `consent`, `legal_authority`, `best_interests`, `direct_care` | Consent covers optional processing only (records of processing B8). |
| `sharing_decision` authority role | Mental Capacity Act 2005 (Office of the Public Guardian registrations, Court of Protection orders); DWP appointeeship | `lpa_health_welfare`, `lpa_property_finance`, `deputy_personal_welfare`, `deputy_property_affairs`, `appointee` | From `contact.role` and `contact.authority_scope`, with reference, evidence document and end date. |
| `sharing_decision` deputy order sections | Court of Protection order (Mental Capacity Act 2005 s.16 and s.20) | `sharing_decision.sections` codes, as recorded from the order | Required for `deputy_personal_welfare` and `deputy_property_affairs`; a deputy is never shown a section outside it. |
| `sharing_decision_suspension` | Harbour | `suspended_at`, `lifted_at` (UTC; `lifted_at` empty while it lasts), reason, lifted by and the reason it was lifted | Periods, not a single flag (migration 0025): an update from a suspension period stays closed after it ends (comms.md rule 2). `lifted_at` after `suspended_at`; one open period per decision; `sharing_decision.suspended_at` mirrors the open one. |
| `sharing_decision` capacity | Mental Capacity Act 2005 s.1(2) (presumption of capacity) | `presumed`, `assessed_has_capacity`, `assessed_lacks_capacity` | Links the capacity assessment where one exists. |
| `about_me_share_link.token_hash` | Harbour | Lower-case hex SHA-256 of the link token (64 characters) | The token itself is shown once and never stored; expiry no later than the sharing decision's end. |
| `recorded_after_exit` on `care_note`, `observation`, `body_map_mark`, `assessment`, `activity_record` and `visit_log` | Harbour | `true` or `false` | Phase 1. True when an entry about an event at or before a discharge, death or move to hospital, or within the clock tolerance after it (`sync.clock_drift_flag_minutes`), is accepted after it (people.md rule 3, HZ-006); shown with the late-entry flag. |
| `handed_over_by` on `care_note`, `observation`, `body_map_mark`, `activity_record` and `visit_log` | Harbour | UUIDv7 (`tenant_user.id`) or null | Phase 1 (migration 0041). "Sent by": the manager who handed the entry over from a device for its author (`created_by`), when one did (care.md section 6, Device integrity part 6); null when its author sent it. Returned as `handedOverBy` with every entry item. |
| `task_id`, `task_outcome` on `care_note`, `observation`, `body_map_mark`, `assessment`, `activity_record` and `visit_log` | Harbour (`TASK_LINK_OUTCOMES`) | UUIDv7; `completed`, `task_cancelled`, `task_already_closed`, `not_linked`, `medicines_conflict` (migration 0026) | Phase 1 (migration 0023). The task the entry named and what the entry did to it (care.md rule 13, HZ-004, HZ-006): set together or not at all (check `<table>_task_outcome`). `task_already_closed` and `not_linked` are listed for review by the nurse in charge; `medicines_conflict` (a medicines task the entry could not complete) for an urgent conflict review. |
| `body_map_mark.drawn_x`, `drawn_y`, `drawn_zone`, `drawn_side` | Harbour (`BODY_MAP_DRAWING` in `packages/domain`) | `drawn_x` 0 to 120 and `drawn_y` 0 to 240 in the drawing's own units (x from the viewer's left, y from the top), or both null when a zone was chosen with the buttons; `drawn_zone` `viewer_left`, `centre`, `viewer_right`; `drawn_side` `left`, `right`, `midline` (the person's own) | Phase 1 (migration 0043; care API follow-ups). Where the mark was placed and the side the server worked out from it and the view (care.md rule 7, HZ-019). Set together (check `body_map_mark_drawing`); null on marks recorded before. Returned as `drawnSide` on `BodyMapMarkItem`. |
| `body_map_mark.drawn_from_device_side` | Harbour | `true` or `false` (default) | Phase 1 (migration 0045; #26 review round 2, C4). True when a phone from before the server read the drawing sent only the side it worked out, and the zone was taken from that side on the view; then `drawn_x` is null (check `body_map_mark_drawn_from_device_side`). Returned as `drawnFromDeviceSide`. |
| `FluidDay.flaggedEntries`, `flaggedIntakeMl`, `flaggedOutputMl` (API) | Harbour | Whole numbers (count, ml) | Phase 1 (#26 review round 2, C3). Of the fluid entries counted for the day, those a device recorded deleting (`entry_device_deletion_flag`) and the intake and output they add; they stay in the totals, shown beside them (care.md rule 6; HZ-040; H-165). |
| `FluidDay.refusedEntries`, `refusedOfferedMl` (API) | Harbour | Whole numbers (count, ml) | Phase 1 (#26 review round 3). Drinks offered and refused that day and the amount offered; a refused drink adds nothing to `intakeMl` or the shortfall (care.md rule 6; HZ-014; H-167). |
| `observation.flags.alertRoute` | Harbour | `nurse_in_charge`, `fallback`, `no_one` | Phase 1 (#26 review round 3). Who an entry's urgent alert reached, worked out before the entry is written: the nurse in charge, the fallback (someone else who can open the record), or no one; absent when the entry raised no alert, and on entries saved before it was kept (care.md rule 6; HZ-014, HZ-016). |
| `care_plan.copy_from_active` | Harbour | `true`, `false`, or null | Phase 1 (migration 0047; #26 review round 3). Whether starting the draft asked to copy the active plan (`CreateCarePlan.copyFromActive`), so a start sent again with its client id is compared with it (HZ-029); null for drafts started before. |
| `care.alert.unrouted` audit event | Harbour | Reason and `scope.reasonCode`: `news2_threshold`, `iddsi_level_not_recorded`, `iddsi_reason_missing`, `iddsi_prescribed_unreadable`, `iddsi_unsafe_level`, or `urgent_result` for an alert stored before codes were kept | Phase 1 (#26 review rounds 2 and 3). An urgent result alert no one who can open the record could be told about: the result's opaque ids, the person and location ids, and a coded reason, never the result in words (HZ-014). |
| `observation.flags.iddsiProblem` | Harbour | `level_not_recorded`, `reason_missing`, `prescribed_unreadable` | Phase 1 (care API follow-ups). On a food or drink entry kept from a device although the web form would have refused it for its IDDSI level (care.md rule 6, HZ-016, C3), beside `iddsi` (`outcome` adds `level_not_recorded` and `prescribed_unreadable`) and `iddsiAlert`; absent otherwise. |
| `StaffName` on API outputs (`recordedByStaff`, `handedOverByStaff`, `changedByStaff`, `publishedByStaff`, `assigneeStaff`, `completedByStaff`, `createdByStaff`, `decidedByStaff`, `authorStaff`, `sentByStaff`, a handover's `staff` and acknowledgements) | Harbour (from `tenant_user.display_name` and `job_title`) | `{ id, displayName, jobTitle }` or null | Phase 1 (care API follow-ups; care.md section 5). Beside every opaque staff id a care response returns, read under the caller's row-level security and only on records the route already lets them read; null for a member not of the organisation (a system job). Never the email. Regulation 17 attribution. |
| `escalation_policy_link` | Harbour (`ESCALATION_POLICY_TOOL_BANDS` in `packages/domain`) | Tool `news2`, `must`, `waterlow`, `braden`, `ng249_falls`; band one of the tool's bands (NEWS2 `low`, `low_medium`, `medium`, `high`; MUST `low`, `medium`, `high`; Waterlow `not_at_risk`, `at_risk`, `high_risk`, `very_high_risk`; Braden `severe_risk`, `high_risk`, `moderate_risk`, `at_risk`, `below_at_risk_threshold`; none for the falls pathway) or null for every band; location or null for the organisation; title (3 to 200 characters), reference (up to 100), policy document | Phase 1 (migration 0043; care API follow-ups). The organisation's escalation policy a validated tool's result links (care.md rule 5, HZ-012, HZ-014): a location's own policy for the band wins, then the location's for the tool, then the organisation's for the band, then for the tool; otherwise `not_configured`. Returned as `EscalationPolicyRef`. Configuration, not personal data; mutable, versioned, soft-deleted; one live link per tool, band and place. |
| `discard_reason` | Harbour (`DEFAULT_DISCARD_REASONS` in `packages/domain`) | Code `^[a-z][a-z0-9_]{1,39}$`; English and Welsh labels; order; seeded; retired at | Phase 1 (migrations 0043 and 0044; care API follow-ups). The organisation's coded reasons for deleting unsent entries on a device (care.md section 6, Device integrity part 8; HZ-040, H-146). Every organisation starts with the five the phone offers (`recorded_elsewhere`, `entered_in_error`, `staff_left`, `nurse_in_charge_informed`, `other`), seeded by a trigger on `tenant`; a code is never deleted, only retired. Configuration, not personal data. A deletion with an organisation's own code is audited as `other` with the reason's id (`organisationReasonId`), never the code, so words an organisation writes never enter the hash-chained trail (#26 review round 2). Adding, changing and retiring a reason are audited by its id only, and a reason is changed by its id (`PUT /v1/discard-reasons/{reasonId}`; `DiscardReasonItem.id`), never its code in a URL (#26 review round 3). |
| `device_discard_record` | Harbour | Deletion id, stage `requested`, `deleted`, `failed`; kind `held_deleted`, `signed_out_with_unsent`, `refused_removed`; coded reason (a `discard_reason` code); owner, deleter and sender `tenant_user` ids; device id; count; when deleted and recorded | Phase 1 (migrations 0043 and 0044; care API follow-ups). One row per stage of each deletion record (the discard replay index: unique on deletion and stage), written only in the system's view, append-only; the audit events stay the hash-chained record. Filled from the audit trail by migration 0044. Retention class `audit_event`. |
| `entry_device_deletion_flag` | Harbour (`DEVICE_DELETION_FLAGS`) | Entry id and table (`care_note`, `observation`, `body_map_mark`, `activity_record`, `visit_log`, `assessment`); flag `uploaded_after_deletion`, `deleted_after_upload`; person, location, owner, deletion id, review task | Phase 1 (migrations 0043 and 0044; care API follow-ups). The server's flag on an entry its device recorded deleting (care.md section 6, Device integrity part 8; HZ-040), one per entry (unique on table and entry id, migration 0045), append-only, written only in the system's view and read like the entry. Returned as `deviceDeletion` on every entry item. Filled from the audit trail by migration 0044. Retention class `care_record`. |
| `break_glass_event.reason_code` | Harbour | `emergency_care`, `covering_another_area`, `safeguarding`, `incident_or_complaint`, `request_from_professional`, `other` | Phase 1; the typed justification is kept as well. |
| `people.person.break_glass` audit event, outcome `denied` | Harbour | Reason `person_not_found` (no such person in the organisation) or `outside_read_scope` (the member's read permissions could not open the record even by break-glass); resource the person's id | Phase 1 (ADR-0071 review round 2). Written after the refused attempt is rolled back, in its own transaction, so a refusal leaves a record; the typed justification is not kept for a refused attempt. |
| `care.refused_entry.unrouted` audit event | Harbour | Reason and `scope.reasonCode` `refused_entry_urgent`; resource the review task; `scope.personId`, `scope.locationId` (opaque ids) | Phase 1 (ADR-0071 review round 2, C2-M1). Written as the system when an urgent refused-entry review could be told to no one: no nurse in charge who can read the person's record and notes, no holder of `care.plan.write` who can see the person, and no fallback. |
| `PersonSummary.access` (API output, not stored) | Harbour | `reaching` (the permission keys the caller may use whose scope reaches the person without break-glass, sorted), `recordCare` and `editCarePlan` (booleans: whether `care.note.write` and `care.plan.write` are among them), `readOnlyReason` `break_glass`, `scope` or null | Phase 1 (ADR-0071 review rounds 2 and 3, C2-M2 and C3-M1). Decides which forms each tab of the record offers; the API still checks every write. No two-step sign-in field: a session without it cannot read the person at all (review round 5). |
| Sync token write claims | Harbour | `entries_write_location_ids` (location ids), `entries_write_assigned` (boolean), `entries_write_person_ids` (the ids of the people the user is assigned to, when `entries_write_assigned`, at most 100, else absent) | Phase 1 (ADR-0071 review rounds 2 and 3, C2-M3 and C3-M2). Where `care.note.write` reaches; no stream reads them. The phone keeps the last token's values in its keystore (`harbour.write-scope.v1`: location ids, person ids and a flag, no names or care data), cleared at sign-out and when a session is held, to decide where it offers recording. When the item cannot be removed it is overwritten with `null`, so no older scope is found; with none known the phone records about no one (review round 5). |
| Sync token handover claims | Harbour | `handover_location_ids` (location ids), `handover_assigned` (boolean) | Phase 1 slice 10 part 2. Where `care.handover.manage` reaches (ADR-0071): the locations whose handovers sync whole, and whether the handovers where the user's assigned people live sync, limited to those people. Read by the `*_handovers` streams only; the open tasks follow the care claims (`care.plan.read`). The token's audit event counts them (`handoverLocations`, `handoverAssigned`). |
| Device copies of the round and the handover | Harbour (`packages/sync/src/client/schema.ts`) | `task` (open tasks: ids, kind, title (free text, 3 to 120 characters, as the round view shows it), required permission, source, assignee, due window, priority, evidence required, status, restore code, escalation level, updated time, version), `handover` (location, shift name, start and end, compiled and locked times), `handover_item` (the server's `key` as `item_key`, position, kind, person, source, `at`, late addition, added time), `handover_note` (item key, person, body, created time and author), `handover_acknowledgement` (the user's own: user, item keys as a JSON array, server time), `handover_staff_acknowledgement` (for a whole reader, who acknowledged and when: user and server time, never item keys, which name people and what happened to them); times ISO 8601 UTC, booleans 0 or 1 | Phase 1 slice 10 part 2. Read-only on the device; no task details or reasons, no handover refresh time or version, no device ids. Kept while in scope and in the offline window, cleared with the rest of the device's copy at sign-out or wipe. |
| Device-only columns for the round and the handover | Harbour (`packages/sync/src/client/schema.ts`) | `task.queued_transition` (JSON: the move's UUIDv7, `done` or `skipped`, the reason, the version seen, the member's `tenant_user` id, the device time, tenant, person, the task's home (`location_id`), due time and title); `handover_acknowledgement.location_id` and `seen_token` (43 characters, base64url); `task_id` on the five entry tables (the round's task the entry is the evidence for, sent as `taskId`) | Phase 1 slice 10 part 2. Written on the device only and never sent by the server, so the server's copy clears them; a refused move or acknowledgement is kept with them in `upload_issue` until removed with a coded reason. |
| `task.escalation_unrouted` audit event | Harbour | Reason and `scope.reasonCode`: `assignee_only` (only the assignee could be told, and was; review round 4), `no_one_sees_person` (a task about a person), `no_one_reaches_location` (one about no one); resource the task; `scope` kind, location id, required permission, due time | Phase 1 (ADR-0071 review round 3, C3-M3). Written as the system on the first occurrence and then at most once a day per task and reason while an overdue task can be told to no one active other than its assignee; the task is not marked escalated and is tried again every hour, every such task in each run (review rounds 3 to 5). |
| `people.break_glass_alert.unrouted` audit event | Harbour | Reason and `scope.reasonCode` `no_recipient` (no one) or `opener_only` (only the person who opened it holds the roles alerted; review round 5); resource the break-glass record; `scope.personId`, `scope.locationId` (opaque ids) | Phase 1 (ADR-0071 review round 4). Written as the system when a record is opened by break-glass and no Registered Manager reaching the home and no quality lead other than the opener is active to be alerted; the record still opens. |
| `escalation.unrouted.daily` (operator log line, not stored) | Harbour | `tenantId` (opaque), `counts` per unrouted audit action over the last 25 hours | Phase 1 (ADR-0071 review rounds 4 and 5). One line a day per organisation with any unrouted safety work; no personal data and no free text. A CloudWatch metric filter on the worker's log group counts it for an alarm ([on-call runbook](../runbooks/on-call.md)). |
| `worker.job.failed` (operator log line, not stored) | Harbour | `queue` (the job's queue), `error` (the error's kind), `code` (a database code, or null), `tenantId` (opaque, when one organisation's part of a sweep failed) | Phase 1 (ADR-0071 review round 5, C5-M1). One line per failed job or failed organisation's part; never an error message, which may hold data. A CloudWatch metric filter counts it for an alarm ([on-call runbook](../runbooks/on-call.md)). |
| `safety.notification.unrouted` audit event | Harbour | Reason and `scope.reasonCode` `no_active_submitter`; resource the statutory notification; `scope.locationId` (opaque id), `scope.dueAt` | Phase 1 (ADR-0071 review round 5, C5-M3; HZ-013). Written as the system at most once a day per notification while an overdue draft has no active holder of `safety.notification.submit` at its location to alert; the draft stays unalerted and every run tries again. Counted in `escalation.unrouted.daily`. |
| `platform.escalation.unrouted` audit event | Harbour | Reason and `scope.reasonCode` `no_recipient`; resource the notification; `scope` chain id, step index, role key, location id | Phase 1 (ADR-0071 review round 3, C3-M4). Written as the system when an escalation chain step, and its fallback (a Registered Manager reaching the home, else the owner), reach no one active. |

## Packs and governance (Phase 1, slice 11)

Code lists for [operations.md](operations.md), [quality.md](quality.md) and [comms.md](comms.md).
None of these fields has a national standard; they are Harbour's, and are exported in the full
tenant export with these names.

| Harbour field | Standard mapping | Code list or format | Notes |
| --- | --- | --- | --- |
| `downtime_pack.source` | Harbour | `server_nightly`, `server_rebuild` (the system again after someone moved or their status changed; migration 0055), `server_on_demand`, `kiosk_cache` | |
| `downtime_pack.generated_at`, `as_at`, `valid_until` | Harbour | ISO 8601 UTC; shown dd/mm/yyyy hh:mm UK time | `valid_until` = `as_at` + `downtime_pack.valid_hours` |
| `downtime_pack` content sections | Harbour; allergies as `allergy`, communication needs as AIS, resuscitation as `advance_care_record`, IDDSI levels as the care profile (IDDSI framework codes, food and drink separately), care plan domains as the PRSB PCSP domains | `identity`, `allergies`, `resuscitation`, `iddsi_food`, `iddsi_drink`, `communication`, `evacuation`, `medicines_due`, `contacts`, `care_plan`, `risks`, each with status `included`, `not_recorded`, `held_elsewhere`, `withheld`, `conflicting` (resuscitation records that disagree) or `unreadable` (a stored value that is not a valid code) | The snapshot is stored as JSON only; the PDF is drawn on request and never stored (#45, #46). The resuscitation section lists every active ReSPECT and DNACPR record. Medicines due list scheduled doses (`due`, `given`, `not_given`) and PRN medicines with their last-given time, dm+d-coded from Phase 2 |
| Location settings `downtime.mar_location`, `downtime.peep_location` | Harbour | Plain text, worded for the printed page | Where the paper MAR and the PEEPs are kept until the eMAR (Phase 2) and PEEPs (Phase 3) |
| `outage.kind` | Harbour | `power`, `network`, `harbour_unavailable`, `device_failure`, `planned_maintenance`, `other` | With a free-text description |
| `outage.started_at`, `ended_at`, `declared_at`, `closed_at`, `back_entry_due_at` | Harbour | ISO 8601 UTC | `ended_at` null while open; the outage window used by back-entry |
| `outage` state | Harbour | `declared`, `closed`, `reconciled`, `cancelled` | |
| `late_entry_reason` (care events) | Harbour | `downtime` or null | With `outage_id`, `outside_outage_reason` (free text, only outside the window), `paper_reference` and `not_from_paper_reason` (free text, for an entry inside an outage that was not copied from paper) |
| `paper_date`, `paper_time`, `paper_occurrence` (care events) | Harbour | `YYYY-MM-DD` and `HH:MM` as written on the form, UK wall-clock time (stored as a date and a time of day to the minute, migration 0053); `only`, `earlier` (BST) or `later` (GMT) for the repeated autumn hour | Kept beside the resolved event instant (`resolvePaperTime`) |
| `outage` reconciliation | Harbour | reconciled by and at, statement (free text), reviewed entry ids, forms entered (count) | The reconciler cannot have entered records for the outage |
| `outage` declaration, correction and cancellation | Harbour | declared by and at (set by the database), `declared_late` (worked out by the database: declared more than `care_note.late_entry_hours` after the start, or no figure found); `correction_reason` (free text, why the start or end was last corrected; each correction in the history); cancelled by and at, cancellation reason (free text) | Migrations 0050 and 0051. A cancelled outage is final and does not count against overlaps |
| `downtime_pack` row | Harbour | `person_ids` (the people on its pages, worked out from the content by the database), `generated_by` (null for the nightly job), `warnings` (JSON: counts only, keyed by kind or section), `document_id` (always null: the PDF is never stored; a CHECK from migration 0055 keeps it so) | Migration 0050. Append-only; the row-level security policy reads `person_ids` |
| `location.downtime_mar_location`, `location.downtime_peep_location`, `downtime_places_confirmed_at`, `downtime_places_confirmed_by` | Harbour | Plain text, 1 to 200 characters; ISO 8601 UTC and a `tenant_user` id, both empty until confirmed | Migrations 0050 and 0051. The location settings `downtime.mar_location` and `downtime.peep_location`, seeded with `DEFAULT_PAPER_MAR_LOCATION` and `DEFAULT_PEEP_LOCATION`, changed and confirmed only by holders of `platform.location.manage`; a changed place is unconfirmed again |
| `evidence_pack.recipient` | Harbour | name, organisation, work email (lower case) | The recipient is personal data (records of processing) |
| `evidence_pack.purpose`, date range, locations, statements | Harbour; statements as the CQC quality statement ids of the framework model (QUAL-001, Phase 2) | Free text; `YYYY-MM-DD` inclusive; location ids; statement ids | |
| `evidence_pack_item` field outcome | Harbour | key; kind `organisational`, `care_content`, `direct_identifier`, `staff_name`, `third_party`, `free_text` (from `EVIDENCE_FIELD_KIND_MAP` by record type, [quality.md](quality.md) rule 3); `included`, `redacted`, `withheld`, with reason `third_party`, `staff_role_only`, `free_text_redacted_by_hand`, `person_not_in_scope`, `person_unknown`, `identifier_not_needed`, `free_text_not_reviewed`, `redaction_incomplete`; redacted by (user id) | Roles printed in place of names come from `EVIDENCE_PARTY_ROLES` and `EVIDENCE_STAFF_ROLES` |
| `evidence_pack_item` record type | Harbour | `incident`, `care_note`, `observation`, `body_map_mark`, `assessment`, `care_plan_section`, `risk_assessment`, `activity_record`, `visit_log`, `advance_care_record` | |
| `evidence_pack_item` exclusion | Harbour | `restricted_record`, `outside_date_range`, `location_not_requested`, `not_tagged`, `statement_not_requested`, `person_not_in_scope` | Internal manifest only |
| `evidence_pack_link` | Harbour | token hash (SHA-256, never the token), issued by and at, replaces link, `expires_at`, `revoked_at`, failed code attempts (never decreases) | ADR-0050 |
| `evidence_pack_link_code` | Harbour | code hash (HMAC-SHA256 of the link and code under the server key `EVIDENCE_LINK_SECRET`; never the code), `issued_at`, `used_at` | Six digits, single use, valid `evidence_pack.code_valid_minutes`, at most three open per link; verification lives in an encrypted (AES-256-GCM) and signed `__Host-` HttpOnly, Secure, SameSite=Strict session cookie per link (organisation, link and pack ids, the verified address, its expiry), not in the database |
| `statement_of_purpose_version` sections | CQC (Registration) Regulations 2009 Schedule 3 | `aims_and_objectives`, `services_and_needs`, `contact_details`, `legal_status`, `locations` | Contact details are business details of the provider and registered managers |
| `statement_of_purpose_version.legal_status` | Harbour | `individual`, `partnership`, `limited_company`, `limited_liability_partnership`, `charitable_incorporated_organisation`, `community_interest_company`, `nhs_body`, `local_authority`, `other` (with detail) | |
| `statement_of_purpose_version` kind and state | Harbour | kind `baseline`, `revision`; state `draft`, `approved`, `superseded`, `discarded` | |
| `statement_of_purpose_version` approval and notification | Harbour | `version_number` (1, 2, 3 in the organisation, set by the database), author, contributors, `supersedes_id`, approved by and at, `notification_due_at` (approval plus `cqc.statement_of_purpose.revision_notice_days` UK days, worked out by the database; null for the baseline), notified by and at, `notification_evidence` (the CQC reference or how it was sent), discard reason | Migration 0057. One draft and one approved version at a time; approved versions are fixed |
| `evidence_pack_item` row | Harbour | `fields` (JSON array: key (at most 64 characters), label (at most 80), kind, outcome, reason, `redactedBy`; never the shown values or a redacted copy), `title` (a generic label, at most 120 characters), `redacted_by` (worked out by the database), `supersedes_id` (a hand redaction adds a row replacing the item) | Migration 0057. Append-only |
| `evidence_pack_bundle` | Harbour | `content` (JSON: the shown value of each included field, hand-redacted copies included, by item id and field key), `deleted_at`, `deletion_reason` `link_ended`, `pack_revoked`, `pack_discarded` | Migration 0057. The PDF is drawn from it on request and never stored; not exported (a temporary copy of records exported in their own tables) |
| `evidence_pack_link` and `evidence_pack_link_code` (migration 0057) | Harbour | link: `revocation_reason` `pack_revoked`, `reissued`; `last_opened_at`; code: `valid_until` (the issue plus `evidence_pack.code_valid_minutes`, at most 10 minutes, worked out by the database) | Token and code hashes are SHA-256 hex; secret in the export |
| `letter_template.kind`, `channel` | Harbour | kind `admission`, `fee_review`, `incident_follow_up`, `duty_of_candour`, `general`; channel `letter`, `email` | |
| `letter_template_version.state` | Harbour (`TEMPLATE_WORKFLOW`) | `draft`, `approved`, `superseded`, `retired` (with a reason), `discarded` (with a reason); `version_number` per template; author, contributors, approved by and at | Approved never by its author or a contributor; subject for email only. |
| Merge fields | Harbour (`MERGE_FIELDS` in `packages/domain/src/comms/templates.ts`) | `{{field.name}}`; types `text`, `date` (`YYYY-MM-DD`), `datetime` (ISO 8601), `money` (whole pence), `number`; data classes `none`, `personal`, `special_category`; flags `multiLine` (never in a subject), `notInEmail` (NHS number, date of birth), `allowsResultsToFollow` (`candour.results` only) | ADR-0051 |
| `letter` | Harbour | template version, person, recipient (`recipient_kind` `person` or `contact` with `contact_id`, one of the person's own contacts), channel, `personal_fields` (the merge field keys used that hold personal data), `special_category` (letters only), `results_to_follow` (candour), `incident_id` and `incident_serious`, `document_id` (a letter's PDF) or `delivery_reference` (an email), sent by and at | The rendered letter is a document about the person; never an email's content; retention by `letterRetentionClass` (`retention_class`, migration 0059) |
| Candour relevant person | Harbour; Health and Social Care Act 2008 (Regulated Activities) Regulations 2014 regulation 20(7) | `service_user`, or `representative` with contact id and basis `death`, `under_16_not_competent`, `lacks_capacity` | Held on the candour record ([safety.md](safety.md)); the letter goes to this person |

`downtime_pack`, `outage` and `evidence_pack_link` are operational records; they are exported in the
full tenant export but map to no national standard.

## Family feed and communications (Phase 1, slice 12)

Code lists for the tables in [comms.md](comms.md) section 2. No national data standard covers a
family feed; addresses follow the internet and telephone standards named below.

| Harbour field | Standard mapping | Code list or format | Notes |
| --- | --- | --- | --- |
| `feed_item.kind` | Harbour | `activity`, `visit`, `appointment`, `shared_note`, `photo`, `care_plan_update`, `finance_statement` | Section from `FEED_ITEM_SECTIONS` (the `sharing_decision.sections` codes); `finance_statement` is a placeholder until Phase 3. |
| `document.category = feed_photo` | Harbour | `feed_photo` (with `person_photo`, `care_attachment`, `person_document`, `organisation_document`) | The only category a family feed photo comes from (JPEG, PNG or WebP, 10 MB; `care_record`). |
| `feed_item.text` | Harbour | Plain text, at most 1,000 characters; an approved phrase (`phrase_key`) or a member of staff's words | Never a clinical note: a shared note's words are written for the family when it is published (the publisher and time are the marking; `source_id` names the note). |
| `feed_item.carePlanDomain` | PRSB PCSP need domains (as `care_plan_section.domain`) | `PCSP_DOMAINS` marked `may_appear` in `FEED_CARE_PLAN_DOMAINS` | Required for `care_plan_update` and empty otherwise (CHECK constraint); the CSO confirms the allow-list (H-110). |
| `feed_item` confirmation | Harbour | Confirmed by (tenant user id) and reason (plain text, at least `FEED_CONFIRMATION_MIN_REASON_LENGTH` characters) | Only when staff words carry an event or wellbeing term (comms.md rule 12); both set or both empty. |
| `feed_item.photoDocumentId` | Harbour | Document id | Only for `kind = 'photo'` (CHECK constraint). |
| `feed_item_withdrawal.reason` | Harbour | `source_corrected`, `published_in_error`, `person_asked`, `photo_consent_withdrawn` | |
| `feed_view` | Harbour | Item, contact, decision, section, care plan domain, person status, capacity for sharing (`presumed`, `assessed_has_capacity`, `assessed_lacks_capacity`), `viewed_by` (the portal account), `viewed_at` (UTC) | The exposure history (comms.md rule 4). Section and domain are copied from the update by the database (migration 0061). |
| `family_portal_user` | Harbour | Tenant user id, person id and contact id (one open link per account and contact); revoked at, by and reason | The link a portal session is resolved from (ADR-0061); never paired with a `person_assignment` (refused by the database both ways); revoked, never deleted (migration 0061). Linked only when the account's verified email equals `contact.email` (trimmed, compared case-insensitively); otherwise refused as `account_not_contact`. |
| `family_channel.kind` | Harbour | `email`, `sms`, `push` | |
| `family_channel.address` | Email: RFC 5321 and 5322 (at most 254 characters); SMS: ITU-T E.164 (`+` and 8 to 15 digits); push: the Expo push token | Text | Proof of the address is the verification, not the format check. |
| `family_channel.opted_out_via` | Harbour | `sms_reply`, `email_link`, `portal` | SMS replies STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT opt out; START or UNSTOP opt back in. |
| `family_channel.suspended_reason` | Harbour | `hard_bounce`, `complaint`, `device_not_registered` | Cleared when the address changes. |
| `family_notification.status` | Harbour | `planned`, `held`, `sent`, `failed`, `cancelled` | Held until quiet hours end (UK time). |
| `family_notification_setting` quiet hours | Harbour | `HH:MM` to `HH:MM`, UK local time; a window may cross midnight | The tenant's window comes from the rate table (`comms.family_notifications.*`). |
| `visit_booking.status` | Harbour | `confirmed`, `cancelled` | With `sequence` for the calendar file. |
| `visit_booking_setting` hours | Harbour | Minutes after midnight, UK time (`minute_of_day`); end up to 1440 (midnight) | No product default. |
| `location_visit_restriction.kind` | Harbour | `outbreak`, `other`; with `from`, `to` (UTC) and a reason for staff only | Refuses online booking at the location with the usual "call the home" message. |
| `visit_log.accompaniment_purpose` | Harbour (Regulation 9A accompanying) | `planned_appointment`, `unplanned_appointment`, `emergency` (`ACCOMPANIMENT_PURPOSES`) | Required for `visit_log.kind = 'accompaniment'`; only planned appointments reach the feed. |
| Visit calendar file | iCalendar, RFC 5545 | `text/calendar`; UID `visit-{booking id}@{portal domain}`; DTSTART and DTEND with `TZID=Europe/London` and a VTIMEZONE, UTC in the repeated autumn hour | Names the home, never the person. |
| Click-to-call | RFC 3966 `tel:` URI with an E.164 number | `tel:+441632960001` | The home's own number only. |
| `consent_record.decision = photos` | Harbour (care consent kinds) | As `CONSENT_DECISION_KINDS` | The basis for photos in the feed, with `best_interests_decision` (decision kind `photos`, a yes or no outcome) where the person lacks capacity. |

## Platform completions (Phase 1, slice 13)

Code lists for [platform-completions.md](platform-completions.md). None maps to a national standard.

| Harbour field | Standard mapping | Code list or format | Notes |
| --- | --- | --- | --- |
| `manifest.json` | Harbour export contract | `format` (`harbour-tenant-export`), `schemaVersion` (semantic version, `EXPORT_SCHEMA_VERSION`, 1.1.0), `kind` (`full`, `changes_since`), `since` (UTC or empty), `exportId`, `tenantId`, `requestedBy`, `generatedAt` (UTC), `snapshotAt` (UTC) and `snapshotAtUk` (local time with offset, zone `BST` or `GMT`), `schema` (path, SHA-256, bytes), `tables` (name as `schema.table`, rows, legal-hold rows, excluded soft-deleted and sample, files with path, format `csv` or `jsonl`, SHA-256, bytes, rows), `currentSummary` (path, SHA-256, bytes, rows; empty for a changes-since export), `notExported` (name, reason), `documents` (included, bytes, quarantined, excluded, destroyed, files with id, path, SHA-256, bytes), `destroyed` (path, count, by table, certificate ids), `auditChain` (verified, first broken position), `complete`, `problems` (`table_missing`, `unexpected_table`, `unclassified`, `file_missing`, `row_count_mismatch`, `foreign_tenant_rows`, `summary_missing`, `summary_row_count_mismatch`, `document_not_written`, `document_checksum_mismatch`), `warnings` (`audit_chain_broken`, `destroyed_without_certificate`) | An export with any problem is never offered (HZ-070, HZ-071). Version 1.1.0 added `kind`, `since`, the snapshot, the current summary, the `_uk_date` columns, units, codes and the CSV guard. |
| `current_summary.csv` | Harbour export contract | `person_id`, `allergy_status`, `allergies` (substance and severity, most severe first, separated by semicolons), `cpr_decision` (`attempt_cpr`, `do_not_attempt_cpr`, `not_recorded`, `conflicting`), `cpr_record_ids`, `cpr_review_overdue`, `iddsi_food` and `iddsi_drink` (level with name and colour, or `not recorded`), `communication_needs_status`, `communication_needs` (need and preferred format), `as_of` (UTC), `as_of_uk` | One row per exported person, worked out by the same functions as the point-of-care header and the transfer pack. `conflicting` lists every record in force. Check these first when moving a person to another system (HZ-071). |
| Export column classification | Harbour (`EXPORT_TABLES`) | `exported`, `internal`, `secret` | Only `exported` columns are written; only the `public` schema is read. Internal and secret columns (`document.storage_key`, `tenant_user.auth_user_id`, `integration_connection.secret_ref`) never leave (HZ-070). |
| `destroyed.csv` | Harbour | `table`, `id`, `destroyed_at` (UTC), `certificate_id` | Records destroyed past retention; their rows are not in the table files. |
| `tenant_export.status` | Harbour | `queued`, `running`, `ready`, `failed`, `expired`, `revoked` | A ready export past its expiry reads as `expired`. |
| `tenant_export.kind`, `downloaded_at`, `downloaded_by` | Harbour | `full`, `changes_since` (with `since`, UTC); the single download's instant (UTC) and member (`tenant_user.id`, always the requester) | Migration 0062. The archive is fetched once and then deleted. |
| `dpia.status` | Harbour | `draft`, `prepared`, `signed`, `superseded` | The onboarding state adds `not_started` and `review_due`. Migration 0063: `dpia_version` from 1, `prepared_by` (tenant_user ids), `version_sha256` (lower-case hex of the canonical JSON of prefill, answers, ratings and ICO reference), `typed_name`, `statement`, `basis` (JSON). |
| `tenant` data protection governance | Harbour | `data_protection_lead_id` (tenant_user id), `sector` (`independent`, `public`), `privacy_notice_url` (https), `dpa_signed_on` (UK date), `uses_data_beyond_direct_care` (boolean or empty: not answered), `marketing_enabled`, `ai_free_text_enabled`, `ai_provider` (`bedrock_london`, `bedrock_eu`, `anthropic`, `tenant_own`) | Migration 0063. |
| DPIA risk ratings | ICO DPIA template terms | Likelihood `remote`, `possible`, `probable`; severity `minimal`, `significant`, `severe`; overall and residual `low`, `medium`, `high` | Risk ids R1 to R12 as the DPIA template. |
| DPIA review triggers | Harbour | `new_purpose`, `new_sub_processor`, `new_data_category`, `feature_enabled`, `yearly_review` | |
| `tenant_setting_decision.kind` | Harbour | `accepted`, `set` | `set` needs the organisation's own rate table row for the key (`checkSettingDecision`). Migration 0064. |
| `retention_decision.kind` | Harbour | `accepted`, `lengthened`, `period_set`, `not_used` | `accepted` and `lengthened` for classes with a default; `period_set` and `not_used` for classes the tenant policy sets; lengthening or setting needs the organisation's own period, a lengthened one longer than the default (`checkRetentionDecision`). Migration 0064. |
| `tenant.staff_file_option` | retention.md | `staff_file.after_leaving`, `staff_file.to_75th_birthday`, or null until chosen | One option for all staff files. Migration 0064. |
| `dcb0160_record.safety_case_version` | Harbour safety case | Free text, 1 to 40 characters, the release's safety case (for example `v0.0`) | Must equal the API's `SAFETY_CASE_VERSION` when recorded (`checkDcb0160Recording`). |
| Sub-processor objection resolution | Harbour (DPA clause 6.2) | `objection_withdrawn`, `not_used_for_tenant`, `services_ended` | |
| `sub_processor_response.kind` | Harbour | `acknowledged`, `objected`, `objection_resolved` | An objection has a notice and grounds of 20 to 4,000 characters; a resolution has a notice and one of the resolutions above; an acknowledgement with no notice acknowledges the register entry. Migration 0065. |
| `sub_processor_notice.kind` | Harbour | `new`, `replacement` | `use` is the `SubProcessorUse` JSON (`always`, `capability`, `ai_provider`). |
| Sample flag | Harbour | `person.is_sample` (boolean), `person.sample_batch_id` (UUID; set exactly when `is_sample`, check `person_sample`); `sample_batch` (`people`, `loaded_by`, `loaded_at`, `removed_by`, `removed_at`; one not removed per organisation) | Sample people: family name `Example`, 999-range NHS numbers that pass the check digit, `example.invalid` emails, Ofcom drama telephone numbers (to verify, H-123), invented addresses (an "Example" street, no postcode or `ZZ99`). Shown with a "Sample" badge; prints carry the watermark "SAMPLE DATA: NOT A REAL PERSON" (HZ-072). Migration 0069. Sample people are left out of the full export and counted. The removal's audit scope is `people` (count) and `records` (table name to count of practice records removed with them). |
| `person.national_data_opt_out_checked_at` | Harbour; NHS national data opt-out | Timestamp (UTC) or empty for "not checked" | The existing boolean cannot say "not checked". |
| Search audit scope | Harbour | `queryKind` (`text`, `nhs_number`), `termCount`, `entityTypes` (`person`, `staff`, `document`, `note`), `omitted` (kind and reason `not_permitted`, `no_scope`, `mfa_required`, `not_applicable`), `includeArchived`, `personScope` (`tenant`, `locations`, `assigned`, or empty when no person record was searched), `locationIds`, `validUntil` (UTC), `resultCounts`, `total`, `resultIds`, `personIds`, `careRecordView`; break-glass: `breakGlassRecordId`, `reasonCode` | Never the words typed or the typed break-glass reason, which stays in the break-glass record (HZ-011). |
| Search vectors | Harbour | `person.search_names`, `person.search_room`, `tenant_user.search_name`, `document.search_title`, `care_note.search_body`: generated `tsvector` columns of the terms `app.search_terms` gives (migration 0066) | Derived plain-text copies of the names, room, display name, document title and note text, in their own rows (never a separate store; ADR-0070): deleting or purging the row removes them, but like the row they stay in backups for 35 days, and crypto-shredding would not reach them if their source column were later encrypted (H-380). Internal in the export catalogue, since they can be rebuilt from the exported columns. |
| `break_glass_event.kind` | Harbour | `open`, `search` | A break-glass search names no person (`person_id` empty) and lasts no time (`expires_at` equals `opened_at`); the people shown are in its audit event, and the homes they live at in `shown_location_ids` for the weekly report (migration 0070). |
| Search match quality | Harbour | `exact` (every term a whole word), `prefix` | Ranks results; a break-glass search shows only `exact` matches. |

## Platform operational tables (not part of the MODS export)

These tables support running the service and are exported in the full tenant export (section 5.1) but
map to no national data standard: `audit_event` (hash-chained), `record_version`, `outbox_event`,
`notification`, `notification_delivery`, `escalation_chain`, `feature_flag`, `form_template`,
`form_submission`, `integration_connection`, `integration_inbound`, `support_access_request`,
`break_glass_event`, `person_assignment`, `role`, `role_assignment` and `access_grant` (each with
`organisation_wide`, whether a role assigned with no location, or a grant, reaches the whole
organisation; ADR-0071 review round 1), and from
Phase 1 `break_glass_weekly_report`, `about_me_share_link`, `welcome_checklist_template`,
`tenant_export`, `dpia`, `sub_processor_response`, `tenant_setting_decision`, `retention_decision`,
`dcb0160_record`,
`family_notification`, `visit_booking_setting` and `family_portal_user`, and from the device
integrity work ([care.md](care.md) section 6) `device_binding` (which member of staff used which
device, by its opaque id, when the server first and last saw them together, and a revocation with
who made it and a coded reason: `lost_or_stolen`, `staff_left`, `access_withdrawn`, `replaced`,
`other`), `device_discard_entry` (the entry ids each stage of a deletion of unsent entries listed:
`requested`, `deleted`, `failed`, with the deletion record and whose entries they were) and
`refused_entry` (the server's copy of a care entry the API refused: its table, the request the
device made for the entry as JSON, in that kind's own contract shape (`CreateCareNote`,
`CreateObservation`, `CreateBodyMapMark`, `CreateActivityRecord`, `CreateVisit`), the refusal's
HTTP status, code and reason, when it was refused, the device and its author; exported with the
care record) and `handed_over_entry` (each entry a hand-over sent: the hand-over id, the device
that held it, its owner, who sent it, the table and entry id and when it was accepted), and from
the care API follow-ups `device_discard_record` (one row per stage of each deletion record, with
its coded reason), `discard_reason` (the organisation's coded reasons) and `escalation_policy_link`
(the escalation policy each validated tool's result links), all described in the table above;
`entry_device_deletion_flag` is exported with the care record. The Phase 1 engines add
`document_signature` (signer capacity `staff`, `person` or `representative`; the name as typed; the
statement; the SHA-256 of the bytes signed; append-only), `legal_hold` (a person, or a subject type
and id; the reason; placed, and released by and at with a reason), `workflow_instance` and
`workflow_transition` (definition key and version, subject type and id, the person where there is
one, state, when it entered it and the SLA due time; each move with who and why) and
`notification_preference` (quiet hours as UK `HH:MM`, channels per notification kind).
`request_quota` (the recent request times of each member under each per-user limit) is
operational and not exported, and `device_session` (the sign-in session ids bound to each device,
so the API refuses them once the device is revoked; read by their member and by jobs, never by a
tenant-wide role) is a security record and not exported (the global
`sub_processor_notice` table is Thapsus's and is not exported either). Every exported table is described in
`EXPORT_TABLES` (`packages/domain/src/platform/export.ts`), which a test keeps in step with the
schema. The task engine's `task` and `task_series` are exported the same way; from migration 0023
they carry `cancel_code` and `inactive_code` (`paused_while_away`, `ended_at_exit`,
`exit_recorded_in_error`, `planned_exit_cancelled`, `missed_before_return_recorded`: why the people
lifecycle stopped them) and `task.evidence_after_close` (evidence that arrived after the task was
cancelled), and `stopped_by_exit_id` on both (the exit record that ended the task or series, so a
correction brings back only what that exit stopped); from migration 0026 `task.restore_code`
(`caught_up`, `answered_while_stopped`: how a return or correction brought the task back) and
`document.image_printable` (whether a JPEG or PNG prints on the transfer pack, decided once at
upload). `task.details` is JSON a review task carries:
`missedTasks` (task id, kind, due time and whether it was reopened; missed medicines rounds first
and never dropped, then the rest newest first), `missedTasksOmitted` (how many more were not
listed), `missedTasksNotListedBefore` (an ISO date, UK time: rounds due before it are not all
listed) and `entries` (entry kind, client id, device id, user id and times; opaque ids only,
never clinical text). A flagged-entry task (`sync.entry_reported_deleted`,
`sync.entry_deleted_after_upload`) adds `ownerTenantUserId` and `entryCount` (its entries up to
50, the rest counted), and a refused-entry review (`care.refused_entry_review`) lists each copy
with `refusedEntryId` and `refusalCode` beside the entry's kind and ids, never its content.
Field-level
detail is in `packages/db/src/schema/`; purposes and lawful bases are in
[records of processing](../compliance/records-of-processing.md).

## Device copies (offline sync, not part of the export)

The mobile app keeps a subset of the care tables on the device (Phase 1 slice 10, [care.md](care.md)
section 6). Device columns use the database column names, so this mapping applies unchanged, with
these differences, defined in `packages/sync/src/client/schema.ts`:

- `observation.values` is `chart_values` on the device, because `values` is a reserved word in SQLite.
- `body_map_mark.drawn_side`, `drawn_zone`, `drawn_x` and `drawn_y` are written on the device and
  sent with the upload as `drawnSide`, `drawnZone` and `drawnAt` (`{ x, y }`, the point tapped in
  the drawing's own units; none when a zone button was used); an entry queued before the device
  kept the zone is sent with the zone its drawn side names on that view. The API works the side out
  again from the place and the view and stores all four (HZ-019); the streams do not send them
  back, so they are empty on synced rows.
- `upload_issue` exists only on the device: an entry the API refused, with its content, until
  someone removes it with a recorded reason (the content never ages out). The device also sends
  the content to the server, which keeps a copy (`refused_entry`; contract `SyncRefusedEntry`,
  which refuses unknown keys: the entry id, table, person id, the request the device made for
  the entry in that kind's contract shape, the refusal's status, code and reason and when it was
  refused); `server_copy` is `copied` once the server confirms it, `refused` when the entry cannot
  become a valid request or the server will not keep it (counted in the device report as
  `copiesRefused` and said on the needs-attention list), or `not_copied` for entries never sent;
  an unconfirmed copy is sent again after each sync. The row itself is never
  uploaded or exported; its removal is recorded through `POST /v1/sync/discards`.
- `held_entry` exists only on the device: entries that had not uploaded when the session ended,
  each with its table, operation and columns as JSON (`payload`) and its place in the queue, kept
  until the owner signs in again and they go back into their tables, a manager (or, on a
  revoked device, the owner) hands them over (the device's report sent first from that sign-in,
  then each entry in the owner's name, with `x-harbour-handover-owner` and `x-harbour-handover`,
  recorded in `handed_over_entry`, kept on the entry as `handed_over_by` and audited as
  `sync.entry.handed_over`: the sender as actor, the owner, the device and the hand-over id; a
  refusal is 422 `handover_refused`, on which or a 404 the entry stays held with the server's
  reason in `handover_refusal`, a plain-English sentence with no personal data, and the rest are
  sent; any 403 stops the hand-over), or the
  owner or a manager
  deletes them with a recorded reason (nothing is deleted automatically; at
  `mobile.held_entries_max_days` the hold escalates to a manager). `sync_meta` keeps the database's
  owner (`tenant_user` id, sign-in id, tenant and name, as JSON) under the id `meta:owner`, the
  cached rate figures (offline window, hold limit, clock tolerance), and the person's own words for
  removing a refused entry under `discard-note:<tombstone id>` (JSON: the coded reason, the words,
  the entry id and the time), which never leave the device (security review round 4, M3).
  Retention class for these words (security review round 5, S-L4): kept only until the server has
  every stage of the deletion they explain (its tombstone has left the keystore), then deleted at
  the next sync; never kept longer than the device itself, which wipes them with everything else.
  They are not part of the care record and are never shown. An entry left by a deletion that did
  not finish moves to `upload_issue` with the code `held_discard_failed` and is never uploaded; the
  device reports how many as `blocked`.
- The held marker in the device keystore (outside the database) holds the owner's ids and name, the
  count, when the hold started, when it escalates, the last server time, `uploadBlocked` when a
  deletion of the entries did not finish, and `revoked` when a manager revoked the device.
- Tombstones of deleted unsent entries are kept in the device keystore, outside the database, as
  JSON with no free text: an id, the kind (`held_deleted`, `signed_out_with_unsent`,
  `refused_removed`), a coded reason (`recorded_elsewhere`, `entered_in_error`, `staff_left`,
  `nurse_in_charge_informed`, `other`), the stage reached (`requested`, `deleted`, `failed`) and
  the stages not yet acknowledged, the tenant, owner and deleter `tenant_user` ids, up to 20 entry
  ids and 10 person ids, the count, the time, why there are no ids (`idsMissing`: `key_absent`
  or `key_invalid`), what a deletion left behind (`leftover`: `file`, `key`) and the opaque id
  of the device the entries were held on (`deviceId`, sent with every stage and recorded in the
  audit scope as `heldOnDeviceId`). Each stage is
  sent to `POST /v1/sync/discards` (contract `SyncDiscard`, which refuses unknown keys: the coded
  reason and no words; up to 500 entry ids when sent at once, the 20 kept when sent later, never
  more than the count) and the tombstone is deleted once the server has every stage of a finished
  deletion. The
  audit events (`sync.entries.discard_requested`, `sync.entries.discarded`,
  `sync.entries.discard_failed`, resource type `device_discard`, the failure naming the request it
  supersedes; `deletedByTenantUserId` null when the device did not know) keep the coded reason only
  (security review round 4, M3; clinical review round 4, H1); each stage also lists its entry
  ids in `device_discard_entry`, which the flag below reads. A leftover file or key is a separate
  security event (`sync.device.residue`, scope `leftover`). An entry uploaded later whose id its
  owner's device recorded as deleted gets a `sync.entry.after_discard` audit event; an entry a
  deletion lists that had already reached the server gets `sync.entry.before_discard` once the
  deletion is recorded as done (scope: the deletion record's id and the task's id); each is also
  kept once on the entry as `entry_device_deletion_flag` (`uploaded_after_deletion`,
  `deleted_after_upload`), returned as `deviceDeletion` on the entry. Each stage of a deletion is
  one `device_discard_record` row; an organisation's own code travels as `organisationReasonCode`
  with `reasonCode` `other`, and only a code in its `discard_reason` list is taken. Each deletion
  record has one review task per kind and location (`sync.entry_reported_deleted`,
  `sync.entry_deleted_after_upload`; source `device_discard`, the record's id; no person id), whose
  title carries the count, whose details carry the owner, the count and the entries, and whose
  audit events (`sync.entry_flag.raised`, `sync.entry_flag.added`, resource `task`) carry the
  deletion record, the owner's `tenant_user` id, the count and how many were added;
  a cap is `sync.entry_flag.capped` (resource `device_discard`, scope `mergedInto`: the owner's
  oldest open task at the location, whose `added` event then carries `merged`). A hold's device
  report (unsent, refused, held and blocked counts, the oldest age, when the hold started, the
  owner's `tenant_user` id and up to 50 location ids, contract `SyncDeviceReport`, which refuses
  unknown keys) may wait in the keystore the same way, with the id of the device that held the
  entries; the server records it as `sync.device.report` (resource `device`, the device id; scope
  adds the waiting count, when the waiting began, `startFloor` (`earlier_report`, `first_seen` or
  null), `ownerBound`, and `claimedOwnerTenantUserId` when the named owner has no `device_binding`
  row for the device). `sync.token.issue` names the device as its resource when the request
  carries its id, and the token and each report bind the member to the device (`device_binding`).
  A revoked device is refused with 403 `device_revoked`, audited as `sync.device.refused_revoked`
  (resource `device`, scope: the route) at most once an hour per device; a revocation is
  `platform.device.revoked` (resource `device`, scope: the reason code, how many bindings, the
  members' `tenant_user` ids and how many sessions it ended). When the device last reported
  entries waiting, the revocation needs `confirmEntriesWaiting` (409 `entries_waiting`), its
  hold's tasks are moved due at once (`sync.device_hold.moved`, scope `because: revoked`) and
  urgent, and the manager is told (`sync.revoked_device_waiting`, the device's opaque id only).
  The device report may carry `copiesRefused` (recorded in its audit scope). While held, unsent or blocked entries wait, the server keeps a task per location
  (`sync.device_hold`, source `device_hold`, the device id) for a Registered Manager, or one per
  Registered Manager when no location is known, written as the reporter, with its raise, reopen,
  moves, reset, merge and close audited (`sync.device_hold.raised`, `.reopened`, `.moved`, `.reset`,
  `.merged`, `.closed`, `.close_refused`, `.capped`; the raise and reopen name the hold's owner and
  any unbound claim, and the reopen whether it reset the escalation; opaque ids only). Holds past a
  reporter's daily cap are on one task per reporter (source `device_hold_capped`, its source id
  the reporter's `tenant_user` id). An overdue sync task no one could be told about is audited as
  `sync.escalation_unrouted` (resource `task`, no actor) at most once a day per reason, coded
  `assignee_only` when only its own assignee could be told (and was; ADR-0071 review round 5). When a cap merges a
  task into another, the location's Registered Managers also get an in-app notification
  (`sync.reporter_capped`, source the member's `tenant_user` id, no names) at most once a day per
  member and source, audited as `sync.capped_notice.sent` (resource `tenant_user`). The keystore
  also keeps the device's opaque id (the PowerSync client id), and the hold's marker and the
  database's owner record keep the owner's location ids.

Timestamps arrive on the device as ISO 8601 in UTC with microseconds (`2026-10-11T09:30:00.000000Z`);
booleans as `1` and `0`; JSON and array columns as JSON text. Entries written on the device carry a
UUIDv7 made there, which the API keeps as the record's `id`.

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
