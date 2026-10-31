# Medicines (`medicines`) - specification

Master prompt sections 10.2 and 10.3, with 9.2 (return reconciliation), 17.1 (offline eMAR) and
18 (data model). Phase 2 builds the eMAR ([phase-2.md](../plans/phase-2.md), lane A; ADR-0012
builds it rather than integrating a vendor). Slice 2 wrote this spec in full for the medicines
record and reconciliation (MEDS-001) and built its domain rules; the administration, PRN and
controlled-drug rules (sections 4.2 and 9) are slice 3's, written here as the rows they will
fill. Status per feature: [feature register](feature-register.md).

## 1. Purpose and register rows

Section 10.2: the medicines record, administration rounds and the registers a care home keeps, with
the rules in section 10.3 that protect people.

| Row | Feature (register) | Phase | Plan slices |
| --- | --- | --- | --- |
| MEDS-001 | dm+d-coded medicines record and reconciliation (admission, transfer, change, return from hospital) | 2 | 2, 10, 16, 49, 52 |
| MEDS-002 | Offline administration rounds with barcode and person confirmation, time-critical rules and the 10.3 safety rules | 2 | 3, 22, 48, 53, 68 to 70 |
| MEDS-003 | PRN protocols with outcomes and psychotropic PRN report | 2 | 3, 28, 53, 69 |
| MEDS-004 | Covert administration records with best-interests evidence | 2 | 38, 53 |
| MEDS-005 | Electronic controlled-drugs register with two signatures and running balances | 2 | 3, 34, 54, 70 |
| MEDS-006 | Self-administration risk assessment and review | 2 | 38, 52 |
| MEDS-007 | Homely remedies protocols | 2 | 38, 55 |
| MEDS-008 | Stock, 28-day cycle ordering and disposal records, with fridge and room temperature logs | 2 | 42, 55 |
| MEDS-012 | Medication errors and near misses with notification rules | 2 | 7, 45, 55 |
| MEDS-013 | Annual medication review tracker and competence gating with logged override | 2 | 3, 45, 55 |
| MEDS-014 | Printable MAR chart and CD register exports | 2 | 50, 54 |

Not in Phase 2: MEDS-009 GP proxy ordering and MEDS-010 pharmacy interface (Phase 5), MEDS-011 home
care levels of support (Phase 4). The dm+d reference data and its download are INTG-006
([integrations.md](integrations.md)).

## 2. Schema (for slices 10 and 16; no migration in slice 2)

Forced RLS on every tenant table (ADR-0002), scoped by the person (`person_child_scope`, as the care
record). dm+d reference tables are global, with no `tenant_id` (ADR-0080, slice 10).

