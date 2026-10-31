# Safety Phase 2 rules (Phase 2 slice 7)

Branch `feat/safety-domain-phase-2`. Register rows SAFE-006, SAFE-011, SAFE-012, SAFE-014,
SAFE-015, SAFE-016 and MEDS-012 (domain rules only; no database, API or screens; no migration).

## What changed

- Spec: [safety.md](../specs/safety.md) "Phase 2 rules" (seven rules, the permissions used, the
  rate keys and the test list).
- Domain: new files under `packages/domain/src/safety/` (the Phase 1 files are untouched):
  the safeguarding log (`concern` to `referred`, `enquiry`, `outcome` and `closed`, or `no_referral`
  with a reason; closing needs the Making Safeguarding Personal record and, where a member of staff
  was removed for harm, the DBS referral decision); complaints (working-day targets paused while
  waiting for the complainant, appeals, a final response that must signpost the Ombudsman with its
  time limit); speaking up (named, confidential or anonymous with no identity kept; the outcome shared
  before closing where a reply is possible); deaths (the steps each death needs, from the clinician's
  recorded judgement of expected or unexpected; the mortality review date); missing person (the
  timeline in order, the police call target, the Herbert Protocol profile's age, closing only after a
  welfare check and a debrief); disclosure requests (a legal basis per type, approval by someone other
  than the requester, the Access to Health Records Act answer times); medication errors (questions
  and the tasks they raise).
- Rate table: eleven rows, tenant targets where no law sets one and the Ombudsman and Access to
  Health Records figures, all marked to verify.
- Human actions H-590 to H-594 (lane D); the register rows' paths.

## Clinical safety and data protection

- The plan assigns no hazard to slice 7; HZ-126 (safeguarding) and HZ-127 (missing person) come with
  slices 13 and 37, which store these records. Medical-device boundary: the rules record the
  clinician's judgements and list steps; nothing diagnoses, scores or recommends treatment (the
  medication error task asks for clinical advice, it gives none).
- No personal data stored or processed by this slice (pure functions).

## What is open

- The medication error questions join the incident classifier only with a migration: the database
  checks `classifier_answer.question_key` against a fixed list. The module is ready for that slice.

## Human actions logged

- H-590 to H-594.

## Tests

- `packages/domain/src/safety/{safeguarding,complaints,whistleblowing,deaths,missing-person,disclosure,medication-error,phase2-rates}.test.ts`
  (table-driven; 98.5% lines and 95.2% branches of the new files), including UK dates across both
  clock changes and working days across Christmas bank holidays.
