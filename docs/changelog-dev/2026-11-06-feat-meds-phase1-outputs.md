# Medicines in the Phase 1 outputs (Phase 2 slice 49)

Branch `feat/meds-phase1-outputs`, from `feat/meds-rounds` (slice 48). MEDS-001, MEDS-002.
Migration 0144.

## What changed

- **Downtime pack (HZ-021, H-102)**: doses due while the pack is valid (`downtime_pack.valid_hours`)
  come from the eMAR. Any dose still open is listed first ("No outcome recorded when the list was made"), a held
  entry's doses print as on hold, each with the entry's notice, and when-required medicines show when
  last given. An empty list says so. A person whose eMAR cannot be read gets an `unreadable` section
  and a `medicines_unreadable` warning; the person ids are logged and audited, the nightly build
  raises the job alarm, and the pack is rebuilt on the next read. A medicines change, dosing record
  or administration makes the pack stale. People with no eMAR entries keep the paper MAR pointer.
  The medicines rates are read once per pack.
- **Transfer pack (HZ-023, H-82)**: the medicines in force come from the eMAR, with when each was last
  given and the home's record of the entry ("On hold on the home's eMAR: …"). If the eMAR cannot be
  read, the pre-admission list is used and the first page says so (`medicines_emar_unreadable`,
  logged and audited). A malformed schedule counts as unreadable.
- **Both packs** say when the list was read and that it is not the live record
  (`emarSnapshotNotice`).
- **Handover and care plans (HZ-003, H-151)**: outstanding doses and failed dose checks reach the
  handover as tasks (test added); the medicines action notice now reads "Not a round: medicines
  rounds are on the eMAR" in the code, specs, hazard log and the care worker guide.
- Docs: medicines.md section 16, the hazard log (HZ-003, HZ-021, HZ-023), data standards, records of
  processing, the medical-device boundary.

- **Round 3 (lead's leftovers)**:
  - **Migration 0144**: `handover_item.source_type` gains `medication_administration`. A refused
    dose reaches the shift handover as a refusal ("Refused: a medicine"), including one recorded
    late. `app.downtime_pack_people()` accepts the pack's `buildSnapshot`.
  - The downtime pack is stale when any source row was written by a transaction its build snapshot
    could not see, so the printed "as at" never covers data it lacks.
  - Administration history is read for `MEDICINES_OUTPUT_HISTORY_DAYS` (default 35) plus the latest
    given record of each medicine before it.
  - Held when-required medicines print as on hold.
  - Tests: location scope (another home never appears), and the transfer record route's audit.

## Left

- TODO for the batch: a medicine recorded as not available should raise the stock task through
  slice 42's hook (`feat/meds-stock`), which this base does not have.
- Add `MEDICINES_OUTPUT_HISTORY_DAYS` (optional, default 35) to `.env.example` if the batch keeps one
  for the API.
- The CSO items stay on their recommended answers: H-82, H-102, H-151, the variable-dose wording, and
  "not started yet" entries.
