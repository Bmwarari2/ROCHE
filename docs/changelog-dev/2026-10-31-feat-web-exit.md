# Leaving the service on the web: discharge, transfer and death (PEOP-010)

Branch `feat/web-exit`.

## What changed

- A new **Leaving** tab on the person's record (`/people/{id}/leaving`) for discharges, transfers
  to another provider and deaths. It plans a discharge or transfer, records one, or records a death
  (whether it was expected and the LeDeR question are always asked, never assumed), then shows the
  checklist with who owns each item, who it tells and when, and what is required by law.
- Items are marked done, or not required with a reason where the checklist allows it. Statutory
  notifications the safety module drafts (the regulator's death notification in England, the
  medical examiner's information pack, LeDeR) are never ticked by hand, before their draft exists
  too: the tab says they are waiting to be drafted, then links to the notification page, and the
  API refuses a hand tick (HZ-013). Outside England the regulator's notification is recorded by a
  holder of `safety.notification.submit`, with step-up.
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

- The property return form has no witness field, so returning a valuable or an item nobody could
  sign for is refused by the API (it needs a second member of staff); record those through the
  API until the form takes a witness.

## What is next

- `POST /v1/people` here is temporary: `feat/web-admission` adds the enquiry route
  (`people-enquiries.ts`, `people.enquiry.manage`, client ids). Once it is on main this branch drops
  its own route and the journey records its people through that one.
- The journey's people stay on the residents list once archived (the list shows every status);
  each run finishes any person an interrupted run left, so none is left live. `smoke.spec.ts`
  checks "Allergies not recorded" on Cara's own row, not anywhere in the table.

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

- Self-review (accessibility and security reviewer agents): archiving asks again; unique names on
  buttons and inline forms; a planned exit's details are kept when the departure is recorded; a
  neutral duplicate refusal; `outbox:run` uses the shared demo-seed guard.
- PR #116 security review: `POST /v1/people` refuses an NHS number held only out of the caller's
  scope in the same words as an invalid one, audits both duplicate refusals (denied, without the
  number) and is limited per user (`ENQUIRY_REQUESTS_PER_MINUTE`, default 10); the date of birth is
  from 1900 and not in the future (the route moves to `feat/web-admission`, see what is next;
  the scrubbed error log is that branch's too); drafted notification items cannot be ticked by hand before their draft (M2); clearing a money,
  deposit or DWP flag the plan set needs `finance.ledger.approve` with step-up, and flag changes
  are audited; the person who recorded the departure, as well as whoever planned the exit, may not
  confirm the money returned. Idempotent enquiries (HZ-029) are listed as a known gap in care.md.
