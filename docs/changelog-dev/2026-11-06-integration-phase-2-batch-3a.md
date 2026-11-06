# Phase 2 merge batch 3a (migrations 0104 to 0117)

Branch `integration/phase-2-batch-3a`.

## What changed

- Merged twelve migration branches (0104, 0107 to 0117) and eleven without migrations onto `main`.
  0118 (`fix/recommended-answers-care`) joins last.
- Journal times for 0104 to 0117 follow 0103 one second apart; snapshots re-chained onto 0103,
  with a 0117 snapshot generated from the schema.
- 0111's sample removal list is the union of every branch's list (the death, missing person and
  outbreak tables stay).
- The hazard log was merged section by section; stale planned rows that later slices built were
  removed.
- `scheduling.md` has one numbering: 15 bank and agency, 16 time and attendance, 17 absence,
  18 pay runs, 19 lone-worker safety, 20 wellbeing. `integrations.md`'s dm+d section is 12.
- Slice 52's product picker and transcription facts read slice 10's dm+d tables when a release is
  loaded.
- Interim until batch 3b's 0123: medicines entries carry no tags, minimum interval or PRN maximum.
- Agency workers never count as registered nurses or drivers for the staffing scale (HZ-123).
- Encrypted e-learning packages are read by range through the decrypting stream.
- The feature register's summary counts are recomputed.

## What is next

- Merge 0118, move the sample removal union into it if it redefines the list, then open the PR.
