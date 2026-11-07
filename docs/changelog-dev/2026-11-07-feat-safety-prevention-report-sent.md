# Regulation 28: the date the report was sent, the response period and an extension

Branch `feat/safety-prevention-report-sent`, from `main` at `43de29fe`. Item 5 of the lead's list of
gaps the slice 83 guides review found.

## What changed

- **Field**: the Regulation 28 report is recorded by "Date the report was sent" (it said "When the
  report was received"); the API field stays `reportOn`, described as the date sent.
- **Period**: the response is due within `coroner.prevention_report_response_days` (rate table, no
  literal) beginning with the date the report was sent, so that date is day one
  (`preventionResponse` in the domain, table-driven tests). It was counted from the day after, a
  day late; H-1570 asks for the legal check.
- **Extension**: a later date the coroner allowed (`prevention_extended_to`, migration 0157,
  written as 0157 until it is renumbered before merge); refused unless later than the usual due
  date; the response is then due on it, and the screen says "(extended by the coroner)". The
  closed-request guard lets it be recorded after release, as the other Regulation 28 dates.
- **Docs**: safety.md rule 43, data-standards.md, the export catalogue, human actions H-1570 and
  H-1571.
