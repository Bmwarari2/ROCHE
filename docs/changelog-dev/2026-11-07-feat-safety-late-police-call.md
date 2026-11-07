# A police call recorded after the person was found (HZ-127)

Branch `feat/safety-late-police-call`, from `main` at `43de29fe`. Item 2 of the lead's list of gaps
the slice 83 guides review found.

## What changed

- **Domain**: once a person is found, the timeline still takes the police called, at its true
  time, if that time is before they were found (refused in words otherwise), once, with the
  reference (`timelineEntryProblems`). Searching, sightings and the rest stay closed once found.
- **API**: the call answers the incident's police involved question, so the CQC notification
  (regulation 18(2)(f)) is drafted while the incident is open. On an incident already closed, the
  call is kept, audited, and raises an urgent task for the Registered Manager to reopen the
  incident and submit the notification; the episode returns `policeInvolvementUnnotified`. The
  episode also returns the police call target once called (`policeCallTargetAt`).
- **Web**: a found episode with no police call says how to record one made; a call after the
  target shows as called after the target, as a warning; an entry recorded more than 15 minutes
  after its time says when it was recorded; the close card says a call cannot be added after
  closing; a call recorded after the incident closed says the notification still needs doing.
- **Tests**: domain, API (police involved and the CQC draft after Found), web unit and an e2e
  journey.
- **Hazard log**: HZ-127 cause, control and tests; HZ-013 control. Human actions H-1567 to H-1569.
- **Reviewer**: clinical safety, no blocker; its two highs (a closed incident dropping the
  notification, a late call shown as done) and mediums fixed.
