# Pre-admission, admission, rooms and property screens (PEOP-005, PEOP-007)

Branch `feat/web-admission`.

## What changed

- API (additive): `POST /v1/people` records an enquiry, a new person record at `enquiry` with names
  and a date of birth only (`people.enquiry.manage` at that home, a client id for safe resends,
  never dated later than now); `GET /v1/locations/{id}/services` lists a home's services. Both answer
  a home outside the caller's access as not found. OpenAPI and the typed client regenerated.
- Web: People links to **Enquiries and pre-admission** (`/people/pre-admission`), where people not
  yet admitted are listed (no longer on the residents' list) with their communication needs, and
  **Record an enquiry** (`/people/pre-admission/new`), which asks for a search first.
- Web: three record tabs. **Pre-admission**: start the assessment, the twenty sections ("not
  applicable" never offered for allergies, resuscitation or eating and drinking; done needs what
  was found), the medicines list, sources and involvement, the decision with reasons and
  conditions, replaced decisions struck through, conditions confirmed, close as not admitted or
  re-refer. **Admission and room**: admit into a free bed once the decision allows it, the
  placement, room and bed with move history and a move form, the welcome checklist with
  safety-critical items first. **Property and keys**: items in with who signed and a witness found
  by name (never the recorder), return (after a death only to the personal representative),
  disposal, loss with its incident; keys issued, returned or lost.
- Writes are offered only where the permission reaches the person and the status allows it;
  versions and client ids go with every write; forms post. Strings in en-GB inside `people.`, Welsh
  copied and listed as untranslated.
- Docs: people.md (enquiry route, section 6 web screens, `people.enquiry.manage`), records of
  processing (enquiries; the property witness), data-standards (`status_changed_at` for an
  enquiry), hazard log (HZ-001 and HZ-007 controls; tests for HZ-001, HZ-007, HZ-011, HZ-015,
  HZ-016 and HZ-029).

## What is next

- Staff names on decisions, conditions, the checklist, moves and property (the lifecycle responses
  carry opaque ids only; the screens say "you" or "a colleague").
- The enquiry pipeline itself (PEOP-004: sources, stages, follow-ups), editing demographics and the
  NHS number (PEOP-001), the tenant's welcome checklist settings screen, photos of property items,
  the bed board and room clearance screens, and user guides.

## Human actions logged

- H-470: CSO to confirm the "done needs what was found" screen rule and "you or a colleague" for
  pilot; DPO to confirm the witness found by name.

## Tests

- `apps/api/test/people-enquiries.test.ts` (20 after the security review); `apps/web/src/lib/admission.test.ts`;
  `apps/web/e2e/pre-admission.spec.ts` (3) and `apps/web/e2e/admission.spec.ts` (3), axe in the
  light and dark themes on every state.

## Review rounds

- Security review round 1 (PR #118), `POST /v1/people`:
  - H1: a request sent again with an id no longer answers with a person summary. It is answered
    as the first (`replayed`, audited `people.person.enquiry.replay`) only for the caller's own
    enquiry, still at `enquiry`, with the same location, names, date of birth and time it came in;
    any other record's id, seen or not, is refused alike (422) and audited as denied with the id
    only. Every answer is `EnquiryRecorded` (id, location, status, status time, version).
  - M1: the same id with other details is refused with 409 `id_reused_with_different_details`,
    nothing changed; the web form then starts a new id and asks for the list to be checked
    (HZ-001).
  - M2: the date of birth runs from 1900-01-01 to today (UK), the time it came in from 1900 and
    not before the birth (contract refinements), and a value Postgres cannot hold (class 22) is
    refused with 422. `app.ts` `onError` now logs the error's kind, its code and the stack's
    frames only (`loggableError` in `logger.ts`), never the message or the stack line repeating
    it, which for a failed query holds its values; a log-capture test proves no name or date
    reaches the log (and fails with the old logging).
  - L1: refusals are audited as denied with opaque ids (`outside_scope`, `location_not_found`,
    `id_in_use`, `id_reused_with_different_details`).
- Main merged (#105, #109, #112, #117 and others): the record keeps the reviews and hospital tabs
  beside the three tabs here; People offers the reviews tracker beside enquiries.
