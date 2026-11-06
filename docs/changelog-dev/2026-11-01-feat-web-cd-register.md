# Controlled drugs register screens (Phase 2 slice 54)

Branch `feat/web-cd-register`, from `feat/meds-cd-register` (slice 34). MEDS-005 and MEDS-014;
[medicines.md](../specs/medicines.md) section 15.

## What changed

- **Register tab** on the person's record (Controlled drugs, after Charts), seen by the API's
  readers. One row per page, showing:
  - the balance as the API reports it;
  - the last count's result in words;
  - when the next count is due, or that it is overdue.
  A recorder opens a page for a medicine on the MAR chart.
- **Register page**:
  - Entries in order, each with its number, movement (icon and word), quantity, the balance after
    it as the API recorded it, who it came from or went to, the reference, who recorded it and
    who witnessed it (or why no witness).
  - A correction sits directly under the entry it corrects; nothing is struck through or hidden.
  - Stock counts are listed with their results.
- **Witness first (ADR-0084 on the web)**:
  - The witness signs in their own session with a fresh step-up, for what they saw and the member
    they watched.
  - The recorder chooses that signature from the ones waiting for them.
  - A lone entry with a reason is offered only under the `where_available` policy and never for a
    destruction.
- **Recording**: receipts, returns to the pharmacy, disposals and destruction; corrections of a
  quantity or a detail.
- **Counts**: a count that does not match needs what was found, and the page says a medication
  incident has been raised.
- **Print**: a plain per-page print view (every entry, signature, correction and count) until
  slice 50's format (H-1331).
- **API**:
  - `GET /v1/controlled-drugs/pages/{pageId}/recorders` (for witnesses).
  - `GET /v1/controlled-drugs/pages/{pageId}/witness-assertions` (the caller's waiting signatures).
  - The page detail names everyone who signed it.
- **Development only**:
  - With `MEDICINES_FIXTURES` on, the demo owner, manager and nurse hold medicines competence.
  - `seed-users.ts` gives the demo's Frank a morphine entry with schedule 2 for the journey.

## Tests

- API: the recorders list never includes the caller; a recorder sees only signatures waiting for
  them; the page names its signers.
- Web unit: chips, corrections ordering (HZ-116), and the form readers.
- Playwright: a witnessed receipt, a correction and a count that does not match, then the print
  view, with axe in light and dark.

## Safety and data protection

- Hazard log: HZ-115 and HZ-116 controls and tests.
- Medical-device boundary re-checked.
- No new personal data fields: staff names already held are shown to members who can read the
  register (H-1330).

## Review fixes (06/11/2026)

- Clinical safety:
  - Each count that does not match now shows "Medication incident raised" on the page and in
    print. This comes from a new `incidentRaised` field on the stock check.
  - The recorders list now includes members who can only count the stock.
  - A correction whose entry is missing says so; it no longer shows "entry 0".
- Security:
  - The two new reads are audited (`medicines.cd.recorders_viewed`,
    `medicines.cd.assertions_viewed`).
  - New tests: 403 without the permission, and 404 for a page the caller cannot see.
  - The waiting signature's movement now has the contract's type instead of a cast.
  - The server actions check each body against the contract before sending it.
- Accessibility:
  - The witness choice no longer duplicates an id, and shows its error inline when there is
    nothing to choose.
  - The print view shows the person's communication needs.
  - Signed quantities use a text keypad, so a minus can be typed.
  - Lists keep `role="list"`.
  - Clearer hint text, the unit on the expected count, and "No witness recorded" when no reason
    was given.
  - Count results are i18n strings.
- Left for later: a competence check before listing recorders (names only; low).
  `@harbour/db/seed` is still imported by the medicines ports (H-1333).

## Human actions

H-1330 to H-1334.
