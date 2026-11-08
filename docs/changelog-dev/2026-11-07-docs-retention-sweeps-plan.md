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

## Slice 0 (08/11/2026)

Docs only; no code or migration. Every DPO answer is provisional: an owner-accepted recommendation,
pending DPO review at the testing phase (ADR-0132).

- `docs/plans/human-actions.md`: new section "Phase 2: retention sweeps (plan and slice 0)" with the
  plan's 12 DPO questions and their provisional answers: H-1556 to H-1560 (questions 1 to 5) and
  H-1581 to H-1587 (questions 6 to 12, numbered at merge after H-1580).
- `docs/decisions/0135-retention-row-destruction.md` (proposed; number confirmed at merge): row
  destruction through a retention-only column (`retention_deleted_at`), a grace period, then deletion
  or column clearing with a certificate per batch, class and table; one NOLOGIN
  `harbour_retention_owner` as a recorded exception to ADR-0133; the registry as the single
  table-to-class source; `record_version` deleted with the record; audit events kept as ids; modes
  and two-person approval. Indexed in `docs/decisions/README.md`.
- `docs/specs/retention.md`: the mapping table de-duplicated (one row per table; the later decision
  kept for `outbreak_case`, H-767, and casework, H-806) and given rows for the 32 Phase 2 tables
  without one (provisional, H-1557 and H-1558); `lone_worker_check_in` and `whistleblowing` marked
  retired (rows kept); survey answers moved to `staff_survey_response`; the engine notes and gaps
  updated for automatic holds, `tenant_policy`, the staff file option and the settled gaps.
- `docs/compliance/retention-and-deletion.md`: describes today's state (documents only, no batch or
  grace period, holds on a resident or one record, no retention role) and points to the plan;
  duplicate and stale rows in sections 4 and 5 removed.
- `docs/plans/retention-sweeps.md`: section 7 gives each question's ID and says the answers are
  provisional; section 8 links the ADR.
