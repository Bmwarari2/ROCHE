# Medicines (`medicines`) - specification

Master prompt sections 10.2 and 10.3, with 9.2 (return reconciliation), 17.1 (offline eMAR) and
18 (data model). Phase 2 builds the eMAR ([phase-2.md](../plans/phase-2.md), lane A; ADR-0012
builds it rather than integrating a vendor). Slice 2 wrote this spec in full for the medicines
record and reconciliation (MEDS-001) and built its domain rules; slice 3 built the administration,
PRN, competence and controlled-drug rules (section 4.2; MEDS-002, MEDS-003, MEDS-005, MEDS-013). Status per feature: [feature register](feature-register.md).

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
([integrations.md](integrations.md) section 12: the reference tables, loader, search, product and
GTIN lookups and the device subset built in slice 10; the download is slice 75).

## 2. Schema (for slices 10 and 16; no migration in slice 2)

Forced RLS on every tenant table (ADR-0002), scoped by the person (`person_child_scope`, as the care
record). dm+d reference tables are global, with no `tenant_id` (ADR-0080; built in slice 10,
migration 0110, [integrations.md](integrations.md) section 12).

| Table | Kind | Key columns | Retention class |
| --- | --- | --- | --- |
| `medication` (the MAR entry; one row per version) | Versioned: each change is a new row; only the check, stop and replacement columns are set later, once each (a trigger refuses changing a set value), under `expected_version` | person, `version`, `replaces_id`, `state` (`not_yet_checked`, `checked`, `difference_found`, `stopped`, `replaced`), `origin` (`transcribed`, `reconciliation`, `import`), dm+d `vmp_id` and `amp_id` with the dm+d name at transcription, route code and name, `directions` (`regular` or `when_required`), the pattern (`every_day`, `every_n_days` with the interval and `anchor_on`, `weekly` with weekdays, interval and `anchor_on`, `monthly` with the day), the re-anchor (by, at, reason) when a version deliberately moved the day count, withdrawn (by, at, reason) for a later version a change or stop withdrew, with the reason it gave, the when-required dose, indication, special instructions as written, prescriber, `starts_at`, `stops_at`, `review_on`, source (kind, reference, document), `transcribed_by` and `_at`, second check (by, at, outcome, difference), stop (by, at, effective at, reason, source), `replaced_by_id`, `replaced_from`, CD schedule from dm+d (slice 10), `reconciliation_id`, `import_batch_id` (slice 51) | `mar_chart` |
| `medication_schedule` (section 18's name; one row per prescribed time) | As its entry (written with it) | entry, `time` (HH:MM, UK), dose kind (`amount`, `range`, `variable`), quantity or from and to (numeric, at most 3 decimal places), unit code and dm+d unit name | `mar_chart` |
| `medication_reconciliation` | Mutable until completed, then closed | person, `trigger` (`admission`, `transfer`, `return_from_hospital`, `change`), the people-lifecycle event it answers, `triggered_at`, started by and at, the entries and versions at the start, `status` (`open`, `completed`), completed by and at, allergies compared, person involved or the reason not, the reason there is no discharge letter | `mar_chart` |
| `medication_reconciliation_source` | Append-only | reconciliation, kind (rule 9), reference, document, received at, why it is current (`current_because`) when received before the event | `mar_chart` |
| `medication_reconciliation_item` | Append-only | source, the line as written, dm+d `vmp_id` and `amp_id` when coded, what it says (`start`, `continue`, `change`, `stop`, `unclear`) | `mar_chart` |
| `medication_reconciliation_decision` | Replaced while open; frozen at completion | reconciliation, the entry or source line it is about, kind (`continue`, `change`, `stop`, `query`; `start`, `not_started`), linked lines, note, who confirmed a continue (`confirmed_with`), reason or question, the change's or restart's re-anchor reason, the change-day answer, the draft entry, the entry it made | `mar_chart` |

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
| Transcribe a new entry, or change one (a new version) | `medicines.record.manage` | A dm+d product, a route and units dm+d gives, a source document (rules 1 to 5); one entry per product; a change keeps the product (rule 6) | The person |
| Second-check an entry | `medicines.record.manage` | Current medicines competence; not the transcriber; compared with the source (rule 6) | The person |
| Stop an entry | `medicines.record.manage` | A reason and the source document; now or later (rule 6) | The person |
| Start, decide and complete a reconciliation | `medicines.record.manage` | Current medicines competence to complete (rules 7 to 12) | The person |
| Record an administration or its outcome (slice 22) | `medicines.emar.administer`; `medicines.cd.administer` (step-up) for a controlled drug | `checkAdministration` (rule 17): current competence or an override in force (rule 22) | The person |
| Record and check a dosing record (variable dose) | `medicines.record.manage` | Rule 18: the checker is a second person with current competence | The person |
| Correct an administration record | `medicines.emar.administer` for the author; `medicines.record.manage` for anyone else | Rule 23: a referenced correction of the latest record, with a reason | The person |
| Approve a competence override | `medicines.override.approve` | Rule 22: not the member themselves, a reason, at most the table's hours | The member's location |
| Witness a controlled drugs entry | `medicines.cd.witness` (the witness's own sign-in on the same device; ADR-0084) | Rule 27: not the recorder | The person |
| Record a CD receipt, disposal, transfer, destruction, correction or stock check (slice 34) | `medicines.cd.administer` (step-up) or `medicines.stock.manage` | Rules 24 to 27 | The person or location |
| Close a round with doses outstanding (slice 48) | `medicines.emar.administer` | Rule 23: a reason | The location |

Medicines competence (`current`, `expired`, `not_held`) is an input to `recordSecondCheck`,
`completeReconciliation`, `checkDosingRecord` and `checkAdministration` (via `medicinesCompetenceAt`
on the sign-off date). Slice 16 must read it on the server from workforce's competence port
(slice 17, ADR-0085), for the signed-in member, at the time of the action; never from the request
body, the device or a cross-module join. Until the port exists the API uses its contract-tested
mock, and no route may pass a client-supplied value.

## 4. Rules that are easy to get wrong

Every rule has a table-driven test in `packages/domain/src/medicines/` named with its hazard ID.
Figures come from `rate_table` by key, resolved with `resolveMedicinesRates`; slice 2 reads only
`medicines.ordering_cycle_days`, and a test fails if that figure appears as a literal in the rules.
Thapsus Care transcribes and applies what the prescriber wrote; it calculates no dose, suggests no time
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
   "0.5 to 1 tablet"). A compound unit keeps every part in full ("12 micrograms/hour" for
   "mcg/hr"); a measured unit is written "2 × 5 ml spoonfuls", so its size is never read as part of
   the number. No thousands separator ("5000 units"). Thapsus Care never converts a dose: a number with
   more than 3 decimal places is refused with "ask the prescriber or pharmacist", never "use a
   smaller unit" (H-551). A quantity below 1 in g, mg or micrograms is refused
   (`smaller_unit_permitted`) where dm+d permits the next smaller unit for the product (mg,
   micrograms, nanograms), so "0.5 g" is never transcribed where the BNF's prescription-writing
   guidance asks for "500 mg"; the message names the smaller unit and says to ask the prescriber or
   pharmacist for the dose in it, and Thapsus Care never works out the converted figure (recommended
   answer to H-551, 31/10/2026; the pharmacist confirms it at the testing phase). Mass units are
   recognised by their dm+d description. **Variable doses** (HZ-005): the day doses come from a dosing record (for
   example a warfarin schedule after an INR test, with its source), second-checked like an entry,
   and a dose is given only from a checked one (rule 18, slice 3; slice 16 stores it). Slice 2 had
   blocked every variable-dose entry until the dosing record existed. With no checked record
   for the day, the entry's notice tells staff to ask the prescriber for the day's dose and
   record it on the dosing record for a second person to check.
3. **Schedules** (HZ-003, HZ-009; `schedule.ts`). A regular entry has prescribed wall-clock times
   (HH:MM, UK time), each with its own dose, on a pattern: every day; every n days (2 is every other
   day) counted from the pattern's `anchorOn`, a day a dose fell or falls due; weekly on named days
   every n weeks (2 is fortnightly) counted from the week of `anchorOn`; monthly on a day, on the
   last day of a shorter month (flagged). The anchor is a date of its own, never the start of an
   entry version, so a change or a restart never restarts the count (rule 6a).
   There is no "every n hours" regular schedule: the times are written out (H-553). Doses are
   expanded to instants with the time-zone database over the MAR cycle (`marCycle`: from 00:00 UK
   time on the tenant's cycle start for `medicines.ordering_cycle_days` days; `marCycleContaining`
   finds the cycle for a date), never by adding 24 hours, and only within the entry's period.
4. **Clock changes** (HZ-009, H-22). A time in the hour skipped when the clocks go forward is due
   an hour later (01:30 becomes 02:30 BST) and flagged `time_skipped`; a time in the hour repeated
   when they go back is due once, at the first (BST) occurrence, and flagged `time_repeated`; an
   08:00 dose stays at 08:00 either side (23 or 25 hours apart). If a moved time lands on another
   prescribed time of the same entry, both doses stay and both name the other (`sameInstantAs`) for
   the nurse in charge: Thapsus Care never merges or drops a dose. `clockChangesIn` names the days in a
   cycle when the clocks change, so the MAR and the round can say so.
5. **Non-daily schedules name the day** (HZ-005). Every dose of a non-daily pattern carries its day
   name for the MAR row (`MarDose.dayName`), and the schedule in words names the days
   (`describeSchedule`: "1 tablet every Monday at 07:00", "2 tablets every other day at 08:00,
   counting from Monday 02/11/2026").
6. **Entry states and the second check** (HZ-005; `mar-entry.ts`). A draft needs a dm+d product, a
   route dm+d gives for it, a valid schedule or a when-required dose, an indication for a
   when-required medicine, the prescriber, a source document (kind and reference; a verbal
   instruction is not a source, H-552), a stop after the start and a real review date
   (`checkMarEntryDraft`, every problem at once). A new entry, whatever its origin (typed, a
   reconciliation or an import), is **Not yet checked** (`transcribeMarEntry`). No dose of a new
   entry is due before it was recorded, whatever its start (`marEntryDosesFrom`): an entry recorded
   at 14:00 from 00:00 has no 08:00 dose that day, and the MAR shows that time as "Before this
   entry was recorded: not due" (`marEntryTimesBeforeRecorded`). If a dose earlier that day may
   still be needed, the transcription says why (`earlierDosesDueReason`, the same-day route, as
   for corrections in rule 6c): that day's earlier doses stay due (never those of earlier days),
   and that day the entry carries "Recorded part-way through today with today's earlier doses
   kept due: check with the nurse in charge whether each was given before giving it." The second check
   (`recordSecondCheck`) needs a person other than the transcriber, with current medicines
   competence, who confirms they compared the entry with the source; it either confirms it
   (**Checked**) or records what differs (**Check found a difference**: the entry may not be given
   until a corrected version replaces it). A change (`changeMarEntry`) is a new version, Not yet
   checked, for the same person and the same dm+d VMP (the dose, times, route, brand or AMP, dates
   and directions may change; another VMP, so another strength or form too, is refused,
   `different_product`: stop the entry and record the new product as a new entry). It takes
   effect now or later, at a time a version is in force (`entry_closed` otherwise: a stopped
   medicine is restarted as a new entry, and a correction of an entry not yet started takes effect
   from its start); the person who made it cannot check it. A stop (`stopMarEntry`) needs a reason
   and its source and takes effect now or later; doses before it stay. A new entry is refused while
   an entry of the same VMP, any brand, is in force for the person then or later
   (`same_product_in_force`: change that entry, or stop it first), so one entry per product is on
   the MAR (H-553); another VMP with the same ingredient is its own entry. An entry whose stop or
   replacement is still to come is checked, and corrected by a change, like any other while it is
   in force (a check after it has ended is refused). `marEntryStatus` gives the words (never colour
   alone) and whether a dose may be given: only the version in force ("Not started yet" before its
   start; "Replaced by a newer entry", "Stopped", "Ended" or "Withdrawn before it started" after);
   by default an entry awaiting its check may be given with the notice beside it, and a tenant may
   choose to hold such entries until checked (`UncheckedEntryPolicy`; H-550). A variable-dose entry
   says "Variable dose: give only the dose the checked dosing record gives for the day", and a
   dose without a checked record is refused (rule 18).

   The version rules refuse the sequences that are hard to get right rather than handling them
   (H-553); each refusal says what to do instead.

   **Rule 6a: the day count is kept from the last dose due** (HZ-003, HZ-004; `keepsCountFrom`,
   `lastDueDose`). A new version's pattern, and a restart of a product the person had before
   (`earlierEntries`, every version, stopped ones too), must fall on the day of the last dose that
   was actually due across the medicine's versions: an every-n-days grid through that day, a weekly
   pattern on that weekday (and, every n weeks, that week), a monthly pattern on that day of the
   month. So a patch every 3 days from Monday 02/11 changed on Tuesday 03/11 is next due Thursday
   05/11 at 07:00 or 09:00; a fortnightly Monday dose moved to Tuesday is not due the next day
   without a reason; and a count is not lost by passing through every day, when required or a
   stop. Otherwise the change or restart is refused (`count_reanchored`, naming the last dose)
   unless the prescriber's new pattern starts a new count on purpose: the reason is recorded on the
   new version (`reanchor`; H-553). A missing or unreadable anchor is refused (`bad_anchor`),
   never thrown.

   **Rule 6b: exactly one version in force** (HZ-004; `versionInForceAt`). A change and a stop work
   on every version of the medicine: the version in force when they take effect ends then. A
   change or a stop while a later version is scheduled is refused (`later_version_scheduled`,
   naming it) unless the request withdraws that version and says why (`withdrawLaterReason`; the
   withdrawn version records who, when and that reason, and the API audits it); a stop while a
   later stop is recorded is refused unless it says why the earlier stop replaces it. A stop still
   to come, on the version in force or on a version the change withdraws, carries over to the new
   version (the earliest, when there are two), so a change never cancels a stop: a course that
   continues past its stop is a new entry from the stop. The course end (`stopsAt`, from the
   prescription) is kept the same way: the new version gives the same end, or an earlier one,
   never none or a later one (`course_end_kept`, naming the end); a course that continues past its
   end is a new entry from then (H-553). So at no instant are two versions givable, and nothing is
   given after a recorded stop or a course end from an entry recorded before it. A property test
   runs random sequences of changes, stops, restarts and corrections (regular and when required,
   with and without course ends) and checks every boundary, every dose and every day; the
   reviewer's fuzzer (9,000 sequences) finds no doubled dose, no two givable versions and nothing
   given after a stop.

   **Rule 6c: no change part-way through a day with doses** (HZ-003, HZ-004). A change that takes
   effect part-way through a UK day is refused when either version has a regular dose that day
   (`change_from_tomorrow`): it takes effect from 00:00 the next day, so that day's doses are the
   old version's and the next day's the new one's, never given twice or dropped. That includes
   regular to when required, and when required to regular with a dose later that day. A change on
   a day with no regular dose under either version (when required to when required, or every 3
   days on a day between doses) may take effect at any time. A restart (a new entry of a product
   the person had before) that starts part-way through a day on which a dose was already due under
   the entry that stopped is refused (`restart_from_tomorrow`); stopped before that day's first
   dose, it may start the same day. On the days the clocks change, a change from 00:00 gives the
   new schedule's doses for the day (rule 4).

   Two cases keep that day's doses in sight instead (H-553). A **correction**, a change of a
   version whose check found a difference, fixes a transcription error rather than changing the
   prescription, so it takes effect at once, for the rest of the day (`correctedPartWayThrough`):
   that day it carries "Corrected part-way through today: check today's doses with the nurse in
   charge before giving the rest." And a version **replaced from 00:00 tomorrow** (a change made
   today, such as after a return from hospital at 14:00) carries, for the rest of today, "A change
   starts tomorrow: check today's remaining doses with the nurse in charge." The stricter option
   was chosen: no ordinary change takes effect part-way through a day, even from a reconciliation.
7. **Every medicine on the MAR is decided, on a line that says so** (HZ-121; `reconciliation.ts`).
   Each source line is recorded as written with its dm+d product and what it says: start,
   continue, change, stop or unclear (`says`). A reconciliation lists the entries to decide on
   when it began (`entriesToReconcile` over every version of the person's entries: for each
   medicine, the version in force or, when none is, the first scheduled to start; worked out from
   dates, never by state, because a version whose stop or replacement is still to come is already
   `stopped` or `replaced`: the API must not filter by state); each needs exactly one decision a
   person made: continue, change, stop or query. A
   decision is supported only by a line that says that thing about the same dm+d product (a VMP,
   by identity): a line that says something else, or names another product, never supports it,
   whatever the note (`line_does_not_support`). Thapsus Care never infers a stop because a source leaves
   a medicine out: a stop links the line that says it stops, from a current document; with no such
   line the decision is a query. A change keeps the entry's dm+d VMP (`change_different_product`
   otherwise: a switch, such as warfarin to apixaban, is a stop on the old product's line and a
   start on the new one's) and links the line that says the change, about that product, from a
   current document. A continue needs a line that says continue from a current
   document that shows what is prescribed now (on a return from hospital with a discharge letter,
   the letter's line; otherwise a prescription, the pharmacy's MAR, a discharge or transfer letter,
   the GP record, a clinic letter or the prescriber's written instruction); one supported only by
   labels, the previous setting's MAR or what the person or family say, or by no line, needs a note
   and who confirmed it (the prescriber or a clinician, how and when: `confirmedWith`). A continue
   of a medicine with a later version or a stop scheduled before the reconciliation is refused
   (`continue_with_later_scheduled`, naming it) until the person checks it against the sources:
   they change or stop the medicine, or say why it still stands (`scheduledStillStands`). A change
   is refused the same way while it keeps a version or stop scheduled before the reconciliation
   (`change_with_later_scheduled`, naming each): a version scheduled before the change takes effect
   (a change from 12/11 keeps one from 10/11), or a stop still to come (a change never cancels a
   stop). The person starts the change before the scheduled version, so it withdraws it, with the
   reason, or says why what is kept still stands (`scheduledStillStands`, carried into the plan). A
   stop while a later version or stop is scheduled gives the reason it withdraws or replaces it,
   and so does a change that withdraws a version (`withdrawLaterReason`, rule 6b), carried into the
   plan. An unclear line blocks completion until
   it is asked about and recorded again (`line_unclear`).
8. **Every medicine in the sources is decided** (HZ-121). Each source line is linked to one entry
   decision, or started (a new entry, from a current document's line that says start, continue or
   change, about the draft's own product), or not started with a reason, or queried; a line used
   twice is refused.
9. **Sources** (HZ-121). At least one, each saying what it is. A source shows what is prescribed
   now for this event only when received on or after the admission, transfer or return, or marked
   current by the person with a reason (`currentBecause`); a GP record from June does not support
   anything after a November return on its own. On a return from hospital the discharge letter is
   one of the sources, or the completer says why there is none and how the medicines were
   confirmed. What the person or family says is always asked but is not enough on its own to
   start, change or stop a medicine (`source_not_a_document`); the other kinds become the new
   entry's source document.
10. **Differences and duplicates by identity only** (HZ-121; `linkDifference`). Thapsus Care never pairs
    lines with entries itself and never compares ingredients. Continuing an entry on a line that
    names another brand of the same VMP needs a note. One entry per dm+d VMP (rule 6): a start of a
    VMP the MAR already holds is refused when the reconciliation completes (`start_refused`,
    `same_product_in_force`), and so is a start beside an entry of the same VMP continued or
    changed in the plan, or a second start of it (`duplicate_product`), even for a regular and a
    when-required entry of one product (H-553); the existing entry is changed instead. Stopping and
    starting the same product in one reconciliation is a change. The exception is a start on or
    after the end the existing entry has after the plan: a course the letter extends (to 14/11, from
    a course ending 10/11) is continued or changed to its end and started again from then on the
    letter's line, because a change never extends a course end (rule 6b; H-553). Another VMP with
    the same ingredient is never flagged.
11. **Completion** (HZ-121, HZ-005; `completeReconciliation`). Refused, with every reason, while a
    query is open or a line unclear, a decision is missing, doubled or unsupported, a new entry's
    draft fails rule 6, a change, stop or start fails the MAR rules (rule 6, 6a to 6c): each change
    and stop is tried against the entry's versions (`entryVersions`) and each start against the
    person's earlier entries of the product, stopped ones included (`earlierEntries`), when the
    reconciliation completes, so a refusal shows then, not when the plan is applied
    (`change_refused`, `stop_refused`, `start_refused`), a product would be on the MAR twice, the completer's medicines
    competence (read from the workforce port, section 3) is not current, the allergies in the
    sources have not been compared with the recorded allergies by the completer (Thapsus Care matches no
    allergen, ADR-0082 default), the person (or someone who speaks for them) was not involved and
    no reason is given, an entry belongs to someone else, or the entries to decide on are not the
    ones it began with (`record_changed`, medicine by medicine): a medicine added or gone, or
    another version in force now. A reconciliation begun at 23:00 and completed at 00:30, after a
    change scheduled for 00:00 took effect, says "Paracetamol 500mg tablets: version 2 is in force
    now, from 06/11/2026 00:00, in place of version 1 this reconciliation began with. Redo the
    decisions for it against version 2", and the decision for version 1 says the same; the API takes
    the entries again (`entriesToReconcile`) when the person redoes those decisions. The result is the plan the API applies in one transaction: continued
    entries, stops with their source from when it completes (`stopMarEntry`), changes
    (`changeMarEntry`, with the re-anchor reason), each with the reason it withdraws a later
    version or stop and why what it keeps still stands, and starts (`transcribeMarEntry`, with the
    person's earlier entries and, when given, the reason that day's earlier doses may still be
    needed) made Not yet checked with origin `reconciliation`, so a second person checks each.
12. **Not yet reconciled** (HZ-121; `outstandingReconciliations`). Every admission, transfer and
    return from hospital without a completed reconciliation is listed for the person, oldest first,
    with "Medicines not yet reconciled since the return from hospital on 03/11/2026 14:30." A
    reconciliation for an event also covers that person's earlier events; one for a change covers
    none.

### 4.2 Administration, PRN and controlled drugs (slice 3, built)

Section 10.3: the app refuses to record an administration without a selected person, a dose and an
outcome; requires a witness for controlled-drug entries where the tenant policy says so; blocks
duplicate administration within the minimum interval and requires an override reason; shows the
last-given time for every PRN; locks a MAR row once synced and allows only referenced corrections;
keeps device clocks honest; and reconciles offline rounds on sync for the nurse in charge (slices
48 and 70). Section 10.2 adds late and early warnings with time-critical rules, and annual
competence that blocks administration when expired, with the manager override logged. Rules 13 to
27 are slice 3's domain rules; [ADR-0082](../decisions/0082-medicines-rules-at-the-device-boundary.md)
sets how time-critical and interval rules meet the medical-device boundary. Rate keys: those in
`MEDICINES_RATE_KEYS`, each read from the table (a test scans the rules for every two-digit figure).

13. **Tags at transcription** (ADR-0082; `MEDICINE_TAGS`, `suggestedTags`). A MAR entry carries
    tags a person sets at transcription and the second check confirms: `time_critical`,
    `paracetamol`, `bisphosphonate`, `psychotropic`. Thapsus Care offers a tag only when the tenant's
    own list for it holds the product's exact VMP; never by ingredient or name. An entry also
    carries the minimum interval the prescription or PRN protocol states, and a when-required entry
    its maximum in 24 hours (the PRN status says when none is recorded, for entries from before
    0123). A new or changed when-required entry without its maximum in 24 hours is refused at
    transcription and import (`prn_limit_required`): the transcriber asks the prescriber. An
    interval alone is refused too, since it can be overridden and caps no daily total (H-1066;
    #162 and batch 3b clinical reviews).
14. **Dose windows** (HZ-003, HZ-004, HZ-009; `timing.ts`). A scheduled dose's own window opens
    `medicines.dose_window.early_minutes` before its time and ends
    `medicines.dose_window.late_minutes` after; an entry tagged time-critical has the narrower
    `medicines.time_critical.*` (never wider than the regular window). No outcome is recorded
    before the window opens (`dose_not_due_yet`), so a later dose (this evening's, tomorrow's) is
    never recorded at the morning round and nothing is filled in ahead; a dose that has already
    happened (taken by the person, given by family, recorded after it was given, or a correction)
    is recorded and flagged for review instead (rule 17). Anywhere inside its window a dose is on
    time; after it, late, with a reason. Given before its due time it asks a reason (and is flagged
    early) only for an entry tagged time-critical (`earlyNeedsReason`). Any dose, early, on time or
    late, asks a reason when it comes closer to the entry's dose before it, or to its dose after it
    (a dose entered later than others), than the scheduled gap less the window's early side
    (`closerThanScheduled`; flagged `close_to_last_dose` or `close_to_next_dose`): a late 10:30
    dose followed by the 12:00 dose at 12:00 is asked about, as is an 08:00 dose back-entered at
    11:30 before a 12:00 dose given at 12:05; and no reason is asked for every dose a round gives
    a little early (#162 third clinical review and its re-checks, against alert fatigue). Windows are elapsed time, so on the
    days the clocks change they are as long as any other (#162 clinical review; H-1064 asks the
    CSO for an upper limit on a tenant's figures).
15. **Outstanding and escalation** (HZ-003). With no outcome after its window a dose is "Late: no
    outcome recorded" and stays outstanding until someone records what happened; nothing closes it.
    Its escalation falls due at the end of its window, so a time-critical dose escalates sooner
    (slice 48 sends it). Thapsus Care never makes a missed dose due again.
16. **Minimum intervals** (HZ-004, HZ-009, HZ-010; `intervals.ts`). A dose inside the entry's own
    prescribed interval (counting every version of the entry), or inside the paracetamol interval of
    a dose from any entry tagged paracetamol, before or after it, needs an override reason and is
    flagged; for a dose that has already happened, the reason is what happened. Gaps are elapsed
    time between drift-corrected instants (`driftCorrectedTime`: the
    device time plus the offset measured at its last sync; drift beyond
    `sync.clock_drift_flag_minutes` is flagged), so a clock change neither shortens nor lengthens one.
17. **Recording a dose** (HZ-001, HZ-003, HZ-004, HZ-005; `checkAdministration`). Refused without a
    selected person, the medicine and (for a regular medicine) the scheduled dose, and an outcome;
    for another person's medicine; for a time the entry has no dose; for a dose already recorded (a
    correction instead); from a version not in force or not givable (rule 6); for a reason code not
    for the outcome; at a time later than now beyond the table's clock tolerance
    (`sync.clock_drift_flag_minutes`; `recorded_in_future`); and, on the round, a record of any
    outcome dated more than `medicines.record_delay_tolerance_minutes` (30, to verify: carers
    record after a round) before it is recorded (`recorded_after_delay`), which is recorded instead
    by the route for a record made after the event below, flagged and escalated. An ordinary round
    record must also pass every rule at both the time given and the server's `recordedAt` (the
    maximum, intervals and gap, the window, the entry in force and not held, and competence or an
    override, with the competence at `recordedAt` from workforce's port, `competenceAtRecording`);
    where a rule passes at one time and fails at the other it is refused
    (`differs_at_recording_time`, naming what fails when it is recorded) and goes by the flagged
    route, so neither allowance on the entered time can clear a limit; lateness is judged at the
    later of the two, so a dose recorded late shows as late, with why; and a flag that needs a
    reason (early, late, close to another dose, inside an interval, under an override) at either
    time stays on the record. A record by the route is judged at the time given, flagged and
    escalated, and is checked again at `recordedAt`: where the rules give a different answer at
    the two times it is flagged `differs_when_recorded` and the review is urgent, naming what
    differs, so a dose dated back through a stop, a lapse or its lateness is never only a warning
    (#162 third review's re-checks and final check; H-1067).
    Outcomes: given, refused, not given (asleep, away from the home, in hospital,
    nil by mouth, unable to swallow, vomiting, other), not available (out of stock, not delivered,
    other), taken by the person themselves, given by family as agreed, withheld (the prescriber said
    to, outside the limits the prescriber set, other); "other" and "withheld" always need words.
    "Given" needs the amount in the entry's unit: the prescribed amount, within a prescribed range,
    or the checked dosing record's dose; another amount needs what happened and is flagged as a
    possible medication error. A dose is not given while an earlier dose of the same entry in the
    24 hours before it has no outcome (`earlier_dose_outstanding`, naming each by time and date):
    that one is recorded first. "Taken by the person themselves" and "given by family" record a
    dose staff did not give: on an entry with a 24-hour maximum they need the amount, which always
    counts towards it (one in another unit is recorded as given, never converted, and flagged as
    not counted). A dose that has already happened is a fact, so it is always recorded: such a
    dose, a dose staff record after giving it (`givenBeforeRecorded`), and every correction
    (rule 23) are never refused by the window, an earlier dose outstanding, the entry in force,
    the dosing record or the maximum, nor, for a record made after the event, by the competence of
    whoever gave it then. They are flagged instead (`ReviewFlag`: before window, earlier dose
    outstanding, entry not usable, no usable dosing record, amount in another unit, competence not
    current, inside the minimum interval) and sent to the nurse in charge to review in words:
    `urgent` when any of those rules was broken, `warning` when only how it was recorded needs
    review; one over
    the maximum is flagged "over maximum" and escalated `urgent`, and one with no checked dose to
    compare it with (a variable dose with no usable dosing record) needs its amount and is
    escalated `urgent` with that amount (`no_prescribed_dose`), never only a warning. A record
    made after the event (`givenBeforeRecorded`, for a dose or any other outcome) cannot stand in
    for one made on the round (#162 third clinical review): it needs a reason of 20 characters or
    more
    (`GIVEN_BEFORE_RECORDED_REASON_MIN_LENGTH`, as for break-glass search); its time given (`at`,
    the review's `givenAt`) must be strictly before `recordedAt`, which the API sets from the
    server's clock and never takes from the request (`given_after_recorded`); whoever records it
    needs current competence, or an override of an expired one (rule 22, H-1061), or it is refused;
    the member named as having given it is checked at the time given and, when not the recorder,
    the record is flagged `given_by_someone_else`; every use is flagged `given_before_recorded`,
    counted per member for the override report with competence overrides (`REPORTED_FLAGS`,
    `countReportedFlags`), and escalated to the nurse in charge: `warning`, or `urgent` when it
    broke any rule. The API raises every escalation through the escalation chain, whose recipients
    and acknowledgement slice 48 sets (H-1062, H-1067). On the round, about to give a dose, every
    one of those rules refuses it. Flags carried: early, late, interval override, competence
    override, amount differs, other unit not counted, over maximum, entry not yet checked and the
    review flags.
18. **Variable doses** (HZ-005, HZ-116; `dosing-record.ts`). A variable-dose entry's day doses come
    from a dosing record transcribed from its source (for example the anticoagulant clinic's), for
    each day and prescribed time, and checked by a second person with current competence who
    compared it with the source. The newest record covering a day and time decides that dose: it
    is given only when that record was checked and found to match its source; when the newest is
    not yet checked, or its check found a difference, the dose is refused
    (`dosing_record_not_checked`, `dosing_record_differs`) and an older record is never used
    instead; with none, `no_checked_dosing_record`. An older record still gives a day the newer one
    does not cover (H-1060 asks whether a newer record should replace older ones from its first
    date). "Newest" is by the server's time (dosing records are recorded and checked online); two
    records made at the same instant must all be checked and agree, or the dose is refused
    (`dosing_records_disagree`).
19. **When required: maximum and last given** (HZ-004; `prnStatus`, `prnMaximumExceeded`,
    `prnDosesNotCounted`). A dose that would take the total over the prescribed maximum in any 24
    hours containing it, before or after it (so a dose entered later than others is counted
    against those after it too), is refused, with no override on the round: the prescriber decides
    (a dose already taken is recorded and escalated, rule 17). A dose of the medicine in another
    unit is never converted and never left out silently: it is named as not counted. The round
    shows when it was last given, by whom and whether it has synced, the 24-hour total, what
    remains (the prescriber's maximum less the total, H-1065), and when the interval allows the
    next, with every notice that applies: no maximum recorded (the prescribed interval applies, with
    no limit of Thapsus Care's own), the maximum given, the last dose not synced, a dose in another unit
    not counted. Thapsus Care does not add up paracetamol across products
    against a daily total; each entry's own maximum applies (H-1063).
20. **When-required outcomes** (`prnOutcomeDueAt`). The outcome of a when-required dose falls due
    `medicines.prn.outcome_check_minutes` after it and is listed until recorded.
21. **Competence** (HZ-119; `competence.ts`). Medicines competence is current until 00:00 UK time on
    the date `competence.medicines.refresh_months` after the last observed sign-off (the last day of
    a shorter month); none before a sign-off. The API reads the sign-off from workforce's port
    (ADR-0085), never from the request.
22. **Competence gate and override** (HZ-119). Every outcome a member records needs current
    competence, or, when it has expired, an override in force that someone else recorded with a
    reason for at most `medicines.competence_override.max_hours`; the API checks the approver holds
    `medicines.override.approve`. Every overridden record is flagged for the override report
    (slice 45). A member never signed off is refused outright, whatever override is offered: staff
    not assessed as competent must not give medicines (NICE SC1 1.18, as the master prompt cites
    it; H-1061).
23. **Rounds and the MAR row lock** (HZ-003, HZ-004). A round closes with doses outstanding only
    with a reason; the outstanding doses, time-critical first, go to the handover and stay
    outstanding. A record may be amended on its device by its author until it syncs; after that it
    is locked, and a correction is a new record that refers to the latest record for the same
    person and dose (a when-required dose: the same entry and MAR day), with a reason, and can
    never move to another dose. Whoever records the correction (its author, or a holder of
    `medicines.record.manage`) needs current competence then, or an override of an expired one
    (H-1068), judged at the correction's `recordedAt`, the server's time. What the correction says
    meets every rule of rule 17 as a record made after the event, the member it names being
    whoever gave the dose then: "refused" corrected to "given" is checked as a dose given then,
    refused for a missing or unexplained amount, and flagged for review (or escalated urgently over
    the maximum) where a dose about to be given would be refused, because refusing would leave a
    false record and a dose given out of the history (#162 second clinical review; H-1067). A
    correction whose new outcome records that a dose happened (given, taken by the person, given by
    family) follows exactly the rules for a dose recorded after it was given (rule 17): a reason
    of 20 characters or more, a time given strictly before the correction's `recordedAt`, the
    corrector's competence, the named giver checked at the time given (and flagged when not the
    corrector), and always the `given_before_recorded` flag, counted and escalated, urgently when a
    rule was broken; so recording "refused" and correcting it to "given" never gets round that
    route (#162 third review's re-check). Every correction is a reviewable event (its second
    re-check): it needs a reason of 20 characters or more, whatever it changes; it is flagged
    `corrected` with what it changes (`corrected`: outcome, amount, time, giver, or a detail such
    as a coded reason) and counted per member for the report; one that removes a dose recorded as
    taken or lowers the amount counted (an amount in another unit counts as none) is flagged
    `dose_removed`, and one that moves its time `dose_moved`, each escalated to the nurse in charge
    as a `warning`, or `urgent` when the entry has a 24-hour maximum, a minimum interval or the
    paracetamol tag, because the change frees room for another dose (a routine amount correction
    on a regular medicine is a warning, H-1067). The 24-hour maximum over every 24 hours, the
    intervals and the scheduled gap, both ways, are checked around the dose as the original
    recorded it and as the correction records it, against the other doses: a breach the
    correction creates is flagged `breach_created` and one it hides `breach_hidden`, each sent for
    review urgently, naming the limit. The stored record keeps its outcome, amount and giver
    (`RecordedAdministration`) so the change can be judged. Only the duplicate check against the
    record it corrects is left out, and that record is left out of the history
    (`checkCorrection`).
24. **Controlled drugs register page** (`controlled-drugs.ts`). One page per person and dm+d VMP
    (drug, form and strength); entries in time order; movements receipt, administration, disposal,
    transfer out, destruction and correction. A stock check compares the count with the page and
    raises an incident for any difference (slice 34; HZ-115 from then); the next is due
    `medicines.cd.stock_check_interval_days` UK days after the last.
25. **Running balance** (`cdBalanceAfter`). Every entry stores the balance after it, checked against
    the previous entry's; it never goes below none; liquids keep 3 decimal places.
26. **Margin corrections**. A mistake is never edited: a correction entry names the entry it puts
    right, says why, says whether it puts right the quantity (a signed change to the balance) or
    another detail such as the time (no change, so a correction of nothing cannot pass for a
    mistyped 0), and only a correction refers to another entry or says what it corrects.
27. **Witnesses** (HZ-116; `checkCdEntry`, `defaultCdWitnessPolicy`). Every entry has a second
    signature from a witness who is not the recorder; a blank witness is refused. Where the tenant's policy is `required` (by
    default residential, nursing, respite and children's homes) a witness is always needed; where it
    is `where_available` (by default home care, supported living, live-in, complex care and day
    services) a lone worker may record why there was none, and the entry is flagged for manager
    review. Destruction is always witnessed. The witness's own sign-in and the step-up are the API's
    (ADR-0084, slice 34).

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
  counting from the anchor and whether a change keeps the count; schedule problems),
  `mar-entry.test.ts` (draft problems; states; second check; change; stop; status words and the
  unchecked policy; a change keeps the product, brand changes allowed; exactly one version in
  force: a later version withdrawn only with a reason, a stop carried over (the v1, v2 with a stop,
  correction case), a change refused with nothing in force, and a property test over random
  sequences of changes, stops, restarts and corrections, regular and when required, with and
  without course ends, checking every boundary, that nothing is given after a recorded stop or a
  course end, and every day's doses against the schedule; a change keeping the course end, its
  own or a withdrawn version's; the count kept from the last dose due across changes, through
  every day and back, across a stop and restart, and a weekday move needing a reason; no change
  part-way through a day with doses, including regular to when required and back, and on the days
  the clocks change; a correction after a failed check at once, with that day's notice; the
  version replaced from tomorrow telling staff to check today's remaining doses; one entry per
  product and a restart from the next day; no dose due before a new entry was recorded, the
  earlier times shown as not due, and the same-day route with its reason and notice (the property
  test checks no dose is due before its entry was recorded); a future stop or replacement still
  checkable and correctable; a variable-dose entry pointing to the checked dosing
  record; tags offered only from the tenant's lists, by exact VMP (ADR-0082)),
  `reconciliation.test.ts` (the plan; every entry and line decided; lines that say what they mean,
  with the alendronic acid and warfarin to apixaban cases; a change into another product refused;
  a stop citing its line; a continue shown by a current prescription, or confirmed by a
  clinician; a June GP record not current; a change's, a stop's and a restart's MAR rules tried at
  completion, including a medicine stopped before the reconciliation, and the reason a stop or
  change gives to withdraw what was scheduled; a continue or a change refused while it keeps a
  version or stop scheduled before the reconciliation, until it is said to stand; a change
  starting before a scheduled version withdrawing it; a course the letter extends started as a new
  entry from its end; a start keeping that day's earlier doses due with a reason; the entries to
  reconcile from dates; one entry per product;
  sources; queries; the stale record; completion checks; outstanding reconciliations). Run under `TZ=UTC`, `TZ=Europe/London` and `TZ=America/New_York`.
- Domain (built, slice 3): `timing.test.ts` (windows from the table, narrower for time-critical,
  escalation sooner; outstanding never closes itself; before the window, early, on time and late;
  windows on the days the clocks change; tag notices; the drift-corrected clock),
  `intervals.test.ts` (the prescribed interval across versions; the paracetamol rule across tagged
  entries only; elapsed time across the clock changes; the drift-corrected clock; the 24-hour
  maximum over every 24 hours containing the dose; doses in another unit named, not counted; last
  given, total, remaining, next and every notice; outcome follow-up), `competence.test.ts` (the
  sign-off and the anniversary, on the days the clocks change; no override without a sign-off; the
  gate and the override's rules), `dosing-record.test.ts` (no dose without a checked record; the
  newest record covering the day decides, never an older one; record problems; the second check),
  `administration.test.ts` (person, dose and outcome; another person's medicine; not scheduled;
  already recorded; coded reasons; entries not givable; the amount; variable doses; an early dose
  asking why only when time-critical or too close to the last dose; the window and
  an earlier dose outstanding, on the days the clocks change too; intervals and the override; the
  24-hour maximum; doses already taken, or given before they were recorded, counted, flagged for
  review and escalated; the route for a dose given before it was recorded (the reason's length, a
  time given before the server's time of recording, the recorder's and the giver's competence,
  every use flagged, counted and escalated, urgently when a rule is broken); competence and the override; closing a round; the row lock and
  corrections checked as records made after the event, with the corrector's competence, and those
  to a dose outcome by the rules for a dose recorded after it was given; every correction flagged
  with what it changes, a dose removed, lowered or moved escalated, and breaches it creates or
  hides flagged; a dose closer to the doses either side than the schedule allows asked about, late
  or not; a dose dated in the future, or a record of any outcome dated back on the round beyond
  the record delay, refused; an ordinary record judged at the time given and the time recorded,
  refused onto the flagged route where they differ, and late when recorded late),
  `mar-entry.test.ts` (a when-required entry with a limit), `controlled-drugs.test.ts` (page key;
  balance; corrections, including one of a detail that changes no quantity; witness rules by policy and
  service; a blank witness; destruction; stock checks).
- Database (slice 16): RLS and HZ-011 isolation for each table; the write-once trigger on check,
  stop and replacement; `expected_version` on changes.
- API (slice 16): `hazard HZ-005 imported medicines are created as not yet checked`; a second check
  by the transcriber is refused; a reconciliation completes only with every decision and applies
  its plan in one transaction; the return check is completed by it; audit events.
- Open controls for slices 16 and 22 (HZ-003, HZ-010, HZ-121), logged by the #135 sixth review:
  - The API applies a reconciliation's plan, and records every change, stop and new entry, with
    the `at` the rules were tried with: the time of recording (`completedAt`, or the member's
    action), never the sync or server time; it keeps the server time beside it (HZ-010), so a plan
    applied after midnight is not tried against a different day.
  - The API passes every version of a medicine to the rules (`versions`, `entryVersions`,
    `earlierEntries`), never a subset, so a scheduled version or stop is always seen.
  - Slice 22 (#162 third re-check): the API supplies the administrator's competence at the time
    given and at `recordedAt` (`competenceAtRecording`), both from workforce's port, so an
    ordinary record is judged at both times.
  - Slice 22 (#162 second re-check): the stored administration keeps its outcome, amount and
    giver (`RecordedAdministration.outcome`, `amount`, `administeredBy`), which `checkCorrection`
    compares with the correction; the override report counts `corrected`, `dose_removed` and
    `dose_moved` with the route and overrides (`REPORTED_FLAGS`).
  - Slice 22 (#162 third clinical review): the API sets every administration's `recordedAt` from
    the server's clock (for a record made offline, the drift-corrected time of recording, kept
    beside the receipt time) and refuses a dose recorded after it was given whose time given is
    not before it; it reads the recorder's and the named giver's competence from workforce's port,
    never from the request; and the override report (slice 45) counts `given_before_recorded`
    beside `competence_override` per member (`countReportedFlags`).
  - The same-day route covers only the day an entry is recorded: an admission recorded at 00:30
    shows a 23:30 dose the evening before as not due, with no way to keep it due. That is a missed
    dose, not a double one; the nurse in charge decides with the prescriber (H-553).
- Web (slice 52): the dm+d picker, the second check, the reconciliation screen with each
  difference in words, Playwright with axe.
- The Phase 2 gate needs: a medication round completed offline with barcode and witness in the
  Maestro suite; expired competence blocking administration in tests (slice 3 onwards).

## 10. Open questions

- H-550 (CSO): whether an entry awaiting its second check may be given (default yes, with the
  notice; a tenant may hold such entries), how soon the check is due and who is told when it is
  not done, and whether a stop needs a second check too (default no: it takes effect with its
  source and reason); whether a future stop or replacement should itself be checked before it
  takes effect, and whether a stop still to come should carry over to a correction (default: yes);
  the dosing record for variable doses and its second check (rule 2, slice 3). **Release gate:**
  slice 2 is not released to a tenant without slice 3's dosing record; until then a variable-dose
  entry is never givable and its notice tells staff to ask the prescriber for the day's dose and
  record it as a new entry, stopping the variable one first (confirm that interim instruction, or
  that the gate holds). After a check finds a difference, the correction takes effect at once, for
  the rest of the day, with a notice that day to check the day's doses (default; #135 fourth
  review): confirm, and whether the corrected entry's earlier dose that day needs more than a
  notice.
- H-551 (pharmacist): the dose-writing rules in rule 2, the 3 decimal places, "0.5 tablets",
  "2 × 5 ml spoonfuls" and "12 micrograms/hour", and whether a quantity below 1 where dm+d gives a
  smaller unit (0.5 g, 500 mg) should be refused rather than transcribed as written; "ml" as dm+d
  writes it or "mL" as the BNF does.
- H-552 (CSO with a pharmacist): the reconciliation rules 7 to 12, the source kinds (no verbal
  instruction; family not enough alone; the previous MAR allowed), which sources show what is
  prescribed now (on a return, only the discharge letter when there is one), a source counting as
  current only when received after the event or marked current with a reason, recording what each
  line says (start, continue, change, stop, unclear) and refusing any decision a line does not say,
  starts only from a current prescriber's or pharmacy's line (no confirmation route, unlike a
  continue), who may confirm a continue that no such source shows, a stop only from a line that
  says so, one entry per dm+d VMP with no note to override it, a change keeping the VMP (a switch is a stop and a start), "withheld until review" (not a state: stop and start again), who may complete
  one, and the reading of NICE SC1 sections 1.7 and 1.14 as the master prompt cites them (the
  build environment could not reach the NICE pages).
- H-553 (CSO with a pharmacist): the schedule patterns, written-out times instead of "every n
  hours", per-time doses, the section 18 schedule type split, both doses kept when a clock change
  brings two times together, the day count kept from the last dose due across versions and
  restarts, a weekday or day-of-month move counting as a re-anchor (even daily to weekly), and the
  refusals that replace handling complicated sequences (rules 6, 6b, 6c): no change part-way
  through a day with a regular dose (it takes effect from 00:00 the next day, so a change wanted
  for the same evening, or regular to when required that day, waits a day: is that acceptable,
  and what should staff do meanwhile?); no restart the same day after a dose was due; no change or
  stop while a later version is scheduled unless it withdraws that version with a reason; a stop
  always carrying over (a course extended past its stop is a new entry); no change when nothing is
  in force; one entry per product, so a regular and a when-required entry of the same VMP (for
  example lorazepam at night and when required) cannot both be on the MAR: is a combined entry, or
  an exception, needed? From the #135 fourth review: a change keeps the course end (no change may
  drop or extend it, even when the new prescription gives a later end: the course continues as a
  new entry from its end); a same-day change, such as after a return from hospital at 14:00,
  still takes effect from 00:00 the next day, and the old version tells staff "A change starts
  tomorrow: check today's remaining doses with the nurse in charge" (the stricter option, rather
  than a same-day change with an answer about that day's doses): is a notice enough, or should
  today's remaining doses of the old version be held? From the follow-up and fifth review: no dose
  of a new entry is due before it was recorded, and the same-day route keeps that day's earlier
  doses due with a reason and a notice to check with the nurse in charge (default): is that the
  right control on the day of admission, and who may give the reason? A course the discharge
  letter extends is recorded as the existing entry continued to its end and a new entry started
  from then on the letter's line (default, rather than a change allowed to extend the end when a
  current line says so): is that acceptable when the letter has a single line for the medicine?
  For the CSO to confirm (#135 sixth review): who may give the same-day reason (default: the
  transcriber, whose entry a second person then checks); the single-line extension above; the
  refusal of a reconciliation begun before midnight and completed after a change took effect at
  00:00 (default: refused, naming the version, until those decisions are redone); and the dose
  before midnight on an admission recorded just after it (a 23:30 dose when the entry is recorded
  at 00:30), which the same-day route cannot keep due: is a missed dose there acceptable, or is a
  route needed for the evening before?
- H-554 (CSO): the dose windows (60 minutes either side, 30 for time-critical), the reason asked
  for an early or late dose, and when an outstanding dose escalates.
- H-555 (CSO with a pharmacist): the when-required rules: the rolling 24 hours containing the
  dose, no override over the maximum, an override reason inside the interval, the outcome check
  after 60 minutes, and a when-required entry transcribed with no maximum recorded (now refused,
  H-1066).
- H-1060 to H-1066 (CSO; #162 clinical review): whether a newer dosing record replaces older ones
  from its first date (default: the newest record covering the day decides); a member never signed
  off is never overridable (default built); how a dose taken over the maximum is recorded
  (default: always recorded with its amount, flagged and escalated urgently; staff never give
  over it); the paracetamol total across products is not enforced (default: each entry's own
  maximum and the tagged interval); an upper limit on a tenant's dose windows (default: none
  beyond the time-critical window never being wider); whether showing "remaining" stays inside
  the device boundary (default: shown, as arithmetic on the prescriber's figure); and a
  when-required entry needing a limit at transcription (default: refused without one).
- H-1067 and H-1068 (CSO; #162 second clinical review): that a correction, or a dose staff record
  after giving it, is flagged for review and escalated rather than refused by the rules that
  decide whether a dose may be given (default built), with the escalations' severities and the
  re-rating of HZ-004, HZ-005 and HZ-119; and whose competence a correction checks (default: the
  corrector's now, gating; the competence of whoever gave the dose then, flagged).
- H-556 (CSO with a pharmacist; with H-516): the controlled drugs defaults: the witness policy by
  service type, destruction always witnessed, corrections as signed balance changes beside the
  entry, the stock check every 7 days.
- H-557 (CSO): competence lapsing at 00:00 on the anniversary of the sign-off, the override of at
  most 12 hours approved by someone else, and the override applying to every outcome, not only
  "given".
- H-558 (CSO with a pharmacist): the administration record rules: a different amount allowed with
  what happened (flagged as a possible medication error), corrections by the author or a holder of
  `medicines.record.manage`, the dosing record per day and time for variable doses, and tagging
  combination products by hand (ADR-0082's residual risk).
- The decisions and defaults for later slices are in [phase-2.md](../plans/phase-2.md) (ADR-0080 to
  ADR-0085) and the human actions H-510 to H-517 in [human-actions.md](../plans/human-actions.md).

## 11. As built (slices 2 and 3, domain rules)

`packages/domain/src/medicines/`, exported from `@harbour/domain`; pure functions with no I/O. No
schema, API, web or mobile changes in this slice.

| Module | Main exports | For |
| --- | --- | --- |
| `dmd.ts` | `DmdProductRef`, `DmdRoute`, `isDmdId`, `isDmdProduct`, `dmdProductDifference` | Rule 1 |
| `dose.ts` | `Dose`, `DoseUnit`, `parseDoseQuantity`, `isDoseQuantity`, `formatDoseQuantity`, `doseUnitName`, `formatDose`, `checkDose` | Rule 2 |
| `schedule.ts` | `SchedulePattern`, `RegularSchedule`, `checkSchedule`, `expandSchedule`, `MarDose`, `marCycle`, `marCycleContaining`, `clockChangesIn`, `describeSchedule`, `keepsCountFrom`, `ukDateOf`, `WEEKDAY_NAMES` | Rules 3 to 5 and 6a |
| `mar-entry.ts` | `MarEntryDraft`, `MarEntry`, `checkMarEntryDraft`, `transcribeMarEntry`, `recordSecondCheck`, `changeMarEntry` and `stopMarEntry` (on every version), `versionInForceAt`, `lastDueDose`, `marEntryEnd`, `marEntryDosesFrom`, `marEntryDoses`, `marEntryTimesBeforeRecorded`, `marEntryStatus`, `MAR_ENTRY_NOTICES`, `MAR_SOURCE_KINDS` | Rules 6, 6a to 6c |
| `reconciliation.ts` | `completeReconciliation`, `entriesToReconcile`, `linkDifference`, `outstandingReconciliations`, `RECONCILIATION_TRIGGER_WORDS`, `LINE_SAYS_WORDS` | Rules 7 to 12 |
| `timing.ts` | `doseWindow`, `recordedTiming` (`RecordedTiming`), `earlyNeedsReason`, `closerThanScheduled`, `scheduledDoseState`, `SCHEDULED_DOSE_WORDS`, `escalationAt`, `doseNotices`, `isTimeCritical`, `driftCorrectedTime` | Rules 14 to 16 |
| `intervals.ts` | `GivenDose`, `entryVersionIds`, `intervalConflicts`, `prnStatus`, `PRN_NOTICES`, `prnMaximumExceeded`, `prnDosesNotCounted`, `prnOutcomeDueAt`, `prnOutcomesOutstanding` | Rules 16, 19, 20 |
| `competence.ts` | `medicinesCompetenceAt`, `checkCompetenceGate`, `CompetenceOverride` | Rules 21, 22 |
| `dosing-record.ts` | `checkDosingRecordDraft`, `recordDosingRecord`, `checkDosingRecord`, `variableDoseFor` (`VariableDose`) | Rule 18 |
| `administration.ts` | `ADMINISTRATION_OUTCOMES`, `OUTCOME_WORDS`, `OUTCOME_REASONS`, `REASON_WORDS`, `DOSE_TAKEN_OUTCOMES`, `DOSE_ALREADY_TAKEN_OUTCOMES`, `REVIEW_FLAG_WORDS`, `GIVEN_BEFORE_RECORDED_REASON_MIN_LENGTH`, `REPORTED_FLAGS`, `countReportedFlags`, `checkAdministration` (with `AdministrationEscalation`, `ReviewFlag`), `checkRoundClose`, `marRowLocked`, `checkAmendment`, `checkCorrection` | Rules 17, 23 |
| `controlled-drugs.ts` | `cdPageKey`, `cdBalanceAfter`, `checkCdEntry`, `defaultCdWitnessPolicy`, `cdPageBalance`, `cdStockCheck`, `cdStockCheckDueAt` | Rules 24 to 27 |
| `rates.ts` | `MEDICINES_RATE_KEYS`, `resolveMedicinesRates` | Every medicines figure (cycle, windows, intervals, PRN outcome, CD stock check, competence and override) |
| `dmd-release.ts` (slice 10) | `checkDmdRelease`, `dmdReleaseOrder`, `dmdReleaseFreshness`, `dmdReleaseDateFromName`, `isGtin`, `toGtin14`, `dmdSearchQuery`, `dmdDoseUnitCodes`, `dmdProductFacts`, the release content types | Rules 1 and 2 against the reference data; [integrations.md](integrations.md) section 12 rules 2 to 8 |
| `dmd-subset.ts` (slice 10) | `selectDmdDeviceSubset` | The device's dm+d subset ([integrations.md](integrations.md) section 12 rule 9; slice 68) |

## 12. As built (slice 16, schema and API)

Migration 0111 (`packages/db/src/schema/medicines.ts`), contracts
`packages/contracts/src/medicines.ts`, routes `apps/api/src/routes/medicines.ts`, mapping
`apps/api/src/services/medicines.ts`, ports `apps/api/src/integrations/medicines-ports.ts`.

- **Tables** as section 2, with these choices:
  - `medication.medicine_id` groups the versions of one entry (the first version's id; a restart is
    a new entry). The rules still receive every version of the person's product
    (`earlierEntries`) and every version of the entry (`versions`, `entryVersions`).
  - The when-required dose is JSON (`prn_dose`); regular times are `medication_schedule` rows,
    written in the same transaction as their entry (a trigger refuses later additions).
  - Decisions are JSON (`EntryDecision` or `ItemDecision`), validated by the API, with the entry or
    line and the kind as columns. A new set marks the earlier rows deleted while the
    reconciliation is open.
- **Database rules**:
  - Forced RLS by tenant and `person_child_scope` on all six tables; no DELETE for `harbour_app`.
  - On `medication`, a trigger keeps what a version says fixed and sets the check, stop,
    replacement and withdrawal once each; a stop may be replaced only by an earlier one (rule
    6b). The state needs the column that defines it.
  - A new version must replace an earlier version of the same medicine and the same VMP, take
    the next number after the latest, and be not yet checked. The unique (medicine, version) key
    refuses a second change from the same version, so `expectedVersion` holds under concurrency.
  - A replacement moves to a later version only when the version it named has been withdrawn,
    to a live version of the same medicine that replaces this row, and never to a later time (v1 replaced by v2; v2 withdrawn as transcribed in error; v3 then
    replaces v1). The API writes a withdrawal before the version that follows it.
  - Every child row is tied to one person by composite keys: a version's source and stop
    documents (`document (tenant, person, id)`), its reconciliation, a line's source, a decision's
    line and the entry a decision made. A document, line or entry from another person's record is
    refused by the database.
  - A completed reconciliation, its sources, lines and decisions never change. Only a non-app
    role (retention) may mark a completed one deleted, once, never undone; the app may never change
    `deleted_at`.
  - `capture_version` keeps each earlier state of a row in `record_version`.
- **Concurrency**: every write for a person (including a reconciliation's sources and lines, so
  nothing arrives while one completes) takes a transaction-scoped advisory lock on that
  person (`medicines:<person id>`) before reading the record, so two requests for the same
  person are tried one after the other against the latest record. Reads (history, the MAR) take
  no lock. A unique-key clash is a 409;
  a check or key refusal by the database is a 422 `medicine_refused_by_record`.
- **Names**: the product, route and unit names stored and shown are dm+d's own, looked up by
  code from `DmdFactsPort`, never the request's. A line's product name also comes from dm+d.
- **Documents**: a source or stop document must be this person's, available and not deleted,
  when it is named and again, for every source, when the reconciliation completes.
- **dm+d** (slice 10 merged in batch 3a): `vmp_id` and `amp_id` are validated identifiers
  (`isDmdId` in the API, the SNOMED CT shape in the database) with no foreign key yet: the
  fixtures below are not in the dm+d fixture release, so the keys wait until they are one set
  (`packages/db/test/medicines-record.test.ts` says so and must change with them). The dm+d facts
  (routes and units) come from `DmdFactsPort`: slice 10's reference tables whenever a release is
  loaded (`dmdTablesPort`; VMPs only, never an invalid or superseded product), otherwise the
  configured port. Production with no release loaded uses `unavailableDmd`, which knows no
  product, so nothing is transcribed. The
  fixture of four invented products (no AMPs: an AMP is unknown) and `fixedCompetence` are used
  only when `MEDICINES_FIXTURES` is on; it defaults on outside production, and production
  refuses to start with it on. A pilot or staging stack holding real people's records sets it
  to `off` (H-1022). A product dm+d does not hold is refused as "dm+d does not hold
  this product" or "The dm+d reference data is not loaded yet", also at completion.
- **Competence** (slice 17 not yet built): `MedicinesCompetencePort`, read on the server for the
  signed-in member at the time of the action. Production uses `unavailableCompetence`, which
  answers `not_held`, so no second check or completion is accepted until the workforce port
  exists. Tests use `fixedCompetence`.
- **Permissions**: reading needs `medicines.record.manage`, `medicines.emar.administer` or
  `care.plan.read`; no separate `medicines.record.read` is added (section 3's question,
  ADR-0071's per-permission scope applies). Writing needs `medicines.record.manage`.
- **Times**: the rules are tried at the time of recording on the server (the member's action);
  a reconciliation's plan is applied with its `completedAt` (HZ-010).
- **Unchecked policy**: `give_with_notice`, the default in force (H-550), until a tenant setting
  exists.
- **Reconciliation events**: an admission is the placement, from 00:00 UK time on its start date;
  a return is the hospital transfer's `returned_at`. A transfer between homes has no event record
  yet, so it is started as a `transfer` with no event. Completing a return's reconciliation marks
  its `medicines_reconciled` check and task done, with the transfer row locked; that check cannot
  be ticked by hand on the transfer, and its task is evidence-only on the tasks route. A return recorded without a transfer record raises its tasks
  against the person and has no event to answer, so it is reconciled as a `change` until H-1023
  is decided.
- **MAR**: each dose carries its entry's status now (`entryStatus`: words, whether it may be
  given, any notice), so a chart cell never shows a dose without its notice. The status is the
  entry's now, not at each dose's time (H-1025).
- **Audit and outbox**: `medicines.entry.viewed`, `.transcribed`, `.changed`, `.checked`,
  `.check_found_difference`, `.stopped`, and `medicines.reconciliation.started`, `.viewed`,
  `.source_added`, `.item_added`, `.decided`, `.completed`. A refused check or completion is
  audited as `denied` (with the problem codes) outside the refused transaction, so it is kept. All carry ids and counts, never content. Outbox: `medicines.entry.changed`,
  `medicines.entry.stopped` and `medicines.reconciliation.completed`, with ids only.
- **Tests**: `packages/db/test/medicines-record.test.ts` (20) and `apps/api/test/medicines.test.ts`
  (28), with the `MEDICINES_FIXTURES` cases in `apps/api/test/config.test.ts`.

## 13. Web screens (slice 52, MEDS-001 and MEDS-006)

The person record's **Medicines** tab, for holders of `medicines.record.manage`,
`medicines.emar.administer` or `care.plan.read` (the API's read rule); writing needs
`medicines.record.manage`. Every page sits inside the record frame, so the point-of-care header
(name, photo, date of birth, NHS number and allergies) is above every medicine, and each form that
records a medicine repeats, at its top, the person's name, date of birth and NHS number, the allergy
status and every allergy with its severity and reaction, most severe first (`PersonCheck`; the full
identity bar there is H-1287). Thapsus Care never matches a medicine to an
allergy or to a person: the screens show both, and people compare them.

**Rules**

1. **The list** (`/people/{id}/medicines`): the entries in force or scheduled, one per medicine,
   each with its product (dm+d's name), route, the dose and schedule in the domain's words
   (`directionsInWords`, never rewritten), the start and any stop or review date, and its state as
   an icon and a word. An entry not yet checked always says **Not yet checked**, with the API's
   notice. Outstanding reconciliations (an admission, a transfer, a return from hospital) are shown
   above the list with a way to start one; an open reconciliation is linked.
2. **One entry** (`/people/{id}/medicines/{entryId}`): what the version says, who transcribed it and
   from which source, the second check, any stop, and the version history, newest first. A
   withdrawn version is shown struck through (`<del>`) with the word **Withdrawn** and its reason;
   a replaced version says **Replaced**.
3. **Transcription** (`/people/{id}/medicines/new`): the product is chosen from dm+d by searching
   (`GET /v1/medicines/products?q=`; until slice 10's reference data, the API's dm+d port answers,
   which is the invented fixture outside production and nothing in production, so nothing can be
   transcribed there yet); the route and dose unit are chosen only from what dm+d permits for that
   product. Directions are regular (a pattern: every day, every n days, weekly on chosen days, or
   monthly on a day; and one to eight times, each with its dose) or when required (one dose). A
   dose is an amount, a range or "variable", with its unit; it is sent and shown exactly as
   entered. The prescriber, the start, and the source document (its kind and reference) are
   required; the stop, review date, indication and special instructions are optional. One dose time
   is shown, with "Add another dose time" up to eight. A dose with no time is refused, never
   dropped. A dose is the number typed (a leading zero is refused; "1.50" is sent as 1.5). Changing
   the product starts the route, unit and doses again. After saving, the entry opens and says so.
   The API's
   refusals (for example a restart needing a reason) are shown at their fields with their words,
   and a reason field appears only when the API asks for it.
4. **Second check**: offered to a holder of `medicines.record.manage` other than the transcriber,
   while the entry is not yet checked. The checker ticks that they compared the entry with the
   source document itself, and says whether it matches; a difference needs words. The API reads
   competence from the workforce port; a refusal is shown in its words.
5. **Stopping**: when it takes effect, the reason and the source of the instruction (kind and
   reference), with the version as read. Never inferred: only a person stops a medicine.
6. **Reconciliation** (`/people/{id}/medicines/reconciliations/{recId}`): started from the list (for
   an outstanding event, or as a change). Then, in order on one page: the sources (kind, reference,
   when received, and why it is current where the API asks); the lines from each source, as written
   (with a dm+d product where known, and what the line says: start, continue, change, stop or
   unclear); a decision by a person for every current entry (continue, change, stop with a reason,
   or a query) and every line not matched to one (start, not started with a reason, or a query);
   and completion (allergies compared, the person's involvement or why not, and why there is no
   discharge letter where the API asks). Thapsus Care never decides: a line that says "stop" does not
   stop anything until a person decides it. A refused completion shows every problem in the API's
   words (listing them by entry and line needs an API change: H-1283). Continuing or changing a
   medicine with a version that starts later asks why that version still stands. Each entry shows
   its state and route beside its decision. A decision is saved at the reconciliation's version on
   the person's screen; if anyone decided anything since, it is refused (the API records the last
   saver as the decider of the set: H-1286). A change reconciliation takes the server's time.
7. **Self-administration** (MEDS-006's self-administration records) is not in slice 16's API, so
   there is no screen yet (H-1281).
8. **Status as an icon and a word**: Not yet checked, Checked, Difference found, Stopped, Replaced,
   Withdrawn; a reconciliation Open or Completed.

**API added in this slice**: `GET /v1/medicines/products?q=` (`medicines.record.manage`; two or more
characters; dm+d's name, permitted routes and dose units; `loaded` says whether dm+d is loaded),
through a `search` on `DmdFactsPort`. With `MEDICINES_FIXTURES` on, the competence fixture holds
the demo owner, manager and nurse as current, so the local journeys can check and complete.

**Tests**: `apps/web/src/lib/medicines.test.ts` (state chips, the transcription, check, stop and
reconciliation forms read into the contract, doses kept exactly as entered);
`apps/api/test/medicines.test.ts` (the product search); `apps/web/e2e/medicines.spec.ts`
(transcribe, second check by another person, stop, and a reconciliation from sources to
completion; axe in light and dark).
  (27), with the `MEDICINES_FIXTURES` cases in `apps/api/test/config.test.ts`.

## 13. Administrations (slice 22, schema and API)

Migration 0123, schema `packages/db/src/schema/medicines.ts`, contracts
`packages/contracts/src/medicines.ts`, routes `apps/api/src/routes/medicine-administrations.ts`.
Slice 3's rules decide every write (`checkAdministration`, `checkCorrection`); the API reads the
facts they need and stores the outcome. MEDS-002, with HZ-001 to HZ-005, HZ-116 and HZ-119.

### 13.1 The entry fields slice 3 added

Slice 3 added three fields to a MAR entry: its tags (rule 13), the minimum interval, and a
when-required entry's 24-hour maximum. Migration 0123 adds them to `medication` (`tags`,
`minimum_interval_minutes`, `prn_max_per_24h`). They are part of what a version says, so the
write-once trigger keeps them fixed. Entries recorded before 0123 have no tags and no interval or
maximum; a when-required entry with neither keeps the PRN status notice "no maximum recorded" until
it is changed (H-1160).

### 13.2 Tables

| Table | Kind | Key columns | Retention class |
| --- | --- | --- | --- |
| `medication_administration` | Append-only: no UPDATE or DELETE for the application; a correction is a new row with `supersedes_id` | `id` (the client's UUID, so a resend is idempotent), person, the entry version (`medication_id`), `due_at` (null for a when-required dose), `outcome`, coded `reason_code` and `reason_note`, amount (quantity and unit code), the prescribed dose it was checked against, the dosing record used, the reasons the rules asked for (amount difference, timing, interval override, given before recorded), `given_at` (drift-corrected), the device time and offset, `administered_by` (who gave it: the recorder unless recorded after giving by someone else), `recorded_by`, `recorded_at` (the server's clock), the competence override used, the flags, `supersedes_id` and the correction reason, the scan evidence (ADR-0081, a hook until barcodes land) and the controlled drugs entry (a hook for slice 34) | `mar_chart` |
| `medication_administration_witness` | Append-only, at most one per record | the administration, the witness, when, how they signed (`step_up` on the web; `device_factor` from slice 70) | `mar_chart` |
| `medication_dosing_record` | The record never changes; its second check is set once | person, the entry version, source (kind, reference, document), the doses (date, time, quantity in the entry's unit), recorded by and at, second check (by, at, outcome, difference) | `mar_chart` |

Database rules:
- Forced RLS by tenant and `person_child_scope` on all three tables. Composite keys tie each row to
  one person: the entry version, the dosing record, the record a correction supersedes, the
  witnessed record and every document.
- One original record per scheduled dose: a unique key on (entry version, `due_at`) where
  `supersedes_id` is null. One correction per record: a unique key on `supersedes_id`.
- A correction stays with its record's person, entry version and due time (the database checks
  them; the API also checks a when-required dose's MAR day by `checkCorrection`).
- A witness is never the recorder or the giver.
- Weekdays are stored as the domain's codes (`mon` to `sun`), never full names.
- One original per dose is keyed on the entry version and due time; across versions of one
  medicine the API checks it under the person's lock.
- `recorded_at` is the server's clock (`now()`), never the request's.

### 13.3 Recording a dose

`POST /v1/people/{id}/medicine-administrations`, with `medicines.emar.administer`. The body carries
the client's id, the entry, the due time or none, the outcome, the reason, the amount, the reasons
the rules ask for, and, for a record made after the event, `givenBeforeRecorded` with `givenAt` and
why.
- **Idempotent**: a resend of the same id with the same content returns the stored record (200);
  the same id with other content is a 409.
- **Serialised**: the per-person lock of section 12, so two doses for one person are tried one
  after the other against the stored history.
- **The facts**: every version of the person's entries, the doses already recorded, the dosing
  records, the competence of the signed-in member from the competence port (and any override in
  force, from the same port), and the rates from the rate table for the person's nation.
- **The time**: a dose is recorded at the server's time; a request may send its own time only for
  a dose recorded after it was given (security review M1). How a device's offline records are
  uploaded, and checked at their drift-corrected time, is decided with slices 68 and 69 (H-1164).
- **Given before recorded** (#162, slice 3's rules): `givenAt` (drift-corrected when the device
  sends its offset) strictly before the server's `recordedAt`, a reason of at least
  `GIVEN_BEFORE_RECORDED_REASON_MIN_LENGTH` characters, the recorder's current competence now (or
  an override of an expired one), and the giver (`givenBy`, the recorder by default) checked at the
  time given. The rules always flag it `given_before_recorded` (and `given_by_someone_else` when
  another member gave it) and escalate it, urgently when it broke a rule.
- **Controlled drugs** (from slice 34, section 14.4): a dose of an entry whose dm+d controlled drug
  schedule is set, given, writes its register entry with the record, with a fresh step-up and the
  witness's signature; other outcomes move no stock.
- **Refused** records are audited as `denied` with the problem codes, outside the refused
  transaction.

### 13.4 Corrections and the row lock

A record is locked once stored on the server (`marRowLocked`): there is no edit route. A
correction is `POST /v1/medicine-administrations/{id}/corrections` with a reason and what the
record should say (`correctionReason`, the outcome and its time, never later than now, and
`givenBy` when the giver differs from the record's), by its author or a holder of
`medicines.record.manage`, checked by `checkCorrection` (the latest record for the dose only; the
person and dose never move). The facts it reads are what stands now less the record corrected, so
a correction of a correction never counts the record the first correction replaced. Reads show
the corrected record struck through beside its correction.

### 13.5 Witness and second signature

The witness is a second signed-in member (ADR-0084, as phase-2.md records it; the ADR is written
with slice 34). On the web the witness signs with their own session and a fresh step-up:
`POST /v1/medicine-administrations/{id}/witness`, under the person's lock. The witness needs
`medicines.emar.administer` and current competence, is never the recorder or the giver, and
signs only the latest record for the dose (never one a correction replaced). A missing step-up is
refused and audited. There is no time limit on signing yet (H-1166). A device witness
(`device_factor`) is slice 70.
Controlled drugs: when the entry's product is a controlled drug, slice 34 writes the register
entry and links it (`cd_entry_id`); until then the hook is empty and slice 22 records nothing in
a register.

### 13.6 Escalation through the task engine

- **Each escalation** the rules return raises a task for the nurse in charge (`clinical_lead`),
  urgent or routine as the rules say, named for its reason in fixed words that name no medicine:
  over the 24-hour maximum, given with no checked dose to compare it with, or a record to review
  (every dose recorded after it was given is one). The escalation's own words are returned to the
  recorder; the record is the task's source. Slice 48 adds the notification chain.
- **An outstanding dose**: the worker job `medicines-outstanding-doses` (every 5 minutes, looking
  back 3 days, under each person's lock) raises one task per scheduled dose whose escalation time
  (`escalationAt`, the end of its window) has passed with no outcome, for people at the home
  (status `active`; in hospital or on leave, the doses are recorded as away instead, H-1165),
  time-critical doses urgent, never twice. The task is closed when an outcome is recorded; nothing
  makes a missed dose due again.

### 13.7 Reads

- `GET /v1/people/{id}/medicine-administrations?from=&to=`: the records with corrections
  linked, at most 31 days at a time.
- `GET /v1/people/{id}/medicine-round?at=`: the doses due around a time with their state
  (`scheduledDoseState`), notices, and each when-required entry's status (`prnStatus`).

### 13.8 Medicines on the phone (slice 68; ADR-0130)

Built in slice 68 (migration 0147; the routing column of migration 0146, ADR-0134), for members holding `medicines.emar.administer` where `people.person.read` and `care.plan.read` reach too (so a MAR never syncs without the person's identity and allergies), in the two
person scopes of the care streams (replication bypasses RLS, so the stream queries carry the scope;
`medicines-streams.test.ts` proves it):
- **`*_medicines`** (priority 1, with the allergy streams, HZ-002): MAR entry versions not
  withdrawn or removed, a stopped or replaced one included (the phone judges `stop_at`,
  `stop_effective_at` and `replaced_from`, so a change from tomorrow never takes today's doses off
  the round), with the person's schedule times, dosing records and covert records (not removed)
  whatever version they belong to, in buckets per person (ADR-0130; H-1425); the phone shows only
  those of a version it holds.
  The round on the phone (slice 69) works out each version's doses with the domain's
  `marEntryEnd` and `marEntryDosesFrom` on these rows, so a replaced version and its replacement
  never both show the same dose (HZ-003).
- **`*_medicine_administrations`**: administrations recorded in a ten-day block of
  `meds_recent_days` (today, the 34 UTC days before and tomorrow, minted by the API; `meds_recent_blocks`):
  at the token's homes, one bucket per home and block by the row's own `sync_location_id` (the
  person's home while they receive care, set and moved by the database; ADR-0134); for assigned
  people, one bucket per person and block. For the last given of a monthly or
  weekly medicine, intervals and the 24-hour maximum (H-1421); never one bucket per person and day,
  which went past PowerSync's buckets per connection (ADR-0130, ADR-0134; H-1426).
- **`my_medicines_competence`**: the member's own medicines competence sign-offs and their
  withdrawals.
- **dm+d**: `GET /v1/medicines/device-subset` (integrations.md section 12 rule 9), for the products
  on the MARs of the people the streams give the member, fetched on connecting, when those products
  change and at most hourly otherwise, and replaced whole on the phone; a failed request keeps the
  last copy and records when it failed (`meta:dmd-subset-failed-at`).
- Token claims `meds_location_ids`, `meds_assigned`, `meds_recent_days` (the 35 days the phone counts) and `meds_recent_blocks` (their ten-day blocks, which the streams filter on); none reach a device
  without them (fails closed). No document, reconciliation, error, review, stock or controlled drug
  register row syncs.
- **Uploads**: decided with slice 69 (H-1164): a record made offline is recorded after the event,
  so it is checked at its drift-corrected time, idempotent by id, and a refusal comes back to the
  device as a conflict for the nurse in charge (slice 70).

### 13.9 Audit and outbox

Audit actions, carrying ids, outcomes, flags and problem codes, never the medicine or the dose:
- `medicines.administration.recorded`, `.corrected`, `.witnessed`, `.viewed`;
- `medicines.dosing_record.recorded`, `.checked`.

Outbox events, with ids only: `medicines.administration.recorded` and
`medicines.administration.corrected`.

### 13.10 Dosing records

A variable dose is given only from a checked dosing record (rule 18).
- **Recording**: `POST /v1/medicines/{entryId}/dosing-records`, with `medicines.record.manage`,
  checked by `recordDosingRecord`.
- **Checking**: `POST /v1/dosing-records/{id}/check`, by a second person with current competence,
  checked by `checkDosingRecord`.
- **Reading**: `GET /v1/medicines/{entryId}/dosing-records`.
- **Database**: the record's content never changes, and the check is set once.

## 14. Controlled drugs register (slice 34, schema and API)

Migration 0128, schema `packages/db/src/schema/medicines.ts`, routes
`apps/api/src/routes/controlled-drugs.ts`. Slice 3's rules decide every entry (`checkCdEntry`,
`cdBalanceAfter`, `cdStockCheck`, `defaultCdWitnessPolicy`; rules 24 to 27). MEDS-005, ADR-0083
and ADR-0084 as phase-2.md records them, with HZ-009, HZ-115, HZ-116 and HZ-119.

### 14.1 Tables

| Table | Kind | Key columns | Retention class |
| --- | --- | --- | --- |
| `controlled_drug_page` | Never changes | person, dm+d `vmp_id` (drug, form and strength) with dm+d's name and the unit, opened by and at; one page per person and VMP | `controlled_drugs_register` |
| `controlled_drug_entry` | Append-only | page, `seq` (its place on the page), movement (`receipt`, `administration`, `disposal`, `transfer_out`, `destruction`, `correction`), quantity (signed for a quantity correction, 0 for a detail correction), `balance_after`, the entry a correction puts right and what it corrects, the reason, who it came from or went to and the reference (for example the pharmacy's delivery note), when it happened, recorded by and at (the server's clock), the witness and the assertion they signed, or why no witness was available, flags, and the administration it records | `controlled_drugs_register` (and `mar_chart` for administrations) |
| `controlled_drug_witness_assertion` | Created by the witness, used once | page, the movement and quantity witnessed, the administration when there is one, the witness, the recorder they watched, when, when it expires (`medicines.cd.witness_assertion_minutes`), and the entry or stock check that used it | `controlled_drugs_register` |
| `controlled_drug_stock_check` | Append-only | page, the count, the balance expected, the difference, who counted, the witness and their assertion, or why no witness was available (flagged for manager review), when, and the reason when it did not balance | `controlled_drugs_register` |

Database rules:
- Forced RLS by tenant and person scope on all four tables. Composite keys tie every row to one
  person and page.
- **Running balance**: on every entry, `seq` is the next on its page and `balance_after` is the
  previous balance plus a receipt or correction and less every other movement. It is never below
  zero, and an entry is never earlier than the one before it. The database checks this, as well as
  the rules.
- **Corrections**: a correction names an entry on the same page and says whether it corrects the
  quantity or a detail. No other movement names an entry.
- **Witness**: a witness is never the recorder, nor, for a dose, the member who gave it.
  Destruction is always witnessed. An assertion is used once, before it expires, by an entry made
  by the recorder the witness named, whose page, movement, quantity and administration match it.
- **Never edited**: entries, pages and stock checks have no UPDATE or DELETE for the application.
  An assertion changes only by being used, once.
- `recorded_at` and `checked_at` are the server's clock.

### 14.2 The second signature (ADR-0084 on the web)

1. The witness, signed in with their own session and a fresh step-up, records what they
   witnessed: `POST /v1/controlled-drugs/pages/{pageId}/witness-assertions` with the movement and
   quantity, the administration for a dose, and the member they watched record it. Only that
   member's entry may use the signature. This needs `medicines.cd.witness` and current
   medicines competence. It returns an assertion that expires after
   `medicines.cd.witness_assertion_minutes`.
2. The recorder, also with a fresh step-up, records the entry naming that assertion. The witness
   is never the recorder, and the assertion must match what is recorded.
3. Where the tenant's policy is `where_available` (by default home care, supported living,
   live-in, complex care and day services), a lone worker may instead say why no witness was
   available. The entry is then flagged for manager review. Destruction is always witnessed.

The policy is the strictest of the location's services (`defaultCdWitnessPolicy`). A device
witness, who signs on the same device with their own factor, is slice 70.

### 14.3 Routes

- `GET /v1/people/{id}/controlled-drugs`: the person's pages, each with its balance, its last stock
  check and when the next is due. A page never checked is due from when it was opened. No task
  raises an overdue check yet (H-1206).
- `POST /v1/people/{id}/controlled-drugs/pages`: opens the page for a MAR entry whose dm+d product
  is a controlled drug. The page takes that product and its dose unit.
- `GET /v1/controlled-drugs/pages/{pageId}`: the page's entries in order. Each correction is shown
  beside the entry it puts right. The page also shows its stock checks.
- `POST /v1/controlled-drugs/pages/{pageId}/entries`: a receipt, disposal, transfer out,
  destruction or correction, checked by `checkCdEntry` under the person's lock. The recorder needs
  `medicines.cd.administer` and a fresh step-up.
- `POST /v1/controlled-drugs/pages/{pageId}/stock-checks`, with `medicines.cd.administer` or
  `medicines.stock.manage`: a count, witnessed under the same rules.
  `cdStockCheck` compares it with the page. A count that does not balance needs a reason and
  publishes `medicines.cd.stock_discrepancy`, which the safety module turns into a medication
  incident. The incident's id is the stock check's, so the event is never applied twice. The count
  never changes the balance: a correction entry does that.

### 14.4 Administrations of a controlled drug (slice 22's hook)

Slice 22's refusal is removed. Recording a dose from a MAR entry whose product is a controlled drug
(`cd_schedule` set) works as follows:
- **Given**: writes, in the same transaction, an `administration` entry on the person's page for
  that product (opened if needed) for the amount given, in the page's unit. It needs
  `medicines.cd.administer`, a fresh step-up and a witness assertion for that administration, or,
  where the policy allows, why no witness was available. The member who gave it records it, and
  the witness is neither of them.
- **A dose recorded after it was given**, older than the page's last entry, is entered when it is
  recorded, with a reference to the administration that holds the time given. This keeps the
  register in time order and never leaves the dose off the MAR (H-1204).
- **Taken by the person themselves or given by family**: refused for a controlled drug until the
  CSO decides whether such doses move the home's stock (H-1202). The administration's `cd_entry_id` names the entry, and the entry names
  the administration.
- **Any other outcome** (refused, not given, not available, withheld): moves no stock and writes
  no entry.
- **A correction** that changes how much was given: writes a quantity correction on the page,
  witnessed under the same rules, naming the chain's register entry. A correction of only the time
  writes a detail correction. A correction to "given" from another outcome writes an
  administration entry at the time given. A correction that moves no stock carries the chain's
  entry forward, so a later correction corrects it. A correction from "given" to another outcome
  puts the dose back in stock (H-1203 asks whether it should be a disposal instead).
- The page's unit is the MAR entry's dose unit when the page opens (H-1205). Patch site rotation
  is not in this slice (H-1209).

The printable per-page export is slice 50.

### 14.5 Audit and outbox

Audit actions carry ids, movements and problem codes, never the drug or the count:
- `medicines.cd.page_opened`, `.entry_recorded`, `.witness_asserted`, `.stock_checked`, `.viewed`;
- refusals are audited as `denied`.

Outbox events, with ids only: `medicines.cd.entry_recorded` and `medicines.cd.stock_discrepancy`.

## 15. Rounds, escalation and conflict review (slice 48, API)

Migration 0134, routes `apps/api/src/routes/medicine-rounds.ts`. MEDS-002, with HZ-001, HZ-003,
HZ-004, HZ-006, HZ-008 and HZ-010. The screens are slice 53.

### 15.1 The round for a location

`GET /v1/locations/{id}/medicine-round?from=&to=` needs `medicines.emar.administer` and covers at
most 12 hours. For each person living at the location whom the caller may see (status `active`;
RLS and person scope), it gives:
- the scheduled doses in the slot, each with its window, its state in words (`Not due yet`, `Due
  now`, `Late: no outcome recorded`, `Outcome recorded`) and the notices its tags switch on.
  Doses are ordered by state (late, due now, not due yet, recorded), time-critical first within
  each state, then by due time. Any dose since the same UK clock time the day before the slot
  that is still late or due is included (a UK day back, not 24 hours, so a clock change moves
  nothing out of reach), so an earlier dose never drops off the round. Each dose carries its
  weekday for a pattern that is not every day and any clock change that skips or repeats its
  time (rule 5, H-553). A dose with an open conflict says "Recorded twice on different devices:
  waiting for review" (`reviewPending`). The person view inherits this.
- each when-required medicine that may be given now, with when it was last given, by whom, the
  24-hour total, what remains and when the interval allows the next (`prnStatus`).

People are ordered by room and then name, so the round follows the building. When one person's
round cannot be worked out (no medicines rates for their nation, a schedule that cannot be read),
everyone else's round is still given; that person's entry has no doses and says in words
(`unavailable`) to check their MAR chart before giving anything and tell the person in charge. The
log carries their id only. Each person's rates
(windows, tolerance) come from their own nation's rate table. The person view
(`GET /v1/people/{id}/medicine-round`) and the location view use the same function.

### 15.2 Escalation of outstanding doses

The worker job `medicines-outstanding-doses` (section 13.6) raises one task per dose whose window
has ended with no outcome. Time-critical doses are urgent. The task is closed when an outcome is
recorded. Each person is worked out on their own: when one person's doses cannot be worked out
(no rates for their nation, an unreadable schedule), the job still raises everyone else's tasks,
logs that person by id only and raises one urgent task (`medicines.dose.check_failed`, one open
per person) saying their missed doses could not be checked. These tasks are ordinary task-engine tasks, so the task engine's escalation (unanswered
tasks escalate up the location's chain) and the handover pick them up with no medicines-specific
path.

### 15.3 Handover of outstanding doses

The shift handover reads every open task at the location due by the end of the shift (care.md
rule 8). An outstanding dose's task therefore appears on the handover as an overdue or unfinished
task, in its own words, and stays there until an outcome is recorded. Nothing makes the dose due
again.

### 15.4 Conflict review (two devices, one dose)

A record uploaded from a bound device (a bearer request whose `x-harbour-device` header names a
device the session was already bound to before the request, and not revoked; the header alone is
not enough) for a scheduled dose that already has a record on the server is never dropped. On the
web, with no device, the second record is refused in words, because the person is there to see it.
- It is stored as a conflict (`medication_administration_conflict`): the uploaded record as sent,
  what the server found wrong with it (`problems`, codes), the record that stands, the device's time
  and who sent it.
- One open conflict per dose and uploader (a partial unique index enforces it). A further upload of
  the same dose by the same person is kept as its own row joining the first (`joins_id`), with its
  own client id and payload, so a resend finds it; it raises no further task, is audited
  (`conflict_joined`) and is resolved with the first.
- A review task for the nurse in charge is raised. It is urgent, and due at once, when the dose is
  time-critical or when the two records disagree (one says taken, the other not), because until it
  is reviewed the MAR shows only the first; a later upload that disagrees makes it urgent.
  Otherwise it is routine and due within 8 hours, because escalation runs from the due time
  whatever the priority (H-1271). The task names no medicine.
- The upload gets `202 Accepted` with the conflict's id, so the device stops resending it.
  Resending the same client id returns the same conflict; the same id sent for another person,
  dose or outcome is refused (`409`).

Device refusals other than a duplicate (for example a dose over the maximum recorded offline) are
still refused with their problem; whether to keep them for review too is human action H-1272.

A round record may carry `givenAt` up to `medicines.record_delay_tolerance_minutes` before it is
recorded (section 13; #162); a time in the future beyond the clock drift allowance is refused.

`GET /v1/medicine-administration-conflicts?locationId=` (or `?personId=`; one is required) lists
first conflicts, open ones first (at most 200, with `truncated` when more match), each with the
uploads that joined it; the reviewer sees every field
the device sent. `GET
/v1/medicine-administration-conflicts/{id}` shows both records side by side. `POST .../resolve`,
with `medicines.record.manage`, records the decision and why. Its outcome is either:
- `first_stands`: the record on the server stands and the upload was a duplicate; or
- `corrected`: the nurse in charge corrected the record that stands through the corrections
  route, and the correction's id is named. The correction must supersede the record that stood
  (directly or through its chain) and be recorded after the upload arrived; or
- `both_given`: the dose was given twice. A medication incident is raised for the person through
  the outbox (`medicines.administration.double_dose`, handled by safety; its words name no
  medicine). The second dose stays on the conflict and the incident; it is not added to the MAR
  history, so when-required totals do not count it (human action H-1270).

The decision must fit the records: `both_given` only when both say the dose was taken (given,
self-administered or given by family); `first_stands` is refused when an upload says taken and the
record that stands does not, so the reviewer corrects the record instead. Someone who recorded or
uploaded the dose may still decide, so a lone nurse at night never leaves a conflict waiting: the
decision is audited as a self-review and raises a routine retrospective review task for the
Registered Manager (the provider when the Registered Manager decided), due within 8 hours
(H-1270). Nobody who decided, recorded, gave, corrected or uploaded the dose may close that review.
A controlled drug's conflict is always decided by someone who did none of these, and its permission
and step-up are checked before the decision's transaction opens, so its scope limits what the
decider can see. The checks read what the record that stands
says now, after any correction. A controlled drug's conflict also needs
`medicines.cd.administer` and a fresh step-up, and `both_given` on one raises an urgent task to
enter the second dose on the register, witnessed. The incident's time is the device's time given
when it sent one.

A conflict is resolved once, never edited, and its task is closed. Every refusal, including a
second attempt to resolve, is audited. The upload itself never
becomes an administration record without a person's decision.

The table is append-only, apart from the resolution, which is set once. It has forced RLS and
person scope, and its retention class is `mar_chart`.

### 15.5 Audit and outbox

- Audit actions, carrying ids only: `medicines.round.viewed` (with the person ids shown),
  `medicines.administration.conflict_raised`, `.conflict_joined`, `.conflict_viewed` (with the
  conflict and person ids), `.conflict_resolved`.
- Outbox events: `medicines.administration.conflict_raised`; `medicines.administration.double_dose`
  (raises a medication incident whose id is the conflict's, so applying it twice raises one).
## 14. Medication errors, reviews and reports (slice 45; MEDS-012, MEDS-013)

Hazard HZ-134; human actions H-1290 to H-1299. Builds on slice 7's `medicationErrorTriage`
([safety.md](safety.md) Phase 2 rule 7) and slice 22's administrations. Nothing here diagnoses,
scores a person or recommends a treatment (medical-device boundary): it records what happened and
what a named person decided, and counts records.

### 14.1 Medication errors and near misses on the incident

A medication incident (incident `type` `medication`) may carry one **medication error record**
(`medication_error`, one per incident, mutable with `expected_version`), about one person on the
incident:

- **What went wrong**: one or more kinds from Thapsus Care's list, which follows the NRLS medication
  incident error categories (National Reporting and Learning System, NHS England; kept by Learn
  from Patient Safety Events) as the source, with the source named in the code
  (`MEDICATION_ERROR_SOURCE`): omitted dose, wrong dose or strength, wrong frequency, wrong
  medicine, wrong person, wrong time, wrong route, wrong formulation, wrong quantity, given after
  it was stopped, known allergy or contraindication, expired medicine, wrong storage, monitoring not
  done, record unclear or missing, other (H-1290 confirms the list).
- **The stage** (NRLS stage of the medication process): prescribing, transcribing, dispensing or
  supply, administration, monitoring, storage, other.
- **The medicine and the dose record**, each optional: a version of one of the person's medicines
  entries (`medication_id`), and an administration record (`administration_id`) for that person.
  Both are checked to belong to the person on the incident, and to be of one medicines entry: a
  dose record of another medicine is refused.
- **Slice 7's questions**: whether it reached the person (`yes`, `no`, `unsure`; a near miss when
  no), whether a controlled drug was involved, and whether it may be deliberate or repeated. A
  controlled drug is presumed `yes` when the chosen medicine, or the dose record's medicine,
  carries a CD schedule, and an explicit "no" against a CD-scheduled medicine is refused (H-1294).
  An omitted dose counts as having reached the person, never as a near miss.
- **Dates**: the clinician cannot be told before the incident happened, and a controlled drug
  report cannot be dated in the future.
- **What was done**: immediate actions (text), the prescriber or clinician told (when, and who, as
  text), the advice given (text), the root cause found (text, once known), the controlled drug
  report (the date and the reference the area's Controlled Drugs Accountable Officer gave).

Severity, harm and the statutory notifications stay on the incident and its classifier, which
this slice does not change. The **prompts** (`medicationErrorTriage`) are returned with the record
and shown, never sent anywhere by Thapsus Care:

- **Clinical advice** whenever it reached or may have reached the person, or a dose was omitted,
  with "if the person is unwell, call 999", until who was told, when, and their advice are all
  recorded.
- **Controlled drug report** to the area's NHS England Controlled Drugs Accountable Officer when a
  controlled drug was or may have been involved (H-594 recommended answer), until its date and
  reference are recorded.
- **Safeguarding**: answer the incident's own safeguarding question (`safeguarding.concern`) when
  the error may be deliberate or repeated, caused significant harm, the harm is not yet graded, or
  a dose was omitted (H-549 recommended answer; whether near misses that risked harm also prompt is
  H-1292). It clears once that question is answered. A person decides; nothing is referred
  automatically.
- **CQC**: a medication error is notifiable only through what it caused or shows (for example a
  death, an injury meeting regulation 18(2)(a) or (b), abuse or neglect, or police involvement),
  which the classifier already decides; the record says so in words and never raises a
  notification itself.

Access follows the incident (security review, 01/11/2026): reading, adding and changing need MFA,
as the incident itself does; an incident about a person the reader cannot see is refused whole;
a deleted incident is not found. Adding needs the right to change the incident (its raiser, or a
manager of incidents at its home); changing needs that or to have added the record. A closed
incident's record cannot be added to or changed (H-1299 asks whether a manager may correct it with
a reason). The record takes its incident's retention class.

### 14.2 Medication reviews (MEDS-013)

A **medication review** (`medication_review`, mutable with `expected_version`) is scheduled for a
person (`due_on`) and recorded as done (`done_on`) by a named clinician (`clinician_name`,
`clinician_role`: GP, pharmacist, nurse or other prescriber, consultant, other), with the outcome in
the clinician's words (`outcome`, text). Thapsus Care never suggests a change. Once done, it cannot be
changed except by a correction with a reason. A review not yet done can be moved to another date
or cancelled, each with a reason (kept in history). The tracker (`reviewStatus`) shows for each
person on medicines: the last review done, the earliest booked review, the date due by the interval
(last done plus `medicines.review_interval_months`), and the next due as the earlier of the two,
saying when a booking is later than the interval allows. The status in words: overdue, due soon
(within `medicines.review_due_soon_days`), review booked, due by the interval and not yet booked,
not scheduled (no review ever done or booked). Scheduling follows the person's lifecycle as a care
plan change; recording one done follows it as a care note on the day it was done.

### 14.3 Reports (information only)

- **Competence overrides and doses recorded after they were given** (`overrideCounts`): per member
  and period, at a location, from the latest version of each administration record's flags (a
  superseded record is not counted). A competence override and a dose given while competence was
  not current count against the member who gave the dose; a dose recorded after it was given counts
  against the member who recorded it (HZ-119, H-1067, H-1295).
- **PRN and psychotropic use** (slice 28's report, built here because slice 28's PRN protocols are
  not built): per person and period, the doses given of when-required entries, of entries tagged
  `psychotropic`, and of both, with the medicine names, counted from the records only. The report
  says it is a count of records for a clinician's review, never a judgement of the person or the
  prescribing. Each dose is classed by the version of the entry it was given against; a record
  superseded by a correction is not counted, wherever the correction falls (H-1297).
- **Medication error trend**: per location and UK calendar month (every month in the period shown,
  empty months as zero), errors, near misses and those not yet known, by kind and stage.
- Every report period is in UK dates, inclusive, and at most `medicines.report_max_days` long
  (H-1296). People are counted at their current home (H-1298): a person who moved is counted at the
  new home for the whole period.

### 14.4 Permissions

| Action | Permission |
| --- | --- |
| Add a medication error record to an incident one can see | `safety.incident.report` |
| Change it (actions, prescriber told, root cause, CD report) | the member who added it, the incident's raiser, or `safety.incident.manage` at its home; with MFA |
| Read it | `safety.incident.read` (with the incident's own scope), with MFA |
| Schedule, move, cancel and record reviews; read the tracker | `medicines.record.manage` |
| Read the reports | `medicines.record.manage` at the location |

### 14.5 Schema (migration 0135)

`medication_error` and `medication_review`: `tenant_id`, forced row-level security, the person's
scope (and for an error the incident's: `app.incident_visible`), history in `record_version`,
retention as their incident for errors (`care_record` or `serious_incident`, copied by the guard)
and `mar_chart` for reviews. The error guard refuses a deleted or non-medication incident, a
person not on it, and a dose record of another medicine; the review guard needs a new reason to
change a review once done, and to move or cancel one not yet done.

### 14.6 Test list

- Domain, table-driven: the error kinds and stages, the checks on an error record, the triage with
  the controlled drug presumption, the review status at, before and after the due dates, the
  next-due arithmetic over month ends, the PRN and psychotropic counts, the trend.
- Database: isolation for both tables; an error only on a visible incident about one of its
  people; the medicine and dose record of that person only; a done review fixed.
- API: add, read and change an error record with its prompts; the CD report clearing its prompt;
  refusals in words; a member who may not change the incident; a closed incident; reviews
  scheduled, done, moved and cancelled; the tracker; the three reports on fixed dates; the period
  cap. MFA uses the shared refusal (`mfaRefusal`) proved in `mfa-session-factor.test.ts`.
## 15. Stock, ordering, disposal and temperatures (slice 42, schema and API)

Plan slice 42 (MEDS-008; migration 0138; ADR-0103). Medicines in a care home are dispensed for
each person, so stock is kept per person and per product. Controlled drugs keep their own register
(section 14): this section never moves their stock, and shows their balance from the register. The
pharmacy is reached only through a contract-tested mock port (H-517). Nothing here says whether a
medicine is still fit to use: after a temperature out of range, that is the pharmacist's call, and
Thapsus Care says so in those words (medical-device boundary).

### 15.1 Tables

- `medicine_stock_item`: one per person and dm+d product (`vmp_id`), opened from a MAR entry
  (`medication_id`) in that entry's dose unit, by whom and when. Append-only. The database refuses
  an item for a controlled drug (the entry's `cd_schedule` set).
- `medicine_stock_movement`: append-only, in sequence per item, each with its signed `change` and
  `balance_after` (the database checks it follows from the last). The movements are:
  - `receipt` (with the order line it fills, when there is one) and `carried_forward` (stock
    brought into a new cycle), both positive;
  - `administration` (slice 22's hook, naming the administration) and `returned` (to the
    pharmacy), both negative;
  - `disposal` (naming the disposal record), negative;
  - `administration_correction` (a correction of a dose's amount or outcome), either sign;
  - `count_adjustment` (a count that differs from the balance), either sign, with a reason.
  A balance may go below zero: a dose is never blocked by stock, and the count is asked for
  instead (rule 3).
- `medicine_disposal`: a quantity of a person's item disposed of, with a reason code and note,
  who recorded it, and its witness: a second member who confirms it themselves, or, where the
  organisation's policy allows, why no one witnessed it. The witness is set once.
- `medicine_order_cycle`: a location's 28-day cycle, by the first day of a cycle (`anchor_on`).
  Its length is `medicines.ordering_cycle_days` from the rate table.
- `medicine_order` and `medicine_order_line`: a location's order for a cycle. The order has a
  status (`draft`, `submitted`, `part_received`, `received`, `cancelled`), how it was sent
  (`manual` or `pharmacy_port`) and the port's reference. Each line has a person, a MAR entry,
  the product, the quantity and the unit. Lines are fixed once the order is submitted.
- `medicine_storage`: a location's fridge or medicines room or cupboard, with a name.
- `medicine_temperature_reading`: append-only. A reading in tenths of a degree, with the minimum
  and maximum since the last reading when the thermometer gives them. It stores the range that
  applied, from the rate table (`medicines.fridge_min_celsius` and `medicines.fridge_max_celsius`
  for a fridge; `medicines.room_max_celsius` for a room), and whether it was out of range. The
  database works both out from the rate table itself.

### 15.2 Rules (`packages/domain/src/medicines/stock.ts`, table-driven tests)

1. **Per person, per product.** An item is opened from one of the person's MAR entries, in its dose
   unit, once per product. A controlled drug has no item: its stock is the register's, shown
   beside the others with the register's balance and a link to the page, never counted twice.
2. **Receipts and returns.** A receipt adds a positive quantity, naming its order line when it
   fills one. A return to the pharmacy takes a positive quantity off.
3. **Administrations decrement stock** (slice 22's hook). A dose recorded as given, from an entry
   whose product has an item and is not a controlled drug, writes an `administration` movement
   for the amount given in the same transaction, when the amount's unit is the item's.
   - With no item, or a different unit, no movement is written; the dose is never refused.
   - The hook runs in a savepoint: if moving the stock fails, it is undone, a routine count task
     asks the person in charge to check the stock, and the dose stands.
   - "Not available: out of stock" raises one urgent task per person and product, outside the
     savepoint, so a stock failure never takes it away; further doses not available join the open
     task.
   - A balance that goes below zero raises one routine task, "Medicines stock count needed", for
     the person in charge.
   - A correction writes the difference between what the chain now says left stock and what has
     already left, as an `administration_correction`. A dose first recorded before its item was
     opened was never counted in it, so its corrections move nothing; one recorded after moves the
     difference (a dose first refused and then corrected to given takes its amount).
4. **Counts.** A count that matches writes nothing but the audit. One that differs writes a
   `count_adjustment` to the count, with a reason.
5. **Disposal, witnessed per the organisation's policy.** `medicines.disposal.witness_required` is
   1 by default; an organisation may set 0 in the rate table.
   - The recorder names a witness, who confirms the disposal themselves, from their own session.
     The witness is never the recorder, and must be an active member holding
     `medicines.stock.manage` at the person's home, so that they can confirm it (the database
     checks it too).
   - Until it is confirmed, the disposal is `awaiting_witness`, and a routine task, assigned to
     the witness, asks them to confirm it. Only the confirmation closes the task.
   - Where the policy allows, the recorder may instead give why no one could witness it.
   - The stock leaves when the disposal is recorded.
   - The destruction of a controlled drug is the register's (section 14), never here.
6. **The 28-day cycle and reorder prompts.** A location's cycle starts on its anchor date and every
   `medicines.ordering_cycle_days` after it.
   - The daily job `medicines-reorder-prompts` raises one routine task, "Medicines order due",
     `medicines.order.prompt_days_before` days before a cycle starts, unless the location already
     has an order for it.
   - Figures come only from the rate table.
7. **Order status.** The steps are `draft`, then `submitted` (by hand, or through the pharmacy
   port, which gives a reference), then `part_received` and `received` as receipts fill its lines;
   or `cancelled` while not yet received.
   - Lines change only while the order is a draft.
   - Submitting needs access to everyone at the home, so no line is left out unseen. The order
     stays locked while the pharmacy is called, so it is never sent twice; the pharmacy has 15
     seconds to answer. The port receives the order's id to treat as idempotent, and each person
     as a keyed pseudonym (an HMAC with `PHARMACY_REF_SECRET`) stable within the organisation, never
     Thapsus Care's id or a name.
   - A receipt never fills more than a line asked for without saying so (an over-receipt is
     allowed, flagged).
8. **Temperatures.** A reading is out of range below the minimum or above the maximum for its kind
   of storage (a room has no minimum here), and the database decides it, from the rate table.
   - A reading has at most one decimal place, so one at a range's edge is never rounded into it.
   - An out-of-range reading raises an urgent task for the person in charge (`clinical_lead`),
     due at once. The task engine escalates it `task.overdue_escalation_minutes` after the
     reading if nobody has completed it.
   - While that task is open, further readings out of range for the same storage join it.
   - Its words never say whether the medicines can be used: "Medicines storage out of range.
     Check the storage, and ask the pharmacist whether the medicines in it can still be used."
   - The task ends when someone completes it; readings are never edited.

### 15.3 Permissions

| Action | Permission |
| --- | --- |
| Open an item; record a receipt, return, count or disposal; set a cycle; make, submit, cancel and receive orders; add storage | `medicines.stock.manage` |
| Witness a disposal | `medicines.stock.manage`, never the recorder |
| Record a temperature reading | `medicines.stock.manage` or `medicines.emar.administer` |
| Read stock and movements | `medicines.record.manage`, `medicines.emar.administer` or `medicines.stock.manage`, for people in scope |
| Read orders, storage and readings | The same permissions, at locations in scope |

Person tables follow the person's scope (`app.person_visible`). Location tables follow the
location's (`app.handover_location_visible`).

### 15.4 API

- `GET /v1/people/{id}/medicine-stock`: each item with its balance and last movements, and each
  controlled drug's register page with its balance (the register's, marked as such).
- `POST /v1/people/{id}/medicine-stock`: open an item from a MAR entry.
- `POST /v1/medicine-stock/{itemId}/receipts`, `/returns`, `/counts` and `/disposals`.
- `POST /v1/medicine-disposals/{id}/witness`.
- `GET` and `PUT /v1/locations/{id}/medicine-cycle`.
- `GET` and `POST /v1/locations/{id}/medicine-orders`.
- `GET /v1/medicine-orders/{id}`, and `POST` to its `submit` and `cancel`.
- `GET` and `POST /v1/locations/{id}/medicine-storage`.
- `GET` and `POST /v1/medicine-storage/{id}/readings`.

### 15.5 Audit and outbox

Audit events carry ids, movements, counts of lines and whether a reading was out of range; never a
product or a figure:
- `medicines.stock.item_opened`, `.received`, `.returned`, `.counted`, `.disposed`,
  `.disposal_witnessed`;
- `medicines.order.created`, `.submitted`, `.cancelled`;
- `medicines.cycle.set`;
- `medicines.storage.added`;
- `medicines.temperature.recorded`.

Outbox events, with ids only: `medicines.temperature.out_of_range` and
`medicines.stock.below_zero`.

### 15.6 Tests

- Domain (`stock.ts`):
  - the sign of each movement and the balance after;
  - the correction difference;
  - when the hook moves stock;
  - count adjustments;
  - the disposal witness rules;
  - cycle starts and reorder prompts across clock changes;
  - order steps;
  - temperature ranges at the edges.
- Database:
  - append-only movements with a following balance, and no item for a controlled drug;
  - the witness set once and never the recorder;
  - the temperature range from the rate table;
  - person and location scope, and cross-tenant denial.
- API:
  - receipts, returns, counts and disposals;
  - the administration hook on a given dose and its correction, a controlled drug untouched and
    shown from its register;
  - a reorder prompt once;
  - an order submitted through the mock;
  - an out-of-range reading raising an urgent task that escalates when overdue, with words that
    give no advice on use.

### 15.7 Known gaps

| Gap | To close |
| --- | --- |
| Household remedies and stock not dispensed for one person | H-1320 |
| No live pharmacy client; only the mock | H-517, H-1321 |
| No reminder when a temperature reading is missed for the day | H-1322 |
| The printable stock and temperature records | Slice 50 |
| A dose's amount in a unit other than the item's moves no stock | H-1323 |
## 15. Controlled drugs register screens (slice 54, MEDS-005 and MEDS-014)

The person record's **Controlled drugs** tab and a page per drug, for the API's readers; recording
needs `medicines.cd.administer` (or `medicines.stock.manage` for a count) and signing as witness
needs `medicines.cd.witness`, each with a fresh step-up, as the API asks. Every page sits inside the
record frame, so the point-of-care header (name, photo, date of birth, NHS number, allergies) is
above the register.

**Which register is the record** (H-1517, HZ-115): Harbour's register is the record at a home only
once controlled drug recording is released there on both the web and the phone (the per-location
flag `medicines.cd_recording`, off by default). Until then the tab and every page say at the top,
in words with a warning icon, that the paper controlled drugs register is the record and not to
record controlled drugs there; the web offers none of the register's forms (open a page, record,
witness, correct, count); the printed page and the person's stock say the paper register is the
record; and the web round's record page tells staff to record a controlled drug in the paper
register and on the paper MAR. A flag the web cannot read counts as off. The demo seed releases
recording at the demo home only. The API does not yet refuse entries where it is off (open
control in HZ-115, for the CSO).

**Rules**

1. **The tab** (`/people/{id}/controlled-drugs`): one row per register page (drug, form and strength,
   as dm+d names it), with the balance **as the API reports it** (never added up in the browser),
   the unit, the last stock check's result in words and when the next count is due (with an
   "overdue" word and icon when it has passed). A holder of `medicines.cd.administer` opens a page
   for a medicine on the MAR; the API refuses one that is not a controlled drug, in its words.
2. **A register page** (`/people/{id}/controlled-drugs/{pageId}`): every entry in order (its number
   on the page, date and time, movement, quantity, who it came from or went to and the reference,
   the balance after it as the API recorded it, who recorded it and who witnessed it, or why no
   witness was available). A correction is shown directly under the entry it corrects, and the
   entry it corrects says it was corrected (never struck through or hidden: the register is never
   changed). Flags (for example "no witness, for manager review") are words with an icon. The stock
   checks follow, each with its result in words.
3. **Witness first** (ADR-0084 on the web): the witness, in their own session, opens the page and
   signs for what they saw: the movement, the quantity and the member they watched record it
   (`GET .../recorders` lists those who may record at the person's home, never the witness). The
   page says the signature lasts `medicines.cd.witness_assertion_minutes` and is used once.
4. **Recording** a receipt (from the pharmacy), a return to the pharmacy (`transfer_out`), a
   disposal or a destruction: the movement, the quantity in the page's unit, when it happened
   (now if left empty), who it came from or went to, and the reference. The witness is chosen from
   the signatures waiting for the signed-in recorder on this page (`GET .../witness-assertions`,
   with the witness's name, movement and quantity); none waiting says so and how to get one. Where
   the policy is `where_available` and the movement is not a destruction, a lone worker may instead
   say why no witness was available, which flags the entry for review. The API checks the
   signature matches what is recorded.
5. **Corrections**: chosen from the page's entries, correcting the quantity (a signed change) or a
   detail (no change of stock), with a reason, witnessed the same way. Never an edit.
6. **Stock checks**: the count, witnessed the same way. A count that does not match the balance
   needs a reason; the result says how many over or short, in the API's words, and that a
   medication incident has been raised. A count never changes the balance: a correction does.
7. **Printing** (`/people/{id}/controlled-drugs/{pageId}/print`): slice 50's printable register
   format does not exist yet, so a plain print view lists the page heading (the person, the drug,
   form, strength and unit), every entry with its signatures (recorder and witness by name, or why
   none) and corrections under the entry they correct, and the stock checks, with the date and time
   printed and "Page n of m" from the browser. Printing is audited by the page read (H-1331).
8. **Separation of duties** on screen: the witness form never offers the witness as recorder; the
   recorder only sees signatures naming them; the API refuses the same person twice.

**API added in this slice**: `GET /v1/controlled-drugs/pages/{pageId}/recorders` (`medicines.cd.witness`)
and `GET /v1/controlled-drugs/pages/{pageId}/witness-assertions` (`medicines.cd.administer` or
`medicines.stock.manage`; unused, unexpired, naming the caller).

**Tests**: `apps/api/test/controlled-drugs.test.ts` (the two routes); `apps/web/src/lib/controlled-drugs.test.ts`
(the forms read into the contract, movements and results in words, corrections placed under their
entry); `apps/web/e2e/controlled-drugs.spec.ts` (a witness signs, the manager records a receipt with
that signature, a correction, a stock check that does not balance, and the print view; axe in light
and dark).
## 15. Covert administration, self-administration and homely remedies (slice 38; MEDS-004, MEDS-006, MEDS-007)

Hazards HZ-026 and HZ-120; human actions H-1350 to H-1359. Section 14 is slice 45's (on its own
branch). Thapsus Care records and applies the organisation's decisions: it never recommends covert
administration, a method, a level of self-administration or a remedy (medical-device boundary).
Every limit is the rate table's or the home's own protocol's, never a literal.

### 15.1 Covert administration (MEDS-004)

A **covert record** (`covert_medication_record`, mutable with `expected_version`, history kept) is
per medicine (the stable `medicine_id`, copied by the database from the entry version chosen). It
stands on:

- the person's **capacity assessment** for the decision `covert_medicines` finding a lack of
  capacity (NICE SC1 (2014) 1.15.1: never covertly to a person who has capacity), not corrected
  since;
- the **best-interests decision** after that assessment, not corrected since (NICE SC1 1.15.3);
- **who took part**, by role and name, which must include the prescriber and a pharmacist;
- **how it is given** and the **pharmacist's advice** on giving it that way (crushing, food,
  timing), in their words;
- a start date, not before the decision, and a **review date** within
  `medicines.covert.review_max_days` (H-1352).

One open record per medicine. A **review** records the same evidence again with the date reviewed,
the next review date (within the rate table's days from the review) and a reason; an **end** records
the date and reason. Every change needs a new reason; an ended record is closed (database guard).
A record whose capacity assessment or best-interests decision has since been corrected, or whose
person a later assessment of covert medicines finds to have capacity, shows as needing review
(`basis_changed`) and no longer covers a dose (NICE SC1 1.15.1).
Writing needs `medicines.covert.manage` at the person's home, in the API and in row-level security.

**On the MAR**: a dose that was given may be marked **covert** (`medication_administration.covert`),
shown on the record; covert on any other outcome is refused. Showing the record's status, method
and advice beside the entry on the round is the round view's (slice 53, H-1354). A covert dose is never refused, because it has happened and the record must say so
(HZ-004): with no current record for the medicine it carries `covert_without_record` and an urgent
task for the nurse in charge; while the record's review is overdue it carries
`covert_review_overdue` and a task (H-1351).

### 15.2 Self-administration (MEDS-006)

A **self-administration assessment** (`self_administration_assessment`, append-only; a review is a
new assessment) records, for the medicines it lists (the person's own, checked by the database):
the person's **choice**, **capacity** (assumed, as the Act requires, or a linked assessment that
says so), **dexterity**, **storage**, the **level** decided (looks after and takes them; takes them
with support; staff give them), notes, the date and a review date within
`medicines.self_admin.review_max_days` (H-1353). A level other than staff giving needs the person's
choice, capacity not lacking, dexterity and lockable storage (domain and database). A linked
capacity assessment must be the person's current one and say what the assessment records; it is
not yet tied to a self-administration decision kind, which needs its own migration (H-1354). The
latest
assessment listing a medicine decides its status: current, review overdue or not assessed.

A dose recorded as **taken by the person** (`self_administered`) is never refused: with no current
assessment that has them self-administering it carries `self_admin_not_assessed` and a task; while
the review is overdue, `self_admin_review_overdue` (H-1353).

### 15.3 Homely remedies (MEDS-007)

A **homely remedy protocol** (`homely_remedy_protocol`, per home, mutable with history) holds the
product (dm+d VMP when coded), what it is for, one dose and its unit, the shortest gap in hours, the
most in 24 hours, the days a course may last before the person's GP is asked (within
`medicines.homely_remedy.max_days_ceiling`), the staff allowed to give it, the GP or pharmacist who
agreed it and when, and a review date within `medicines.homely_remedy.review_max_days` (H-1355).
Changing it needs a new reason; a withdrawn protocol is closed.

A **homely remedy dose** (`homely_remedy_administration`, append-only, client UUID) needs the giver
to confirm they checked the person's allergies (Thapsus Care never matches them: HZ-007, ADR-0082), and
is recorded by the member who gives it (database). It can be checked first without recording
(`POST .../homely-remedy-doses/check`). It is refused in words when (H-1356):

- the protocol is withdrawn or past its review date;
- the member is not named on it;
- the dose is not the protocol's;
- it is sooner than the shortest gap, or would exceed the most in 24 hours;
- the course (doses with gaps no longer than `medicines.homely_remedy.course_gap_hours`) has
  lasted the protocol's days: the GP is asked first;
- the person has the same dm+d product on a current entry (another product with the same
  ingredient is not caught: ADR-0082, H-1357);
- the person does not live at the protocol's home (database guard).

Doses of the same product under other protocols at the home (the same dm+d product, or the same
name when not coded) count too, so a replaced protocol never starts afresh. Gaps, the 24 hours and
the course are elapsed hours, not calendar days, so a clock change neither adds nor removes time
(H-1355). A dose **already given** is recorded with when and why: what the check finds is recorded
as flags and escalated urgently, never refused (HZ-004; H-1356); a time in the future is refused.

A dose recorded in error is marked by a new record with a reason; it stays, struck through, and no
longer counts.

### 15.4 Permissions

| Action | Permission | Scope |
| --- | --- | --- |
| Read covert records, assessments, protocols and homely remedy doses | `medicines.record.manage`, `medicines.emar.administer` or `care.plan.read` | The person; the home |
| Record, review and end a covert record | `medicines.covert.manage` (new: owner, Registered Manager, deputy, clinical lead; backfilled to existing tenants' built-in roles by migration 0140) | The person's home |
| Record a self-administration assessment | `medicines.record.manage` | The person |
| Add, change and withdraw a homely remedy protocol | `medicines.record.manage` | The home |
| Give a homely remedy | `medicines.emar.administer`, and named on the protocol | The person, at the protocol's home |
| Mark a homely remedy dose entered in error | The member who gave it, or `medicines.record.manage` | The person |

All are care-record permissions (MFA). Audited with ids only.

### 15.5 Schema (migration 0140)

`covert_medication_record`, `self_administration_assessment`, `homely_remedy_protocol` and
`homely_remedy_administration`, each with `tenant_id`, forced row-level security and the tenant
policy; the person's scope on the three about a person; the home's scope on protocols; history
(`capture_version`) on the two mutable tables; append-only triggers and no UPDATE or DELETE grant
on the other two; no DELETE on any. `medication_administration` gains `covert` (default false:
expand only) and four flags. Retention `mar_chart`. Sample data removal lists the new person tables.
Sent to devices from slice 68 (section 13.8).

### 15.6 Test list

- Domain, table-driven: every covert record problem and status; the covert dose marks; every
  self-administration problem, the status from several assessments, the dose marks; every protocol
  problem, every homely remedy dose refusal, the course gap.
- Database: isolation and scope; the covert guard (lack of capacity for covert medicines, the
  decision after it, prescriber and pharmacist, another person's medicine, a new reason for every
  change, closed once ended); the covert write policy; self-administration of the person's own
  medicines only, append-only; protocol writes by home, a dose only by a named member at the home
  on the current version, entered in error, append-only; the role backfill, idempotent and audited.
- API: covert permission, refusals in words, one open record per medicine, a covert dose marked,
  review with the version read, end and the urgent escalation after it; self-administration
  refusals, the flag and escalation before an assessment and none after; protocol refusals, a dose
  by a named member once per id, refusals in words, entered in error, a prescribed product,
  withdrawal.

## 18. Web: stock, homely remedies, errors and reviews (slice 55; MEDS-007, MEDS-008, MEDS-012, MEDS-013)

No migration and no API change. In the side navigation: "Medicines stock" (`medicines.stock.manage`) and "Medicines reports" (`medicines.record.manage`); the person's Medicines tab links their stock, homely remedies and medication reviews.

### Stock, ordering, disposal and temperatures screens (slice 55, MEDS-008)

The web screens for section 15 (slice 42's API; no API, contract or database change). A home's
stock page is at `/medicines-stock/{locationId}` (`/medicines-stock` sends the reader to the chosen
home, or lists the homes when the shell shows every one). A person's stock is under their record's
**Medicines** tab, at `/people/{id}/medicines/stock`, inside the record frame, so the point-of-care
header is above it. Reading needs any of the API's readers (`medicines.record.manage`,
`medicines.emar.administer` or `medicines.stock.manage`); every change needs
`medicines.stock.manage`, except a temperature reading, which `medicines.emar.administer` may also
record. The API checks each again, and its refusals are shown in its own words at the field they
belong to.

**Rules**

1. **The home's page** has three sections. The **ordering cycle** shows the cycle's length (the rate
   table's `medicines.ordering_cycle_days`, from the API), the day a cycle started and when the next
   starts; a stock manager sets the first day of a cycle, against the version read. **Orders** lists
   each order by its cycle, newest first, with its step as an icon and a word (draft, submitted,
   part received, received, cancelled), its number of lines and how and when it was sent.
   **Storage and temperatures** lists each fridge and medicines room or cupboard, each opening its
   readings, and a stock manager adds one (a kind and a name of 2 to 80 characters).
2. **Starting an order** (`/medicines-stock/{locationId}/orders/new`) lists each person at the home
   the reader may see, with each medicine on their MAR in force and its dose unit. A quantity typed
   for a medicine orders it; one left empty does not. The first day of the next cycle is offered.
   At least one quantity is needed. The API checks each line is the person's own medicine at this
   home and never a controlled drug.
3. **An order** (`/medicines-stock/{locationId}/orders/{orderId}`) shows its step (icon and word),
   when and how it was sent, the pharmacy's reference, and each line with the person, the medicine,
   the quantity ordered and the quantity received (a line received beyond its quantity says so in
   words). A draft is submitted by hand or through the pharmacy (the API says when the pharmacy is
   not connected); an order not yet received can be cancelled.
4. **A fridge's or room's readings** (`/medicines-stock/{locationId}/storage/{storageId}`) lists the
   last 100, newest first. Each shows its state as an icon and words, never colour alone: "In
   range" or "Out of range", with no direction or cause (the figures beside it say that). Whether a reading is out of range is the API's (the database's) decision,
   from the rate table; the screen never works it out. Each shows the range that applied, as the API
   stored it, and the thermometer's lowest and highest since the last reading. An out-of-range
   reading with a task says a task was raised and points to the tasks list.
5. **Recording a reading**: the temperature now and, optionally, the lowest and highest since the
   last reading, each from -50 to 60 with at most one decimal place (8.04 is refused, so a reading at
   a range's edge is never rounded into it; HZ-132). After it is recorded the form shows its state
   (icon and words), the range that applied and the API's own words on what happens next. Nothing on
   these screens says whether the medicines can still be used.
6. **A person's stock** lists each item with its balance as the API counts it (never added up in the
   browser), a balance below nought as an icon and the words "Below nought, count needed", and its
   last movement. Each controlled drug shows its register's balance, says it is kept in the
   register, and links to the register page; it is never counted here. A stock manager opens an
   item from a medicine on the MAR in force that has none.
7. **A stock item** (`/people/{id}/medicines/stock/{itemId}`) lists its latest movements in words
   (received, given, returned, disposed of, a dose corrected, a count adjusted) with the signed
   change, the balance after and who recorded it when. A stock manager records:
   - a **receipt**, naming the open order line it fills when there is one (lines of submitted and
     part-received orders for this person's medicine);
   - a **return** to the pharmacy;
   - a **count**, where a count that differs from the balance shown needs a reason (the API compares
     again under a lock);
   - a **disposal**: the quantity, a coded reason, a note, and either a witness (a member at the
     home, never the recorder) or why no one could witness it (at least 10 characters), never both.
     The organisation's policy decides whether a disposal may go unwitnessed; the API says so when it
     may not. Where the reader cannot see the staff list (`platform.user.manage`), the form says to
     ask a manager to record a witnessed disposal.
8. **Witnessing a disposal** (`/people/{id}/medicines/stock/disposals/{disposalId}`): a disposal
   movement links here for stock managers other than its recorder. The page shows the medicine, the
   quantity and when, and the named witness confirms it once, in their own session; the API refuses
   anyone else in its words. Only this closes the witness task.
9. Quantities are numbers above nought with at most three decimal places and no leading zero; a
   count may be nought. Dates are typed as day, month and year.

**As built**: `apps/web/src/lib/medicine-stock.ts` (pure readers into the contract, chips as icon and
word, the field for each stock refusal), `apps/web/src/app/actions/medicine-stock.ts` (each body
checked against the contract's zod schema with only the form's fields),
`apps/web/src/components/medicines/stock/LocationStockForms.tsx` and `PersonStockForms.tsx`, and the
pages above. The home's stock page needs a link in the side navigation and the person's
**Medicines** tab needs a link to the stock page (not built in this area; see the lead's notes).

**Known gaps**: the API has no expiry date on a stock item, so no expiry state is shown (when one is
added, show it as an icon and words, never colour alone). A disposal has no read route, so its
witness state is shown only on arrival after recording it ("waiting for the witness to confirm it")
and the witness page finds it among the item's latest ten movements. The new-order page reads each
person's MAR one request at a time in parallel (one per person at the home).

**Tests**: `apps/web/src/lib/medicine-stock.test.ts` (who sees and changes stock; an order's step,
a reading's state, a balance below nought and a disposal's witness state each as an icon and a word;
a temperature to one decimal place at most, 8.04 and 1.95 refused; a reading at the edge that the API
found in range stays in range; receipts, returns, counts, disposals, the cycle, a new order, a
submission and storage read into the contract with each mistake at its field; which order lines a
receipt can fill; which entries an item can be opened from); `apps/web/e2e/medicine-stock.spec.ts`
(the manager sets the cycle, adds a fridge, records a reading in range and one out of range, starts
and submits an order, opens an item, receives the order line, counts with a reason, and records a
disposal the nurse confirms as witness; axe in light and dark at every screen, with and without
errors).

### Homely remedies on the web (MEDS-007; slice 55; HZ-120, HZ-007)

The home's homely remedy protocols and a person's homely remedy doses are on the web, on the slice
38 API (section 15.3). The web keeps nothing: every rule (the rate table's limits on the days and
the review, who is named, the dose, the gap, the 24 hours, the course, the same product prescribed)
is the API's, and its words are shown as they are.

**The home's protocols** (`/medicines-stock/{locationId}/homely-remedies`) list each protocol with
its state as an icon and the API's words (in use; review overdue, not to be used until reviewed;
withdrawn), the figures agreed with the GP or pharmacist (what it is for, one dose, the shortest gap,
the most in 24 hours, the days before the GP is asked, who agreed it and when, the review date, how
many staff it names, the dm+d code when coded), and why it was last changed or withdrawn. A
medicines manager adds one (`.../new`), changes one (`.../{protocolId}/change`, every figure as it
stands, the staff ticked, a new reason, the version read) and withdraws one (`.../{protocolId}/withdraw`,
with a reason and the version read). A withdrawn protocol offers neither.

**A person's homely remedies** (`/people/{id}/medicines/homely-remedies`, in the record's medicines
tab) list the doses given, newest first: the product, the amount and unit ("quantity not
recorded" when there is none, never zero), when, why, "Given by you"
for the reader's own, when and why a dose was recorded afterwards, and any flags in words. A dose
entered in error stays, struck through, with an "Entered in error" chip and the reason. Someone who
may give homely remedies at the person's home sees "Give a homely remedy": the person and every
allergy (`PersonCheck`), the person's current medicines on the MAR (stopped, replaced and withdrawn
left out; if they cannot be read, a warning to check the MAR), the home's protocols in use, the
chosen protocol's figures beside it (with a warning when the protocol has no dm+d product, so Thapsus Care
cannot check it against the MAR), and the amount (the protocol's dose filled in). "Check against the protocol" asks the API
(`POST .../homely-remedy-doses/check`) and shows its answer in its words; only a dose the check found
within the protocol, for the same protocol and amount, offers why it is given, the allergy
confirmation, the confirmation that the remedy was compared with the current medicines (HZ-120: the
API matches only the same product, never an ingredient) and "Record the dose". The API requires the
second confirmation too (`medicinesCompared: true` in `RecordHomelyDose`), stores it on the dose
(`medicines_compared`, migration 0150, a database check on every dose given from then on) and puts
it in the audit event's scope with the allergy confirmation.

#### Rules

1. The pages are shown to holders of `medicines.record.manage`, `medicines.emar.administer` or
   `care.plan.read`; the location page also needs the home to be one of the reader's locations.
   Adding, changing and withdrawing a protocol are offered only with `medicines.record.manage`.
2. A protocol's state is always an icon and the API's words: in use (tick), review overdue
   (warning triangle), withdrawn (circle with a line through it).
3. The protocol form reads every field before anything is sent: the product (200 characters), an
   optional dm+d code (6 to 18 digits), what it is for (500), one dose and the most in 24 hours
   (above zero, at most three decimal places, never rounded, the most in 24 hours not below one
   dose), the unit (60), the shortest gap in hours (above zero, at most 168, two decimal places),
   the days before the GP is asked (a whole number from 1 to 365), at least one member of staff,
   who agreed it, GP or pharmacist, the date agreed and a review after it. The organisation's
   limits on the days and how far ahead the review may be are the rate table's, applied by the API
   (no literal in the web).
4. The staff a protocol may name are the organisation's staff the reader may list (by name and job
   title), the reader, and anyone the protocol already names whom the reader cannot list (shown as
   such, so a change never drops them unseen).
5. A change sends every figure again, a new reason and the version read; a stale version is the
   API's conflict, said in words. A withdrawal sends a reason and the version read.
6. A dose is checked with the API before it can be recorded. A check that finds anything shows each
   problem in the API's words and offers no way to record it; a changed protocol or amount needs a
   new check.
7. A dose is recorded now, by the person signed in, with why it is given and the giver's
   confirmation that they compared the person's allergies with the remedy; Thapsus Care never compares
   them (HZ-007, ADR-0082). The web never sends a dose as already given (`alreadyGiven` is null,
   whatever a crafted call holds). The client's id is made by the page, so a resend is one record.
8. A refusal shows the API's words at the field it belongs to (the dose at the amount; on the
   protocol form the dose, the most in 24 hours, the gap, the days, the staff, the date agreed and
   the review), and anything else above the form.
9. A dose may be marked entered in error, with a reason, by the member who gave it (holding
   `medicines.emar.administer`) or by a medicines manager, while it still stands; the API checks the
   home again. The dose stays, struck through, with the reason.
10. The server actions check every body against the contract's schema and send only the form's
    fields; nothing about the person is logged.

#### As built (slice 55)

- `apps/web/src/lib/homely-remedies.ts` (pure readers, chips, permissions, addresses, the member
  list) with `homely-remedies.test.ts`.
- `apps/web/src/app/actions/homely-remedies.ts` (add, change, withdraw, check, record, entered in
  error).
- `apps/web/src/components/medicines/homely/` (`ProtocolSummary`, `ProtocolForm`,
  `WithdrawProtocolForm`, `HomelyDoseForm`, `EnteredInErrorForm`, `load-members.ts`).
- Pages: `apps/web/src/app/(shell)/medicines-stock/[locationId]/homely-remedies/` (list, `new`,
  `[protocolId]/change`, `[protocolId]/withdraw`) and
  `apps/web/src/app/(shell)/people/[id]/medicines/homely-remedies/page.tsx`.
- Gap: a dose already given and recorded afterwards (`alreadyGiven`, recorded with flags and
  escalated) is not offered on the web; the web lists such doses with their flags in words. Doses
  show "Given by you" only, not the giver's name, because the reader may not be able to list staff.
- Links to these pages from the medicines-stock location page and the person's medicines tab are
  for the lead to add (those pages belong to other areas).

#### Tests

- Vitest `apps/web/src/lib/homely-remedies.test.ts`: `hazard HZ-120 who sees and changes homely
  remedies`, `hazard HZ-120 a protocol's state is an icon and the API's words, never colour alone`,
  `hazard HZ-120 reading the protocol form` (every field refusal, table-driven; the rate table's
  limits left to the API), `hazard HZ-120 hazard HZ-007 checking and recording a dose` (amounts never
  rounded; allergies confirmed; never sent as already given; the API's words; a new check after a
  change), `hazard HZ-120 refuses without medicinesChecked`, `currentMedicines (hazard HZ-120)`, `hazard HZ-120 a dose entered in error stays, struck through, with its reason`,
  `hazard HZ-120 the staff a protocol may name`.
- Playwright `apps/web/e2e/homely-remedies.spec.ts`: `hazard HZ-120 hazard HZ-007 homely remedies
  only within the home's protocol` (add with errors, change with a reason, check a dose outside the
  protocol, record one with the allergies beside it, too soon in the API's words, entered in error,
  withdraw; axe light and dark at every screen, with and without errors).

### Medication errors, reviews and reports on the web (MEDS-012, MEDS-013)

For docs/specs/medicines.md section 14 (a new subsection "14.7 Web screens (slice 55)"). Built on
the slice 45 API (`apps/api/src/routes/medication-errors.ts`) with no API, contract, database or
domain change. Hazard HZ-134 (with HZ-003 for an omitted dose and HZ-119 for the override report).

#### Screens

- **Medication error on an incident**: `/incidents/{id}/medication-error`, linked from the incident
  page by one button, "Medication error details", shown on a medication incident the reader sees
  whole. The page shows what was recorded (the kinds and stage in the API's words with their NRLS
  source, whether it reached the person as an icon and words, the three questions, what was done,
  who was told, when and their advice, the root cause and the controlled drug report), the
  escalations ("What is still to do") in the API's own reasons, and the form that adds or changes
  the details.
- **A person's medication reviews**: `/people/{id}/medicines/reviews`, inside the medicines tab of
  the record. Where the reviews stand (the tracker line), every review newest first, a form to book
  one, and for each review a disclosure to record it done, move it or cancel it (booked), or
  correct it (done).
- **Medicines reports**: `/medicines-reports` chooses the location (or goes to the shell's chosen
  one); `/medicines-reports/{locationId}` lists the four reports; `/reviews` is the review tracker;
  `/overrides`, `/prn` and `/trend` are the override report, the PRN and psychotropic report and the
  medication error trend.

#### Rules

1. The error page needs `safety.incident.read`; the form shows only to a holder of
   `safety.incident.report` who raised the incident, manages incidents (`safety.incident.manage`)
   or added the record, on an open incident. The API decides again (its raiser or a manager of
   incidents where it happened, or the member who added the record; MFA; never a restricted or
   closed incident).
2. A restricted incident shows a notice and no record; an incident of another type says the
   details go on a medication incident; a closed incident shows its record with a notice and no
   form.
3. Adding chooses the person from the people we support on the incident: one is chosen for the
   reader; with several, the page lists each to record for. The medicine is chosen from the
   person's medicines record and the dose record from their records in the 24 hours either side of
   the incident (superseded records left out). A list that cannot be read keeps what was recorded.
4. The form says each mistake at its field before anything is sent, mirroring
   `checkMedicationErrorRecord`: unknown kinds or stage, an omitted dose answered as not reaching
   the person (HZ-003), who was told without when (or the reverse), told before the incident or in
   the future, a controlled drug report date without its reference (or the reverse) or in the
   future, a report with "no controlled drug", and answers over 2,000 characters (120 for the
   reference). An empty answer is sent as not answered, never as "no".
5. The API's refusal sentences (`MEDICATION_ERROR_PROBLEM_WORDS`, `REVIEW_PROBLEM_WORDS`) are found
   in its refusal and shown at their fields; any other refusal shows above the form in its words.
6. The escalations are the API's `prompts`, in its order, each as an icon and a name with the API's
   reason: clinical advice, the controlled drug report, the safeguarding consideration (each shown
   as still to do) and how CQC is decided (information). The page says Thapsus Care sends none of them
   and that each goes once what answers it is recorded. The web adds or removes none.
7. Whether it reached the person is the API's `nearMiss` in words and an icon: reached, a near miss,
   or not yet known. A controlled drug presumed from the medicine's schedule is said so.
8. Reviews need `medicines.record.manage`. Booking takes the date due; recording done takes the
   date (not in the future), the clinician's name and role and the outcome in the clinician's
   words; moving takes the new date and a reason; cancelling takes a reason; correcting one done
   takes a reason. The version read is sent back. Thapsus Care suggests no change to a medicine.
9. Each review's state and the tracker's status are an icon and words (the API's `statusWords` for
   the tracker: overdue, due soon, booked, due by the interval and not booked, none booked or
   done), never colour alone; a booking later than the interval allows is said in words.
10. The reports need `medicines.record.manage` and a location in the reader's list; the API also
    refuses an assigned scope. The tracker lists people overdue first, as the API orders them, with
    a count of overdue and due soon, and links each person to their reviews.
11. The override, PRN and trend reports choose their period (the contract's `from` and `to`, UK
    dates, inclusive) with date boxes in a form that uses the page's address, so the report can be
    bookmarked. Defaults: the last 28 days, and for the trend the last six calendar months. A date
    that is not real or an end before the start is said at its field and nothing is read; a period
    longer than `medicines.report_max_days` is refused by the API in its words.
12. Every report is a table with a caption and a row header, every count in its own cell, so it is
    read without colour; no chart is drawn. The trend has three tables (reached or not, kinds,
    stages), every month a column with zeros shown, a total column, and only kinds and stages that
    happened listed; the NRLS source is named. The PRN report shows the API's note above its
    table every time. The override report names a member no longer listed as such.
13. Every report says it counts records for a person to look into and judges nothing.

#### As built

- `apps/web/src/lib/medication-errors.ts` (pure readers, chips, period reading, table rows) with
  table-driven tests in `medication-errors.test.ts` (56 tests).
- `apps/web/src/app/actions/medication-errors.ts`: `addMedicationError`, `changeMedicationError`,
  `scheduleReview`, `changeReview` (done, reschedule, cancel); each body checked with the contract's
  zod schema (`NewMedicationError`, `EditMedicationError`, `ScheduleMedicationReview`,
  `RecordMedicationReview`, and the reschedule and cancel bodies built from the contract's pieces,
  matching the API's `ChangeMedicationReview` and `CancelMedicationReview`).
- Components in `apps/web/src/components/medicines/errors/`: `MedicationErrorForm`,
  `MedicationErrorDetails` (with `MedicationErrorEscalations`), `ReviewForms`, `PeriodForm`,
  `ReportTable`, `ReportFrame`, `report-location`.
- E2E: `apps/web/e2e/medication-errors.spec.ts`.

#### Tests

- `apps/web/src/lib/medication-errors.test.ts`: `hazard HZ-134 the medication error form is read
  into the contract` (every detail; empty is null, never no; 17 refusals at their fields including
  `hazard HZ-003 an omitted dose answered as not reaching the person`), `hazard HZ-134 the
  escalations are shown in the API's order as icon and word, never sent`, `hazard HZ-134 the API's
  refusals show at their fields`, `hazard HZ-134 medication reviews: status as icon and words, each
  change with its reason`, `hazard HZ-134 hazard HZ-119 the reports: periods, and tables readable
  without colour`.
- `apps/web/e2e/medication-errors.spec.ts`: `hazard HZ-134 hazard HZ-003 the manager records a
  medication error and its follow-up`, `hazard HZ-134 the manager books, moves and records a
  medication review`, `hazard HZ-134 hazard HZ-119 the home's review tracker and medicines reports`
  (axe in light and dark at every screen, with and without errors).
## 16. Web: rounds, administration, when-required medicines and covert (slice 53; MEDS-002, MEDS-003, MEDS-004)

The round on the web for the office and the tablet browser, on slice 48's API. No migration and no
API change. Holders of `medicines.emar.administer` see it; the API checks the permission again at
each person's home.

**Rules**

1. **The home's round** (`/medicines-round/{locationId}`, in the side navigation as "Medicines
   round"): each person living there whom the reader may see, in the API's order (room, then name),
   with the point-of-care header. It lists their doses from two hours ago to two hours ahead, plus
   any earlier dose still late or due (the API's reach). Doses are late first, then due, not yet due
   and recorded, with time-critical first in each. Each dose shows:
   - its state as an icon and a word;
   - "Time-critical" with an icon;
   - the entry's status and notice, any clock change, the dose's notices, and any conflict review.

   When-required medicines show when last given, when the next may be given, and their notices.
   If people's names, photos and allergies cannot be read, no dose is listed and the page says so
   (HZ-001). A person whose round cannot be worked out shows the API's words.
2. **A person's round** (`/people/{id}/medicines/round`, linked from the Medicines tab) says when it
   was worked out. Each dose shows the same as rule 1, and beside the medicine:
   - the **covert record**: its status as an icon and a word (anything but current is a warning),
     how it is given and the pharmacist's advice;
   - the **self-administration level** where the medicine has been assessed (H-1354).

   If the covert records cannot be read, the page says to check the paper record. "Record … due …"
   is offered only for a dose late or due, not recorded and not waiting for review (HZ-004).

   Each when-required medicine shows:
   - when it was last given (and when that was on a device not yet synced);
   - the 24-hour total against the maximum, as an amount in the entry's unit, never a count of
     doses;
   - when the next may be given: "Not now: the most allowed in 24 hours has been given" once the
     maximum is reached, "Not before …" while the minimum interval runs, otherwise "Now, if needed"
     (HZ-004).
3. **Recording a dose** (`…/round/record?entry=&due=`) on its own page. The page shows:
   - a notice that controlled drugs cannot be recorded here yet, and where to record them;
   - the medicine as the round gives it (product, dose, route, due time, time-critical, any clock
     change, indication, special instructions, the when-required figures, the entry's status and
     notices, the covert record and the self-administration level);
   - above the form, the person's name, date of birth, NHS number, allergy status and every allergy,
     most severe first (`PersonCheck`; HZ-007). Thapsus Care never matches them (ADR-0082).

   The form asks:
   - what happened ("Given" is not offered while the entry may not be given);
   - the reason, for an outcome that takes one: the domain's codes, with words for "other";
   - the amount, for a dose taken, offered as prescribed when the prescription gives one amount, in
     the entry's unit. A range or variable dose is typed; an unknown unit stops it with a notice.
   - "Given covertly", for a dose given. Its hint differs when the medicine has no current covert
     record: the API then records it with its flag and a task for the nurse in charge (HZ-026).

   Reasons the API may ask for (early or late, a different amount, before the minimum interval) are
   optional fields. The server action sends only these fields, checked against the contract, so a
   dose already given, another giver or a controlled drug's witness is never sent from the web.
   The API's refusals show in its words at their field (`administration_*` codes). The record's id
   is made by the page, so a resend is the same record. The server's time is used. After saving,
   the person's round opens and focuses "Dose recorded".
4. A dose not on the round any more, already recorded, not yet due or waiting for review says so on
   the record page and offers the way back; no form is shown (HZ-004).
5. **Clock changes** (HZ-009): a time the clocks skip says the dose is due an hour later, at its due
   time; a repeated time says to give it once, at the first.
6. **Not in this slice** (each a decision in H-1401 to H-1405):
   - recording a dose already given, a controlled drug with its witness, and corrections on the web;
   - the PRN protocol's text and the outcome check (slice 28's API, not in this base; HZ-117's entry
     is on slice 28's branch);
   - barcode scanning and the offline round (slices 68 to 70).

**Tests**:
- `apps/web/src/lib/medicine-round.test.ts`: the state chips, the dose offered, the next-allowed
  state (HZ-004), which doses may be recorded (HZ-004), the covert record and self-administration
  level beside the medicine (HZ-026), the outcomes and reasons matching the domain's, and the form
  read into the request with every refusal at its field;
- `apps/web/e2e/medicine-round.spec.ts`: the Medicines tab link, the side navigation, the home's
  round, the person's round, a when-required dose given by keyboard and a scheduled dose refused.
  It checks the 24-hour total, the focus after an error and after saving, and that a recorded dose
  offers no second record. Axe runs in light and dark at each step.
## 17. Printable MAR chart and controlled drugs register page (slice 50; MEDS-014)

Both PDFs are drawn from the record when asked and never stored. The web streams them as downloads that are not cached;
a downloaded file stays on the device, under the home's policy. No migration. HZ-122, with HZ-007.

**Routes** (`apps/api/src/routes/medicines-print.ts`; at most `MEDICINES_PRINT_REQUESTS_PER_MINUTE`
per member, default 20; a month from 2000 to next year):
- `GET /v1/people/{id}/mar/print?month=yyyy-mm`: the MAR chart for one calendar month in UK time.
  It needs a permission that reads the MAR (`medicines.record.manage`, `medicines.emar.administer`
  or `care.plan.read`). Audited as `medicines.mar.printed`, with the month.
- `GET /v1/controlled-drugs/pages/{pageId}/print`: a register page. It needs a permission that reads
  the register. Audited as `medicines.cd.printed`. This replaces slice 54's plain print view as the
  printable format (H-1331); the plain view stays for printing straight from the browser.

**The MAR chart** (`apps/api/src/services/mar-pdf.ts`):
1. Every page names the person (with a preferred name, date of birth and NHS number) and the month.
   Every page says "Printed from the eMAR at … This is not the live record: check the eMAR before
   giving or holding any medicine." The page footer says "Page n of m". The PDF's title names no one.
2. **Allergies** come first. Every allergy is listed, most severe first, with its reaction. "No known
   allergies" shows when it was recorded. A status not recorded says "Allergy status not recorded.
   Find out before giving any medicine." and is never shown as none.
3. **Communication needs** follow the allergies, or say that none are identified or that they are
   not recorded (AIS).
   **A key to the codes**, one per line: G given, R refused, N not given (with the reason), W
   withheld (with the reason), U not available, S taken by the person themselves, F given by family.
   It also explains "at" and a time, "covert", "corrected" and the giver's initials.
4. **Each medicine** in force during the month, or with records in it, shows:
   - the product and route, with "Time-critical:" first where tagged;
   - the directions in the domain's words, the prescriber, and the start and end;
   - its status on the eMAR when printed.
5. **Scheduled doses** are listed by day ("Mon 02/11/2026: 08:00 G at 08:40 2 tablet AE; 20:00 R
   (The person declined it) AE"). Each block is labelled with its version.
   - **Which records:** those that stand over all the person's records, so a correction made in
     another month still supersedes. A dose is matched by its due time in the month, so one given
     after midnight stays on its day. A record of a scheduled dose that matches no dose time is
     printed as "Recorded with no dose time on this chart", never dropped.
   - **What a cell shows:** the time given when it differs, the amount, the reason, "covert" and
     "corrected", and the giver's initials, or "giver not named". A time on a clock-change day
     carries its zone.
   - **With no record:** "no outcome recorded" when its time has passed, or "not yet due". A time
     before the entry was recorded says "not due".
6. **When-required doses** are listed as recorded, with the time, code, amount, marks and initials,
   or "No dose recorded this month".
7. **Staff initials on this chart** lists the initials and names of everyone who gave a dose. Two
   people with the same initials get a number each ("AE1", "AE2").
8. **Not printed** (H-1408): the superseded record struck through. The eMAR history shows both.

**The register page** (`apps/api/src/services/cd-register-pdf.ts`):
- the heading: the person, the drug as dm+d names it, the unit, and the balance when printed;
- every entry in register order, so the running balance reads in order: movement, signed
  quantity, running balance, when, counterparty and reference, who recorded it, and who witnessed it
  or why there was no witness;
- each correction saying which entry it corrects (a correction of a correction too) and why, and
  each corrected entry saying which entries correct it;
- every stock check: counted, expected, the result in words, and who counted and witnessed it;
- on every page, the same printed-time notice.

**Web**: the Medicines tab has "Print the MAR chart": choose one of the last 12 months and download
the PDF. A register page has "Download the register page (PDF)". If no PDF comes back, the page says
so.

**Tests**:
- `apps/api/test/medicines-print.test.ts`: the cells, the lines, the month in UK time and the
  register lines, all pure and table-driven, and the routes (the notice on every page, audited,
  another organisation refused);
- `apps/web/src/lib/medicines-print.test.ts`;
- `apps/web/e2e/medicines-print.spec.ts`: axe in light and dark, and the download.

## 16. PRN protocols, outcomes and the psychotropic report (slice 28; MEDS-003)

Hazard HZ-117; human actions H-1380 to H-1389. Sections 14 and 15 are slices 45 and 38 (on their
own branches). Thapsus Care counts, compares with the protocol and displays; it never recommends a
dose, a medicine or an alternative (medical-device boundary).

### 16.1 PRN protocols

A **PRN protocol** (`prn_protocol`, mutable with `expected_version`, every version kept in
`record_version`) is the home's guidance for one of the person's current when-required entries
(the stable `medicine_id`, copied by the database): what it is for, the **signs** that mean it may
be needed (at least one), the **non-drug alternatives** to try first, the **order of use** among
the person's medicines for the same purpose (a group and a place, one medicine per place), the
expected effect, the prescriber or pharmacist it was **agreed** with and when, and a **review** date
within `medicines.prn_protocol.review_max_days` (H-1382). One open protocol per medicine.

The **dose, the most in 24 hours and the minimum interval stay the prescriber's**, on the entry
(migration 0123, rule 13): a protocol shows them from the latest version of the entry and never
holds a second copy, so a changed prescription is always what staff see (H-1381). Changing a
protocol needs a new reason; a withdrawn protocol is closed. Statuses, read with the latest
version of the entry: in use, review overdue, medicine stopped (the entry is stopped or replaced
with nothing current), no longer prescribed when required, withdrawn.

### 16.2 Outcomes

The **outcome** of a when-required dose that was given or taken (`prn_outcome`, append-only,
client UUID): it helped, it helped a little, it did not help, the person was asleep, could not
tell; a note; when it was seen (after the dose, never in the future). One outcome per dose; a
correction names the outcome it corrects, with a reason. Doses whose outcome is due
(`medicines.prn.outcome_check_minutes` after the dose, `prnOutcomeDueAt`) and not recorded are
listed for the person, however long ago (H-1383).

### 16.3 The organisation's medicine lists and the PRN frequency report

The organisation's **medicine lists** (`medicine_list_item`) hold exact dm+d products (VMPs) for
each tag (`time_critical`, `paracetamol`, `bisphosphonate`, `psychotropic`; ADR-0082, H-514); never
an ingredient or a name. A removal is kept with its reason. They feed rule 13's tag suggestions and
the psychotropic count (H-1384).

The **PRN frequency report** (`GET /v1/locations/{id}/medicines/prn-frequency`) counts, for each
person and when-required medicine in a period (UK dates, inclusive, at most
`medicines.prn_report.max_days`, H-1385): doses given or taken (latest records only; a record a
correction replaced never counts), UK calendar days with doses, the most on one calendar day (UK time, not the prescriber's rolling
24 hours), doses given with no protocol in force, doses given under a protocol past the review date in force at the time (from the protocol's
version history, so a review recorded later never rewrites what was overdue),
outcomes by kind and those outstanding. A protocol is in force from when it was recorded (or the
agreement date, if later: a date typed in never covers earlier doses) until the instant it was
withdrawn. A medicine is psychotropic when the
dose's own entry version is tagged so or its product is on the organisation's psychotropic list;
the report can show those alone. It always carries the note that it is a count for the
prescriber and pharmacist, never a judgement (H-1386). People are counted at their current home.
The path differs from slice 45's usage report, which this report extends (H-1387).

### 16.4 Permissions

| Action | Permission | Scope |
| --- | --- | --- |
| Read a person's protocols and outstanding outcomes | `medicines.record.manage`, `medicines.emar.administer` or `care.plan.read` | The person |
| Record, change and withdraw a protocol | `medicines.record.manage` | The person |
| Record or correct an outcome | `medicines.emar.administer` or `medicines.record.manage` | The person |
| Read a medicine list | `medicines.list.manage`, `medicines.record.manage` or `medicines.emar.administer` | The organisation |
| Add to or remove from a medicine list | `medicines.list.manage` (new: owner, Registered Manager, deputy; backfilled by migration 0143) | The organisation |
| Read the PRN frequency report | `medicines.record.manage` | The home |

All are care-record permissions (MFA). Audited with ids only.

### 16.5 Schema (migration 0143)

`medicine_list_item`, `prn_protocol` and `prn_outcome`, each with `tenant_id`, forced row-level
security and the tenant policy; the person's scope on protocols and outcomes; write policies (lists:
`medicines.list.manage`; protocols: `medicines.record.manage` at the person's home; outcomes:
either permission, including a care worker's assigned role, through `app.may_record_for_person`,
the same function slice 38 defines); history on lists and protocols; append-only outcomes with
the recorder checked as the member signed in; no delete. Retention `mar_chart` (lists:
`organisation_document`). Sample data removal lists protocols and outcomes. Not sent to devices
yet (slice 68).

### 16.6 Test list

- Domain, table-driven: every protocol problem and status; every outcome problem; the report's
  counts across the clock change; the list check.
- Database: list writes by permission, closed once removed; a protocol only for a current
  when-required entry, at the person's home, one open per medicine, a new reason for every change,
  closed once withdrawn; outcomes for a when-required dose by the recorder, once per dose,
  corrections, append-only; isolation; the role backfill.
- API: list permission and duplicates; a protocol showing the entry's limits and the psychotropic
  list, one open per medicine, a taken place, changes with the version read; outstanding outcomes,
  refusals in words, idempotent resend, correction; the report's counts, filter, period cap and
  permission.


## 16. Medicines in the Phase 1 outputs (slice 49, API)

MEDS-001 and MEDS-002, with HZ-003, HZ-021 and HZ-023. Migration 0144 (a refused dose as a
handover source; the pack's build snapshot); the packs' JSON content gains fields. Code: `apps/api/src/services/medicines-outputs.ts`, `emarSnapshotNotice` in
`packages/domain/src/medicines/outputs.ts`.

- **Every printed or exported medicines list** opens with when it was read from the eMAR and "This
  is not the live record: check the eMAR, or the paper MAR in use, before giving or holding any
  medicine" (UK date, 24-hour time and zone). Each line is the record as read; the lists never say
  what to give or hold (medical-device boundary).
- **Downtime pack (HZ-021, H-102)**: for each person with entries on the eMAR, `medicines_due` lists
  the scheduled doses from when the pack is built to the end of its validity (the rate
  `downtime_pack.valid_hours`), using the round's rules, so a dose since the same UK time the day
  before that is still open is included. Each dose has dose, route, due time, time-critical and
  `due`, `given` or `not_given` (only `due` is kept). A dose still open from before is
  `outstanding: true`, listed first and printed "No outcome recorded when the list was made: …, was due …".
  A dose of an entry that may not be given now (a check that found a difference) is `onHold: true`
  and prints "On hold on the eMAR, not to be given: …". The entry's notice (not yet checked, a
  variable dose, a change tomorrow) is `notice` and prints on the next line. When-required medicines
  carry dose, route, indication and when last given; one on hold is listed as "On hold on the eMAR,
  not to be given: when required: …" with its notice, never left off. `producedAt` is when the eMAR was read. An empty
  list prints "No dose is due on the eMAR while this pack is in use, and no when-required medicine is
  on it."
  - Someone with no eMAR entries keeps where the paper MAR is kept.
  - Someone whose eMAR cannot be read (each person in a savepoint) gets the section state
    `unreadable`: "Medicines could not be read from the eMAR when this pack was made. Use the eMAR,
    or <the paper MAR place> if it is in use." It also gets a `medicines_unreadable` warning. The
    person ids are logged and audited (`medicinesUnreadable`), the nightly build raises the job
    alarm, and the pack is built again on the next read.
  - The medicines rates are read once per pack. Each person's administration records are read for
    `MEDICINES_OUTPUT_HISTORY_DAYS` (configuration, default 35), with the latest given record of each
    medicine version before that, uncorrected, so "last given" never goes missing
    (`recentAdministrations`).
  - A medicines change, a dosing record or an administration for anyone on the pack makes it stale
    when it is next read online. Besides the record times, the pack keeps the database snapshot it
    was built from (`buildSnapshot`): a row written by a transaction that snapshot could not see (one
    that began before the build and committed after it) also makes it stale, so the printed "as at"
    is never later than the data it covers. A printed or cached copy is not updated (residual risk:
    H-102).
- **Transfer pack (HZ-023, H-82)**: for a person with entries on the eMAR, `medicines` has `source:
  "emar"`, `producedAt` and each entry in force (not withdrawn, not yet started, replaced, stopped or
  ended). Each item has:
  - name, dose (each distinct scheduled dose, joined), route, and how often in words or "When
    required";
  - `lastGivenAt`: the latest given, self-administered or given-by-family record across the entry's
    versions;
  - `status`: the home's record for a hospital reader, never an instruction. Examples: "On hold on
    the home's eMAR: check found a difference.", "Recorded on the home's eMAR as not yet checked.",
    "Variable dose: the dose for each day is on the home's dosing record. Ask the home." It is null
    when checked.

  The PDF adds "Last given: …" or "not recorded on the eMAR", and the status as its own line. An empty
  list still reads not recorded. Someone with no entries keeps the pre-admission list, marked as
  needing checking against the MAR. If the eMAR cannot be read, the pre-admission list is used and
  the first page carries `medicines_emar_unreadable` ("The care home's electronic medicines record
  could not be read …"), logged and audited by person id.
- **Handover and care plans (HZ-003, H-151)**: outstanding doses (`medicines.dose.outstanding`) and
  a person whose doses could not be worked out (`medicines.dose.check_failed`) reach the shift
  handover as their tasks. A dose refused on the eMAR (the record that stands; a corrected one is
  not) reaches it as a `refusal` item, source `medication_administration`, summary
  `handover.summary.refusal` with `chart: medicine` ("Refused: a medicine"); a refusal recorded late
  is added to a locked handover by the sweep. A care plan medicines action still never generates
  tasks; its notice reads "Not a round: medicines rounds are on the eMAR". Not yet: a medicine not
  available raises no stock task on this base (slice 42's hook; for the batch).
