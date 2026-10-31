# Administration, PRN, competence and controlled drugs rules (MEDS-002, 003, 005, 013; Phase 2 slice 3)

Branch `feat/meds-domain-administration`, stacked on #135 (`feat/meds-domain-record`).

## What changed

- `docs/specs/medicines.md` section 4.2 written as rules 13 to 27, with the permissions each action
  needs (no new permission), the test list, the open questions and what was built.
- [ADR-0082](../decisions/0082-medicines-rules-at-the-device-boundary.md) (proposed, H-514): the
  time-critical and interval rules apply to entries a person tags at transcription and a second
  person checks; Harbour suggests a tag only from the tenant's own list of exact dm+d VMPs, never by
  ingredient; allergies are shown, never matched. The medical-device boundary's section 6 records
  both decisions, with a slice 3 paragraph.
- MAR entries gain `tags`, the prescribed `minimumIntervalMinutes` and, when required, the
  `maxQuantityPer24Hours` (`suggestedTags` offers tags from the tenant lists).
- New domain modules in `packages/domain/src/medicines/`:
  - `timing.ts`: dose windows from the rate table, narrower for time-critical entries; early and
    late; a dose without an outcome stays outstanding; escalation at the end of the window; the
    tags' notices; the drift-corrected clock.
  - `intervals.ts`: the prescribed interval across an entry's versions and the paracetamol rule
    across tagged entries, in elapsed time; the when-required maximum over the 24 hours up to a
    dose (no override); last given, by whom and whether synced; the outcome follow-up.
  - `competence.ts`: competence until 00:00 UK time on the anniversary of the sign-off (from the
    table's months); the gate on every outcome and the override by someone else, with a reason, for
    a bounded time, flagged for the report.
  - `dosing-record.ts`: day doses for variable-dose entries, second-checked; a dose only from the
    latest checked record. A variable-dose entry now says where its dose comes from, and
    `checkAdministration` refuses one without a checked record (slice 2's interim block lifted).
  - `administration.ts`: outcomes and coded reasons; `checkAdministration` (person, dose and
    outcome; another person's medicine; a dose not scheduled or already recorded; a version not in
    force; the amount; timing; intervals; the maximum; competence); closing a round; the MAR row
    lock and referenced corrections.
  - `controlled-drugs.ts`: one page per person and VMP; the running balance checked on every entry;
    margin corrections; the witness rule by tenant policy (defaults by service type), destruction
    always witnessed; stock checks raising an incident; the stock-check due date.
- Rate table: seven tenant defaults marked to verify (dose windows, time-critical windows, the PRN
  outcome check, the CD stock-check interval, the override's longest length); `MEDICINES_RATE_KEYS`
  reads every medicines figure, and a test fails if any two-digit figure appears as a literal.
- Hazard log: HZ-116 (two-person checks) and HZ-119 (expired competence) added; HZ-003, HZ-004,
  HZ-009 and HZ-010 planned domain tests passing; HZ-005's open dosing-record control built.
- Register: MEDS-002, MEDS-003, MEDS-005 and MEDS-013 `partial`. STATUS updated.
- Merged #135's third to sixth clinical reviews and `main`. Slice 3 now sits on the stricter
  record rules (changes from 00:00 on a day with doses, later versions withdrawn only with a
  reason, a change keeping the product and its course end, one entry per product, a correction
  taking effect at once with that day's notice, no dose due before an entry was recorded), so a
  dose before an entry was recorded is not scheduled for `checkAdministration`; its tag test
  changes from 00:00. A variable-dose
  entry's notice now also says what to do with no checked record for the day: ask the prescriber
  and record the dose on the dosing record for a second person to check. The medicines
  competence result type is `MedicinesCompetenceGate`, because workforce's slice 4 exports a
  `CompetenceGate` of its own. The register's summary (Platform core and Quality, which `main`
  had left behind its rows, and the total) and the STATUS counts now match the register's rows:
  80 `partial`, 153 `todo`.

## #162 clinical review (31/10/2026)

Each finding reproduced by the reviewer's probe and fixed with a table-driven `hazard HZ-...` test:

- HZ-005 (high): `variableDoseFor` let an older checked dosing record answer when a newer one for
  the same day was unchecked or found to differ (warfarin came back as 2.5 mg, not 1 mg). The
  newest record covering the day and time now decides; unchecked or differing, the dose is refused
  (`dosing_record_not_checked`, `dosing_record_differs`), never taken from an older record.
- HZ-004 (high): "taken by the person themselves" and "given by family" counted as nothing at the
  maximum, and an amount entered at the maximum was refused, so the dose went unrecorded. On an
  entry with a 24-hour maximum the amount is now required and always counts; such a dose is always
  recorded, flagged "over maximum" over it, with an urgent escalation in the result
  (`AdministrationEscalation`) for the API to raise. Staff giving over the maximum is still refused.
- HZ-004 (high): an early dose had no limit, so this evening's or tomorrow's dose could be recorded
  at 08:06 with a typed reason. No outcome is now recorded before the dose's own window opens (the
  table's `medicines.dose_window.early_minutes`, or the time-critical figure; `dose_not_due_yet`);
  inside the window before its due time it is early, with a reason; and a dose is not given while
  an earlier dose of the entry that day has no outcome (`earlier_dose_outstanding`). A dose the
  person already took is flagged instead of refused. New input: `recordedDueTimes`.
- The 24-hour maximum now covers every 24 hours containing the dose, before and after it, so a dose
  entered later than others (10 against a maximum of 8) is refused.
- A member never signed off (`not_held`) is refused outright; only an expired competence may be
  overridden (NICE SC1 1.18).
- `checkCorrection` now runs every `checkAdministration` rule on what the correction says, leaving
  out only the duplicate check and the corrected record itself; it takes the rates and returns
  issues, flags and escalations (`AdministrationCorrectionCheck`).
- A when-required entry with neither a minimum interval nor a maximum is refused at transcription
  (`prn_limit_required`); the fixtures that relied on one now state an interval.
- Low: a blank controlled drugs witness is refused (`witness_blank`); a margin correction of
  something other than the quantity may change the balance by none; a dose of the medicine in
  another unit is named as not counted (`prnDosesNotCounted`, `PRN_NOTICES.otherUnitNotCounted`,
  the `other_unit_not_counted` flag), never converted; `prnStatus` returns every notice
  (`notices`), so "not synced" is never hidden; the HZ-001 wrong-person test is in HZ-001's
  verification table; dose windows and competence lapsing at 00:00 UK time are tested on the last
  Sundays of March and October.
- Docs: medicines.md rules 13, 14, 16 to 19, 22, 23, 26 and 27, the test list and open questions;
  hazard log HZ-004, HZ-005, HZ-116 and HZ-119 (causes, controls, verification), with HZ-001 and
  HZ-009 verification rows; the two early-window rate rows say what the figure now does; the
  medical-device boundary's slice 3 paragraph (the dose already taken, "remaining", other units).

## What is next

- Slice 10 (dm+d reference data), then slice 16 (the medication tables and API) and slice 22
  (administrations through `checkAdministration`, with the competence port from slice 17).
- HZ-115 (the CD register) is slice 34's; it should cite the balance and correction tests here.

## Human actions logged

- H-554 (CSO): dose windows and escalation.
- H-555 (CSO with a pharmacist): when-required rules.
- H-556 (CSO with a pharmacist, with H-516): controlled drugs defaults.
- H-557 (CSO): competence and the override.
- H-558 (CSO with a pharmacist): administration record rules and ADR-0082's residual risk.
- H-1060 to H-1066 (CSO, from the #162 clinical review, each with the default built): a newer
  dosing record replacing older ones from its first date; `not_held` never overridable; how a dose
  taken over the maximum is recorded; the paracetamol total across products not enforced; an upper
  limit on a tenant's dose windows; whether "remaining" stays inside the device boundary; a
  when-required entry needing a limit at transcription (H-555's default changed with it).

## Tests

- `timing.test.ts`, `intervals.test.ts`, `competence.test.ts`, `dosing-record.test.ts`,
  `administration.test.ts`, `controlled-drugs.test.ts`, with the slice 2 files: 515 medicines
  tests, passing under `TZ=UTC`, `TZ=Europe/London` and `TZ=America/New_York`. Whole domain
  package after the merges: 5,394 tests, 99.68% line coverage under each of the three time
  zones (`pnpm --filter @harbour/domain test:coverage`). `pnpm lint`, the domain typecheck and the
  markdown link check run clean.
- After the #162 clinical review: 623 medicines tests (518 before); the whole domain package 6,129
  tests, passing under the three time zones, with 99.69% line coverage (medicines 99.43%, every
  medicines file at 99% or more). `pnpm exec biome ci .` and `pnpm typecheck` clean.
