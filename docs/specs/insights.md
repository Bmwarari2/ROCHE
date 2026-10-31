# Insights: role dashboards (INSI-001)

Bounded context `insights` (master prompt section 15.2). This file covers the Phase 1 role
dashboards on the web home page (`/`); the report builder, benchmarks and statutory outputs
(INSI-002 to INSI-004) follow in later phases and get their own sections here.

## Purpose

The home page tells each member of staff, in plain English, what is waiting for them across the
modules already built, and takes them to the list that holds it. Section 15.2 asks for: carer,
today's tasks and alerts; manager, safety, staffing, overdue items and occupancy; executive,
cross-location quality and finance; quality lead, framework coverage and audit status. In Phase 1
only tasks, alerts, safety and overdue items have data behind them; staffing, occupancy, finance and
audits arrive with their modules (Phases 2 to 4) and are not shown as empty placeholders.

## Rules

1. **Permission decides the tile, not the role name.** A tile appears only when the reader holds
   the permission the page it links to checks (the same helper the navigation uses), so the
   carer, nurse, manager and owner views follow from the built-in roles in
   [permissions.md](permissions.md) and from any tenant role. Scope is the API's: every count comes
   from an existing endpoint called as the reader, so row-level security, attribute scope, MFA and
   audit apply exactly as on the list page.
2. **A count in words with a link.** Each tile says how many things are waiting in a sentence
   ("2 tasks overdue", "No incidents open"), with its state as an icon and a word (never colour
   alone), and links to the list it summarises.
3. **A failure is a warning, never a zero.** When the data behind a tile cannot be loaded, the tile
   says so ("We could not load this. Open the list to check.") with a warning icon and word, and
   shows no count. When only part of it loaded (one location of several, or a list cut at the API's
   limit), the count is shown as "at least" with a second chip saying some could not be loaded.
   A refusal for a missing permission hides the tile, as the list page would refuse it.
4. **Facts only.** Counts and states come straight from the API (task time state, review state,
   statutory notification clock, outage state, handover acknowledgement). No scoring, ranking,
   weighting or prediction; tiles are in a fixed order.
5. **Location.** With a location chosen, every tile is for that location. With every location
   shown, tiles read per location for up to three locations; past that the per-location tiles ask
   the reader to choose a location instead of fanning out, and the organisation-wide tiles
   (alerts, incidents, statutory notifications, break-glass reports) still show.
6. **Budget.** All reads run in parallel on the server, at most 16 API calls (one alerts read shared
   with the shell, one incidents, two statutory notifications, one break-glass, and four per
   location for up to three locations). No client-side fetching.
7. **Family members** keep their own home (`/updates`); they never see the staff dashboard.
8. **Never stale without saying so.** The page says when its counts were worked out, and reads
   them again every five minutes while it is in view, and as soon as it comes back into view after
   longer than that.

## Tiles

| Tile | Shown when the reader holds | Source | Counts | Link | Empty state |
| --- | --- | --- | --- | --- | --- |
| Alerts | always (staff) | `GET /v1/notifications` (latest 100) | warning and urgent alerts not yet acknowledged; urgent ones said apart | `/notifications` | No alerts waiting for you |
| Tasks on the round | `care.plan.read` | `GET /v1/locations/{id}/round` | open tasks overdue or escalated, and due now | `/round/{id}` or `/round` | No tasks due or overdue on this shift |
| DoLS authorisations ending | `care.dols.manage` and `care.plan.read` | the same round views: open `care.dols_expiry` reminders (care.md rule 11) | reminders open, overdue ones said apart | `/round/{id}` or `/round` | No DoLS reminders open |
| Handover | `care.handover.manage` | `GET /v1/locations/{id}/handovers` | handovers of the last week the incoming shift has not acknowledged; whether the shift running now has one | `/handover/{id}` or `/handover` | Every handover acknowledged |
| Reviews due | `care.plan.read` | `GET /v1/locations/{id}/reviews` | reviews due and overdue | `/people/reviews` | No reviews due or overdue |
| Incidents open | `safety.incident.read` | `GET /v1/incidents` (latest 500) | open and under review | `/incidents` | No incidents open |
| Statutory notifications | `safety.incident.manage` | `GET /v1/notifications/statutory` (draft, ready) | still to submit; overdue clocks said apart | `/notifications/statutory` | No notifications to submit |
| Outages | `operations.downtime.read` or `.manage`, and `people.person.read` | `GET /v1/locations/{id}/outages` | outages under way, and closed ones still to reconcile | `/downtime/{id}` or `/downtime` | No outages under way or to reconcile |
| Break-glass reports | `platform.audit.read` | `GET /v1/break-glass/weekly-report` (last full week) | reports not yet reviewed | `/break-glass/weekly-report` | Every report for the week reviewed |
| People | `people.person.read` | none | none | `/people` | (always a link) |

## States

| State | Icon and word | When |
| --- | --- | --- |
| Nothing waiting | circle with tick, "Nothing waiting" | the count is zero and everything loaded |
| To do | clock, "To do" | something waits, none of it late |
| Overdue | circle with alert, "Overdue" | a task, review, reminder or notification clock is past due, or a handover was not acknowledged |
| Urgent | triangle with alert, "Urgent" | an urgent alert is unacknowledged, or an outage is under way |
| Could not load | triangle with alert, "Could not load" | every source of the tile failed |
| Some not loaded | triangle with alert, "Some not loaded" | some sources failed, or a list reached the API's limit (beside the main state) |
| Choose a location | magnifier, "Choose a location" | more than three locations and none chosen |

## Permission matrix

| Role (built-in) | Alerts | Tasks | DoLS | Handover | Reviews | Incidents | Notifications | Outages | Break-glass | People |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Owner | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| Registered Manager | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| Clinical lead or nurse | yes | yes | by role bundle | yes | yes | yes | by role bundle | by role bundle | no | yes |
| Care worker | yes | yes (assigned people) | no | no | by role bundle | by role bundle | no | by role bundle | no | yes (assigned) |

"By role bundle" means the tile follows the permission in the tenant's version of the role; the
code never names a role.

## Test list

- `apps/web/src/lib/dashboard.test.ts` (table-driven): which tiles each permission set sees; each
  summariser's count, state and link for empty, due, overdue, partial and failed inputs; a failed
  source is never a zero; a refusal hides the tile; the location limit; a state the web does not
  know warns.
- `apps/web/e2e/dashboard.spec.ts`: the manager, nurse, carer and owner see their tiles with counts
  in words and links that open; an incident recorded in the run shows in the manager's incidents
  tile; axe with no serious violations in light and dark themes.

## Hazards

The dashboard is a pointer to lists, never the list itself. Its controls are recorded against
HZ-008 (alert fatigue: urgent alerts said apart, no colour-only state), HZ-013 (statutory
notification overdue shown, a failed read never reads as none) and HZ-020 (DoLS reminders open shown
to managers) in [the hazard log](../clinical-safety/hazard-log.md).

## Audit and data protection

No new data, storage or processing: every read is an existing endpoint, audited there. The page
shows counts and the names of locations only, never a person's name or care text. No retention
class applies.
