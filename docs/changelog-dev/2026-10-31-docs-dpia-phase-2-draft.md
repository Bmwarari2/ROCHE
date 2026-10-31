# Phase 2 DPIA: section 7B and risks R20 to R29 in the template and the prefill (plan slice 84)

Branch `docs/dpia-phase-2-draft`, PR #157.

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

- The code step (H-795, asked for on the same branch):
  - R20 to R29 in sections 6 and 7 of the template, and in the in-app prefill (`PHASE_2_RISKS` in
    `packages/domain/src/platform/dpia.ts`), after the Phase 1 risks, with the template's wording
    (the test checks every prefilled risk's id and wording against the template).
  - A signed DPIA is flagged for review when a standard risk is added: `DpiaBasis` records
    `standardRisks` (base, Phase 1 and Phase 2 ids, never the conditional ones); a new
    `new_standard_risk` trigger names the risks the signed version never assessed. A basis saved
    before the field existed counts as covering R1 to R8 only, so a DPIA signed before R13 to R19
    (the open item from 31 October 2026) or R20 to R29 is flagged. The trigger's wording is in the
    `dpia.trigger` message (en-GB, and the Welsh catalogue's English placeholder).
  - R22, R25 and R28 are standard although their processing is still being built; section 7B says
    so, and a tenant records in 7B.6 what it does not use.

## What is next

- Every signed DPIA becomes due for review when this merges (by design): tell tenants' data
  protection leads in the release note.
- Update section 7B as more Phase 2 slices are built, and replace branch references with merged
  paths.

## Human actions logged

- H-790 (DPO review of section 7B and the lawful bases), H-791 (subject access requests from people
  named in safeguarding and speaking-up records), H-792 (location at clock-in and check-ins), H-793
  (each adapter provider), H-794 (smallest survey group), H-795 (engineering: the prefill; done on
  this branch).

## Tests

- `pnpm check:links`; `pnpm lint`; typecheck of the domain package; `packages/domain/src/platform`
  (1,335, including `dpia.test.ts` with three new cases for the standard-risk trigger and the
  prefill of R20 to R29); `packages/i18n` (48); `apps/api/test/dpia.test.ts` and
  `onboarding.test.ts` (21); the web DPIA components and copy test (23). The DPIA journey
  (`apps/web/e2e/dpia.spec.ts`) rates every risk in a loop, so the ten extra risks need no change;
  it was not run here.
