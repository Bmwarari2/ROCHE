# Person record: personal details, About me and sharing screens (PEOP-001, PEOP-003, PEOP-013)

Branch `feat/web-person-details`, no PR yet.

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

- When an authority on a contact changes or ends early, the decisions resting on it keep what they
  were recorded with; re-check or flag them (HZ-022 open control).
- The recipient's page for an About me share link (with the portal; needs a migration like 0058).
- Lifestyle and preference fields, the legal status code list, removing a contact, uploading
  evidence from the contact form (PLAT-009), and choosing care plan domains for a decision.
- The register rows' code, tests and user-docs columns and STATUS are for the coordinator.

## Human actions logged

- None.

## Tests

- `apps/api/test/people-details.test.ts` (26); `apps/api/test/people-lifecycle.test.ts` (the share
  link test checks the version).
- `apps/web/src/lib/person-details.test.ts` and `sharing.test.ts` (38 with the copy test);
  `apps/web/src/lib/care-record.test.ts` (the three tabs).
- Journeys with axe in light and dark themes, run locally against the dev servers:
  `apps/web/e2e/person-details.spec.ts` (4), `about-me.spec.ts` (2), `sharing.spec.ts` (2). Each
  writes only records named with the run on demo resident 6 and puts the opt-out back.
