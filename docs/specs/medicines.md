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
| Record administrations, PRN, CD entries, stock, overrides | `medicines.emar.administer`, `medicines.cd.administer` (step-up), `medicines.cd.witness`, `medicines.stock.manage`, `medicines.override.approve` | Slice 3 rules | The person or location |

Medicines competence (`current`, `expired`, `not_held`) is an input to `recordSecondCheck` and
`completeReconciliation`. Slice 16 must read it on the server from workforce's competence port
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
   smaller unit" (H-551). **Variable doses (open control, HZ-005):** a variable dose has no link to
   its dosing record yet. Slice 3 adds the dosing record (the day doses, for example a warfarin
   schedule after an INR test, with its source) as a record of its own that is second-checked like
   an entry before any dose is given from it, and slice 16 stores it; until then `marEntryStatus`
   gives `mayGive: false` for a variable-dose entry, checked or not, under either policy, and its
   notice says what to do instead: "Ask the prescriber for today's dose and record it as a new MAR
   entry, stopping this one first" (a test shows that can be done the same day). Slice 2 is not
   released to a tenant without slice 3's dosing record (H-550).
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
   is never givable in slice 2 (rule 2).

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
  checkable and correctable; variable doses not givable, and the notice's instruction followed),
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
- The decisions and defaults for later slices are in [phase-2.md](../plans/phase-2.md) (ADR-0080 to
  ADR-0085) and the human actions H-510 to H-517 in [human-actions.md](../plans/human-actions.md).

## 11. As built (slice 2, domain rules)

`packages/domain/src/medicines/`, exported from `@harbour/domain`; pure functions with no I/O. No
schema, API, web or mobile changes in this slice.

| Module | Main exports | For |
| --- | --- | --- |
| `dmd.ts` | `DmdProductRef`, `DmdRoute`, `isDmdId`, `isDmdProduct`, `dmdProductDifference` | Rule 1 |
| `dose.ts` | `Dose`, `DoseUnit`, `parseDoseQuantity`, `isDoseQuantity`, `formatDoseQuantity`, `doseUnitName`, `formatDose`, `checkDose` | Rule 2 |
| `schedule.ts` | `SchedulePattern`, `RegularSchedule`, `checkSchedule`, `expandSchedule`, `MarDose`, `marCycle`, `marCycleContaining`, `clockChangesIn`, `describeSchedule`, `keepsCountFrom`, `ukDateOf`, `WEEKDAY_NAMES` | Rules 3 to 5 and 6a |
| `mar-entry.ts` | `MarEntryDraft`, `MarEntry`, `checkMarEntryDraft`, `transcribeMarEntry`, `recordSecondCheck`, `changeMarEntry` and `stopMarEntry` (on every version), `versionInForceAt`, `lastDueDose`, `marEntryEnd`, `marEntryDosesFrom`, `marEntryDoses`, `marEntryTimesBeforeRecorded`, `marEntryStatus`, `MAR_ENTRY_NOTICES`, `MAR_SOURCE_KINDS` | Rules 6, 6a to 6c |
| `reconciliation.ts` | `completeReconciliation`, `entriesToReconcile`, `linkDifference`, `outstandingReconciliations`, `RECONCILIATION_TRIGGER_WORDS`, `LINE_SAYS_WORDS` | Rules 7 to 12 |
| `rates.ts` | `MEDICINES_RATE_KEYS`, `resolveMedicinesRates` | `medicines.ordering_cycle_days` |

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
  (28), with the `MEDICINES_FIXTURES` cases in `apps/api/test/config.test.ts`.

## 13. Web screens (slice 52, MEDS-001 and MEDS-006)

The person record's **Medicines** tab, for holders of `medicines.record.manage`,
`medicines.emar.administer` or `care.plan.read` (the API's read rule); writing needs
`medicines.record.manage`. Every page sits inside the record frame, so the point-of-care header
(name, photo, date of birth, NHS number and allergies) is above every medicine, and the allergy chip
is repeated beside each form that records a medicine. Harbour never matches a medicine to an
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
   required; the stop, review date, indication and special instructions are optional. The API's
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
   discharge letter where the API asks). Harbour never decides: a line that says "stop" does not
   stop anything until a person decides it. A refused completion shows every problem in the API's
   words (listing them by entry and line needs an API change: H-1283). Continuing or changing a
   medicine with a version that starts later asks why that version still stands.
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
