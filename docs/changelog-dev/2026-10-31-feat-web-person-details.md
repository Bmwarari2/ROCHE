# Person record: personal details, About me and sharing screens (PEOP-001, PEOP-003, PEOP-013)

Branch `feat/web-person-details`, PR #119.

## What changed

- API (PEOP-001, additive): `GET` and `PATCH /v1/people/{id}/details` for the MODS-aligned
  demographics and the national data opt-out (versioned; the NHS number passes the modulus 11 check
  and is unique in the organisation; no NHS number needs a local identifier; postcodes stored upper
  case with one space), and `GET`, `POST` and `PATCH /v1/people/{id}/contacts` for key contacts and
  legal representatives (`evidenceMissing` for an attorney, deputy or appointee with neither a
  reference nor evidence, `expired` after the end date, a deputy's order scope required). Reads
  need `people.person.read`, changes `people.person.update`; audited by id and the names of the
  fields changed. Share links now return their `version`, sent back on revocation. No migration.
- Web: three tabs in the record frame. Personal details: the opt-out in words and an icon, every
  detail ("Not recorded" where empty), contacts in two lists with "Ended", "Evidence not recorded"
  and "Valid until" statuses, and forms to change details, record or remove the opt-out, and add or
  change a contact. About me: the seven PRSB parts, who wrote it and when, a form that asks who
  supported the person, and for sharing managers the share links, made under a decision with
  step-up, the code shown once, revoked with a reason. Sharing (`people.sharing.manage` only):
  decisions with their state from the API, recording one, suspending, lifting and withdrawing with
  a reason, and a section-by-section check of what one recipient can see now. Titles name the tab,
  never the person. Strings in en-GB; Welsh copied and listed as untranslated.
- Docs: people.md section 6 (API and web behaviour) and section 11 (open items), the hazard log
  (HZ-001, HZ-011 and HZ-022 controls and verification), records of processing (who sees and
  changes demographics, contacts and sharing decisions), data-standards (contact fields, postcode
  normalisation, the opt-out and legal status on the web).

## What is next

- A foreign key on `contact.authority_document_id` (needs a migration); removing a contact.
- The recipient's page for an About me share link (with the portal; needs a migration like 0058).
- Lifestyle and preference fields, the legal status code list, removing a contact, uploading
  evidence from the contact form (PLAT-009), and choosing care plan domains for a decision.
- The register rows' code, tests and user-docs columns and STATUS are for the coordinator.

## Human actions logged

- None.

## Tests

- `apps/api/test/people-details.test.ts` (43);
  `packages/domain/src/people/sharing-authority-change.test.ts` (15);
  `apps/api/test/people-lifecycle.test.ts` (the share link test checks the version).
- `apps/web/src/lib/person-details.test.ts` and `sharing.test.ts` (38 with the copy test);
  `apps/web/src/lib/care-record.test.ts` (the three tabs).
- Journeys with axe in light and dark themes, run locally against the dev servers:
  `apps/web/e2e/person-details.spec.ts` (4), `about-me.spec.ts` (2), `sharing.spec.ts` (2). Each
  writes only records named with the run on demo resident 6 and puts the opt-out back.

## Review rounds

- Round 1 (security review). M1: an NHS number on a record the caller cannot see is refused
  without saying whose or where, audited as denied without the number, limited to three refusals
  per member an hour, and the owner gets a duplicate-record task; one on a visible record is still
  refused in words. M2: dates of birth from 1900 to today, end dates from 1900 to 2199, control
  characters (including NUL) refused in every people text field, and data exceptions (SQLSTATE
  class 22) answered as 422 in these routes. M3 (HZ-022, fail closed): a contact change that takes
  an authority away suspends the decisions resting on it in the same transaction
  (`authorityChangeEffects`, table-driven tests), audited `authority_changed` and published; the
  open control is closed. L1: changing a portal member's email needs `people.sharing.manage` and
  step-up. L2: evidence must be an available `person_document` of the same person (the missing
  foreign key is logged). L3: real other-person and wrong-category documents, another home and a
  discharged person's contacts tested. L4: the person row is locked when contacts change. The web
  revocation reason now matches the API (500 characters). Main merged.
