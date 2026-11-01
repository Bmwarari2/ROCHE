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
([integrations.md](integrations.md)).

## 2. Schema (for slices 10 and 16; no migration in slice 2)

Forced RLS on every tenant table (ADR-0002), scoped by the person (`person_child_scope`, as the care
record). dm+d reference tables are global, with no `tenant_id` (ADR-0080, slice 10).

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
   "0.5 to 1 tablet"). A compound unit keeps every part in full ("12 micrograms/hour" for
   "mcg/hr"); a measured unit is written "2 × 5 ml spoonfuls", so its size is never read as part of
   the number. No thousands separator ("5000 units"). Harbour never converts a dose: a number with
   more than 3 decimal places is refused with "ask the prescriber or pharmacist", never "use a
   smaller unit" (H-551). **Variable doses** (HZ-005): the day doses come from a dosing record (for
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
   the nurse in charge: Harbour never merges or drops a dose. `clockChangesIn` names the days in a
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
   whatever the note (`line_does_not_support`). Harbour never infers a stop because a source leaves
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
10. **Differences and duplicates by identity only** (HZ-121; `linkDifference`). Harbour never pairs
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
    sources have not been compared with the recorded allergies by the completer (Harbour matches no
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
    `paracetamol`, `bisphosphonate`, `psychotropic`. Harbour offers a tag only when the tenant's
    own list for it holds the product's exact VMP; never by ingredient or name. An entry also
    carries the minimum interval the prescription or PRN protocol states, and a when-required entry
    its maximum in 24 hours (the PRN status says when none is recorded). A when-required entry
    with neither a minimum interval nor a maximum is refused at transcription
    (`prn_limit_required`): the transcriber asks the prescriber (H-1066; #162 clinical review).
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
    (slice 48 sends it). Harbour never makes a missed dose due again.
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
    for the outcome; at a time later than now beyond the table's typed-time tolerance
    (`sync.clock_drift_flag_minutes`; `recorded_in_future`); and, on the round, a dose given
    earlier than that tolerance before it is recorded (`given_earlier_than_recorded`): a dose given
    now cannot be dated back past an interval, the maximum, its window, a competence lapse or an
    entry being held, and one given earlier is recorded by the route below, flagged and escalated
    (#162 third review's second re-check). Outcomes: given, refused, not given (asleep, away from the home, in hospital,
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
    escalated `urgent` with that amount (`no_prescribed_dose`), never only a warning. A dose
    recorded after it was given cannot stand in for one about to be given (#162 third clinical
    review): it needs a reason of 20 characters or more
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
    no limit of Harbour's own), the maximum given, the last dose not synced, a dose in another unit
    not counted. Harbour does not add up paracetamol across products
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
  or not; a dose dated in the future, or dated back on the round, refused),
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
  after 60 minutes, and a when-required entry transcribed with no maximum recorded (now only with
  a minimum interval, H-1066).
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
- **dm+d** (slice 10 not yet merged): `vmp_id` and `amp_id` are validated identifiers
  (`isDmdId` in the API, the SNOMED CT shape in the database) with no foreign key. A test in
  `packages/db/test/medicines-record.test.ts` fails once a VMP table exists until an expand step
  adds the foreign key. The dm+d facts (routes and units) come from `DmdFactsPort`. Production
  uses `unavailableDmd`, which knows no product, so nothing is transcribed until slice 10. The
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

### 13.8 Sync stream contract (slices 68 and 69)

The round reaches devices through a stream specified here as a contract only. It is not in
`sync-config.yaml` until slice 68, and a test fails if a medicines table appears there before the
stream's isolation tests exist.
- **Stream `location_medicines_round`**: for members holding `medicines.emar.administer` at a
  location, the live people there.
  - Their checked or not-yet-checked entry versions in force or starting within the cycle, with
    their schedule times.
  - Dosing records covering the next 7 UK days.
  - Administrations in the last 48 hours (for intervals, the 24-hour maximum and the last given).
  - The member's own competence reading.
- **Rules**: the same person scope as the care streams (replication bypasses RLS, so the stream
  query carries the scope itself); no stopped or withdrawn versions after their end; no documents.
- **Uploads**: decided with slices 68 and 69 (H-1164): a record made offline is recorded after the
  event, so it is checked at its drift-corrected time, idempotent by id, and a refusal comes back
  to the device as a conflict for the nurse in charge (slice 70). Today the API takes a request's
  own time only through the given-before-recorded route.

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

## 15. Controlled drugs register screens (slice 54, MEDS-005 and MEDS-014)

The person record's **Controlled drugs** tab and a page per drug, for the API's readers; recording
needs `medicines.cd.administer` (or `medicines.stock.manage` for a count) and signing as witness
needs `medicines.cd.witness`, each with a fresh step-up, as the API asks. Every page sits inside the
record frame, so the point-of-care header (name, photo, date of birth, NHS number, allergies) is
above the register.

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
