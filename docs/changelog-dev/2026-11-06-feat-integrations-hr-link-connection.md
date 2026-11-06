# Thapsus-HR link: connection, people and locations

Branch `feat/integrations-hr-link-connection`, from `feat/integrations-hr-link-port` (Phase 2
slice 87; INTG-014; ADR-0126; integrations.md section 11). Migration 0141. Behind the
`integrations.thapsus_hr` flag, off by default.

## What changed

- **Schema** (migration 0141): `hr_person_link`, `hr_location_link`, `hr_sync_state` and
  `hr_delivery`, each with `tenant_id`, forced RLS, a tenant policy, read only with an
  `integrations.hr_link.*` permission, no DELETE. Links are proposed by the sync and decided by a
  person in their own name, never to their own staff file. The link's `integration_connection`
  row can hold only a UK region and the UK host. Identifiers only: no name, email or date of
  birth from Thapsus-HR is stored.
- **Permissions** `integrations.hr_link.manage` (step-up), `.review` and `.read`, with the
  built-in role backfill: owner, Registered Manager and HR all three; deputy review and read; care
  coordinator read.
- **API**: connect (UK only, step-up), status with staleness, owners and staleness limit
  (`expected_version`), test, disconnect, sync now, location mapping, the match review queue
  (confirm or reject), deliveries, and starters hired here created in Thapsus-HR once through the
  mock. OpenAPI and the typed client regenerated.
- **Signed webhook** at `/p/integrations/thapsus-hr/{organisation id}`: HMAC with a 5-minute replay
  window, duplicates dropped, identifiers only, anything else quarantined. It is under `/p/`
  because `/v1/*` always needs a session (spec updated).
- **Employee pull and reconciliation** every 10 minutes: matching by number, then work email with
  date of birth, never by name; the rest to review. Leaving dates go into the staff file's leaving,
  only ever earlier, so the leaver sweep ends sign-in even if later syncs fail; each pull and
  webhook ends a passed leaving at once. Thapsus-HR's job title and start date put back over drift.
- **Hazard HZ-133** controls and tests updated; records of processing and data standards updated.

## Reviews

- Security reviewer, request changes, fixed:
  - Thapsus's domain now comes from `THAPSUS_HR_DOMAIN`, never the caller;
  - confirming a match needs a fresh step-up and a staff file the reviewer can see, and only someone
    who manages that file confirms one with a leaving date;
  - starters only for a visible file, never one's own or an already linked member;
  - the webhook is throttled before any query, does the same HMAC work for every organisation, and
    takes a duplicate safely;
  - no leaving date in audit, and the version policy binds both roles.
- Clinical safety reviewer, request changes, fixed:
  - a leaving date also sets `left_on` and the retention date, so the rota stops offering the leaver;
  - a date that is not a real day counts as today and is raised;
  - one bad record no longer rolls back a pull (savepoints, a withdrawn leaving put back, failures
    recorded);
  - the staff file refuses what Thapsus-HR owns;
  - a start-date change across today goes to review;
  - leavers are shown first in the queue;
  - missing employees, incomplete pages and leavers whose access could not be ended are raised;
  - a failed webhook fetch is retried;
  - staleness is still reported after a disconnect, and limits under 10 minutes are refused.

## Left

- For the CSO: rate HZ-133 (H-1345); confirm the staleness limit (H-1344); accept that rule 13's
  incoming-shift checks are not needed now the rota stays here; whether an invalid leaving date
  should count as today; whether a start-date change should ever be put back automatically;
  whether manual confirmation needs a second person.

- The live Thapsus-HR adapter (production answers 503 until Thapsus-HR's partner features ship,
  H-1343) and reading the webhook secret from Secret Manager.
- Starters are created through `POST /v1/integrations/hr-link/starters/{id}`; hooking this to the
  offer-accepted event waits for WORK-001's event.
- Absences, the rota's staleness notice and `integrations.hr_link.stale` are slice 88.
- Reviewers' remaining non-blocking findings:
  - the starter route should require an accepted offer (WORK-001's event) and take names from it;
  - a route to withdraw a wrong leaving date (with `workforce.staff_file.manage` and a reason);
  - raise `employee_missing` and `leaving_date_invalid` once rather than on every pull;
  - a review queue for start dates held back;
  - move `retainUntil` into a shared service;
  - tests for the page cap, one record failing, `pullSafely` and `leaversNotEnded`;
  - fetch the employee before confirming, so a leaving date given since the last sync is checked;
  - cache the webhook secret.
