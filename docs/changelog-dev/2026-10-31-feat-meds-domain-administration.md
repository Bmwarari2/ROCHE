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

## #162 second clinical review (31/10/2026)

The clinical-safety-reviewer agent, run on the fixes above, found them complete but raised one high
finding and nine others, now fixed:

- High (HZ-004): checking a correction like a new dose refused true records: a dose given early in
  error, over the maximum or by a member whose competence had lapsed could never be recorded as
  given, so the false record stood and the dose was missing from the next dose's checks. A dose that
  has already happened is now a fact in every case: a correction, a dose staff record after giving
  it (`givenBeforeRecorded`, with why), and a dose the person or family gave. The rules that refuse
  a dose about to be given flag it instead (`ReviewFlag`, `REVIEW_FLAG_WORDS`), with a `warning`
  escalation for the nurse in charge to review, or `urgent` over the maximum. On the round they
  still refuse; only record problems (person, dose, amount, unit for staff, reasons) refuse a fact.
- Medium: a correction checks the competence of whoever records it (`correctedBy`), now; the
  member it names, who gave the dose then, is flagged, never refused (H-1068). A dose the person or
  family gave in another unit is recorded as given and flagged, never converted; its amount-differs
  message no longer calls it a medication error. A dose they gave from an entry held or stopped, or
  a variable dose with no usable dosing record, is recorded and flagged (H-1062).
- Low: dosing records are ordered by the server's time and records made at the same instant must
  agree (`dosing_records_disagree`); the no-maximum notice points to the prescribed interval, with
  no limit of Harbour's own; the earlier-dose check looks back 24 hours, not to midnight; a
  correction of a when-required dose stays on its MAR day (`RecordedAdministration.at`); review
  flags now reach the nurse in charge; a CD correction says whether it puts right the quantity or a
  detail (`corrects`), so a correction of nothing cannot pass for a mistyped 0.
- Human actions H-1067 (a dose that has happened flagged, not refused; the escalations' severities;
  re-rating HZ-004, HZ-005 and HZ-119) and H-1068 (whose competence a correction checks).

## #162 third clinical review (31/10/2026)

The route for a dose given before it was recorded could be used before a dose was given: it rested
on a client flag and any non-blank reason, with no recording time and no check of who recorded it.

