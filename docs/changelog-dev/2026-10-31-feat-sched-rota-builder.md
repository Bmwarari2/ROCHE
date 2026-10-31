# Rota builder (SCHED-001, SCHED-002, Phase 2 slice 21)

Branch `feat/sched-rota-builder`, from `feat/work-training-competence` with
`feat/sched-dependency-tool` merged in. Rules, schema, migration and API; the screens are slice 59,
clock-in on the day slice 27, swaps H-838.

## What changed

- `docs/specs/scheduling.md` section 14: the schema, eight rules, routes, audit events and the test
  list for shift templates and patterns, rotas, shifts, assigning with the rostering rule, the
  check before publishing and publishing with notice.
- Domain (`@harbour/domain`):
  - `packages/domain/src/scheduling/rota.ts`: `checkShiftShape`, `shiftTimes` (UK wall clock,
    clock changes), `checkPattern`, `patternShifts`, `staffingProvided` (the rota's care minutes
    and skill holders on a dependency period), `plannedWorkPeriods`, `noticeMinutes`, `overlaps`,
    `rotaDates`, `workingTimeWindow`. No figure as a literal.
  - `packages/domain/src/workforce/roster-checks.ts`: `rosterChecks` (the staff file's DBS, right
    to work and registration on a day, verified items only), `blockerKey`, `overrideCovers`.
  - `RosterInput` takes the competence port's `CompetenceDecision`.
- Migration `0083_rota_builder.sql`: `shift_template`, `shift_pattern`, `rota`,
  `rota_publication` (append-only), `shift`, `shift_assignment`, `roster_override`
  (append-only); forced row-level security with `app.reads_rota`, `app.manages_rota`,
  `app.works_published_shift` and `app.holds_self_permission`; guards for locations, rota dates,
  overlapping rotas, double booking and overrides (never for a right to work, never for oneself,
  only by a holder of `scheduling.rota.approve`); history follows the rota's read rule.
- API (`apps/api/src/routes/rota.ts`, `apps/api/src/services/rota.ts`): templates, patterns,
  rotas, shifts, eligibility, assigning with an optional override and working time advice, the
  check before publishing (the staffing comparison against the organisation's own scale with
  "met, but" whenever a warning stands, working time per member, eligibility again), publishing
  with the check's digest and an acknowledgement of warnings, notice recorded, and a member's own
  published shifts. The required care hours are now computed in
  `apps/api/src/services/staffing-requirement.ts`, shared with slice 12's route.
- Hazards: HZ-123 and HZ-124 gain the rota's controls and tests.
- Data protection: records of processing (rotas and assignments, B3), data standards (rota
  fields), retention (the rota tables), the export catalogue (seven tables).
- Human actions H-830 to H-839.

## Tests

- Domain: `rota.test.ts`, `roster-checks.test.ts` (5,385 domain tests pass).
- Database: `packages/db/test/rota.test.ts` (775 database tests pass).
- API: `apps/api/test/rota.test.ts` (28 tests after review round 1).

## Review round 1 (security and clinical safety)

- Members not working for the organisation on the day (suspended, left, not started) are blocked,
  never overridable (`not_active`).
- A night is checked on the date it ends too.
- The newest DBS certificate decides, and new information from the Update Service always blocks.
- A registration counts only on the role's own register.
- Override keys carry the reason. An override must name the blockers the manager was shown
  (409 `blockers_changed`), and the database refuses overrides added after the assignment.
- Skill minimums count the fewest holders present throughout a period. Care minutes count only
  shifts the organisation counts as care (`counts_as_care`). Neighbouring rotas' shifts that reach
  into a period count.
- Open shifts and overrides make a period "met, but".
- Publishing:
  - it locks the rota, and every change takes the same lock;
  - the publisher must have read the check themselves (`check_not_seen`);
  - each period below the scale is acknowledged by name.
- After a change, the rota reads `changedSincePublished`.
- A member's assignments are serialised with an advisory lock, and so is starting rotas at a
  location.
- Eligibility answers only for members with a role at the location.
- `GET /v1/me/shifts` returns published shifts only.
- Both of a young worker's restricted windows are checked.
- The staff file's figures come from the shift's nation.
- Remaining decisions are folded into H-830, H-835, H-836 and H-839.
