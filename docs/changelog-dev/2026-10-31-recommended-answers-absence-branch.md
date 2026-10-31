# 31 October 2026: recommended answers applied on the absence branch

Branch `feat/sched-absence-leave`. These are the owner's recommended answers
(`docs/plans/recommended-answers.md`), applied now and reviewed at testing. Each row in
human-actions.md says "recommended answer applied 31/10/2026 (review at testing)". The changes
are forward-only in migration 0107, which is not on main.

- **H-830** (clinical; ADR-0099):
  - No DBS certificate at all, and a lapsed or missing registration, are never overridable. This
    holds in the domain (`neverOverridable`, refusals `no_dbs` and `registration`) and in the
    database (`roster_override_never_allowed`).
  - Supervised and shadowing templates and shifts default to `countsAsCare` false.
  - A shift now keeps the `countsAsCare` it is given. Before, the database default always applied.
  - The CSO ratings for HZ-123 and HZ-124 are in the hazard log.
- **H-835**:
  - A driving-for-work compliance item: the DVLA check date and categories, never the licence
    number or the check code, plus the insurance expiry. It is current for
    `workforce.driving_licence_check_months` (12, to verify) and only while insured.
  - It is a check beyond Schedule 3, never needed for a complete file. It feeds `driver` on the
    staffing scale.
  - The NMC registration records its register part. Only the nurse part counts as
    `registered_nurse`, and a nursing associate never does.
- **H-693**:
  - A nurse writes their own revalidation evidence (`PUT /v1/me/revalidation`) and sends it for
    review.
  - HR reviews it (`POST .../revalidation/review`), and the counts are then fixed.
  - The confirmer records the confirmation in their own name and is never the nurse
    (`POST .../revalidation/confirmation`). The database refuses anything else.
- **H-692**:
  - Supervision notes (`supervision_note`: topics, actions agreed, next date, optional note) are
    read only by the supervisor, the supervisee and HR, and are append-only.
  - Health detail goes into an HR document instead.
- **H-970**:
  - Statutory leave is never declined. Carer's leave and unpaid parental leave may only be
    postponed (new state `postponed`, with a reason). The database refuses otherwise
    (`absence_statutory`).
  - A `parental_bereavement` kind.
  - Carer's leave taken in the last 12 months is shown against
    `carers_leave.weeks_per_12_months` (1, Carer's Leave Regulations 2024, to verify). It is
    advisory only.

Docs updated: scheduling.md sections 14 and 15, workforce.md rules 7, 8, 10 and 11, rates.md,
hazard-log.md (HZ-123, HZ-124), records-of-processing.md, data-standards.md and human-actions.md.
