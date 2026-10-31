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

## Tests

- `packages/domain/src/medicines/dose.test.ts`, `schedule.test.ts`, `mar-entry.test.ts`,
  `reconciliation.test.ts`: 227 tests, passing under `TZ=UTC`, `TZ=Europe/London` and
  `TZ=America/New_York`; medicines coverage 100% of lines. Whole domain package: 4,468 tests,
  99.72% line coverage (`pnpm --filter @harbour/domain test:coverage`).
- `pnpm lint`, the domain typecheck and the markdown link check run clean.
