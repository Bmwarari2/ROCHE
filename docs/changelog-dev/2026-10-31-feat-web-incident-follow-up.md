# Slice 9 part 5, incident follow-up on the web: duty of candour, after a death, investigations and trends (SAFE-007, SAFE-008, SAFE-010)

Branch `feat/web-incident-follow-up`, PR #120.

## What changed

- Web, incident page (for a reader who sees it whole), after the statutory notifications:
  - **After a death** (SAFE-008): for each person we support who died, with their communication
    needs, the medical examiner pack's notification with its clock and status, and the pack's
    seven sections with what each holds and where it is kept in their record (or that it is not on
    the web yet); the LeDeR prompt, linking LeDeR's own form from the domain's sources: report it
    when drafted, or check whether it applies when the incident does not record learning
    disability or autism. The medical examiner and LeDeR notification pages show the pack and the
    link too.
  - **Duty of candour** (SAFE-007): the stage as an icon and words; the clocks in words (telling the
    person as soon as reasonably practicable from when the clock started; the written notification
    against the organisation's target, its working days read from the rate table, always said to
    be a target, not a legal deadline); the record; and for a manager on an open incident the forms
    for its stage (threshold decision, telling the person in person, attempts to contact them, the
    written notification, results and correspondence, documents chosen from the person's PDFs) and
    each next step, offered only when the domain's `candourStepProblems` finds nothing missing,
    otherwise what is missing, listed. "Review and close" lists an open candour record first.
  - **Investigation** (SAFE-010): status, lead, method, findings, factors, lessons, the bulletin mark
    and each action with its status, owner, date and task; a manager records it, one action at a
    time, and completes it once the findings and lessons are there.
- Web: `/incidents/trends`, linked from the incidents list: incidents by type in each of the last
  six UK months, with totals, said as counts only (no interpretation).
- API (`PUT /v1/incidents/{id}/investigation`): an action becomes its owner's task only when the
  owner may be given it (`mayBeGiven` with `safety.incident.manage` at the location), as the task
  engine requires; otherwise refused in words. OpenAPI and the typed client regenerated.
- Refusals: the API's candour and investigation refusals in the catalogue's words. Strings in
  en-GB; Welsh copied and listed as untranslated.
- Docs: safety.md section 5 (part 5, with its gaps) and section 9; hazard log HZ-013 and HZ-091
  (controls and verification). No personal data is stored that was not before, so the records of
  processing and data standards are unchanged.

## What is next

- Logged in safety.md section 5: the API does not assemble the medical examiner pack; duty of
  candour letters wait for the letters API to read the candour record; no web upload for the
  candour documents (PLAT-009); finishing the candour record does not record the candour
  notification as submitted; no candour forms on a closed incident; bulletins are a date only (no
  distribution, read receipts or list across incidents); trends by type only, from what the reader
  can list, at most 500 a month.

## Human actions logged

- H-480: the CSO reviews the candour record's wording and steps, and decides whether a candour
  decision after an incident has closed needs a route and whether finishing the record should
  record the candour notification as submitted.
- H-481: the CSO confirms the after-death section (the pack listed, not assembled; the LeDeR check
  while the incident form does not ask about learning disability or autism).

## Tests

- Unit: `candour.test.ts` (45), `investigation.test.ts`, `after-death.test.ts`,
  `incident-trends.test.ts`, and additions to `incident-review.test.ts` and `refusals.test.ts`;
  web suite 998 passing.
- API: `incidents.test.ts` (42, one new).
- Journeys: `candour.spec.ts` (2), `investigation.spec.ts` (3, the trend view also at 320 px),
  `after-death.spec.ts` (2), axe in light and dark on every state; the existing incident journeys
  still pass. `incidents.spec.ts`'s reflow journey now skips the new trends link when it opens the
  first incident on the list.

## Review rounds

- Round 1 (clinical safety), fail safe: closing waits for the duty of candour where Harbour found
  it may apply or the decision says notifiable, and with two or more people harmed names everyone
  still to be told (one candour record covers one person until one per person is built; domain
  `candourCloseBlock` in `incidentCloseProblems`, API and web); a failed candour or investigation
  read is said, offers no form and keeps closing blocked; the threshold question in regulation
  20(9)'s words with its period from the rate table, Harbour's finding beside it, and a decision
  that differs (or changes) confirmed with a reason of at least 20 characters that moves the record
  on; the relevant person's hint limited to 20(7)'s cases; "told in person" only in person; "by the
  end of" a date for a midnight target; the candour notification recorded with the letter's copy,
  no regulator's reference; the LeDeR prompt follows its notification's status and stays on a
  closed incident; API refusals of future candour times, a decision before the incident and
  another person's document, and a new task for a reopened action; trends say "500 or more"
  throughout and tell a reader with a narrow scope what is left out. Hazard log: HZ-013 causes,
  controls and tests; HZ-091 description, causes, effects, controls and tests; the trend rows moved
  to HZ-073. Human actions H-480 and H-481 reframed for the CSO (evidence model, one record per
  person, separation of duties, dated actions, the pack's clock, communication needs) and H-482 for
  the learning disability and autism question. Journeys: two candour journeys added (a decision
  differing from Harbour's finding; two people harmed), the candour notification recorded without a
  reference, and the LeDeR prompt after "not required".
- Round 2 (clinical re-check), fail safe: one candour record covers only the person it names,
  whatever it decides, so "not notifiable" for one person never clears another, with one person
  affected as with several; the relevant person must be one of the people affected (API, step and
  picker), and a finished record's person cannot change; the API, not only the web, asks a tick and
  a reason of at least 20 characters for a decision that differs from Harbour's finding or changes
  a recorded one, and for "not notifiable" after a drafted candour notification, and audits the
  reason; once a decision is recorded, dropping someone affected from the incident or the candour
  check needs a reason, audited with the person's opaque id; an incident the duty of candour holds
  open longer than `candour.close_blocked_days` (rate table, Harbour default 14, to verify) gives
  the Registered Manager an urgent task that escalates; told, sent and attempt times before the
  incident are refused; the regulation 20(9) hint quotes "or are likely to experience" and (b)(ii);
  `incidentManageView` requires the candour record (#130 note in the spec). Hazard log: HZ-013 and
  HZ-091 round 1 rows corrected (the reason was web-only) and round 2 controls and tests added.
  H-480 gains the CSO questions (g) to (k). Tests: domain `workflows.test.ts`, five API tests,
  two web review tests, the refusal mappings, and the two-people journey asserting the name.
  After merging main: the approvals list's `closeBlocked` (#130) comes from the close route's own
  check, the duty of candour included (`apps/api/test/workflows.test.ts`), and the candour and
  investigation forms post (#133's `forms.test.ts`).
- Round 3 (clinical re-check), fail safe: a finished candour record keeps its decision
  (`candour_finished`) until it is reopened (`POST /v1/incidents/{id}/candour/reopen`, a reason of
  at least 20 characters, audited), which takes it back to the threshold decision (or to telling the
  person after no contact), makes a candour notification decided not required a draft again and
  blocks closing; nothing on a closed incident's candour record changes; the web offers reopening.
  Taking someone out of those affected needs `safety.incident.manage` and a reason whether or not a
  decision is recorded, audited with the person. The stuck-incident task has its own ladder
  (Registered Managers, then owners, who manage incidents, every day until resolved; raising,
  escalation and finishing audited) and the task engine leaves it alone. Tests for each, the L5 times
  before the incident, a finished record's person, and the Reg 18 and candour thresholds read apart.
  H-480 (i) and (j) restated for the CSO.
- Round 4 (clinical re-check): the stuck-incident ladder counts from the incident's first task and
  its task cannot be ended by hand; an unrouted day reaches the operator's daily signal; the candour
  update, step and reopen need `safety.incident.manage` where the incident is. HZ-073 and HZ-091
  rows added; the round 3 API tests carry HZ-091 where they test its controls.
