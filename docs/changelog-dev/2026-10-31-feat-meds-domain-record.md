# Medicines record and reconciliation rules (MEDS-001, Phase 2 slice 2)

Branch `feat/meds-domain-record`.

## What changed

- `docs/specs/medicines.md` written in full for the medicines record and reconciliation: the
  tables slices 10 and 16 build (no migration here), the permissions each action needs (no new
  permission), rules 1 to 12 with their hazards, the API and events for slice 16, the test list,
  open questions and what was built. Rules 13 onwards (administration, PRN, controlled drugs) are
  left for slice 3.
- New domain folder `packages/domain/src/medicines/`, pure functions with no I/O:
  - `dmd.ts`: a product is a dm+d VMP (and AMP for a brand) whose identifier has the SNOMED CT
    shape and a valid Verhoeff check digit, so a typed name cannot stand in for one; products are
    compared by identity only, never by ingredient.
  - `dose.ts`: structured doses (an amount, a range the prescription allows, or a variable dose
    read from the dosing record) in a unit dm+d permits, matched by code; typed numbers are taken
    only in the form shown (".5", "5.0", "05", "1,5" and "1/2" are refused with the form to type);
    micrograms, nanograms and units always in full; no conversion between units.
  - `schedule.ts`: prescribed wall-clock times, each with its own dose, on every day, every n days,
    weekly (every n weeks) or monthly patterns, expanded over the MAR cycle from
    `medicines.ordering_cycle_days` in UK time; the clock-change rule (a skipped time due an hour
    later, a repeated time due once, both flagged; two times brought together both kept and
    flagged); day names on every non-daily row; the schedule in words; the days the clocks change.
  - `mar-entry.ts`: draft checks; "Not yet checked" until a second person with current medicines
    competence, not the transcriber, compares the entry with its source; a difference holds the
    entry; changes are new versions taking effect now or later; stops need a reason and a source;
    status words and whether a dose may be given, with the tenant's unchecked-entry policy.
  - `reconciliation.ts`: every MAR entry and every source line needs a person's decision; no stop
    inferred from a missing line; differences shown by dm+d identity only; what the person or
    family says is not enough on its own; the discharge letter or a reason on a return; queries,
    a changed record, competence, allergies compared and involvement checked before completion;
    the plan for the API; the admissions, transfers and returns still to reconcile.
  - `rates.ts`: `resolveMedicinesRates` (`medicines.ordering_cycle_days`); a test fails if the
    figure appears as a literal in the rules.
- Hazard log: HZ-121 added (medicines not reconciled after admission, transfer or return from
  hospital; engineering ratings for the CSO, H-513); HZ-005's slice 2 controls and five planned
  tests, HZ-009's three planned medicines tests and HZ-003's cycle expansion test now passing;
  fourteen hazards with a target residual risk of 3.
- Medical-device boundary: a paragraph on why the medicines record and reconciliation stay inside
  it (no dose arithmetic, no suggested times, identity not ingredients, allergies compared by a
  person).
- Register: MEDS-001 `partial`. STATUS: the Phase 2 row, the branch, and the overall counts
  corrected to the register's (65 `partial`, 168 `todo`; it said 60 and 173).
