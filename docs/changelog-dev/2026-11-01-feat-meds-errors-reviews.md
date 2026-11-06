# Medication errors, reviews and reports (Phase 2 slice 45)

Branch `feat/meds-errors-reviews`, cut from `feat/meds-administration-schema` (slice 22). Migration
0135. MEDS-012, MEDS-013 (and MEDS-003's PRN and psychotropic report, since slice 28 is not built).
Human actions H-1290 to H-1299 (recommended answers applied). Hazard HZ-131; HZ-119 updated.

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

## Review fixes (06/11/2026)

The clinical-safety and security reviews of 01/11/2026 are addressed:

- Access as the incident (H1, M1, M2, M3, B20): `readIncident` and `mayChange`, MFA, restricted
  incidents refused whole, closed incidents fixed, deleted ones not found (the guard and the trend
  check `deleted_at` too).
- Record checks (L4, B5, B6, B14, B21): strict request bodies; impossible dates; the medicine and dose record of one
  entry; a "no" refused against a CD-scheduled medicine; an omitted dose never a near miss; check
  violations returned as 422; retention copied from the incident.
- Prompts (B7, B9 to B13): wording (999, "was or may have been", harm not yet graded, CQC examples), clinical advice
  and safeguarding clearing once their evidence is recorded (safeguarding only on a latest answer
  of yes or no); an omitted dose always prompts safeguarding, whatever the harm (B7; B8 is H-1292).
- Reviews (B1 to B4, L5): next due the earlier of booked and interval, a "not yet booked" status, reschedule and
  cancel with a reason, lifecycle checks, the done-needs-reason refusal as 422.
- Reports (L2, B15 to B18; L1 and B19 are H-1298): latest version only, each dose by its own version, overrides against the giver with
  not-current competence, every month with "not yet known", a period cap
  (`medicines.report_max_days`); current-home attribution documented (H-1298).
- Tests on fixed dates. Docs: spec section 14, HZ-131, HZ-119, the medical-device boundary note,
  H-1290 to H-1299, STATUS.md.
