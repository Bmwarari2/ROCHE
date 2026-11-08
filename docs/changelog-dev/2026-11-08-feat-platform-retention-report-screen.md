# Retention report screen (retention sweeps plan, slice 5)

Branch `feat/platform-retention-report-screen`, stacked on `feat/platform-retention-report` (#215)
at 97969e14.

## What changed

- **Records due for destruction** on `/settings/retention` (plan 5.9, report first). The page
  reads `GET /v1/retention/due` with the other retention calls, through the shared typed client.
  The section says first: "This report only counts. Nothing has been destroyed."
- **Off** (the default): "Report off", what the report does when it is on, and to ask Thapsus
  Care support to turn it on. The flag `platform.retention.sweep_report` has no screen; it is set
  in the organisation's `feature_flag` row. A report kept from an earlier run is not shown once the
  report is off, so an old count is never read as current.
- **On, no report yet**: the report runs every night, so the first appears the morning after.
- **A report**: when it counted (dd/mm/yyyy, 24-hour, UK time, in a `<time>` element), the totals,
  and a table per kind of record (the report's lines added up across tables) with the columns
  due for destruction, held, not yet due (`retain` and `no_trigger_yet`), never offered
  (`tenant_policy` and `never_offered`), not evaluated and total, most due first. Each class is
  named in words from the catalogue (`retention.due.class`); a class the catalogue does not name
  shows its code; tables counted without reading their class are one last row. Then how many
  tables were read and how many were counted without their dates. It uses `CountTable`
  (`DataTable` from `@harbour/ui`), as the weekly break-glass report does: a few dozen rows, so no
  virtualisation.
- **Access**: the page is still shown only to holders of `platform.retention.manage`. The report
  route also needs the role organisation-wide; a narrower holder is told the report covers the
  whole organisation and the rest of the page still shows (any other refusal, step-up included,
  is handled as for the page's other calls).
- 17 catalogue keys under `retention.due.*` (en-GB; Welsh keys hold the English and are listed as
  untranslated, as the parity check requires).

## Tests

- `apps/web/src/lib/retention-report.test.ts`: off, waiting and report; the columns folded from
  the seven counts with a total; lines added up by kind, most due first, unread tables last; class
  names, joined classes, an unknown class and no class.
- `apps/web/src/components/retention/RetentionReport.test.tsx` (jsdom): each state in words
  (off, on with no report, a report with its table and UK time, the refusal), each checked with
  axe-core.
- `apps/web/e2e/retention.spec.ts`: as the owner with step-up, the section in the state the
  database is in (off on the seeded demo; the counts where the sweep has run), with axe in light
  and dark.

## Not changed

- No data changes: the screen reads a report of counts. No personal data is added, so
  `data-standards.md` and `records-of-processing.md` are unchanged.
- Not clinical: no hazard log change.
- No API, schema or migration change.

## What is next

- Slice 6: destruction batches in propose mode.
- A screen to turn the report on, if the DPO wants one rather than a request to Thapsus Care
  support (listed in the report for sign-off, no H-number taken).
