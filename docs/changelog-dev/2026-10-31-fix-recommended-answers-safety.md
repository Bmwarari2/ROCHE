# Recommended answers applied: safety (integration batch 2)

Branch `fix/recommended-answers-safety`, migration 0122. Every change is a recommended answer the
owner asked to apply now, reviewed at the testing phase (`docs/plans/recommended-answers.md`).

## What changed

- H-721: speak-up concerns have their own retention class, 6 years after closing; existing rows
  move to it. The Freedom to Speak Up lead alone exports the silo (`GET /v1/speak-up/export`), with
  a fresh step-up and audited; anonymous concerns carry nothing about the reporter, and the full
  export's manifest names the route.
- H-771: a missing person episode opened with immediate risk tells every clinical lead and team
  leader on site at once, through the notification centre (HZ-127).
- H-773: a person with an active risk assessment for leaving without staff knowing, and no
  Herbert Protocol profile, gets a prompt for the nurse in charge, again when the assessment
  changes, settled when a profile is saved (HZ-127). Dementia waits for diagnoses in the record.
- H-821: each disclosure type's legal basis names its Article 6 basis and Article 9 condition;
  only new requests copy it.
- H-827: the Access to Health Records Act clock counts from the latest record of any kind, and
  uses the shorter period when none is found.
- H-767 and H-782: unnamed staff cases on outbreak line lists (agency or bank workers not in
  Harbour), counted once each in the report's staff figures; staff rows kept 3 years from the
  outbreak's closure; the line list added to DPIA section 7B.
- H-860: the anonymous speak-up page names the Care Quality Commission and Protect.

## What is next

- The outbreak and disclosure web screens (on `feat/web-safety-events`) offer unnamed staff cases
  once both branches meet on main.

## Clinical safety review, round 1

- The immediate-risk alert is sent from the open handler itself, falls back to the Registered
  Manager and then anyone who manages incidents there, and is audited as unrouted when nobody can
  be told.
- A person who goes missing again while the last episode is found but not yet debriefed gets a
  new episode (migration 0122 narrows the one-open index to episodes still searching).
- The Herbert prompt is raised once per assessment date, is due after
  `herbert_protocol.prepare_due_days` (new rate row), skips deleted tasks and is closed when no
  longer needed.
- The Access to Health Records Act clock counts many more record classes, and changes as well as
  additions.
- New tests; HZ-013 and HZ-127 rows reworded; CSO decisions added to H-771, H-773, H-782 and H-827.