- No ADR: none of ADR-0080 to ADR-0097 is due in slice 2 (ADR-0082 is slice 3's); the slice applies
  ADR-0082's defaults (no ingredient matching, allergies shown not matched).

## What is next

- Size: about 3,970 changed lines (1,718 of rules, about 1,820 of table-driven tests as Biome
  formats them, about 500 of documents), above the plan's guide of about 2,000. If review wants it
  split, reconciliation (`reconciliation.ts` and its test, about 1,120 lines, with HZ-121 and spec
  rules 7 to 12) can go to its own pull request: only `index.ts` imports it.
- Slice 3: administration, PRN and controlled-drug rules with ADR-0082 and HZ-116 and HZ-119; the
  second check written here is the transcription check HZ-116 names.
- Slice 10: dm+d reference tables (the permitted units and routes `checkMarEntryDraft` takes), then
  slice 16 (the tables, API and the `medicines_reconciled` return check).

## Human actions logged

- H-550 (CSO): second-check policy for entries not yet checked.
- H-551 (pharmacist): the dose-writing rules.
- H-552 (CSO with a pharmacist): the reconciliation rules and the NICE SC1 reading.
- H-553 (CSO with a pharmacist): the MAR schedule model and the clock-change collision rule.

## Review rounds

- Round 1 (clinical-safety review of #135: 2 High, 5 Medium, 4 Low), fixed with ordinary commits
  on the branch:
  - High 1: every-n-days and fortnightly patterns count from their own `anchorOn` date, never
    from a version's start; a change carries the count, and one that moves it is refused unless
    the prescriber's new pattern starts a new count, with the reason recorded (`reanchor`). A patch
    every 3 days from 02/11 changed at 07:00 or 09:00 on 03/11 is next due 05/11.
  - High 2: a continue needs a line that shows what is prescribed now (on a return with a
    discharge letter, the letter's line); labels, the previous MAR or the family alone need a note
    and the prescriber or clinician who confirmed it (`confirmedWith`).
  - Medium 3: an entry with a stop or replacement still to come stays checkable while in force.
  - Medium 4: only the version in force may be given ("Not started yet" before its start).
  - Medium 5: a stop links the line that says so, from a document; absence is a query.
  - Medium 6: a start of a dm+d VMP already on the MAR is flagged as a possible duplicate and
    needs a note; by identity only.
  - Medium 7: the dosing record for variable doses is logged as an open HZ-005 control for slice 3
    (domain) and slice 16 (storage), with no dose recorded against a variable entry until then.
  - Low 8 to 11: "2 × 5 ml spoonfuls" and "12 micrograms/hour"; the decimals message asks the
    prescriber or pharmacist instead of inviting a conversion; medicines.md says slice 16 reads
    competence from the workforce port on the server; the blocker tests carry "hazard HZ-121".
  - Hazard log HZ-003, HZ-004, HZ-005 and HZ-121 and human actions H-550 to H-553 updated.
- Round 2 (clinical re-check at f7f5f73e: fixes 1, 2, 3, 5 and 7 incomplete), ordinary commits:
  - H1, M2: each source line records what it says (start, continue, change, stop, unclear) and its
    dm+d product; a decision is supported only by a line that says that thing about the same VMP,
    whatever the note; an unclear line blocks completion. Alendronic acid can no longer continue on
    its STOPPED line, nor warfarin on the apixaban line.
  - H2: changes and stops work on every version of the medicine (`changeMarEntry(versions, ...)`,
    `stopMarEntry(versions, ...)`): the version in force when they take effect ends, later
    versions that had not started are withdrawn, so exactly one version is ever in force; a
    property test over 60 seeded random sequences checks every boundary.
  - H3: the day count is kept from the last dose actually due across all versions, through every
    day or when required, and across a stop and restart (`earlierEntries` on a new entry); a
    weekday or day-of-month move is a new count that needs a reason (the old test asserting Monday
    to Tuesday kept the count is replaced); a missing anchor is refused, never thrown.
  - M1: a variable-dose entry is never givable until its dosing record exists.
  - M3: a source shows what is prescribed now only when received on or after the event, or marked
    current with a reason (`currentBecause`).
  - M4: a change on a day with doses says whether that day's doses were all given or one is still
    due at the new times (`todaysDoses`), so it never doubles or drops that day's dose.
  - M5: an entry with a stop still to come can be corrected while in force; the stop carries over.
  - Lows: a change into a continued product is flagged as a possible duplicate; every-n-days and
    fortnightly tests across the four clock changes; the hazard log no longer says the count runs
    from the start; a change's and a restart's count and change-day questions show when the
    reconciliation completes.
  - Where the design call was unclear, the more restrictive behaviour was chosen and recorded as a
    CSO question (H-550, H-552, H-553): starts need a current prescriber's or pharmacy line with no
    confirmation route; daily to weekly counts as a re-anchor; a stop carries over to a correction.
- Third clinical review (2 High, 3 Medium, Lows): the complicated sequences are now refused
  rather than handled, and each refusal is a CSO question (H-550, H-552, H-553).
  - H-A: a change, stop or correction while a later version is scheduled is refused unless it
    withdraws that version and says why (`later_version_scheduled`, `withdrawLaterReason`); a stop
    still to come always carries over, from the version in force or a version withdrawn; a change
    needs a version in force, so it can never restart a stopped medicine (a gap the new property
    test found).
  - H-B: a change keeps the same dm+d VMP (`different_product`; `change_different_product` in a
    reconciliation); a switch is a stop on the old product's line and a start on the new one's.
  - Medium, rule 6c: `todaysDoses` and the change day are removed. A change part-way through a day
    on which either version has a regular dose is refused and takes effect from 00:00 the next day
    (`change_from_tomorrow`); a restart the same day after a dose was due is refused
    (`restart_from_tomorrow`). This replaces M4 above.
  - Medium: one entry per VMP (`same_product_in_force`); in a reconciliation a second entry is
    refused with no note to override it (`duplicate_product`).
  - Medium: each start is tried against the person's earlier entries of the product
    (`earlierEntries`), so a restart of a medicine stopped before the reconciliation is checked at
    completion; each stop is tried too (`stop_refused`).
  - Property test: changes, stops, restarts and corrections, regular and when required; nothing
    given after a recorded stop; every whole day's doses equal to the schedule's.
  - Lows: regular to when required on a dose day refused; rule 6c tests on the days the clocks
    change; the variable-dose notice says what to do instead, and slice 2's release gate is an
    H-550 question; HZ-121 in the test name; the hazard log no longer says a change never doubles
    or drops a dose.
  - Merged `origin/main`, keeping both sides in STATUS, the human actions and the hazard log.

## Tests

- `packages/domain/src/medicines/dose.test.ts`, `schedule.test.ts`, `mar-entry.test.ts`,
  `reconciliation.test.ts`: 324 tests after the third review, passing under `TZ=UTC`,
  `TZ=Europe/London` and `TZ=America/New_York`; medicines coverage 99.33% of lines. Whole domain
  package after merging `main`: 5,203 tests, 99.69% line coverage under each of the three time
  zones (`pnpm --filter @harbour/domain test:coverage`).
- `pnpm lint`, the domain typecheck and the markdown link check run clean.
