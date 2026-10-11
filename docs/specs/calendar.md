# UK calendar - bank holidays

Working-day clocks count Monday to Friday, leaving out the bank holidays of the nation where the
location is. They include the first care plan after admission (`care_plan.initial_working_days`),
the written duty-of-candour notification (`candour.written_notification.working_days`) and sponsor
licence change reports (`sponsor.change_report_working_days`). Pay enhancements (Phase 3) read the
same list. The figures for those clocks live in the [rate table](rates.md); this document holds
the dates.

Source: GOV.UK bank holidays (https://www.gov.uk/bank-holidays.json), retrieved 2026-10-11,
from 2024 to the last date GOV.UK publishes. England and Wales share one list. The seed loads
this table into `bank_holiday` (`packages/db/src/seed/reference-data.ts`). When GOV.UK publishes
a new year, or a one-off bank holiday is announced, add the rows here in the same format;
`packages/db/src/seed/reference-data.test.ts` fails if a nation has no bank holidays in a year the
table covers.

## Bank holidays

| date | nation | name |
| --- | --- | --- |
| 2024-01-01 | england | New Year's Day |
| 2024-03-29 | england | Good Friday |
| 2024-04-01 | england | Easter Monday |
| 2024-05-06 | england | Early May bank holiday |
| 2024-05-27 | england | Spring bank holiday |
| 2024-08-26 | england | Summer bank holiday |
| 2024-12-25 | england | Christmas Day |
| 2024-12-26 | england | Boxing Day |
| 2025-01-01 | england | New Year's Day |
| 2025-04-18 | england | Good Friday |
| 2025-04-21 | england | Easter Monday |
| 2025-05-05 | england | Early May bank holiday |
| 2025-05-26 | england | Spring bank holiday |
| 2025-08-25 | england | Summer bank holiday |
| 2025-12-25 | england | Christmas Day |
| 2025-12-26 | england | Boxing Day |
| 2026-01-01 | england | New Year's Day |
| 2026-04-03 | england | Good Friday |
| 2026-04-06 | england | Easter Monday |
| 2026-05-04 | england | Early May bank holiday |
| 2026-05-25 | england | Spring bank holiday |
| 2026-08-31 | england | Summer bank holiday |
| 2026-12-25 | england | Christmas Day |
| 2026-12-28 | england | Boxing Day (substitute day) |
| 2027-01-01 | england | New Year's Day |
| 2027-03-26 | england | Good Friday |
| 2027-03-29 | england | Easter Monday |
| 2027-05-03 | england | Early May bank holiday |
| 2027-05-31 | england | Spring bank holiday |
| 2027-08-30 | england | Summer bank holiday |
| 2027-12-27 | england | Christmas Day (substitute day) |
| 2027-12-28 | england | Boxing Day (substitute day) |
| 2028-01-03 | england | New Year's Day (substitute day) |
| 2028-04-14 | england | Good Friday |
| 2028-04-17 | england | Easter Monday |
| 2028-05-01 | england | Early May bank holiday |
| 2028-05-29 | england | Spring bank holiday |
| 2028-08-28 | england | Summer bank holiday |
| 2028-12-25 | england | Christmas Day |
| 2028-12-26 | england | Boxing Day |
| 2024-01-01 | wales | New Year's Day |
| 2024-03-29 | wales | Good Friday |
| 2024-04-01 | wales | Easter Monday |
| 2024-05-06 | wales | Early May bank holiday |
| 2024-05-27 | wales | Spring bank holiday |
| 2024-08-26 | wales | Summer bank holiday |
| 2024-12-25 | wales | Christmas Day |
| 2024-12-26 | wales | Boxing Day |
| 2025-01-01 | wales | New Year's Day |
| 2025-04-18 | wales | Good Friday |
| 2025-04-21 | wales | Easter Monday |
| 2025-05-05 | wales | Early May bank holiday |
| 2025-05-26 | wales | Spring bank holiday |
| 2025-08-25 | wales | Summer bank holiday |
| 2025-12-25 | wales | Christmas Day |
| 2025-12-26 | wales | Boxing Day |
| 2026-01-01 | wales | New Year's Day |
| 2026-04-03 | wales | Good Friday |
| 2026-04-06 | wales | Easter Monday |
| 2026-05-04 | wales | Early May bank holiday |
| 2026-05-25 | wales | Spring bank holiday |
| 2026-08-31 | wales | Summer bank holiday |
| 2026-12-25 | wales | Christmas Day |
| 2026-12-28 | wales | Boxing Day (substitute day) |
| 2027-01-01 | wales | New Year's Day |
| 2027-03-26 | wales | Good Friday |
| 2027-03-29 | wales | Easter Monday |
| 2027-05-03 | wales | Early May bank holiday |
| 2027-05-31 | wales | Spring bank holiday |
| 2027-08-30 | wales | Summer bank holiday |
| 2027-12-27 | wales | Christmas Day (substitute day) |
| 2027-12-28 | wales | Boxing Day (substitute day) |
| 2028-01-03 | wales | New Year's Day (substitute day) |
| 2028-04-14 | wales | Good Friday |
| 2028-04-17 | wales | Easter Monday |
| 2028-05-01 | wales | Early May bank holiday |
| 2028-05-29 | wales | Spring bank holiday |
| 2028-08-28 | wales | Summer bank holiday |
| 2028-12-25 | wales | Christmas Day |
| 2028-12-26 | wales | Boxing Day |
| 2024-01-01 | scotland | New Year's Day |
| 2024-01-02 | scotland | 2nd January |
| 2024-03-29 | scotland | Good Friday |
| 2024-05-06 | scotland | Early May bank holiday |
| 2024-05-27 | scotland | Spring bank holiday |
| 2024-08-05 | scotland | Summer bank holiday |
| 2024-12-02 | scotland | St Andrew's Day (substitute day) |
| 2024-12-25 | scotland | Christmas Day |
| 2024-12-26 | scotland | Boxing Day |
| 2025-01-01 | scotland | New Year's Day |
| 2025-01-02 | scotland | 2nd January |
| 2025-04-18 | scotland | Good Friday |
| 2025-05-05 | scotland | Early May bank holiday |
| 2025-05-26 | scotland | Spring bank holiday |
| 2025-08-04 | scotland | Summer bank holiday |
| 2025-12-01 | scotland | St Andrew's Day (substitute day) |
| 2025-12-25 | scotland | Christmas Day |
| 2025-12-26 | scotland | Boxing Day |
| 2026-01-01 | scotland | New Year's Day |
| 2026-01-02 | scotland | 2nd January |
| 2026-04-03 | scotland | Good Friday |
| 2026-05-04 | scotland | Early May bank holiday |
| 2026-05-25 | scotland | Spring bank holiday |
| 2026-06-15 | scotland | World Cup bank holiday |
| 2026-08-03 | scotland | Summer bank holiday |
| 2026-11-30 | scotland | St Andrew's Day |
| 2026-12-25 | scotland | Christmas Day |
| 2026-12-28 | scotland | Boxing Day (substitute day) |
| 2027-01-01 | scotland | New Year's Day |
| 2027-01-04 | scotland | 2nd January (substitute day) |
| 2027-03-26 | scotland | Good Friday |
| 2027-05-03 | scotland | Early May bank holiday |
| 2027-05-31 | scotland | Spring bank holiday |
| 2027-08-02 | scotland | Summer bank holiday |
| 2027-11-30 | scotland | St Andrew's Day |
| 2027-12-27 | scotland | Christmas Day (substitute day) |
| 2027-12-28 | scotland | Boxing Day (substitute day) |
| 2028-01-03 | scotland | New Year's Day (substitute day) |
| 2028-01-04 | scotland | 2nd January (substitute day) |
| 2028-04-14 | scotland | Good Friday |
| 2028-05-01 | scotland | Early May bank holiday |
| 2028-05-29 | scotland | Spring bank holiday |
| 2028-08-07 | scotland | Summer bank holiday |
| 2028-11-30 | scotland | St Andrew's Day |
| 2028-12-25 | scotland | Christmas Day |
| 2028-12-26 | scotland | Boxing Day |
| 2024-01-01 | northern_ireland | New Year's Day |
| 2024-03-18 | northern_ireland | St Patrick's Day (substitute day) |
| 2024-03-29 | northern_ireland | Good Friday |
| 2024-04-01 | northern_ireland | Easter Monday |
| 2024-05-06 | northern_ireland | Early May bank holiday |
| 2024-05-27 | northern_ireland | Spring bank holiday |
| 2024-07-12 | northern_ireland | Battle of the Boyne (Orangemen's Day) |
| 2024-08-26 | northern_ireland | Summer bank holiday |
| 2024-12-25 | northern_ireland | Christmas Day |
| 2024-12-26 | northern_ireland | Boxing Day |
| 2025-01-01 | northern_ireland | New Year's Day |
| 2025-03-17 | northern_ireland | St Patrick's Day |
| 2025-04-18 | northern_ireland | Good Friday |
| 2025-04-21 | northern_ireland | Easter Monday |
| 2025-05-05 | northern_ireland | Early May bank holiday |
| 2025-05-26 | northern_ireland | Spring bank holiday |
| 2025-07-14 | northern_ireland | Battle of the Boyne (Orangemen's Day) (substitute day) |
| 2025-08-25 | northern_ireland | Summer bank holiday |
| 2025-12-25 | northern_ireland | Christmas Day |
| 2025-12-26 | northern_ireland | Boxing Day |
| 2026-01-01 | northern_ireland | New Year's Day |
| 2026-03-17 | northern_ireland | St Patrick's Day |
| 2026-04-03 | northern_ireland | Good Friday |
| 2026-04-06 | northern_ireland | Easter Monday |
| 2026-05-04 | northern_ireland | Early May bank holiday |
| 2026-05-25 | northern_ireland | Spring bank holiday |
| 2026-07-13 | northern_ireland | Battle of the Boyne (Orangemen's Day) (substitute day) |
| 2026-08-31 | northern_ireland | Summer bank holiday |
| 2026-12-25 | northern_ireland | Christmas Day |
| 2026-12-28 | northern_ireland | Boxing Day (substitute day) |
| 2027-01-01 | northern_ireland | New Year's Day |
| 2027-03-17 | northern_ireland | St Patrick's Day |
| 2027-03-26 | northern_ireland | Good Friday |
| 2027-03-29 | northern_ireland | Easter Monday |
| 2027-05-03 | northern_ireland | Early May bank holiday |
| 2027-05-31 | northern_ireland | Spring bank holiday |
| 2027-07-12 | northern_ireland | Battle of the Boyne (Orangemen's Day) |
| 2027-08-30 | northern_ireland | Summer bank holiday |
| 2027-12-27 | northern_ireland | Christmas Day (substitute day) |
| 2027-12-28 | northern_ireland | Boxing Day (substitute day) |
| 2028-01-03 | northern_ireland | New Year's Day (substitute day) |
| 2028-03-17 | northern_ireland | St Patrick's Day |
| 2028-04-14 | northern_ireland | Good Friday |
| 2028-04-17 | northern_ireland | Easter Monday |
| 2028-05-01 | northern_ireland | Early May bank holiday |
| 2028-05-29 | northern_ireland | Spring bank holiday |
| 2028-07-12 | northern_ireland | Battle of the Boyne (Orangemen's Day) |
| 2028-08-28 | northern_ireland | Summer bank holiday |
| 2028-12-25 | northern_ireland | Christmas Day |
| 2028-12-26 | northern_ireland | Boxing Day |
