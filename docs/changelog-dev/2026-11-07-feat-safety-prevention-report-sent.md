# Regulation 28: the date the report was sent, the response period and an extension

Branch `feat/safety-prevention-report-sent`, from `main` at `43de29fe`. Item 5 of the lead's list of
gaps the slice 83 guides review found.

## What changed

- **Field**: the Regulation 28 report is recorded by "Date the report was sent" (it said "When the
  report was received"); the API field stays `reportOn`, described as the date sent.
- **Period**: the response is due within `coroner.prevention_report_response_days` (rate table, no
  literal) of the date the report was sent (reg 29(4)), so 56 days after it, as before
  (`preventionResponse` in the domain, table-driven tests with fixed dates across the clock
  changes).
- **Extension**: a later date the coroner allowed (`prevention_extended_to`, migration 0158;
  reg 29(5)); refused unless later than the
  usual due date, naming it; the response is then due on it, and the screen says "(extended by
  the coroner)". The closed-request guard lets it be recorded after release, as the other
  Regulation 28 dates.
- **Saving again**: the form starts from what is recorded, and a date left out of the request keeps
  what was recorded (null clears it), so recording the response never clears an extension.
- **Refusals**: an extension too early, or a response before the report, is said on its field.
- **Docs**: safety.md rule 43, data-standards.md, rates.md (reg 29(4) and (5)), the nurse guide,
  the export catalogue, human actions H-1570 to H-1572.
- **Reviewer**: clinical safety; its blocker (my "beginning with" reading made the date a day
  early) reverted to 56 days after the date sent, and its highs fixed.
