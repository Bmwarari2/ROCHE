# Service-user lifecycle (`people`) - specification

Master prompt section 9.2. Phase 0 built the person record foundations; the lifecycle workflows
arrive in Phase 1 (residential) and later phases. Status per feature: [feature register](feature-register.md).

## Built in Phase 0

- `person` (MODS-aligned demographics, validated NHS number, `allergy_status`, communication needs,
  national data opt-out, room label cache, status), `contact` (roles including LPA, deputy, IMCA,
  advocate, appointee, with authority reference and evidence), `allergy`, `placement`, `room`,
  `about_me` (PRSB About Me v2 sections as JSON), `person_assignment`, `break_glass_event`.
  Field mapping: [data-standards.md](data-standards.md).
- Scope: a person is visible to tenant-wide roles, to location-scoped roles at their location, to
  assigned staff, and to holders of an unexpired break-glass record (ADR-0002); contacts, allergies,
  placements and About Me follow the person.
- Point-of-care header data (HZ-001, HZ-007): `GET /v1/people` and `GET /v1/people/{id}` return
  names, date of birth, NHS number, photo link, allergy status and active allergies, and
  communication needs. Every view is audited.
- NHS number validation and display (`packages/domain/src/people/nhs-number.ts`).
- Demo tenant: Harbour House (60 rooms), six residents with invented details and test-range NHS
  numbers, a care worker assigned to three of them (`packages/db/src/seed/demo.ts`).

## Rules

- One person, many placements over time (respite then permanent) under one record.
- The NHS number is the consistent identifier but never the only one (`local_identifier`).
- "No known allergies" is a recorded fact; "unknown" is never displayed as calm (HZ-007).
- Demographic edits are versioned (`record_version`), and nothing is hard-deleted by the app.
- Deceased or discharged people become read-only except for post-event records (Phase 1 rule in the
  API; schema fields `deceased_at`, `discharged_at` exist).

## Phase 1 (next)

Enquiry and referral pipeline, pre-admission assessment, admission with room and property inventory,
About Me authoring, reviews scheduler, hospital transfer pack, discharge and death workflows, family
and professional sharing rules, person photo upload through the document store.
