# Role dashboards on the web home page (INSI-001)

Branch `feat/web-dashboards`.

## What changed

- Web: the home page (`/`) is now the role dashboard. Each tile the reader may open says how many
  things wait in its list, in words, with its state as an icon and a word and a link to the list:
  alerts not acknowledged (urgent said apart), tasks due or overdue on the round, handovers the
  incoming shift has not acknowledged (or "Not known" in a view limited to the reader's people) and
  whether the shift running now has one, DoLS expiry reminders open (never an all-clear tick),
  reviews due or overdue, incidents open, statutory notifications still to submit (overdue clocks
  said apart, with the soonest due time), outages under way or to reconcile, and last week's break-glass reports
  still to review. Today's work first, then safety and oversight, then the people list.
- A tile appears only when the reader holds the permission its list page checks, so the carer,
  nurse, manager and owner views follow from their role bundles. Counts come from the existing
  endpoints, read in parallel on the server as the reader (scope, MFA and audit are the API's), at
  most 18 reads plus the shell's two; a sign-in, MFA or step-up refusal redirects as the list
  pages do; with every location shown, the per-location tiles read up to three locations and
  otherwise ask for one. The alerts read is shared with the shell's unread count.
- A read that fails is a warning ("Could not load"), never a zero, and is logged by path, status
  and problem code only; part of it failing, or a list cut at the API's limit, makes the count "at
  least" with a "Some not loaded" chip, and "Not known" (never the all-clear) when nothing was found. A statutory
  notification read failing fails the whole tile (HZ-013). States the web does not know warn. No
  scoring, ranking or prediction.
- The page says when its counts were worked out, reads them again when the person returns to the
  tab after five minutes, and has "Read the counts again". No background timer, so a page left open
  neither keeps the session alive nor writes audit events nobody made.
- A DoLS expiry reminder on the round now links to the person's DoLS register.
- The Phase 0 placeholder tiles ("Nothing here yet") are gone; staffing, occupancy, finance and
  audits arrive with their modules. Strings in en-GB; Welsh copied and listed as untranslated.
- No API or schema change.
- Docs: new spec `docs/specs/insights.md` (rules, tiles, states, permission matrix, test list),
  hazard log control and verification rows for HZ-002, HZ-008, HZ-013, HZ-018, HZ-020, HZ-024 and
  HZ-073, human action H-410, the register's spec, code and test paths, the specs index.

## Clinical safety and data protection

- Medical-device boundary re-checked: counts and states are the API's; nothing is scored, weighted
  or ranked, and the tiles keep a fixed order.
- No new personal data or processing: the tiles show counts and location names only, never a
  person's name or care text. Records of processing and data standards unchanged.

## Tests

- `apps/web/src/lib/dashboard.test.ts` (table-driven: tiles per permission set, every summariser
  for empty, due, overdue, partial, failed and refused reads, unknown states, the location limit).
- `apps/web/e2e/dashboard.spec.ts` (manager, nurse, carer, owner; axe in light and dark themes; an
  incident recorded in the run is counted and its list opens); `apps/web/e2e/smoke.spec.ts` updated.

## What is next

- Staffing, occupancy, finance and quality tiles as their modules land (Phases 2 to 4); the
  location-level DoLS register read (another PR) for the DoLS tile; a count-only
  `GET /v1/insights/dashboard` audited once, to cut the per-view list audit events; an API count of
  unacknowledged alerts; the review tracker saying when a nation has no figures; the mobile Manage
  mode dashboard.

## Human actions logged

- H-410: the Clinical Safety Officer reviews the dashboard's residual risks, the handover
  acknowledgement grace period and the wording of "without delay" notifications, and signs off the
  new hazard rows.
