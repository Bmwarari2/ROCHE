# Phase 2 DPIA: first draft of section 7B (plan slice 84)

Branch `docs/dpia-phase-2-draft`. Documentation only.

## What changed

- [dpia-template.md](../compliance/dpia-template.md) section 7B, marked as a first draft for the
  DPO and not signed: the lawful bases for the Phase 2 processing built so far, which risks apply to
  each slice, and risks R20 to R29 (the ids the plan reserves; no extra ids were needed), each with
  slices, initial likelihood, severity and overall, the measures built with their evidence paths,
  open measures, the expected residual and the DPO decisions. It covers slices 11 (#151), 13 (#155),
  15 (#149), 18 (#152), 20 (#156), 23 (`feat/work-applicant-tracking`), 24
  (`feat/safety-speak-up`), 25 (#154), 26 (#150) and 33 (`feat/platform-sso`), read from each
  branch's records of processing, spec and changelog. R22, R25 and R28 belong to slices not built
  yet and carry planned measures only. Safeguarding, complaints and the policy library add no new
  risk id; the section says which existing risks apply.
- The evidence paths name files on those branches; ADRs not yet on `main` (0089 to 0092) are named
  as paths, not links, so the link check passes before they merge.
- Human actions H-790 to H-795.

## What is next

- The slice 84 code step (H-795): R20 to R29 in sections 6 and 7 and in the in-app prefill
  (`packages/domain/src/platform/dpia.ts` and its test), with a signed DPIA flagged for review when
  standard risks are added (an open item since 31 October 2026).
- Update section 7B as more Phase 2 slices are built, and replace branch references with merged
  paths.

## Human actions logged

- H-790 (DPO review of section 7B and the lawful bases), H-791 (subject access requests from people
  named in safeguarding and speaking-up records), H-792 (location at clock-in and check-ins), H-793
  (each adapter provider), H-794 (smallest survey group), H-795 (engineering: the prefill).

## Tests

- `pnpm check:links` passes; `packages/domain/src/platform/dpia.test.ts` (56) still passes, since
  the template keeps every risk the prefill names.
