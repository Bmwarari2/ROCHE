# Slice 9 part 5, incident follow-up on the web: duty of candour, after a death, investigations and trends (SAFE-007, SAFE-008, SAFE-010)

Branch `feat/web-incident-follow-up`.

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
