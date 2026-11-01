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

## Left to do (paused 01/11/2026)

Database, API and domain suites passed at f2a9f3df (1090, 1858 and 6672 tests). The security
re-review of the fixes found these, still open:
- M1: the device header alone counts as a bound device (a session binds on first use). Count an
  upload only for a bearer request on a binding that existed before the request; test that a
  cookie session with the header still gets 422.
- M2: `first_stands` and `both_given` ignore the outcomes. Allow `both_given` only when both are
  given; refuse `first_stands` when the upload is given and the standing record is not.
- M3: `both_given` on a controlled drug leaves the register short. Raise a register task or refuse
  until an entry exists; resolving a controlled drug conflict needs `medicines.cd.administer` and
  step-up.
- M4: an upload that joins an open conflict keeps no client id or payload, so a retry after review
  opens a new conflict. Store joined uploads (child table) and audit `conflict_joined`.
- Lows: self-review refused; the double-dose handler throws on a bad payload and the publisher
  refuses a missing location; audit person ids on views; open conflicts first in the list; the named
  correction must still be in force; show the whole upload; the incident's time and place; more
  tests (successful `corrected`, outcome mismatch 409, refusal audit row, rates per nation).
The clinical-safety re-review stopped on a rate limit and must be run again.
