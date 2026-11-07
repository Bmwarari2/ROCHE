# Medicines sync and the device dm+d subset (MOB-007, MEDS-002)

Branch `feat/mobile-meds-sync`, slice 68 (no PR yet), on `integration/phase-2-batch-3b`.

## What changed

- Migration 0147 publishes the MAR, schedule, dosing, covert, administration and competence tables
  for replication only.
- Streams in the two person scopes of `medicines.emar.administer`: live MAR entry versions (a stopped
  one included) with schedule times, dosing and covert records, with priority 1 like the allergy
  streams (HZ-002); administrations recorded today and the 34 days before; the member's own
  medicines competence. Isolation tests per person, location, member and tenant; the slice 22
  contract test is replaced by them.
- The sync token carries `meds_location_ids`, `meds_assigned`, `meds_recent_days` and
  `meds_recent_blocks`. Built on `feat/sync-bucket-per-home` (ADR-0134, migration 0146):
  administrations sync per home and per assigned person by ten-day block, from the row's own
  `sync_location_id`; the budget test and the API's estimate include the medicines streams.
- `GET /v1/medicines/device-subset` gives the dm+d rows the member's MARs need; the phone keeps
  them in local-only tables, replaced whole on connecting, when the MAR products change and at most hourly (ADR-0130).
- Docs: medicines.md section 13.8, ADR-0130, HZ-002 and HZ-113, data standards, records of
  processing, register, H-1421 to H-1427.

## What is next

- Slice 69: the round on the phone with barcode and person confirmation.
