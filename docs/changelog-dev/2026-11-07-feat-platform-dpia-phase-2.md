# DPIA for the Phase 2 processing (Phase 2 slice 84)

Branch `feat/platform-dpia-phase-2`, from `main` at daa038a7.

- `docs/compliance/dpia-template.md` section 7B (still a draft for the DPO, not signed) now covers
  every Phase 2 processing on `main`, with evidence paths on `main` and no branch names:
  - 7B.1 lawful bases, 26 rows, each taken from records of processing; where it names none, the
    row says so and 7B.6 lists the gap.
  - 7B.2 maps every Phase 2 slice on `main` to its risks.
  - 7B.3: R22, R25 and R28 as built. The phone sends no location and clock evidence `none`; a
    lone-worker location is off by default and erased after 30 days; NFC and location evidence
    wait for the monitoring DPIA (H-527). Every adapter is off or a mock, and production refuses
    mocks; OCR waits for its adapter (H-1262). Survey results are suppressed below the larger of
    the national and the organisation's minimum group size. Other risks' measures follow the code
    (sponsor, absence, pay, vetting, leavers, the casework silo, disclosure requests, slice 51
    imports, LMS imports, Thapsus-HR matching); R28's likelihood is "Remote", which is on the
    scale.
  - 7B.5 retention is one table; 7B.6 lists what the DPO decides before signing.
  - Section 7 rows R20 to R29 match the built measures.
- `packages/domain/src/platform/dpia.ts`: the prefill's risk wording and ratings are unchanged;
  its comment no longer says R22, R25 and R28 are being built.
- `dpia.test.ts`: table-driven tests that R20 to R29 are in the prefill with ratings, match the
  template's sections 6, 7, 7B.2 and 7B.3 word for word, that 7B names no branch and every
  evidence path exists, that sign-off is refused while a risk is unrated, and that a DPIA signed
  before R20 to R29 is flagged for review. 115 tests pass.
- Human actions H-1552 (lawful bases to confirm), H-1553 (risk R30 for the Thapsus-HR link),
  H-1554 (duplicate retention classes) and H-1555 (clock-in evidence and the lone-worker location
  flag must depend on the signed DPIA, not a self-declared tick).
- Found, not fixed here: no job yet destroys Phase 2 records when their retention ends (only
  import staging and lone-worker locations are swept); records of processing has duplicated notes
  and says training and rota records come "later"; the register shows SCHED-011 and INTG-007 as
  `todo` with screens or adapters on `main`; H-792 says "before slices 30, 46 and 71", which are
  built.
