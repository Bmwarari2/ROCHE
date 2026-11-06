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
  limits, tags and interval; a new or changed when-required entry needs its 24-hour maximum in
  the domain, the API, the web form and the clinical import (`prn_limit_required`, H-1066). An
  interval alone is refused: it can be overridden with a reason and caps no daily total (batch 3b
  clinical review; the CSO decides whether to relax it). The import takes optional `tags` and
  `min_interval_minutes` (fixed for the version once recorded, so never added at the
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

## Migration notes

- Two deliberate API contract changes, listed in `apps/api/openapi-breaking-ignore.txt` as such (not
  false positives):
  - `PATCH /v1/workforce/staff-files/{id}/references/{referenceId}` no longer accepts
    `declinedReason: no_consent_to_share` (H-876: a reference is never declined for want of consent).
  - `PUT /v1/workforce/staff-privacy-notice` takes a required `documentId` (an available organisation
    document) in place of the free-text `version` (H-940).
- The rule that breaking changes need a major version is applied, not skipped: these go out without
  one only because the API has no external consumer yet (the public API is Phase 6). The only callers
  are the web actions updated in this batch; the mobile app has none.
- Database migrations 0120 to 0140 are forward-only; the dm+d load now runs from its own job.

## Reviews

- Security: no blocking findings; the three non-blocking ones fixed.
- Clinical safety: three blocking findings (hazard log collisions and the import tags), fixed.
- Accessibility: one blocking finding (the when-required unit test), fixed with table-driven
  cases; the e-learning navigation item and the interval error wording corrected.
- Re-review after main, slices 38, 72 and 86 merged in (a7e7155a onwards): security, clinical
  safety and accessibility each mergeable with no blocking findings. The covert mark on corrections
  fixed here; the rest are under Follow-ups.
- Tests: lint, typecheck, db 1468, api 2631, domain 8005, sync 96, web 2531, contracts 34, i18n 48,
  mobile 1413, ui 353; Playwright 340 journeys (one ordering clash between the workforce and
  wellbeing journeys fixed).

## Follow-ups

- `medicines.md` has one section 13 and 14 from batch 3a and one from 3b, and five sections numbered
  15 (slices 48, 42, 54, 38 and 34's screens), each cited by its own slice's code. Renumber them in
  one docs pass with their references (about 90, some in migration comments).

- Security re-review, non-blocking: an assigned-scope role reaches every person its holder can see
  in `app.may_record_for_person` (migration 0140) and at the homely remedy and self-administration
  routes, as eMAR recording already does (`medicine-administrations.ts`). Require an open
  `person_assignment` in the database and the API together, in one change across all three.
- Security re-review, non-blocking: `GET /v1/locations/{id}/homely-remedies` relies on RLS
  (`handover_location_visible`) for reach. An API location check would refuse assigned-scope carers,
  who need the home's protocols, so it goes with the item above.
- Migration 0139 was edited before reaching main (the agency_window grants). A database that ran an
  earlier 0139 needs rebuilding; batch 3b ran only on private databases.

- Clinical re-review, non-blocking (fixed here): a correction that left out `covert` dropped the
  mark; it now carries forward while the dose is still given, with an HZ-026 test. The five
  "hazards at residual risk 3" paragraphs are one list again.
- Clinical re-review, open: homely remedy doses are not yet counted by the eMAR's 24-hour and
  interval checks, nor shown on the MAR, round or phone (fix before slices 52 and 55; HZ-120);
  offline e-learning completion takes the sync day, not the day finished (HZ-124, H-1013); training
  uploads share the phone's upload queue with doses, with no test that a dose passes a training 429;
  the Thapsus-HR staleness defaults are literals, not rate keys, with no clock-change test;
  `homely_remedy_administration.flags` has no allowed-values constraint.

## For the CSO and DPO

- H-1400: how imported medicines get their tags and minimum interval.
- Whether a when-required entry with an interval but no 24-hour maximum may ever be accepted
  (H-1066, H-555): built refused everywhere; never for an entry tagged paracetamol, the reviewer
  advises, and imported `tags` may need to be required (H-1400).
- Rate HZ-134 (H-1291) and accept the corrected HZ-124 and HZ-125 residual risks.
