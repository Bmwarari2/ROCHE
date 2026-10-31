# Working Time rules (SCHED-003, Phase 2 slice 5)

Branch `feat/sched-domain-working-time`. Domain rules only: no database, API, web or mobile code,
no migration.

## What changed

- `docs/specs/scheduling.md` written in full from the stub: the schema the working time rules
  read (for slices 21, 30 and 40), the permission matrix with one permission for slice 30
  (`scheduling.working_time.manage`), 13 rules that are easy to get wrong, the API and audit plan,
  the test list, open questions and the as-built section. Pay rules stay as slice 6's list.
- `packages/domain/src/scheduling/` (new; exported from `@harbour/domain`), pure functions:
  - `checkWorkingTime`: one worker's planned or recorded periods checked for the 48-hour average,
    daily and weekly rest, rest breaks, night work (night worker, the 8-hour average, special
    hazards) and the young worker rules (8 hours a day, 40 a week with other employers' hours, the
    restricted period, 12 hours' daily and 48 hours' weekly rest, 30-minute breaks). Each finding
    is a `breach` or `conditional` (compensatory rest owed in minutes, adult supervision,
    protection for health and safety, or a recorded reason), with its regulation and period ids.
  - The 48-hour average exactly as reg 4(6), (A + B) / C, with excluded days made up from later
    days; rolling or successive reference periods; short service; 26 weeks for the reg 21 special
    case; up to 52 by agreement; opt-outs with their notice rules.
  - Derogations (reg 21 to 24) for care homes turn adult rest, break and night findings into
    conditional ones; nothing derogates the 48-hour average or a young worker limit.
  - Sleep-ins are working time but count only awake time for the minimum wage when sleep is
    expected with suitable facilities; travel between visits is both; home to first visit is
    working time only (`classifyWorkingTime`, `nmwMinutes` for slice 6).
  - Hours in elapsed time; days, weeks, night time and the restricted period in UK local time,
    tested across both 2026 clock changes; the 18th birthday at 00:00 UK time, 29 February
    birthdays on 1 March.
- `docs/specs/rates.md`: 17 `wtr.*` rows (special-case and agreed reference periods, opt-out
  notice, default and agreed night time limits, night worker hours, the special hazards limit, the
  young worker age, the restricted periods, the reduced young weekly rest), all `verified` on
  legislation.gov.uk on 31 October 2026, with a note. The young worker age was planned for slice
  6; slice 5 needs it first. The figures are statutory, so tenant rows do not override them.
- `docs/specs/feature-register.md`: SCHED-003 `partial` (spec, code, tests); counts updated.
- `docs/plans/STATUS.md`: Phase 2 row and overall counts.

No ADR is due in slice 5 (ADR-0086 and ADR-0087 are slice 6's) and the plan assigns it no hazard.
The checks advise and never block; fatigue as a possible hazard is left to the CSO (H-543).

## What is next

- Slice 6 (lane C): pay rules, NMW per pay reference period using `nmwMinutes`, holiday, SSP,
  AWR and auto-enrolment, ADR-0086 and ADR-0087.
- Slice 30 stores the inputs and results (section 2 of the spec) and adds
  `scheduling.working_time.manage`; slice 21 shows the findings on the rota; slice 60 the screens.

## Human actions logged

- H-580: the employment law adviser confirms eight Working Time readings (opt-out days in the
  average, which absences are excluded, reg 11(7), special-case services, care homes as "similar
  establishments" for young workers, sleep-ins and home-to-first-visit travel, the night average's
  C, notice counting).
- H-581: each tenant records its working-time arrangements (special-case services, agreements,
  fortnightly weekly rest, reg 11(7) reasons, special hazards, night worker health assessments).

## Tests

- `packages/domain/src/scheduling/`: `rates.test.ts` (15, including the no-literal scan),
  `classification.test.ts` (22), `agreements.test.ts` (24), `weekly-average.test.ts` (15),
  `rest.test.ts` (32), `night.test.ts` (21), `young-workers.test.ts` (13), `working-time.test.ts`
  (5): 147 tests. Scheduling line coverage 100%, branches 94%; the domain package passes its
  coverage thresholds.
- `pnpm lint`, `pnpm --filter @harbour/domain typecheck`, `pnpm --filter @harbour/domain test`.

## Review rounds

- None yet.
