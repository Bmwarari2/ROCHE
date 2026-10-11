---
status: proposed
date: 2026-10-11
decision-makers: Claude Code (lead engineer); the DPO and the CSO accept or reject (human action H-70)
consulted: master prompt sections 4, 5.1 and 11.1; docs/specs/safety.md section 2; ADR-0002
informed: everyone working on the safety and care modules
---

# Incident scope: visible through any of its people, and classified with tenant-wide scope

## Context and problem statement

An incident can involve several people using the service, staff and visitors, at a location that
may not be any of those people's home (safety.md section 2). The spec says an incident "is visible
to a user only for the people in their scope; the incident header (type, time, location) is
visible to anyone who can see one of them", and incidents with nobody using the service (a utility
failure, a staff injury) follow location scope. ADR-0002 requires every check in the API and again
in Postgres row-level security. Two problems follow. How does the incident row's policy know who is
on it without reading `incident_person`, whose own policy reads the incident (Postgres refuses
policies that recurse)? And how does the notification classifier decide on the whole incident when
the person answering a question can see only some of its people, so a partial view could exclude a
statutory notification that another person's facts require (HZ-013)?

## Decision drivers

- HZ-011: no record of a person outside a user's scope, through the API or the database.
- HZ-013: the classifier must read every person's facts, whoever triggers it.
- Offline capture: the reporter, including staff with no person scope (maintenance, catering),
  must be able to write and then see what they reported.
- Policies that never recurse, and invoker-rights helpers that can never widen access.

## Considered options

- Policy on `incident` reading `incident_person` through a security-definer function.
- A list of the people using the service kept on the incident (`person_ids`), checked by a trigger
  on `incident_person`, with the incident's own scope function reading only that list.
- Location scope for every incident, and person scope for the person rows only.

## Decision outcome

Chosen option: "a list of the people on the incident", because it keeps every helper invoker-rights
(the ADR-0002 pattern), never recurses, and follows the person rather than the place.

- `app.incident_in_scope(location, raised_by, person_ids)`: tenant-wide roles; the person who raised
  it; anyone who can see at least one of `person_ids` (through `app.person_visible`); and, only when
  `person_ids` is empty, people working at the incident's location. An incident about a South
  resident that happened at North is therefore not visible to North's manager.
- `app.incident_visible(incident)` for child records (answers, investigations, candour), with the
  person's own scope added where a record is about one person (candour, per-person notifications
  such as a death). Staff and visitor rows on an incident are third parties: visible to tenant-wide
  roles, the incident's location and its reporter.
- A trigger refuses a person row whose person is not listed on the incident; the API writes the list
  before the rows.
- A reader who cannot see every person on an incident gets it as `restricted`: the header (type,
  time, location, status) and their own people, without the narrative, the classifier's reasoning or
  the notifications, which may describe the others. They cannot change it or answer its questions.
- The classifier runs with tenant-wide scope inside the request's transaction
  (`withTenantWideScope`, which keeps the acting user id), so it always reads every person. What it
  reads goes into the stored drafts and tasks only; the response is read again under the user's own
  scope. Closing an incident checks every notification the same way, so a draft about a person the
  closer cannot see still blocks the close.

### Consequences

- Good, because isolation is proved in the database for people, locations and reporters
  (`packages/db/test/mca-and-incidents.test.ts`) and through the API.
- Good, because a classifier decision never rests on a partial view (HZ-013).
- Bad, because `person_ids` duplicates `incident_person`; the trigger and the API keep them in step,
  and a test refuses a person row the list does not name.
- Bad, because staff who can see only some people on an incident do not see its narrative; the DPO
  and CSO decide whether that is right (H-70).
- Neutral, because tenant-wide scope inside a request is used only by the classifier and the close
  check, never to answer a read.

### Confirmation

`packages/db/test/mca-and-incidents.test.ts` (hazard HZ-011 incident scope across people and
locations) and `apps/api/test/incidents.test.ts` (hazard HZ-011 incident scope across people) prove
the policy; `packages/db/test/rls-coverage.test.ts` keeps RLS, FORCE and the tenant policy on every
table.

## More information

Safety.md section 2 and section 5 (built in slice 7); ADR-0002 (tenancy and row-level security).