- High (HZ-004, HZ-005, HZ-119): the route now needs a reason of 20 characters or more
  (`GIVEN_BEFORE_RECORDED_REASON_MIN_LENGTH`, as for break-glass search), a time given (`at`, the
  review's `givenAt`) strictly before the new `recordedAt`, which the API sets from the server's
  clock (`given_after_recorded`), and a recorder (`givenBeforeRecorded.recordedBy`) with current
  competence or an override of an expired one, refused otherwise. The named giver (`administrator`)
  is checked at the time given, and a giver other than the recorder is flagged
  (`given_by_someone_else`). A dose that has happened with no checked dose to compare it with (a
  variable dose with no usable dosing record) needs its amount and is escalated `urgent` with it
  (`no_prescribed_dose`), never only a warning.
- Medium (HZ-004): every use is flagged `given_before_recorded`, counted per member beside
  competence overrides for the override report (`REPORTED_FLAGS`, `countReportedFlags`), and
  escalated to the nurse in charge: `warning`, or `urgent` when it broke any rule.
- Medium (HZ-004): asking a reason for every early dose caused alert fatigue. Anywhere inside its
  window a dose is now on time; before its due time it asks a reason only for an entry tagged
  time-critical, or when it comes closer to the entry's last dose than the scheduled gap less the
  window's early side (`earlyNeedsReason`). H-1064 reworded.
- Docs: medicines.md rules 14 and 17 and the slice 22 API notes; rates.md early-window rows; hazard
  log HZ-004, HZ-005 and HZ-119; H-1064 and H-1067.

## #162 third clinical review re-check (31/10/2026)

The re-check confirmed the four fixes above and found two more:

- Medium (HZ-004, HZ-119): recording "refused" and then correcting it to "given" got round the
  route: a held entry or a giver never signed off raised only a warning, the correction carried no
  reported flag, and nothing checked the time given against when the correction was recorded. A
  correction whose new outcome records that a dose happened now follows exactly the rules for a
  dose recorded after it was given: a 20-character reason, a time given strictly before the
  correction's `recordedAt`, the corrector's competence (judged at `recordedAt`; `correctedBy`
  no longer carries a time of its own), the named giver checked at the time given and flagged when
  not the corrector, and always `given_before_recorded`, counted and escalated, urgently when a rule
  was broken.
- Low (existing before this PR): a dose at or after its due time had no gap check, so a late 10:30
  dose followed by the 12:00 dose at 12:00 asked nothing. The gap rule (`closerThanScheduled`) now
  applies to every dose, early, on time or late, flagged `close_to_last_dose`; `earlyNeedsReason`
  is now the time-critical early check alone.
- Docs: medicines.md rules 14 and 23; hazard log HZ-004 and HZ-119; H-1067 and H-1068.

## #162 third review, second re-check (31/10/2026)

To close every correction and back-entry path in one round:

- Medium (HZ-004, HZ-119): a dose corrected away was accepted with no flag, count or escalation
  ("given 4" corrected to refused with "typo" freed the maximum). Every correction now needs a
  20-character reason and is flagged `corrected` with what it changes (`corrected`: outcome,
  amount, time, giver or detail), counted per member (`REPORTED_FLAGS` gains `corrected`,
  `dose_removed`, `dose_moved`). One that removes or lowers a dose recorded as taken (another unit
  counts as none) is flagged `dose_removed`, one that moves it `dose_moved`, each escalated as a
  warning, or urgent when the entry has a maximum, an interval or the paracetamol tag. The maximum,
  intervals and scheduled gap are re-checked both ways around the dose before and after the
  correction; a breach it creates or hides is flagged `breach_created` or `breach_hidden` and
  escalated urgently. The stored record keeps its outcome, amount and giver.
- Low (HZ-004): the scheduled-gap check now looks both ways (`close_to_next_dose`), so an 08:00
  dose back-entered at 11:30 is checked against the 12:00 dose given at 12:05.
- Found while hunting for other paths, and closed: a dose given now could be dated back on the
  round past an interval, a window, a competence lapse or a held entry, or dated forward past an
  interval. A record later than now beyond the typed-time tolerance is refused
  (`recorded_in_future`), and on the round a dose dated earlier than that before it is recorded
  is refused and goes by the flagged route (`given_earlier_than_recorded`). A dose that has
  happened and broke a rule now escalates urgently whatever its outcome (taken by the person,
  given by family, recorded after it was given, or a correction), and one taken inside a minimum
  interval is flagged for review (`inside_minimum_interval`).
- Every reviewer probe in scratchpad/probe-gbr/ was run against this commit (the two written for
  the input before `recordedAt` through their adapted copies).
- Then, on the coordinator's decision: 5 minutes was too strict for recording after a round. The
  back-dating limit is now its own rate row, `medicines.record_delay_tolerance_minutes` (30,
  marked to verify, CSO to confirm in H-1067); the forward limit stays at the clock tolerance;
  and tests show every time-dependent rule judged at the dose's own time within the delay.
- Docs: medicines.md rules 14, 17 and 23 and the slice 22 notes; hazard log HZ-004 and HZ-119;
  H-1067 (a routine amount correction raises a warning, for the CSO to accept or refuse).

## #162 third review, third re-check (31/10/2026)

Every correction path was closed; the allowances on the entered time could still be exploited:

- Medium (HZ-004, HZ-119): an ordinary round record was judged only at the time entered, so
  dating it forward within the clock tolerance cleared the maximum, an interval or the window,
  and dating it back within the record delay recorded a dose from a stopped entry or after an
  override had ended, or hid a late dose. An ordinary record is now judged at both the time
  given and the server's `recordedAt` (with the administrator's competence at each,
  `competenceAtRecording` being new); where a rule passes at one and fails at the other it is
  refused (`differs_at_recording_time`) and goes by the flagged route. Lateness is judged at the
  later of the two, so a dose recorded late shows as late.
- Low: outcomes other than "given" had no delay limit (a refusal three hours back was accepted).
  The delay and the flagged route now apply to every outcome (`recorded_after_delay`, renamed from
  `given_earlier_than_recorded`; `givenBeforeRecorded` covers any outcome).
- Table tests built from the reviewer's Y probes; H-1067 says what this means for doses the person
  takes themselves.

## #162 final check (01/11/2026)

No High or Medium findings at 53de07ee; two Lows, fixed:

- Dating a round record up to 5 minutes later, with a reason typed, dropped the
  `interval_override` or `early` flag (Z1a, Z2a). A flag that needs a reason at either time the
  record is judged now stays on it.
- The flagged route was judged only at the time given, so a dose given after a stop and dated back
  through it raised only a warning (Z4, Z4b). The route is now also checked at `recordedAt`;
  where the rules give a different answer it is flagged `differs_when_recorded` and the review is
  urgent, naming what differs. H-1067 says most route records of a late scheduled dose will now
  escalate urgently, for the CSO to confirm.

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
- After the second review: 644 medicines tests; the whole domain package 6,150 tests under the
  three time zones, 99.69% line coverage (medicines 99.45%).
- After the third review: 675 medicines tests; the whole domain package 6,181 tests under the
  three time zones, 99.69% line coverage (medicines 99.47%, `administration.ts` 100%).
- After the re-check: 692 medicines tests; the whole domain package 6,198 tests under the three
  time zones, 99.69% line coverage (medicines 99.47%, `administration.ts` 100%).
- After the second re-check: 718 medicines tests; the whole domain package 6,224 tests under the
  three time zones, 99.69% line coverage (medicines 99.51%, `administration.ts` 100%).
- After the final check: 751 medicines tests; the whole domain package 6,257 tests under the three
  time zones, 99.69% line coverage (medicines 99.52%, `administration.ts` 100%).
- With the third re-check: 743 medicines tests; the whole domain package 6,249 tests under the
  three time zones, 99.69% line coverage (medicines 99.51%, `administration.ts` 100%).
- With the record delay: 725 medicines tests; the whole domain package 6,231 tests under the
  three time zones, 99.69% line coverage (medicines 99.51%, `administration.ts` 100%).
