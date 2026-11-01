# Recommended answers applied: care, safety, mobile and medicines (PEOP-009, CARE-010, CARE-013, SAFE-001, SAFE-008, OPS-028, COMMS-006, COMMS-007, MEDS-001, INSI-001, MOB-001)

Branch `fix/recommended-answers-care`. The owner decided on 31/10/2026 that every open human question
takes its recommended answer now (`docs/plans/recommended-answers.md` on
`docs/production-google-cloud`), all reviewed at the testing phase. This branch applies the answers
that change what is built for care, safety, mobile and medicines items whose code is on `main`.

## What changed

- **Hazard ratings** (H-543, H-595): HZ-124 Major/Medium/3 to Major/Low/3, then Very low/2 once rota
  eligibility gating lands; HZ-126 Catastrophic/Medium/4 to Catastrophic/Low/4 until H-599 is
  settled, then Very low/3, with the residual justified; HZ-128 Considerable/Medium/3 to
  Considerable/Low/2; HZ-123 and HZ-130 as proposed. HZ-124's controls, target and tests, which had
  been filed under HZ-126, are back in its own entry. Safety case v0.2 follows.
- **Transfer pack** (H-27): a missing About Me still prints "not recorded" on page 1 but no longer
  needs the named hand-over acknowledgement on its own (`acknowledge`, `missingToAcknowledge`).
- **Doses** (H-551): `checkDose` refuses a quantity below 1 in g, mg or micrograms where dm+d gives
  the next smaller unit for the product, asking for the prescriber or pharmacist; never converting.
- **Flagged entries** (H-148): a flagged-entry review is due at once when any entry completed a
  scheduled task.
- **Downtime packs** (H-213, H-214): the printed front sheet says once, among the safety-critical
  warnings, that the paper MAR and PEEP places are not confirmed; a CloudWatch alarm,
  `<prefix>-downtime-pack-failed`, tells Thapsus's on-call when a nightly pack fails, with its
  runbook step; the deployer controls are in operations.md and HZ-021. A first version stored the
  confirmation in the pack's content, which the database guard (migration 0051) refuses; it is read
  from the location when printing instead.
- **IDDSI levels** (H-166): food and drink are judged against the level in force when they were
  given, from the care profile's history; the entry says when the level has changed since.
- **Handover on the phone** (H-420): `handover.preview_lead_minutes` (60, rate table, to verify)
  reaches the phone on the sync token; the running shift's own handover comes first only within
  that lead before the shift ends.
- **Incident form** (H-262, H-264, H-482, H-481): an unwitnessed fall asks when the person was found
  (required) and sends `foundAt`, as does a missing person once found; "Not known yet" for the
  emergency services and the GP records null (migration 0118, expand only) with an urgent task; a
  death asks about a learning disability and autism, with a task when not known; the after-death
  section shows the CQC regulation 16 notification with its clock and a link.
- **Reconciliation** (H-267): the API returns each entry to review with its person (named only when
  the reader can see them), kind and time; the web lists them with links. HZ-092 rated as proposed.
- **Web handover, round and dashboard** (H-269, H-270, H-410): handover items show their own
  summaries; round tasks say who they are for and offer actions only to holders of the task's
  permission (`requiredPermission`, `assigneeRoleKey` on task items); the handover tile says
  "Overdue" after `handover.acknowledgement_grace_minutes` (`acknowledgementDueAt` on handover
  summaries); the notifications tile words a "without delay" kind as the incident page does.
- **Care mode** (H-381, H-125): `care.mobile_care_mode`, organisation-wide and off by default (on
  for the demo tenant), refuses the phone's Care mode sign-in (unless it holds unsent entries), its
  sync token and its uploads (403 `feature_disabled`, read as access withdrawn, entries held); the
  store build waits for `MOBILE_SAFETY_CASE_COVERS_APP`. Until the native passcode-binding module
  exists, a live organisation enrols only devices with strong biometrics.
- **Letters** (H-228): the letter PDF carries the provider's letterhead at the top right and the
  recipient's address placed for a DL or C5 left-hand window envelope.

## What is next

- H-125: the native module binding the database key to the device passcode.
- H-228: the print test on real DL and C5 window envelopes before letters go by post.
- H-268: back-entry on the incident and assessment APIs (a migration for their paper fields) and
  the paper record choice on their forms.
- H-306: the time-of-care permission check, after H-309.
- HZ-127's rating when slice 37 adds its entry.
- Set `MOBILE_SAFETY_CASE_COVERS_APP` and each organisation's `care.mobile_care_mode` only once a
  signed safety case covers the app.

## Human actions logged

- None new. H-27, H-148, H-166, H-213, H-214, H-262, H-264, H-267, H-269, H-270, H-381, H-410,
  H-420, H-481, H-482, H-543, H-551 and H-595 marked as applied for review at testing; H-125, H-228,
  H-268 and H-306 left open with notes.

## Tests

- Domain: `transfer-pack.test.ts`, `dose.test.ts` (coverage 99.67% lines).
- API: `device-holds.test.ts`, `downtime-pack-pdf.test.ts`, `pdf-letter.test.ts` (unit);
  `care`, `downtime`, `incidents`, `outages`, `rounds-and-handover`, `letters`, `api` suites.
- Web: `transfer-pack`, `charts`, `incident-forms`, `after-death`, `dashboard`, `handover-summary`,
  `round`, `downtime` unit tests; `incident-forms.spec.ts` (Playwright) updated for the found time.
- Mobile: `handover-view`, `handover-shifts`, `care-mode-gate`, `auth-client`, `db-key`.
- Database: the whole `packages/db` suite with migration 0118.
- Infrastructure: `plan.tftest.hcl` gains the downtime pack alarm (not run here: no Terraform).

## Review rounds
