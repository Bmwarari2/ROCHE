# Leaving the service on the web: discharge, transfer and death (PEOP-010)

Branch `feat/web-exit`.

## What changed

- A new **Leaving** tab on the person's record (`/people/{id}/leaving`) for discharges, transfers
  to another provider and deaths. It plans a discharge or transfer, records one, or records a death
  (whether it was expected and the LeDeR question are always asked, never assumed), then shows the
  checklist with who owns each item, who it tells and when, and what is required by law.
- Items are marked done, or not required with a reason where the checklist allows it. Statutory
  notifications (the regulator's death notification, the medical examiner's information pack,
  LeDeR) are never ticked by hand: they link to their notification page and follow it (HZ-013).
- Property and keys still held are returned on the same tab, with who received them and who
  signed. Confirming the person's money or deposit needs a fresh sign-in and someone other than
  whoever recorded the exit; both refusals are said in words.
- The workflow moves on to waiting for returns, closes, and the record is archived. An archived
  record says "Archived" with an icon on the tab, the header, the people list and search, and the
  tab offers nothing at all. Every status other than "receiving care" now shows beside the name.
- API: `POST /v1/people` records an enquiry (`people.person.create`, location in scope, valid and
  unique NHS number) so the journeys and onboarding can start a person without seeding; the bed
  board gives each room's version so a room held after a death can be cleared; `pnpm --filter
  @harbour/api outbox:run` relays the outbox once for local journeys.

## What is next

- Correcting a discharge or death recorded in error from the Leaving tab (the API supports it, with
  step-up for a death); evidence links on checklist items; disposal and loss of property.

## Human actions logged

- None.

## Tests

- `apps/web/src/lib/exit.test.ts` (what each state and permission set offers, words and icons).
- `apps/api/test/people-lifecycle.test.ts`: recording an enquiry (5 tests) and the room version.
- `apps/web/e2e/exit.spec.ts`: discharge, transfer and death to the archived record, axe in light
  and dark themes (HZ-001, HZ-013).

## Review rounds

- None yet.
