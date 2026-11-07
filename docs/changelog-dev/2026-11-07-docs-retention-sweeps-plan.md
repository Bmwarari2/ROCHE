# Plan: retention sweeps for Phase 2 records

Branch `feat/platform-retention-sweeps`, from `main` at daa038a7. A plan only; no code.

- `docs/plans/retention-sweeps.md` (draft): what the retention engine does today (documents only,
  on request, with a certificate per class; whole-organisation crypto-shred; legal hold only for a
  resident or one record), an inventory of the 135 Phase 2 tables that hold personal data (120
  with a record class, 15 without; 2 partly swept, 133 never), the gaps (no row destruction, no
  grace period, triggers other than `care_ended` and `created` unhandled, append-only tables that
  refuse deletes for every role, `record_version` copies and DSAR bundles never deleted), a design
  and 15 slices in a safe order (report only first; nothing destroyed without a reviewer's
  approval), and 12 questions for the DPO.
- An ADR is needed before slice 7 (row destruction, a retention owner role as an exception to
  ADR-0133's one owner per context, the table registry, `record_version`, audit events, modes and
  approval).
