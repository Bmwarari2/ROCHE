# The medicines round on the phone (Phase 2 slice 69)

Branch `feat/mobile-meds-round`, from slice 68 (`daa7df8e`). No migration: the administration's
`scan_evidence` hook column holds the new checks. ADR-0081 written (its planned number).

## What changed

- `medicineRound` moves into `packages/domain` (`medicines/round.ts`) so the API and the phone
  compute the round the same way; the API's `roundFor` wraps it. On the phone it says when a
  when-required medicine's interval reaches before the records it holds (HZ-004).
- Barcodes and identification (`medicines/barcodes.ts`): GS1 DataMatrix and linear GTIN parsing,
  the pack match to the MAR entry's dm+d product, the HZ-001 identity and pack rule.
- API: `RecordAdministration` takes `pointOfCare` (required on a phone's upload) and
  `deviceRecordedAt` (a phone's records are judged at the time it recorded them, bounded by the
  UUIDv7 id); a scanned pack is matched through dm+d; the checks are kept as `scan_evidence`.
- Sync: the medication stream sends `origin` and the day notices the round reads; the phone's
  `medication_administration` has a local `request` column for the queued upload.
- Phone: a Medicines tab (holders of `medicines.emar.administer`) with the round by slot and each
  person's doses, allergies beside every medicine, the record panel (outcome and reason, photo
  confirmation beside the photo, pack scan with expo-camera, override reasons), upload by client id,
  local reminders for time-critical doses, the medicines figures cached from the rate table, and
  eMAR off on a device the `jail-monkey` checks do not trust. Android `CAMERA` unblocked for
  barcodes only.
- Shared `Button` gains `selection` (radio or checkbox state, with a check icon).

## Reviews

Clinical safety, security and accessibility reviews ran; their blockers and high findings are fixed
(offline records judged at the phone's time, server-side checks and pack match, interval and unknown
last dose refused on the phone, no override after a wrong or expired pack, accessibility state and
announcements). Decisions for the CSO and DPO are H-1432 to H-1438.

## Not done here

- The Maestro flow `hazard-HZ-003-offline-round.yaml` is written and has not been run.
- Wristband tokens (H-1433), attestation (H-1432), the staleness limit (H-1435), the device clock
  offset (H-1436), Welsh strings (H-1438). Controlled drugs and conflict review are slice 70.
