# A police call recorded after the person was found (HZ-127)

Branch `feat/safety-late-police-call`, from `main` at `43de29fe`. Item 2 of the lead's list of gaps
the slice 83 guides review found.

## What changed

- **Domain**: once a person is found, the timeline still takes the police called, at its true
  time, if that time is before they were found (refused in words otherwise), once, with the
  reference (`timelineEntryProblems`). Searching, sightings and the rest stay closed once found.
- **API**: unchanged. The call answers the incident's police involved question, so the CQC
  notification (regulation 18(2)(f)) is drafted while the incident is open; the episode keeps
  the CQC prompt; lateness reads the call's true time.
- **Web**: a found episode with no police call says above the timeline form that a call made
  before the person was found can be recorded now, with its time and reference.
- **Tests**: domain, API (police involved and the CQC draft after Found), web unit and an e2e
  journey.
- **Hazard log**: HZ-127 cause, control and tests.
