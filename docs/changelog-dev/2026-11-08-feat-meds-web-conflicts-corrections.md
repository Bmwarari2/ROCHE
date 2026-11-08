# Doses recorded twice and corrections on the web

- **Doses recorded twice** (`/medicines-round/{locationId}/conflicts`, linked from the home's
  medicines round): each dose two phones recorded, with both records in words, whether they agree
  and whether one member recorded both. Its page offers only the decisions the records allow, asks
  what was found out, and asks again before "given twice" raises a medication incident. A
  controlled drug's dose says it needs a fresh sign-in and someone who took no part; refusals show
  in the API's words (HZ-004).
- **Correcting a dose record**: from the conflict ("Correct the record that stands", which comes
  back with "corrected" chosen) or from the person's new **Dose records** page (the last seven
  days, corrected records struck through). For a controlled drug whose register it moves, the page
  says what the witness signs for and gives them a link to the register page with it prefilled, for
  that correction only (HZ-115). `registerMove` mirrors the API's `registerMoveForCorrection`, with
  table-driven tests.
- API, additive: `AdministrationConflict.current` and `.controlledDrug`, `Administration.inCdRegister`,
  and `administrationId` on a waiting witness signature. A signature for a dose record is no longer
  offered for another register entry. OpenAPI and the client regenerated.
- Demo seed (end-to-end only): three conflicts on Frank Dummy's MAR, one on a controlled drug.
- Docs: medicines.md 15.4, the hazard log's HZ-004 rows, a nurse guide "Decide a dose recorded
  twice", the browser round guide, H-1605 closes when this merges.
