# Administrations: tables and API (Phase 2 slice 22)

Branch `feat/meds-administration-schema`, from `feat/meds-record-schema` (slice 16), with
`feat/meds-domain-administration` (slice 3's rules, #162) merged in. MEDS-002.

## What changed

- **Migration 0123**:
  - `medication_administration`: append-only, with the client's UUID as its id. It holds the
    due time, outcome, coded reason, amount, the prescribed dose checked against, the dosing
    record used, the reasons the rules asked for, the time given (drift-corrected) and the
    server's time, flags, any competence override, and `supersedes_id` for corrections. It has
    hooks for barcode evidence and the controlled drugs entry.
  - `medication_administration_witness`: one second signature per record, never the recorder.
  - `medication_dosing_record`: the doses for a variable dose. Its content is fixed and its second
    check is set once.
  - `medication`: tags, minimum interval and the when-required 24-hour maximum (slice 3's rule
    13), fixed on a version.
  - All tables have forced RLS with person scope and composite keys. There is one original record
    per scheduled dose and one correction per record, and a correction stays with its dose.
    Sample removal and the export catalogue include the new tables.
- **API** (`apps/api/src/routes/medicine-administrations.ts`):
  - Recording a dose runs `checkAdministration` under the person's lock. The facts come from
    the store and the competence port, never the request. It is idempotent by id.
  - A dose recorded after it was given (#162) needs a time before the server's, a reason and
    the recorder's current competence. It is always flagged and escalated.
  - Corrections go through `checkCorrection`, by the author or a record manager. The corrected
    record is shown struck through.
  - A witness signs with their own fresh step-up.
  - Dosing records can be recorded and second-checked.
  - Reads: the round (dose states and when-required status) and the records for a period.
- **Escalation**:
  - Review and over-maximum escalations become tasks for the nurse in charge, in words that name
    no medicine.
  - A worker job (`medicines-outstanding-doses`, every 5 minutes) raises one task per dose whose
    window ended with no outcome. Time-critical doses are urgent, and the task is closed when an
    outcome is recorded.
- **Ports**: the competence port also gives any override in force (`overrideFor`), read from
  workforce, never the request.
- **Sync**: the round stream is a contract only (medicines.md 13.8). A test keeps medicines tables
  off devices until slice 68.
- **Slice 16 fixes found here**:
  - Weekly schedules: the contract's full weekday names never matched the rules, so a weekly
    medicine had no doses. Also pushed to `feat/meds-record-schema` as a92aec5a.
  - The slice 16 API now carries rule 13's fields.
- **#162's latest head merged in** (the given-before-recorded route and corrections held to it in
  the domain): the API now passes the server's `recordedAt`, the recorder and the giver to the
  rules instead of checking the route itself.
- **Clinical-safety and security review fixes**:
  - `administered_by` records who gave a dose apart from who recorded it. A correction keeps the
    giver; the witness is never the recorder or the giver.
  - A request's own time is taken only for a dose recorded after it was given. A correction's
    time is never later than now.
  - Controlled drugs are refused until the register (slice 34).
  - A correction of a correction counts only what stands now.
  - Escalation tasks are named for their own reason.
  - The witness signs under the person's lock, only the latest record, with an audited step-up
    refusal.
  - The outstanding-dose job locks each person, looks back 3 days and skips people in hospital
    or on leave.
  - Record reads are capped at 31 days. The person is checked as visible before the lock.
  - Unique clashes on insert read the same whatever their cause. Resends compare the reasons and
    the time.
  - Weekdays have a CHECK.
- **Docs**:
  - medicines.md section 13;
  - the hazard log;
  - records of processing B1, data standards (administrations), retention;
  - the feature register, STATUS, and human actions H-1160 to H-1164.

## Human actions logged

- H-1160 (CSO): entries recorded before 0123 carry no rule 13 fields until a new version records them.
- H-1161 (CSO): who receives administration escalations until slice 48.
- H-1162 (CSO, security): when a non-controlled-drug dose needs a second signature.
- H-1163 (CSO): no barcode match until ADR-0081's slice.
- H-1164 (CSO): any limit on how late a dose may be recorded after it was given, and device uploads.
- H-1165 (CSO): outstanding-dose tasks only for people at the home; the 3-day look-back.
- H-1166 (CSO, security): a time limit on witnessing, and which outcomes need a witness.
- H-1167 (CSO): controlled drugs refused until slice 34; no weekly entries with full day names.
- H-1168 (CSO, security): the override contract slice 17's port must meet.

## Tests

- `packages/db/test/medicine-administrations.test.ts`:
  - isolation and person scope;
  - append-only records, and one record per dose and one correction per record;
  - corrections that stay with their dose, and the server's time;
  - the witness is not the recorder;
  - dosing records are fixed, and rule 13's fields are fixed.
- `apps/api/test/medicine-administrations.test.ts`:
  - a dose in its window, idempotent by id; a duplicate refused;
  - another person's medicine refused;
  - corrections by the author only, and once;
  - the witness with step-up;
  - competence and override from the port;
  - the 24-hour maximum, and a dose taken over it escalated urgently;
  - a dose recorded after it was given;
  - outstanding doses through the task engine;
  - a variable dose given only from a checked dosing record;
  - audit by id.
- `apps/api/test/medicines.test.ts`: weekly schedules and rule 13's fields.
- `packages/sync/test/medicines-stream-contract.test.ts`.
