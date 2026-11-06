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

## Security re-review fixes (resumed 06/11/2026)

- M1: only a bearer request on a device the session was already bound to counts as an upload
  (`access.deviceBound`).
- M2: `both_given` only when both records say the dose was taken; `first_stands` refused when the
  upload says taken and the record that stands does not.
- M3: a controlled drug's conflict needs `medicines.cd.administer` and a fresh step-up;
  `both_given` on one raises an urgent register-entry task and the incident says so.
- M4: a further upload of the same dose by the same person is its own row joining the first
  (`joins_id`, 0134 edited before landing), found on resend, audited and resolved with it.
- Lows: the recorder or uploader does not decide; the double-dose handler fails on a bad payload;
  views audit the person and conflict ids; open conflicts first; the named correction must be in
  force; the reviewer sees every field sent; the incident's time is the device's time given.
- Not done: a test of a successful `corrected` and of rates per nation.

## Clinical-safety re-review fixes (06/11/2026)

- H1: a dose still due from before the slot stays on the round (only recorded or not-yet-due
  earlier doses are left off).
- H2: round doses carry `dayName` and `clockChange`.
- H3: a dose with an open conflict says it is waiting for review (`reviewPending`).
- M1: urgent when one record says taken and the other not; M2: a later disagreeing upload makes
  the task urgent; M3: a routine conflict is due within 8 hours, not at once.
- M4: an uploader may choose `corrected` only for their own record; the single-nurse rule is in
  H-1270. M6: the reach is the same UK clock time the day before (`addUkDays`).
- Lows: checks read the standing record's current outcome; the device message no longer promises a
  MAR entry; the list says when it is truncated.
- Not done: tests for the controlled drug conflict, a cookie session with the header, a malformed
  double-dose payload, a future `givenAt` and the clock-change slot (H-1277); the `clinical_lead`
  assignee's vacancy routing at homes without nurses is the task engine's (HZ-040).

## Recommended answers (for recommended-answers.md, branch feat/meds-rounds)

| # | Owner | Recommended answer | Build change |
| --- | --- | --- | --- |
| H-1270 | CSO | Accept as built: `both_given` raises a medication incident; the second dose stays on the conflict and the incident, not the MAR history, and when-required totals do not count it. For a lone night nurse, let them resolve and raise a routine retrospective review for the Registered Manager. | Built: a single-resolver path with a retrospective review task |
| H-1271 | CSO | Accept as built: urgent and due at once when time-critical or one record says taken and the other not; routine and due within 8 hours otherwise; one task per dose and uploader. | No |
| H-1272 | CSO | Keep refusing other device refusals back to the device, where the person sees them; revisit with the slice 53 screens. | No |
| H-1273 | CSO | Keep the rate table's `medicines.record_delay_tolerance_minutes` value as seeded. | No |
| H-1274 | CSO | Accept no identity screen until slice 53; the API carries person ids and rooms only. | No |
| H-1275 | CSO | Re-rate HZ-003, HZ-004 and HZ-008 at the testing phase with the slice 53 screens; keep the current targets. | No |
| H-1276 | CSO | Accept as built: people away are left off the location round; slice 53 says they are away. | No |
| H-1277 | Engineering, CSO | Accept the reach of one UK day back, tested for both 2026 clock changes. | Built: `medicine-rounds-clock.test.ts` |
| H-1278 | Engineering | Accept: 0134 restores the list; check at the testing phase that no sample-data removal ran between 0111 and 0134 anywhere. | No |
| H-1279 | CSO | Accept as built: two when-required doses from two devices are both kept, and the server's 24-hour maximum check is the control. | No |

## Lead follow-up (06/11/2026)

- H-1270's recommended single-nurse path built: a self-review is allowed, audited and raises a
  routine `medicines.administration.conflict_retrospective` task for the Registered Manager;
  controlled drugs still need two people.
- Tests added: a successful `corrected`, rates per nation, the controlled drug conflict (two
  people and the register task), a web session sending a device id, a malformed double-dose event,
  a future time given, and the clock-change slot (H-1277).
- Noted, not changed: a location in a nation with no medicines rates seeded, or a regular entry
  with no times, fails the whole location round with a 500 rather than one person's part of it.
