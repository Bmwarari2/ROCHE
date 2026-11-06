# Importing medicines, care plans and staff files (slice 51, PLAT-014, WORK-013)

Branch `feat/platform-import-clinical`, cut from main with `feat/meds-record-schema` (slice 16)
merged in for the medication tables. Migration 0136. Human actions H-1300 to H-1309, each with its
recommended answer applied until the testing-phase review.

## What changed

- **Record types:** the import wizard takes `medicines`, `care_plans` and `staff_files` besides
  `people` (platform.md rules 27 to 31). Each has its own fields, permissions
  (`app.import_reachable`, checked by the API too) and audit action per record.
- **Medicines** arrive not yet checked, by dm+d code only (no name column), with dm+d's own
  names and the medicines rules on every row. `marEntryStatus` holds an imported entry,
  "Imported, not yet checked", off every round and MAR until a second check, whatever the
  organisation's policy (H-548). An undo withdraws them, while none is checked.
- **Care plans** arrive as drafts, one per person with a section per row; never published by the
  import. An undo removes unchanged drafts.
- **Staff file checks** arrive unverified, matched by work email; health, conduct and employment
  history are never imported. An undo removes unverified, unchanged checks.
- **Dry run:** every row's outcome (`rowOutcomes`) in the report, and what committing does in
  words per type.
- **Migration 0136:** the record types; `import_batch_id` on `care_plan` and `compliance_item`
  and the foreign key on `medication`; the batch tie guard; per-type reach and undo; the
  compliance item delete trigger letting only the undo through; the sample removal list as the
  union of 0099's and 0111's (HZ-072).
- **Web:** the upload asks what the file holds; the check lists every row's outcome; the allergy
  section shows for people only.
- **Docs:** platform.md, the hazard log (HZ-130, HZ-005, HZ-024, HZ-124), the medical device
  boundary, records of processing, data standards, the feature register, human actions.

## Reviews

- **Clinical safety:** a change to an imported, unchecked medicine now keeps the hold (high);
  each person gets an urgent task to have imported medicines checked before the next round
  (HZ-003); hazard log rows moved to HZ-024 and HZ-124; medicines and care plans only for people
  receiving care; "Withdrawn: the import that added it was undone"; BST start dates tested.
- **Security:** an undo never deletes a care plan section added since the commit (medium); the
  batch's own type's permissions checked organisation-wide in the API on every batch route;
  staff files matched only for active members, ambiguous emails refused; medicines refusals
  in words with no value; the staff file delete exemption narrowed to imported checks.
- **Accessibility:** type-aware copy throughout (no sentence built from fragments), the commit
  button names what it adds, only the rows that will not be added are listed (capped), and
  changing the type keeps valid column choices and says so politely.

## Tests

- Domain: `imports-clinical.test.ts` (table-driven per type), `mar-entry.test.ts` (H-548).
- Database: `imports-clinical.test.ts`, with the import, sample data, definer and journal tests.
- API: `imports-clinical.test.ts`, with `imports.test.ts`.
- Web: `e2e/import-clinical.spec.ts` and `e2e/import.spec.ts`, axe in light and dark.

## Known gaps

- Medicines import takes daily schedules only (H-1301).
- Contacts and allergies imports follow.
- Welsh copy (H-1309).
