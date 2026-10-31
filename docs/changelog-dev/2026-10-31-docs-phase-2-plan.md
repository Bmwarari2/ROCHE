# Phase 2 plan: medicines and workforce

Branch `docs/phase-2-plan`. Documentation only; no code.

## What changed

- `docs/plans/phase-2.md`: the Phase 2 plan in the Phase 1 plan's shape.
  - Summary and scope: the 59 Phase 2 register rows, with mobile (MOB-007, MOB-013) in scope now
    that mobile is unpaused.
  - Decisions: the Appendix defaults that apply (ADR-0012, ADR-0013, ADR-0022, ADR-0015,
    ADR-0020) and 18 new ADRs to write, each with its default (ADR-0080 to ADR-0097, block 0080 to
    0099 reserved). The points where the master prompt is ambiguous, and the rate rows the slices
    add (no figures in the plan).
  - Work plan: 85 slices in section 19 order, in eight lanes (A medicines, B workforce,
    C scheduling, D safety, E quality, F platform, G mobile, H integrations), each with its register
    rows, migration number (0072 to 0110 in merge order), dependencies and the files the lane owns.
  - Hazards HZ-113 to HZ-130 (HZ-131 to HZ-139 spare) and the existing hazards Phase 2 extends;
    data-protection updates per slice; DPIA risks R20 to R29.
  - The section 19 gate as a checkable table.
- Stub specs with headings, rows and master prompt content only: `medicines.md`, `workforce.md`,
  `scheduling.md`, `integrations.md`; the specs index links them.
- `human-actions.md`: a Phase 2 section with H-510 to H-549.
- `STATUS.md`: the Phase 2 row and the reserved numbers. No register row changes status (a stub is
  not a spec).

## What is next

- The Phase 1 gate items in STATUS.md. Phase 2's domain-rule slices (2 to 9) touch only new folders
  and can start alongside them.

## Human actions logged

- H-510 to H-549.

## Tests

- `pnpm check:links`, `pnpm check:docs-gate`.
