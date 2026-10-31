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
  - the verification status: 508 of 592 rows passing, the other 84 listed in an appendix;
  - residual risk, with thirteen hazards at level 3 and HZ-071 at level 4 until the CSO accepts it,
    and the level-3 hazards rated for a web-only release;
  - the open human actions, decisions for the CSO, deployer controls, known limitations,
    conclusions and recommendations.

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

## Review rounds

- Round 1 (clinical-safety review by the agent, "not yet"). The report:
  - **Open human actions (H1)**: counts the 141 open actions owned or co-owned by the CSO besides
    H-381: 35 mobile-only and 106 not. It groups the 106 by what they block (43 the first real
    tenant, 13 any real tenant, 23 downtime packs, outages and evidence packs, 7 the safety case,
    20 named web features). All but H-353 block a live tenant using the web feature they name. It
    names the clinical ones (H-251, H-66, H-27, H-74, H-160, H-166, H-167, H-224).
  - **Validated tools (H2)**: says the on-screen banding table and locked templates are not built
    (HZ-012, boundary rule 2). It adds H-73, H-127 (the web shows the RCP wording too) and H-163.
  - **Evidence corrected (M1 to M3, L4)**:
    - the web header's photo is unverified;
    - HZ-010's server-received time tests are planned, and the HZ-017 late-note test is cited;
    - HZ-027 cites `post-fall.test.ts` and the incidents API test;
    - alert routing cites the urgent-alert and routing-roles tests;
    - only Braden's flag-off refusal is API-tested.
  - **Level 3 (M4)**: a table rates each level-3 hazard for a web-only release, with whether it
    applies and a one-line reason. Ten stay at 3, HZ-002 and HZ-112 are proposed at 2, and HZ-040 is
    not applicable. The hazard log is unchanged until the CSO decides.
  - **"Clinical review" (M5)**: defined as the agent's review, not a clinician's.
  - **New sections (M6)**: system definition with interfaces and dependencies, assumptions,
    safety-relevant rate-table defaults and their status, conclusions and recommendations, and
    document control.
  - **Mobile (M7)**: the exclusion is stated as an open risk and a CSO decision. No flag gates Care
    mode, and the EAS job submits store builds on a release-candidate tag. Mobile work resumed on
    31 October 2026 but stays excluded.
  - **Smaller fixes (L1 to L8)**:
    - 32 hazards at levels 1 and 2;
    - the CI run is on a commit 35 commits earlier;
    - the docs gate needs the label, and CODEOWNERS is the repository owner;
    - the falls "no score" test names no hazard;
    - Appendix A lists all 84 rows that are not passing;
    - HZ-111 is added to thin coverage;
    - the history journey is refreshed at tagging.
  - **For the CSO**: a "Decisions for the CSO" section. H-381 now points to it and to the web-only
    ratings.
