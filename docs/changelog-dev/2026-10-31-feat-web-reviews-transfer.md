# Reviews and the hospital transfer pack on the web (PEOP-008, PEOP-009)

Branch `feat/web-reviews-transfer`.

## What changed

- Web: a reviews tab on the record (`/people/{id}/reviews`, `care.plan.read`): each review due
  with its date, the rate-table keys it comes from and its state as an icon and a word (overdue,
  due, upcoming, paused while in hospital); family involvement status; changes waiting for review;
  reviews held, a corrected one struck through and marked; and, where `care.plan.write` reaches the
  person, recording a review (care plan, local authority with the council's reference, family
  involvement with how they were involved, trial) or a change in need (HZ-008).
- Web: "Reviews due" from the people list (`/people/reviews`): the location's due and overdue
  reviews, overdue first, each naming the person from the viewer's own list and linking to their
  reviews tab.
- Web: a hospital tab on the record (`/people/{id}/hospital`, `people.movement.record`): the pack
  as it would be made now (the pack's own identity, missing safety-critical sections first as "Not
  recorded", what needs checking), one form to send the person with it (only the hospital typed;
  "Now" by default; belongings offered), the printable PDF streamed from the API and never stored,
  the hand-over with the named acknowledgement and reason when the pack is incomplete, the return
  and each check on return; earlier transfers keep their PDFs. A pack whose identity does not match
  the record is not shown (HZ-001).
- No API or schema change. Strings in en-GB; Welsh copied and listed as untranslated.
- Docs: people.md section 6a (screens, permission matrix, tests), hazard log verification rows for
  HZ-001, HZ-008 and HZ-023, the register's code and test paths.

## Clinical safety and data protection

- Medical-device boundary re-checked: the screens show the API's dates, states and pack sections
  and never interpret content; no scoring.
- No new personal data or processing: review participants are asked by role; the PDF is streamed
  with `private, no-store` and not kept. Records of processing and data standards unchanged.

## What is next

- Correcting a review record (`supersedesId`) from the web; naming who did each return check;
  the offline transfer pack on mobile (Maestro `hazard-HZ-023-offline-transfer-pack.yaml`).

## Human actions logged

- None.

## Tests

- `apps/web/src/lib/reviews.test.ts` (8), `apps/web/src/lib/transfer-pack.test.ts` (12),
  `apps/web/src/lib/care-record.test.ts` (tabs); `apps/web/e2e/reviews.spec.ts` (3) and
  `apps/web/e2e/transfer-pack.spec.ts` (3), axe in the light and dark themes on every state.