| Table | Kind | Key columns | Retention class |
| --- | --- | --- | --- |
| `medication` (the MAR entry; one row per version) | Versioned: each change is a new row; only the check, stop and replacement columns are set later, once each (a trigger refuses changing a set value), under `expected_version` | person, `version`, `replaces_id`, `state` (`not_yet_checked`, `checked`, `difference_found`, `stopped`, `replaced`), `origin` (`transcribed`, `reconciliation`, `import`), dm+d `vmp_id` and `amp_id` with the dm+d name at transcription, route code and name, `directions` (`regular` or `when_required`), the pattern (`every_day`, `every_n_days` with the interval, `weekly` with weekdays and interval, `monthly` with the day), the when-required dose, indication, special instructions as written, prescriber, `starts_at`, `stops_at`, `review_on`, source (kind, reference, document), `transcribed_by` and `_at`, second check (by, at, outcome, difference), stop (by, at, effective at, reason, source), `replaced_by_id`, `replaced_from`, CD schedule from dm+d (slice 10), `reconciliation_id`, `import_batch_id` (slice 51) | `mar_chart` |
| `medication_schedule` (section 18's name; one row per prescribed time) | As its entry (written with it) | entry, `time` (HH:MM, UK), dose kind (`amount`, `range`, `variable`), quantity or from and to (numeric, at most 3 decimal places), unit code and dm+d unit name | `mar_chart` |
| `medication_reconciliation` | Mutable until completed, then closed | person, `trigger` (`admission`, `transfer`, `return_from_hospital`, `change`), the people-lifecycle event it answers, `triggered_at`, started by and at, the entries and versions at the start, `status` (`open`, `completed`), completed by and at, allergies compared, person involved or the reason not, the reason there is no discharge letter | `mar_chart` |
| `medication_reconciliation_source` | Append-only | reconciliation, kind (rule 9), reference, document, received at | `mar_chart` |
| `medication_reconciliation_item` | Append-only | source, the line as written, dm+d `vmp_id` and `amp_id` when coded | `mar_chart` |
| `medication_reconciliation_decision` | Replaced while open; frozen at completion | reconciliation, the entry or source line it is about, kind (`continue`, `change`, `stop`, `query`; `start`, `not_started`), linked lines, the stop's source, note, reason or question, the draft entry, the entry it made | `mar_chart` |

Section 18's **schedule type** (regular, PRN, variable, covert, self-administered, homely remedy) is
held as: `directions` regular or when required; a **variable** dose (the dose changes by date and
is read from the current dosing record, as with warfarin) is a dose kind on a regular entry;
covert administration, self-administration and homely remedies are records of their own linked to
the entry (slice 38), because each can apply to a regular or a when-required medicine (H-553).

Later slices add `medication_administration` (append-only with no UPDATE or DELETE grant: schedule,
due time, outcome, dose given, reason codes, administered by, witnessed by, scan evidence, covert
flag, patch site, stock after, device and server time, `supersedes_id`; slice 22) and
`controlled_drug_entry` (page key person, drug, form and strength; movement, quantity, balance, two
signatures; append-only; slice 34). Retention: `mar_chart` for medicines, schedules,
reconciliations and administrations; `controlled_drugs_register` (and `mar_chart` for
administrations) for CD entries ([retention.md](retention.md)).

## 3. Permissions

In the catalogue since Phase 0 (`packages/domain/src/platform/permissions.ts`; matrix in
[permissions.md](permissions.md)). All are care-record permissions (MFA). Slice 2 adds no
permission: the record and reconciliation use `medicines.record.manage`, held by the owner, the
Registered Manager, the deputy and the clinical lead (team leaders and care workers do not hold it
unless the tenant's own role adds it).

| Action (slice 16 route) | Permission | Also needs (domain rule) | Scope |
| --- | --- | --- | --- |
| Read the person's medicines record and MAR | `care.plan.read`, or `medicines.emar.administer`, or `medicines.record.manage` (slice 16 decides whether a separate `medicines.record.read` is needed, ADR-0071) | - | The person |
| Transcribe a new entry, or change one (a new version) | `medicines.record.manage` | A dm+d product, a route and units dm+d gives, a source document (rules 1 to 5) | The person |
| Second-check an entry | `medicines.record.manage` | Current medicines competence; not the transcriber; compared with the source (rule 6) | The person |
| Stop an entry | `medicines.record.manage` | A reason and the source document; now or later (rule 6) | The person |
| Start, decide and complete a reconciliation | `medicines.record.manage` | Current medicines competence to complete (rules 7 to 12) | The person |
| Record administrations, PRN, CD entries, stock, overrides | `medicines.emar.administer`, `medicines.cd.administer` (step-up), `medicines.cd.witness`, `medicines.stock.manage`, `medicines.override.approve` | Slice 3 rules | The person or location |

Medicines competence (`current`, `expired`, `not_held`) is an input the API reads through
workforce's competence port (slice 17, ADR-0085), never a cross-module join.

## 4. Rules that are easy to get wrong

Every rule has a table-driven test in `packages/domain/src/medicines/` named with its hazard ID.
Figures come from `rate_table` by key, resolved with `resolveMedicinesRates`; slice 2 reads only
`medicines.ordering_cycle_days`, and a test fails if that figure appears as a literal in the rules.
Harbour transcribes and applies what the prescriber wrote; it calculates no dose, suggests no time
and compares no ingredients ([medical-device boundary](../compliance/medical-device-boundary.md)).

### 4.1 Medicines record and reconciliation (slice 2, built)

1. **dm+d only** (HZ-005; `dmd.ts`). Every entry names a dm+d VMP, and an AMP when a brand or
   supplier's product is meant. An identifier must have the SNOMED CT concept shape (6 to 18 digits,
   partition `00` or `10`) and a valid Verhoeff check digit (`isDmdId`), so a typed name can never
   stand in for a product; the reference data (slice 10) says whether it exists. Products are
   compared by identity only (`dmdProductDifference`: another VMP is another product, another AMP
   of the same VMP another brand), never by ingredient.
2. **Structured dose** (HZ-005; `dose.ts`). A dose is an amount ("2 tablets"), a range the
   prescription allows ("1 to 2 tablets") or variable ("As on the current dosing record, in mg"),
   with a unit dm+d permits for the product, matched by code (`checkDose`). A typed number is taken
   only in the form it is shown (`parseDoseQuantity`): a zero before a point (".5" is refused with
   "Write a zero before the decimal point: 0.5, never .5."), no trailing zero or point ("5.0" and
   "5." are refused: "Write 5, never 5.0: a trailing zero or point can be misread as ten times the
   dose."), no leading zeros, commas, fractions or words, at most 3 decimal places, more than zero.
   Display (`formatDose`) writes "micrograms", "nanograms" and "units" in full whatever the source
   calls them ("mcg", "µg", "ug", "ng", "u", "IU"), keeps "mg", "g" and "ml" as dm+d writes them,
   and uses the plural unless the quantity is exactly 1 ("0.5 tablets", "1 to 2 tablets",
   "0.5 to 1 tablet"). No thousands separator ("5000 units"). Harbour never converts a dose (H-551).
3. **Schedules** (HZ-003, HZ-009; `schedule.ts`). A regular entry has prescribed wall-clock times
   (HH:MM, UK time), each with its own dose, on a pattern: every day; every n days (2 is every other
   day) counted from the day it starts; weekly on named days every n weeks (2 is fortnightly)
   counted from the week it starts; monthly on a day, on the last day of a shorter month (flagged).
   There is no "every n hours" regular schedule: the times are written out (H-553). Doses are
   expanded to instants with the time-zone database over the MAR cycle (`marCycle`: from 00:00 UK
   time on the tenant's cycle start for `medicines.ordering_cycle_days` days; `marCycleContaining`
   finds the cycle for a date), never by adding 24 hours, and only within the entry's period.
4. **Clock changes** (HZ-009, H-22). A time in the hour skipped when the clocks go forward is due
   an hour later (01:30 becomes 02:30 BST) and flagged `time_skipped`; a time in the hour repeated
   when they go back is due once, at the first (BST) occurrence, and flagged `time_repeated`; an
   08:00 dose stays at 08:00 either side (23 or 25 hours apart). If a moved time lands on another
   prescribed time of the same entry, both doses stay and both name the other (`sameInstantAs`) for
   the nurse in charge: Harbour never merges or drops a dose. `clockChangesIn` names the days in a
   cycle when the clocks change, so the MAR and the round can say so.
5. **Non-daily schedules name the day** (HZ-005). Every dose of a non-daily pattern carries its day
   name for the MAR row (`MarDose.dayName`), and the schedule in words names the days
   (`describeSchedule`: "1 tablet every Monday at 07:00", "2 tablets every other day at 08:00,
   from Monday 02/11/2026").
6. **Entry states and the second check** (HZ-005; `mar-entry.ts`). A draft needs a dm+d product, a
   route dm+d gives for it, a valid schedule or a when-required dose, an indication for a
   when-required medicine, the prescriber, a source document (kind and reference; a verbal
   instruction is not a source, H-552), a stop after the start and a real review date
   (`checkMarEntryDraft`, every problem at once). A new entry, whatever its origin (typed, a
   reconciliation or an import), is **Not yet checked** (`transcribeMarEntry`). The second check
   (`recordSecondCheck`) needs a person other than the transcriber, with current medicines
   competence, who confirms they compared the entry with the source; it either confirms it
   (**Checked**) or records what differs (**Check found a difference**: the entry may not be given
   until a corrected version replaces it). A change (`changeMarEntry`) is a new version, Not yet
   checked, for the same person, taking effect now or later and replacing the old version from
   then; the person who made it cannot check it. A stop (`stopMarEntry`) needs a reason and its
   source and takes effect now or later; doses before it stay. Stopped and replaced entries are
   closed. `marEntryStatus` gives the words (never colour alone) and whether a dose may be given;
   by default an entry awaiting its check may be given with the notice beside it, and a tenant may
   choose to hold such entries until checked (`UncheckedEntryPolicy`; H-550).
7. **Every medicine on the MAR is decided** (HZ-121; `reconciliation.ts`). A reconciliation lists
   the entries in force when it began; each needs exactly one decision a person made: continue,
   change (a new version from a linked source line), stop (with the source that shows it and the
   reason) or query. Harbour never infers a stop because a source leaves a medicine out. Continuing
   a medicine no source lists needs a note saying how it was confirmed.
8. **Every medicine in the sources is decided** (HZ-121). Each source line is linked to one entry
   decision, or started (a new entry), or not started with a reason, or queried; a line used twice
   is refused.
9. **Sources** (HZ-121). At least one, each saying what it is. On a return from hospital the
   discharge letter is one of them, or the completer says why there is none and how the medicines
   were confirmed. What the person or family says is always asked but is not enough on its own to
   start, change or stop a medicine (`source_not_a_document`); the other kinds (prescription,
   pharmacy label or MAR, discharge or transfer letter, GP record, clinic letter, the prescriber's
   written instruction, the previous setting's MAR) become the new entry's source document.
10. **Differences by identity only** (HZ-121; `linkDifference`). On a link, Harbour shows whether
    the line names another VMP (`product`), another brand of the same VMP (`brand`) or is not dm+d
    coded (`not_coded`); continuing an entry unchanged with any of these needs a note. Harbour
    never pairs lines with entries itself and never compares ingredients.
11. **Completion** (HZ-121, HZ-005; `completeReconciliation`). Refused, with every reason, while a
    query is open, a decision is missing or doubled, a new entry's draft fails rule 6, the completer's
    medicines competence is not current, the allergies in the sources have not been compared with
    the recorded allergies by the completer (Harbour matches no allergen, ADR-0082 default), the
    person (or someone who speaks for them) was not involved and no reason is given, an entry
    belongs to someone else, or the medicines record changed since the reconciliation began
    (another entry, or another version: the completer reviews it first). The result is the plan
    the API applies in one transaction: continued entries, stops with their source, and changes
    and starts made Not yet checked with origin `reconciliation`, so a second person checks each.
12. **Not yet reconciled** (HZ-121; `outstandingReconciliations`). Every admission, transfer and
    return from hospital without a completed reconciliation is listed for the person, oldest first,
    with "Medicines not yet reconciled since the return from hospital on 03/11/2026 14:30." A
    reconciliation for an event also covers that person's earlier events; one for a change covers
    none.

### 4.2 Administration, PRN and controlled drugs (slice 3, planned)

Section 10.3 requires that the app: refuses to record an administration without a selected person,
a dose and an outcome; requires a witness for controlled-drug entries where the tenant policy says
so (default on in residential and nursing homes; a lone worker in home care or supported living
records "no witness available" with the reason, flagged for manager review); blocks duplicate
administration within the minimum interval and requires an override reason; shows the last-given
time for every PRN; locks a MAR row once synced and allows only referenced corrections; keeps
device clocks honest by recording server-received time and flagging drift over
`sync.clock_drift_flag_minutes`; and reconciles offline rounds on sync with a conflict review
screen for the nurse in charge. Section 10.2 adds late and early warnings with time-critical rules,
and annual competence that blocks administration when expired, with the manager override logged.
Slice 3 writes these as rules 13 onwards, with ADR-0082 (time-critical and interval rules apply to
entries a person tags at transcription, second-checked, never by ingredient matching). Rate keys:
`medicines.paracetamol.min_interval_hours`, `medicines.bisphosphonate.before_food_minutes`,
`medicines.review_interval_months`, `medicines.fridge_min_celsius`, `medicines.fridge_max_celsius`,
`medicines.room_max_celsius`, `competence.medicines.refresh_months`.

## 5. API and events (for slice 16)

- `GET /v1/people/{id}/medicines` (entries in force with their status words and notice, the
  outstanding reconciliations), `GET .../medicines/{entryId}/history` (every version, check and
  stop), `GET /v1/people/{id}/mar?cycleStart=` (doses for the cycle with day names and clock-change
  flags).
- `POST /v1/people/{id}/medicines` (transcribe), `POST /v1/medicines/{entryId}/versions` (change,
  with `expected_version`), `/check`, `/stop`.
- `POST /v1/people/{id}/medicine-reconciliations`, `PUT .../{recId}/sources`, `.../items`,
  `.../decisions`, `POST .../{recId}/complete` (runs `completeReconciliation` and applies the plan
  in one transaction). The people lifecycle's `medicines_reconciled` return check is completed by
  the reconciliation for that return.
- Audit events (opaque ids, never content): `medicines.entry.viewed`, `.transcribed`, `.changed`,
  `.checked`, `.check_found_difference`, `.stopped`; `medicines.reconciliation.started`,
  `.completed`. Outbox: `medicines.entry.changed` and `medicines.entry.stopped` (the priority
  stream for medicine-stopped changes, HZ-002, slice 68), `medicines.reconciliation.completed`.

## 6. Offline behaviour

Section 17.1: a full round offline for the people assigned; barcode scans validated against the
cached dm+d subset; CD witness captured locally; on reconnect, conflicts (another device recorded
the same dose) go to a review screen for the nurse in charge. Medicines for assigned people are
reference data that is never evicted while the assignment stands (section 17.2). Root or jailbreak
detection disables the eMAR. Plan slices 68 to 70. Transcription, second checks and reconciliation
need the server in Phase 2; the device shows each entry's status words and notice, the day names
and clock-change flags from the same domain functions.

## 7. Clinical safety

Hazards in the [hazard log](../clinical-safety/hazard-log.md) with Phase 2 controls: HZ-001, HZ-002,
HZ-003, HZ-004, HZ-005, HZ-007, HZ-008, HZ-009, HZ-010, HZ-021, HZ-023, HZ-026. Slice 2 added
HZ-121 (medicines not reconciled after admission, transfer or return from hospital) and built the
domain controls of HZ-005 (dm+d only, structured dose, day names, second check, source document),
HZ-009 (MAR doses across clock changes) and HZ-003 (expansion over the cycle). New hazards HZ-113 to
HZ-120 and HZ-122 are added by the slices the plan names. Medical-device boundary: slice 2 stays
inside it (doses transcribed, never calculated; times as prescribed; products compared by
identity, never ingredient; allergies compared by a person, never matched); re-check
[medical-device-boundary.md](../compliance/medical-device-boundary.md) in every pull request; the
allergen-matching grey area (section 6) is decided by ADR-0082 in slice 3.

## 8. Data protection

Purpose B1 in the [records of processing](../compliance/records-of-processing.md); dm+d fields in
[data-standards.md](data-standards.md) (section 18, data-standard alignment), both updated by slice
16 with the tables. Reconciliation sources may name family members and clinicians (third parties
in a DSAR bundle). No new sub-processor. Slice 2 stores nothing.

## 9. Acceptance criteria and tests

- Domain (built, slice 2): `packages/domain/src/medicines/dose.test.ts` (dm+d identifiers and
  product identity; doses written and read; units dm+d permits), `schedule.test.ts` (the cycle
  from the rate table and no literal; every pattern over a cycle; start, stop and per-time doses;
  last day of a shorter month; day names and wording; the four clock changes of 2026 and 2027;
  schedule problems), `mar-entry.test.ts` (draft problems; states; second check; change; stop;
  status words and the unchecked policy), `reconciliation.test.ts` (the plan; every entry and
  line decided; sources; differences; queries; the stale record; completion checks; outstanding
  reconciliations). Run under `TZ=UTC`, `TZ=Europe/London` and `TZ=America/New_York`.
- Database (slice 16): RLS and HZ-011 isolation for each table; the write-once trigger on check,
  stop and replacement; `expected_version` on changes.
- API (slice 16): `hazard HZ-005 imported medicines are created as not yet checked`; a second check
  by the transcriber is refused; a reconciliation completes only with every decision and applies
  its plan in one transaction; the return check is completed by it; audit events.
- Web (slice 52): the dm+d picker, the second check, the reconciliation screen with each
  difference in words, Playwright with axe.
- The Phase 2 gate needs: a medication round completed offline with barcode and witness in the
  Maestro suite; expired competence blocking administration in tests (slice 3 onwards).

## 10. Open questions

- H-550 (CSO): whether an entry awaiting its second check may be given (default yes, with the
  notice; a tenant may hold such entries), how soon the check is due and who is told when it is
  not done, and whether a stop needs a second check too (default no: it takes effect with its
  source and reason).
- H-551 (pharmacist): the dose-writing rules in rule 2, the 3 decimal places, "0.5 tablets", and
  whether a quantity below 1 where dm+d gives a smaller unit (0.5 g, 500 mg) should be refused
  rather than transcribed as written; "ml" as dm+d writes it or "mL" as the BNF does.
- H-552 (CSO with a pharmacist): the reconciliation rules 7 to 12, the source kinds (no verbal
  instruction; family not enough alone; the previous MAR allowed), "withheld until review" (not a
  state: stop and start again), who may complete one, and the reading of NICE SC1 sections 1.7 and
  1.14 as the master prompt cites them (the build environment could not reach the NICE pages).
- H-553 (CSO with a pharmacist): the schedule patterns, written-out times instead of "every n
  hours", per-time doses, the section 18 schedule type split, and both doses kept when a clock
  change brings two times together.
- The decisions and defaults for later slices are in [phase-2.md](../plans/phase-2.md) (ADR-0080 to
  ADR-0085) and the human actions H-510 to H-517 in [human-actions.md](../plans/human-actions.md).

## 11. As built (slice 2, domain rules)

`packages/domain/src/medicines/`, exported from `@harbour/domain`; pure functions with no I/O. No
schema, API, web or mobile changes in this slice.

| Module | Main exports | For |
| --- | --- | --- |
| `dmd.ts` | `DmdProductRef`, `DmdRoute`, `isDmdId`, `isDmdProduct`, `dmdProductDifference` | Rule 1 |
| `dose.ts` | `Dose`, `DoseUnit`, `parseDoseQuantity`, `isDoseQuantity`, `formatDoseQuantity`, `doseUnitName`, `formatDose`, `checkDose` | Rule 2 |
| `schedule.ts` | `SchedulePattern`, `RegularSchedule`, `checkSchedule`, `expandSchedule`, `MarDose`, `marCycle`, `marCycleContaining`, `clockChangesIn`, `describeSchedule`, `WEEKDAY_NAMES` | Rules 3 to 5 |
| `mar-entry.ts` | `MarEntryDraft`, `MarEntry`, `checkMarEntryDraft`, `transcribeMarEntry`, `recordSecondCheck`, `changeMarEntry`, `stopMarEntry`, `marEntryEnd`, `marEntryDoses`, `marEntryStatus`, `MAR_ENTRY_NOTICES`, `MAR_SOURCE_KINDS` | Rule 6 |
| `reconciliation.ts` | `completeReconciliation`, `linkDifference`, `outstandingReconciliations`, `RECONCILIATION_TRIGGER_WORDS` | Rules 7 to 12 |
| `rates.ts` | `MEDICINES_RATE_KEYS`, `resolveMedicinesRates` | `medicines.ordering_cycle_days` |
