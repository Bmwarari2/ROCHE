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
- Merged #135's third clinical review and `main`. Slice 3 now sits on the stricter record rules
  (changes from 00:00 on a day with doses, later versions withdrawn only with a reason, a change
  keeping the product, one entry per product), and its tag test changes from 00:00. A variable-dose
  entry's notice now also says what to do with no checked record for the day: ask the prescriber
  and record the dose on the dosing record for a second person to check. The medicines
  competence result type is `MedicinesCompetenceGate`, because workforce's slice 4 exports a
  `CompetenceGate` of its own. The register's summary (Platform core and Quality, which `main`
  had left behind its rows, and the total) and the STATUS counts now match the register's rows:
  80 `partial`, 153 `todo`.

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

## Tests

- `timing.test.ts`, `intervals.test.ts`, `competence.test.ts`, `dosing-record.test.ts`,
  `administration.test.ts`, `controlled-drugs.test.ts`, with the slice 2 files: 486 medicines
  tests, passing under `TZ=UTC`, `TZ=Europe/London` and `TZ=America/New_York`. Whole domain
  package after the merges: 5,365 tests, 99.70% line coverage under each of the three time
  zones (`pnpm --filter @harbour/domain test:coverage`). `pnpm lint`, the domain typecheck and the
  markdown link check run clean.
