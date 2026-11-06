# Medicines in the Phase 1 outputs (Phase 2 slice 49)

Branch `feat/meds-phase1-outputs`, from `feat/meds-rounds` (slice 48). MEDS-001, MEDS-002. No
migration.

## What changed

- **Downtime pack (HZ-021, H-102)**: doses due while the pack is valid (`downtime_pack.valid_hours`)
  come from the eMAR. Any dose still open is listed first ("Not given when the list was made"), a held
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

## Left

- Not yet on the handover: refused doses (need a new `handover_item` source, a migration), and
  medicines not available (no task is raised for them yet).
- Residual risk for the CSO: a printed or cached copy of the downtime pack still lists a dose given
  after it was made as not given.
- H-82, H-102 and H-151 stay open for the CSO; the eMAR now answers their medicines part.
- The administration history is read in full per person; bounding it is a follow-up.
