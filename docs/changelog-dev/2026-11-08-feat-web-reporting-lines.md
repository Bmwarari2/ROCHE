# Reporting lines on the web (ADR-0137, PR 2 of 2)

Branch `feat/web-reporting-lines`, built on `feat/workforce-team-line-manager-scope` (PR 1: the
schema, API and row-level security).

## What changed

- A **Line manager** page on each staff file (`/workforce/staff/{id}/line-manager`, linked from
  the staff list): the line manager now and since when, and earlier lines, each Current or Ended
  as an icon and a word. HR (the staff file permission at every home) names, changes or ends the
  line against the version loaded; anyone else who may open the staff file sees it read only.
- A **Staff teams** page in the navigation (`/workforce/teams`) and a page per team: teams in use,
  then archived; members with the lead first and those who left after. HR adds and archives
  teams, renames or moves them, adds members, marks the lead and ends a membership.
- Refusals say the API's own words at their fields (a stale version, oneself as line manager, a
  change before the current line started, a name in use, someone already in the team).
- The generic workforce form's text field takes a starting value, used to rename a team.
- A guide for HR, linked from the guides index and WORK-009.

No migration, no API change.

## Checks

- Web unit tests for `lib/reporting-lines.ts` (who maintains and sees, states, choices and order).
- Playwright `reporting-lines.spec.ts` with axe in light and dark: HR names, changes and ends a
  line (errors first, the end by keyboard only); HR adds a team, members and a lead and archives
  it (the archive by keyboard only); a home's manager sees both read only; a care worker sees
  neither. It passes twice in a row on the same database.
