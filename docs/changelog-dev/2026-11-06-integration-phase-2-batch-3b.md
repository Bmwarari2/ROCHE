# Phase 2 merge batch 3b (migrations 0120 to 0140)

Branch `integration/phase-2-batch-3b`, from `integration/phase-2-batch-3a` (latest 3ea2498b merged
in). The PR to `main` opens once batch 3a's has merged and this branch is green on top of `main`.

## What changed

- Merged in number order: 0120 to 0139 (twenty branches), web-cd-register, then slice 38
  (`feat/meds-covert-self-admin`, built as 0142, renumbered to 0140: file, journal, tag and
  snapshot), slice 72 (`feat/mobile-training-offline`) and slice 86
  (`feat/integrations-hr-link-port`), neither with a migration.
- Journal: idx and `when` strictly increasing after 3a's 0118, one second apart. Snapshots 0120 to
  0140 chained in journal order; 0130, 0131, 0137 and 0139 had none and were added; the latest
  equals the schema.
- 0140, the highest migration, states the union of every sample removal list (92 tables, children
  before the tables they reference). 0139 binds `harbour_member_owner` (0129) by the agency window,
  as 0118 does for the other definer owners that read role rows.
- 0140's administration flag check holds every flag from 0123 to 0140 (its branch carried 0123's
  list). No migration already on `main` changed; 0113 kept as batch 3a has it.
- When-required medicines are recorded again (batch 3a refused them until 0123): the API takes the
  limits, tags and interval; the web form requires the 24-hour maximum and offers the minimum
  interval; the clinical import requires `max_per_24h` for a when-required row and takes optional
  `tags` and `min_interval_minutes` (fixed for the version once recorded, so never added at the
  second check).
- Imported medicines read "Imported, not yet checked" and are held under either policy, with the
  notice that also covers scanned entries.
- Hazard log merged section by section, then repaired: speak-up HZ-131 restored, the medication
  error and review hazard is HZ-134 (its slice 45 tests renamed), Thapsus-HR keeps HZ-133, HZ-124
  and HZ-125 have one controls table and residual risk each.
- `builtin-role-backfill.test.ts` (0137) folded into `builtin-role-backfills.test.ts`.
- `importedMedicines` added to the TaskDetails contract.
- `phase-2.md` and `integrations.md`: the Thapsus-HR link takes 0141 (slice 87) and 0142 (slice
  88); slice 28 takes 0143.
- Config: batch 3a's Google Cloud and SMTP production checks kept; the payroll, LMS, OCR,
  DocuSign, TRUD and pharmacy switches added, each refused in production as its branch had it,
  with tests; the pharmacy pseudonym key is refused at its development default once orders are on.
- Each API router is registered once; the feature register summary is recounted.

## Reviews

- Security: no blocking findings; the three non-blocking ones fixed.
- Clinical safety: three blocking findings (hazard log collisions and the import tags), fixed.
- Accessibility: one blocking finding (the when-required unit test), fixed with table-driven
  cases; the e-learning navigation item and the interval error wording corrected.

## Follow-ups

- `medicines.md` has one section 13 and 14 from batch 3a and one from 3b, and five sections numbered
  15 (slices 48, 42, 54, 38 and 34's screens), each cited by its own slice's code. Renumber them in
  one docs pass with their references (about 90, some in migration comments).

## For the CSO and DPO

- H-1400: how imported medicines get their tags and minimum interval.
- Whether a when-required entry must have a 24-hour maximum everywhere (the web form and import
  require it; the API and domain accept an interval alone).
- Rate HZ-134 (H-1291) and accept the corrected HZ-124 and HZ-125 residual risks.
