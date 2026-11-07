# An absconding incident opens a missing person episode on the web (HZ-127)

Branch `feat/safety-absconding-missing-episode`, from `main` at `daa038a7`. A gap the slice 83
guides review found (item 1 of the lead's list; the guides builder logs its H-rows from H-1543).

## What changed

- **Web**: the incident page offers "Record the missing person episode" on an absconding incident
  as it did on a missing person incident, for each person affected, to whoever may report
  incidents. The API already opened episodes on both types; opening one starts the police call
  target, the urgent police call task and, with immediate risk, the alert to the clinical leads
  and team leaders on site. The types live once in `MISSING_INCIDENT_TYPES` (`lib/missing.ts`).
- **Tests**: `lib/missing.test.ts` (which incident types offer it, and to whom); `e2e/missing.spec.ts`
  (an absconding incident opens the episode from the incident page and shows the police call
  target).
- **Hazard log**: HZ-127 gains the control and its tests.
