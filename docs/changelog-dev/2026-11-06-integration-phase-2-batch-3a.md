# Phase 2 merge batch 3a (migrations 0104 to 0118)

Branch `integration/phase-2-batch-3a`.

## What changed

- Merged thirteen migration branches (0104, 0107 to 0118, with 0118 `fix/recommended-answers-care`
  last) and eleven without migrations onto `main` (5dec5f37).
- Journal times for 0104 to 0118 follow 0103 one second apart; snapshots re-chained onto 0103,
  with 0117 and 0118 snapshots generated from the schema.
- 0111's sample removal list is the union of every branch's list (the death, missing person and
  outbreak tables stay), and 0118, the highest migration, states the same union again.
- 0118 also binds the definer owners that read role rows (sample, silo, import, wellbeing,
  quality reader, invitation) to the agency access window (security review), with a test.
- 0111 revokes UPDATE on the medicines record's append-only tables; the RLS coverage test lists
  every append-only table the batch adds.
- The hazard log was merged section by section; stale planned rows that later slices built were
  removed.
- `scheduling.md` has one numbering: 15 bank and agency, 16 time and attendance, 17 absence,
  18 pay runs, 19 lone-worker safety, 20 wellbeing. `integrations.md`'s dm+d section is 12.
- Slice 52's product picker and transcription facts read slice 10's dm+d tables when a release is
  loaded.
- Interim until batch 3b's 0123: medicines entries carry no tags, minimum interval or PRN maximum,
  and when-required medicines are refused in plain words ("When-required medicines can be added
  once dose limits can be recorded."), never recorded without their limits (clinical review). This
  was chosen over moving 0123's columns into 0111, which would have rewritten 3b's migration.
- The dm+d foreign keys from the medicines record wait: development, tests and the demo tenant use
  invented products that are not in the dm+d fixture release. The test that guards them says so.
- Agency workers never count as registered nurses or drivers for the staffing scale (HZ-123).
- Encrypted e-learning packages are read by range through the decrypting stream.
- The feature register's summary counts are recomputed.
- The hazard log is brought up to date (HZ-123, HZ-124, HZ-128, HZ-129, the risk-3 list).
- Tests kept true after the merges: the dashboard's unfinished month, the encrypting store, GTIN
  lengths, and lower-case medicines subjects inside sentences.
- The API refuses Care mode with its own 403 code `care_mode_off` (from 0118's branch).
- The hospital tab no longer offers to tick a return's medicines check, which only the medicines
  reconciliation completes (HZ-005); it links to the medicines tab instead.

## Data protection and clinical safety

- No new processing beyond the merged branches' own records. Clinical-safety and security reviews
  ran on the merge resolutions; their findings are fixed or listed below.

## What is next

- Move the definer functions owned by `harbour_owner` to NOLOGIN owners, with an ADR (security
  review: eleven new in this batch, as on main).
- Batch 3b (0123) restores when-required medicines with their limits; entries made before need a
  new, second-checked version with tags and interval, never a silent backfill (clinical review).
- Add the dm+d foreign keys once the fixture products are in the dm+d fixture release.
- Show the dm+d release date and "out of date" in the product picker (HZ-113 rule 5); read dm+d
  facts inside the write transaction on the transcribe and change routes.
- Read only the needed segments of an encrypted e-learning package (the range read decrypts from
  the start, review H2).
- Audit 0107's update of `counts_as_care`, which runs across organisations without an audit event,
  and decide whether `disclosure_request`, `dsar_case`, complaints and `dp_complaint` (from main)
  join the sample removal list.
- For the CSO: the HZ-123 and HZ-124 ratings (H-830, H-960), agency nurses not counting towards
  skill mix, whether the medicines record goes live before 3b, and HZ-129 and HZ-131.
