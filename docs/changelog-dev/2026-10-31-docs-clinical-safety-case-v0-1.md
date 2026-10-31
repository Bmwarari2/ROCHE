# Clinical safety case v0.1: Phase 1 residential MVP (gate item)

Branch `docs/clinical-safety-case-v0-1`.

## What changed

- `docs/clinical-safety/safety-case/safety-case-v0.1-phase1.md`: the draft safety case report for
  Phase 1, drafted against `main` at `aae5ab5`. It covers:
  - the Phase 1 scope and intended use, with the mobile app (paused) and medicines (Phase 2) out of
    scope;
  - a summary of the clinical risk management system;
  - the safety argument as ten claims, each with its arguments and the test files that evidence
    them (every path checked);
  - the 45 hazards by area with initial and target residual ratings;
  - the verification status: 508 of 592 rows passing, and what is not yet verified;
  - residual risk, with thirteen hazards at level 3 and HZ-071 at level 4 until the CSO accepts it;
  - the open human actions, the deployer controls and the known limitations.

  The CSO's sign-off is pending.
- Safety case index: v0.1 listed as a draft awaiting CSO review.
- `docs/plans/phase-1-gate.md`: the safety case gate item reads "Drafted, awaiting CSO sign-off".
- Hazard log, factual fixes:
  - the mobile workflow that builds demo mode runs weekly, not nightly (HZ-001 and HZ-006
    verification rows);
  - the summary's count of level-3 target residual risks now includes HZ-112 until its mobile
    control is built (thirteen, not twelve).
- `docs/plans/human-actions.md`: H-381 added. Two blank lines that split the clinical safety table
  (around H-268) are removed.

## What is next

- The CSO's review and signature (H-381, after H-20, H-21, H-23 and H-24).
- Fill the tag, commit and CI run link when Phase 1 is tagged.
- The rest of the gate items in [phase-1-gate.md](../plans/phase-1-gate.md).

## Human actions logged

- H-381: the CSO reviews and signs safety case v0.1 with Brian.

## Tests

- None (documentation only). `pnpm check:links` passes.
