# Rounds, escalation and conflict review (Phase 2 slice 48)

Branch `feat/meds-rounds`, from `feat/meds-cd-register` (slice 34), with #162's final head
(559440bb) merged in. MEDS-002.

## What changed

- **#162 merged in**: the administrations API supplies `competenceAtRecording` and the
  `medicines.record_delay_tolerance_minutes` rate. A round record may carry a time given within the
  tolerance; a time in the future beyond the clock drift allowance is refused.
- **Migration 0134**:
  - `medication_administration_conflict`: a device's second record of a dose, kept as sent with
    what the server found wrong, the record that stands, the device's time and who sent it.
    Append-only apart from a resolution set once; one open conflict per dose and uploader.
  - Forced RLS and person scope, no DELETE for the application, the export catalogue and the
    `mar_chart` retention class.
  - The administration flag check gains `differs_when_recorded`.
  - `app.sample_removal_tables()` lists 0099's tables again (0111, 0123 and 0128 had dropped
    them; H-1278).
- **API** (`apps/api/src/routes/medicine-rounds.ts`):
  - `GET /v1/locations/{id}/medicine-round`: each person's doses in a slot of up to 12 hours,
    late first, with any earlier dose still late, time-critical first, and when-required
    medicines with when last given. Rates per person's nation.
  - A bound device's second record of a dose gets `202 Accepted` with a conflict and a review task
    (urgent when time-critical or the outcomes differ). A resend finds it; the same id for another
    dose is refused.
  - Conflict list (by location or person), detail and resolve (`first_stands`, `corrected` naming a
    correction of the standing record made after the upload, or `both_given`). `both_given`
    publishes `medicines.administration.double_dose`, and safety raises a medication incident.
  - Outstanding doses: the existing worker job's tasks reach the shift handover.
- **Docs**: medicines.md section 15, hazard log (HZ-001 to HZ-004, HZ-006, HZ-008 to HZ-010),
  records of processing, data standards, retention, medical-device boundary, human actions H-1270
  to H-1279.

## Checks

- Typecheck and Biome clean; OpenAPI and the client regenerated.
- Database, API and domain suites: see the report to the lead session.
