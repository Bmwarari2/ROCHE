# Medication errors, reviews and reports (Phase 2 slice 45; paused, part done)

Branch `feat/meds-errors-reviews`, cut from `feat/meds-administration-schema` (slice 22). Migration
0135. MEDS-012, MEDS-013 (and MEDS-003's PRN and psychotropic report, since slice 28 is not built).
Human actions H-1290 to H-1299 (not yet written). Hazard HZ-131 (not yet written).

## Done

- Spec: [medicines.md](../specs/medicines.md) section 14; safety.md rule 7 note; rates.md
  `medicines.review_due_soon_days` (to verify).
- Domain: error kinds extended to the NRLS categories with their source, stages, record checks,
  controlled drug presumption, prompts (`medicationErrorPrompts`), the trend; reviews
  (`reviewStatus`, `checkReviewDone`) and `usageCounts`; table-driven tests.
- Database: `medication_error` and `medication_review` with forced RLS, guards, history, no delete,
  sample removal list kept whole; test `packages/db/test/medication-errors.test.ts`.
- API: `apps/api/src/routes/medication-errors.ts` (error GET, POST, PATCH; reviews; tracker;
  override, PRN and trend reports); test `apps/api/test/medication-errors.test.ts`; OpenAPI and
  client regenerated; export catalogue, retention, records of processing, data standards, feature
  register.

## Left to do (from the clinical-safety and security reviews, 01/11/2026)

Security:
- H1: PATCH's creator-or-manager check uses `can()` (any home, no MFA): use `managesIncident` /
  `mayChange` from safety-shared.ts and `requireMfaForPeople`; tests for a manager at another home
  and a session without MFA.
- M1: POST must require `mayChange` on the incident; PATCH should allow the raiser too.
- M2: use `readIncident` in GET, POST, PATCH: refuse restricted (403, hide free text on GET),
  closed (no writes) and deleted incidents; add `i.deleted_at IS NULL` to the guard in a forward
  migration or before 0135 is merged.
- M3: MFA on POST and PATCH (care-record content).
- L1: reports attribute by the person's current home; bound by placement history or document.
- L2: cap the report period (rate-table key). L3: hidden-error existence leaks via the 409.
- L4: strict objects; dates (clinician told before the incident, CD report in the future, review
  due bounds); medicine and dose record of one entry; map remaining check violations to 422.
- L5: reviews must respect the person's lifecycle (`requireWrite`).

Clinical safety:
- B1 (high): next review due must be the earlier of the scheduled date and last done plus the
  interval; fix the test that locks in the wrong answer.
- B2: a separate status when the date comes from the interval ("next review due, not yet booked").
- B3: reschedule and cancel a review not yet done, with a reason.
- B4: map `medication_review_done_needs_reason` to 422 (or drop the must-differ rule).
- B5 (CSO): an explicit "no" against a CD-scheduled medicine (H-594). B6: presume a controlled drug
  from the dose record's entry; refuse a medicine and dose record of different entries.
- B7, B8 (CSO, H-549): safeguarding for omitted doses and near misses that risked harm.
- B9 to B12: prompt wording (harm not yet graded; CQC reminder without a closed list; 999 line in
  clinical advice; "if a controlled drug was or may have been involved").
- B13: clear clinical advice once who, when and advice are recorded; safeguarding once the
  incident's safeguarding question is answered.
- B14: CD report date in the future; separate words for the reference length.
- B15, B16: PRN report: superseded records across the period boundary; class each dose by its own
  version. B17: override report counts `competence_override` against `administeredBy`, decide on
  superseded records, add `competence_not_current`; update HZ-119.
- B18: trend: count "not yet known" apart and fill empty months. B19: current-home attribution.
- B20: no changes to error details on a closed incident without manage and a reason.
- B21: copy the incident's retention class instead of always `serious_incident`.
- Tests: DST and UK-midnight cases; fixed clock in the API tests (they fail just after UK midnight
  or on the 1st of the month).

Docs still to write: HZ-131 in the hazard log (and HZ-119 update), medical-device-boundary.md
paragraph, H-1290 to H-1299, STATUS.md; then the full test run, push, and report to the lead.
