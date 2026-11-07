# An absconding incident opens a missing person episode on the web (HZ-127)

Branch `feat/safety-absconding-missing-episode`, from `main` at `daa038a7`. A gap the slice 83
guides review found (item 1 of the lead's list; the guides builder logs its H-rows from H-1543).

## What changed

- **Web**: the incident page offers "Record the missing person episode for" the person on an
  absconding incident as it did on a missing person incident, for the resident recorded as the
  person affected, never a witness or on a closed incident (`missingEpisodeSubjects`). The API
  already opened episodes on both types; opening one starts the police call target, the urgent
  police call task and, with immediate risk, the alert to the clinical leads and team leaders on
  site. The empty missing persons list names both incident types.
- **One list**: `MISSING_INCIDENT_TYPES` in the domain (`safety/classifier.ts`) is read by the
  classifier, the API and the web.
- **Tests**: web unit tests (types, the person affected, closed incidents, the permission), an API
  test opening an episode on an absconding incident and refusing one on a fall, a classifier row
  for absconding with no DoLS or Mental Health Act, and an e2e journey from the incident page with
  axe.
- **Docs**: HZ-127 (cause, control and tests); the care worker guide on recording a missing person
  now has the episode step; human actions H-1561 to H-1563 (CSO).
- **Reviewer**: clinical safety, no blocker or high; its mediums fixed, its lows fixed or logged.
