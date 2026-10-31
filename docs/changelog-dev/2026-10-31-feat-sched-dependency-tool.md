# Dependency tool and required care hours (CARE-004, SCHED-001, Phase 2 slice 12)

Branch `feat/sched-dependency-tool`. Rules, schema, migration and API; the rota comparison on
screen is slices 21 and 59.

## What changed

- `docs/specs/scheduling.md` section 13 (section 12 before the slice 6 merge; spec first): the schema, the permission matrix, 12 rules
  and the test list for the organisation's own dependency scale, each person's category and the
  required care hours per shift; pointer rows in sections 2, 3, 7 and 8. `care.md` points to it.
- `packages/domain/src/scheduling/dependency.ts` (exported from `@harbour/domain`), pure functions:
  - `checkScaleDefinition`: shift periods covering the day in UK wall-clock time, categories with
    care minutes for every period, skill-mix minimums (`registered_nurse`,
    `medicines_competent`, `moving_and_handling`, `driver`) and a review interval, all the
    organisation's figures.
  - The version workflow; `checkScaleApproval` (never by the author or a contributor);
    `scaleVersionInForce` at each period's start; `scaleForLocation` (a location's own scale,
    else the organisation's).
  - A person's category as an append-only chain: `checkDependencyRecord` (category and one-to-one
    periods in the version, reason, who decided, not in the future, the current record
    superseded; a review from its own date, a correction from the corrected record's date),
    `dependencyInForce`, `currentDependency`.
  - `staffingRequirement`: required minutes per period for the people living at a location, with
    minutes per category, one-to-one per person, the skill mix, the method in words and the
    organisation's scale as the source with `DEPENDENCY_TOOL_NOTICE`. No scale gives `no_scale`
    and no figure; people with no usable category are named and the result is incomplete; people
    away are listed with the hours they would add; earlier-version and overdue categories are
    flagged.
  - `compareStaffing` (comparison inputs for slice 21): `below`, `incomplete`, `met` or
    `no_scale`, each with a word, the shortfall in words; never met when incomplete.
  - `atMinuteOfDay` in `intervals.ts` is now exported for it.
- `packages/db/src/schema/dependency.ts` and migration `0074_dependency_tool.sql` (one
  self-contained file; journal entry 74; main's migrations stop at 0071): `dependency_scale`,
  `dependency_scale_version`, `dependency_assessment`, each with `tenant_id`, forced RLS and the
  tenant policy; scale writes only for holders of `scheduling.dependency.manage` where the scale
  applies (`app.may_manage_dependency_scale`); the version workflow guard; categories
  append-only with the person's scope, `care.dependency.assess` at the person's location, and a
  guard checking the approved version, the category, the periods and the dates; one chain per
  person by unique indexes; `dependency_assessment` added to the sample-data removal list;
  existing built-in role copies gain the two new permissions, audited.
- Permissions: `scheduling.dependency.manage` (owner, Registered Manager, deputy) and
  `care.dependency.assess` (care record; also clinical lead and team leader); `permissions.md`
  regenerated. Export catalogue entries for the three tables.
- `apps/api/src/routes/scheduling-dependency.ts`: the scale CRUD with `expected_version` (make,
  rename, archive, draft, change, approve, discard), a person's categories (read as an audited
  care-record view; record with reason and who decided, idempotent by client id), and
  `GET /v1/locations/{id}/staffing-requirement` (needs `scheduling.rota.manage` and
  `care.plan.read` over the whole location). Every write and view audited with opaque ids;
  outbox `scheduling.dependency_scale_approved` and `care.dependency_recorded`. `openapi.json` and
  the typed client regenerated; `generate:client` now passes a larger file-size limit to biome,
  because the unformatted client is now over 1 MiB.
- Clinical safety: HZ-123 added (controls, verification); the residual-3 count is now fourteen;
  `medical-device-boundary.md` gains the paragraph "Dependency tool and required care hours" and
  its section 6 row records the default built.
- Data protection: records of processing (dependency categories row and a note), data standards
  (dependency tool section), retention (the three tables).
- `docs/specs/feature-register.md`: CARE-004 and SCHED-001 `partial`; counts updated.
  `docs/plans/STATUS.md`: Phase 2 row and in-progress list.

No rate row is added: every figure is the organisation's own scale (H-712). No ADR is written: the
boundary default is recorded in the boundary document, and whether it needs an ADR is for the CSO
(H-710).

## Human actions logged

- H-710: the CSO rates HZ-123 and confirms the boundary reading.
- H-711: the DPO confirms the lawful basis and retention.
- H-712: each organisation writes and approves its own scale.
- H-713: people on leave or in hospital (default: not counted, listed with their hours).
- H-714: two-to-one and shared hours (supported living).
- H-715: approval by a second member in a single-manager service.
- H-716: the placement's free-text `dependency_category`.

## Tests

- `packages/domain/src/scheduling/dependency.test.ts`: 88 table-driven tests (HZ-123); line
  coverage of `dependency.ts` 99.6%, branches 98%; the scheduling no-literal scan covers the file.
- `packages/db/test/dependency.test.ts`: 17 tests (HZ-123, HZ-011), plus `rls-coverage`,
  `sample-data`, `definer-acls`, `migration-journal`, `tenant-export` and the export catalogue.
- `apps/api/test/dependency.test.ts`: 21 tests (HZ-123, HZ-011); `route-gates`.
- `pnpm lint` and `pnpm typecheck`.

## What is next

- Slice 21 (lane C): shifts and the rota, showing `compareStaffing` beside each shift before
  publishing, with skills read through the workforce competence port (ADR-0085).
- Slice 59: the scale editor, the person's category form and the staffing gap screen.

## Review rounds

- Clinical review round 1 (#153): no High; the boundary holds. Fixed:
  - M1: who is at the location is worked out for each date asked (`presenceOn`): planned
    admissions count from their date and are said; someone away today is away that day and "not
    known" later; an undated admission or a date before the current status began is "not known";
    anyone not known makes the result incomplete, by name. API tests for people away and for a
    planned and an undated admission on future dates.
  - M2: the comparison carries every warning on the requirement and says "met, but read the
    warnings" (`met_with_warnings`) while any stands.
  - M3: the figure is `exact`, `at_least` ("at least N hours") or `none` (no number when nobody is
    counted, never "0 hours"); a location with nobody at all is an exact 0.
  - Lows: a version that moves the shift times starts the next UK day (no gap or overlap); the
    method and a warning say care minutes are not adjusted on clock-change nights; an unknown
    period key is refused (422) instead of reading as "no scale"; a category on a later version is
    flagged `later_version`; no shortfall is given with `no_scale` or no figure; HZ-123 named in
    the clock-change and version-per-period tests; the no-score check covers the comparison.
  - HZ-123 gains the new causes and controls; its target stays 3 until the rota shows the
    comparison. H-710 and H-713 carry the CSO's questions (clock-change nights, the "met, but"
    wording, who counts on a future date, planned admissions).
