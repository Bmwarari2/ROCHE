# Death step corrections as superseding entries, and the line list's reasons (section 5.5)

Branch `feat/safety-death-step-corrections`, from `main`. Item 3 of the lead's list of gaps the
slice 83 guides review found (a pre-pilot blocker against master prompt section 5.5).

## What changed

- **Schema** (migration 0158, written as 0158 until it is renumbered before merge): `death_step`
  gains `supersedes_id` and `correction_reason`; a correction names an entry of the same death and
  step, once, with a reason of 10 to 500 characters; a step already recorded takes a new entry only
  as a correction (a trigger); the superseded entry stays append-only.
- **Domain**: `deathStepCorrectionProblems` and `currentDeathStepEntry`, with table-driven tests.
- **API**: `POST /v1/deaths/{id}/steps` takes `supersedesId` and `correctionReason` and refuses a
  silent second entry; the view gives each step's standing `entryId` and marks history entries
  superseded, with the correction's reason; audited as `safety.death.step_corrected`.
- **Web**: a recorded step offers "Correct" with its reason; the history strikes superseded entries
  through, says "Corrected later" and "Correction" in words, and shows why. The outbreak line list
  shows each correction's reason beside the row.
- **Docs**: safety.md, data-standards.md, the export catalogue, HZ-013, human actions H-1573 and
  H-1574.
