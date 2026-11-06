# Medicines in the Phase 1 outputs (Phase 2 slice 49)

Branch `feat/meds-phase1-outputs`, from `feat/meds-rounds` (slice 48). MEDS-001, MEDS-002. No
migration.

## What changed

- **Downtime pack (HZ-021, H-102)**: doses due over the next 48 hours come from the eMAR, any dose
  still open listed first as outstanding, with when-required medicines and when last given. A
  medicines change or administration makes the pack stale. People with no eMAR entries keep the
  paper MAR pointer.
- **Transfer pack (HZ-023, H-82)**: medicines in force come from the eMAR with when each was last
  taken and the entry's status; the pre-admission list remains the fallback.
- **Both packs** say when the list was read and that it is not the live record
  (`emarSnapshotNotice`).
- **Handover and care plans (HZ-003, H-151)**: outstanding doses and medicines out of stock reach the
  handover as tasks (test added); the medicines action notice now reads "Not a round: medicines
  rounds are on the eMAR".
- Docs: medicines.md section 16, hazard log (HZ-003, HZ-021, HZ-023), data standards.

## Left

- A refused dose on the handover needs a new `handover_item` source (a migration).
- H-82, H-102 and H-151 stay open for the CSO; the eMAR now answers their medicines part.
