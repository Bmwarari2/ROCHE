# Clinical safety case v0.2: first draft (plan slice 85)

Branch `docs/safety-case-v0-2-draft`. Documentation only.

## What changed

- [safety-case-v0.2-phase2.md](../clinical-safety/safety-case/safety-case-v0.2-phase2.md), a first
  draft, not signed, building on v0.1 (#108): what it covers (each Phase 2 hazard so far with its
  branch or pull request), a provisional claim that says why it cannot yet be made, the ratings at a
  glance, and for each hazard its rating, controls built, the `hazard HZ-...` tests named in the
  hazard log on its branch, what stays open, the level-3 justification where there is one and the
  CSO decision; the medical-device boundary points (HZ-121, HZ-123, HZ-126); planned tests; deployer
  information added by Phase 2; decisions for the CSO; sign-off pending.
- Hazards covered: HZ-116 and HZ-119 (`feat/meds-domain-administration`), HZ-121 (#135), HZ-123
  (#153), HZ-124 (`main`), HZ-126 (#155), HZ-128 (#154), HZ-130 (#150). HZ-113 (slice 10) and
  HZ-127 (slice 37) have no hazard-log entry on any pushed branch yet, so the report names them from
  the plan and says their entries come with their slices.
- The safety-case README lists v0.2. Human actions H-840 to H-842.

## What is next

- Update v0.2 as each Phase 2 slice merges (replace branch references with merged paths and CI
  runs), add HZ-113 and HZ-127 when their entries exist, and complete it for the Phase 2 gate with
  `docs/plans/phase-2-gate.md` (the rest of slice 85).

## Human actions logged

- H-840 (CSO and Brian: review and sign v0.2 at the gate), H-841 (CSO: accept or reject the level-3
  residual risks; rate HZ-124 and HZ-128), H-842 (CSO: the boundary positions for HZ-121 and HZ-123;
  rate HZ-113 and HZ-127).

## Tests

- `pnpm check:links` passes. Documentation only; the evidence cited is each hazard's own test list
  on its branch, not run here.
