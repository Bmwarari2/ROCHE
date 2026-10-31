# Statutory rates, thresholds and time limits

Every figure the law (or a tenant default the product ships) can change lives here and nowhere else
(master prompt section 18, "Statutory figures"). The seed script in `packages/db` parses the table under
**Rate table** into `rate_table`; application code reads `rate_table` and never contains these figures as
literals, and tests assert against the table, not a literal (section 7, section 20).

## Conventions

- **Format**: the table under `## Rate table` has exactly one header row and one separator row, in the
  column order `key | value | unit | valid_from | valid_to | nation | source | status`. Do not add other
  tables or text inside that section above the table.
- **key**: dotted lower_snake identifiers. The same key may appear on several rows with different
  `valid_from` dates or nations; for a given key and nation, date ranges never overlap.
- **value**: a plain number with no currency symbol or thousands separator. Money is in pounds with two
  decimals (12.71). Percentages are numbers (12.07 means 12.07%).
- **unit**: `GBP_per_hour`, `GBP_per_day`, `GBP_per_week`, `GBP_per_month`, `GBP_per_year`, `GBP`, `percent`, `days`,
  `working_days`, `working_hours`, `hours`, `minutes`, `seconds`, `weeks`, `months`, `years`, `celsius`,
  `mm`, `count`, `day_of_month`, `month_of_year`, `minute_of_day` (0 to 1439 minutes after midnight, UK local time; 07:30 is 450).
- **valid_from / valid_to**: ISO dates, inclusive. `valid_to` is `-` while the figure is current; when a
  new figure is added, the previous row's `valid_to` is set to the day before. Where a figure has no
  commencement date that matters to Harbour (a product default, or a long-standing rule whose exact start
  is not material), `valid_from` is `2000-01-01`, the register's epoch. That date is a convention, not a
  claim about when the law started.
- **nation**: `england`, `wales`, `scotland`, `northern_ireland`, `uk` or `all`. `uk` means the same figure
  applies in all four nations (directly or through parallel legislation). A figure that applies only in
  Great Britain has a row each for `england`, `wales` and `scotland`; Northern Ireland rows are added by
  the Phase 7 nation pack. Regulator, charging and NHS figures are `england` until the relevant nation
  pack adds its own rows (section 4). `all` marks a Harbour product rule or tenant default that is the
  same everywhere. Lookup takes the tenant location's nation first, then `uk`, then `all`; if nothing
  matches, the lookup fails loudly rather than guessing.
- **status**: `verified` means the value was confirmed on an official page (gov.uk, hse.gov.uk or
  legislation.gov.uk) on 2026-10-11 and the URL is in `source`; `master-prompt` means the figure is stated
  in `docs/00-MASTER-PROMPT.md` (section cited); `to-verify` means it must be confirmed before a real
  tenant relies on it (see the notes below the table).
- **Tenant defaults**: rows marked as tenant defaults in the notes seed each new tenant's settings. A
  tenant may change them within any legal limit; the change is versioned and audited.

## Rate table

| key | value | unit | valid_from | valid_to | nation | source | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| nmw.hourly.21_plus | 12.71 | GBP_per_hour | 2026-04-01 | - | uk | https://www.gov.uk/national-minimum-wage-rates; master prompt 3 | verified |
| nmw.hourly.21_plus | 12.21 | GBP_per_hour | 2025-04-01 | 2026-03-31 | uk | https://www.gov.uk/national-minimum-wage-rates | verified |
| nmw.hourly.18_to_20 | 10.85 | GBP_per_hour | 2026-04-01 | - | uk | https://www.gov.uk/national-minimum-wage-rates | verified |
| nmw.hourly.18_to_20 | 10.00 | GBP_per_hour | 2025-04-01 | 2026-03-31 | uk | https://www.gov.uk/national-minimum-wage-rates | verified |
| nmw.hourly.under_18 | 8.00 | GBP_per_hour | 2026-04-01 | - | uk | https://www.gov.uk/national-minimum-wage-rates | verified |
| nmw.hourly.under_18 | 7.55 | GBP_per_hour | 2025-04-01 | 2026-03-31 | uk | https://www.gov.uk/national-minimum-wage-rates | verified |
| nmw.hourly.apprentice | 8.00 | GBP_per_hour | 2026-04-01 | - | uk | https://www.gov.uk/national-minimum-wage-rates | verified |
| nmw.hourly.apprentice | 7.55 | GBP_per_hour | 2025-04-01 | 2026-03-31 | uk | https://www.gov.uk/national-minimum-wage-rates | verified |
| nmw.accommodation_offset.daily | 11.10 | GBP_per_day | 2026-04-01 | - | uk | https://www.gov.uk/national-minimum-wage-accommodation | verified |
| nmw.accommodation_offset.daily | 10.66 | GBP_per_day | 2025-04-01 | 2026-03-31 | uk | https://www.gov.uk/national-minimum-wage-accommodation | verified |
| nmw.accommodation_offset.weekly | 77.70 | GBP_per_week | 2026-04-01 | - | uk | https://www.gov.uk/national-minimum-wage-accommodation | verified |
| nmw.accommodation_offset.weekly | 74.62 | GBP_per_week | 2025-04-01 | 2026-03-31 | uk | https://www.gov.uk/national-minimum-wage-accommodation | verified |
| nmw.age.21_plus | 21 | years | 2024-04-01 | - | uk | https://www.gov.uk/national-minimum-wage-rates (the "21 and over" band) | verified |
| nmw.age.18_to_20 | 18 | years | 2024-04-01 | - | uk | https://www.gov.uk/national-minimum-wage-rates (the "18 to 20" band) | verified |
| nmw.apprentice.age_limit | 19 | years | 2000-01-01 | - | uk | https://www.gov.uk/national-minimum-wage-rates (apprentices aged under 19, or 19 or over in the first year) | verified |
| nmw.apprentice.first_year_months | 12 | months | 2000-01-01 | - | uk | https://www.gov.uk/national-minimum-wage-rates (the first year of the apprenticeship) | verified |
| ssp.weekly | 123.25 | GBP_per_week | 2026-04-06 | - | england | https://www.legislation.gov.uk/ukpga/1992/4/section/157 (s 157(1)(a), the sum set by S.I. 2026/148 from 6 April 2026); https://www.gov.uk/statutory-sick-pay | verified |
| ssp.weekly | 123.25 | GBP_per_week | 2026-04-06 | - | wales | https://www.legislation.gov.uk/ukpga/1992/4/section/157 (s 157(1)(a), the sum set by S.I. 2026/148 from 6 April 2026); https://www.gov.uk/statutory-sick-pay | verified |
| ssp.weekly | 123.25 | GBP_per_week | 2026-04-06 | - | scotland | https://www.legislation.gov.uk/ukpga/1992/4/section/157 (s 157(1)(a), the sum set by S.I. 2026/148 from 6 April 2026); https://www.gov.uk/statutory-sick-pay | verified |
| ssp.earnings_percentage | 80 | percent | 2026-04-06 | - | england | https://www.legislation.gov.uk/ukpga/1992/4/section/157 (s 157(1)(b) as substituted by the Employment Rights Act 2025 s 11 from 6 April 2026, S.I. 2026/373); https://www.gov.uk/employers-sick-pay; master prompt 12.3 | verified |
| ssp.earnings_percentage | 80 | percent | 2026-04-06 | - | wales | https://www.legislation.gov.uk/ukpga/1992/4/section/157 (s 157(1)(b) as substituted by the Employment Rights Act 2025 s 11 from 6 April 2026, S.I. 2026/373); https://www.gov.uk/employers-sick-pay; master prompt 12.3 | verified |
| ssp.earnings_percentage | 80 | percent | 2026-04-06 | - | scotland | https://www.legislation.gov.uk/ukpga/1992/4/section/157 (s 157(1)(b) as substituted by the Employment Rights Act 2025 s 11 from 6 April 2026, S.I. 2026/373); https://www.gov.uk/employers-sick-pay; master prompt 12.3 | verified |
| ssp.waiting_days | 0 | days | 2026-04-06 | - | england | https://www.legislation.gov.uk/ukpga/1992/4/section/155 (s 155(1), the waiting days, omitted by the Employment Rights Act 2025 s 10(6) from 6 April 2026, S.I. 2026/373); master prompt 3, 12.3 | verified |
| ssp.waiting_days | 0 | days | 2026-04-06 | - | wales | https://www.legislation.gov.uk/ukpga/1992/4/section/155 (s 155(1), the waiting days, omitted by the Employment Rights Act 2025 s 10(6) from 6 April 2026, S.I. 2026/373); master prompt 3, 12.3 | verified |
| ssp.waiting_days | 0 | days | 2026-04-06 | - | scotland | https://www.legislation.gov.uk/ukpga/1992/4/section/155 (s 155(1), the waiting days, omitted by the Employment Rights Act 2025 s 10(6) from 6 April 2026, S.I. 2026/373); master prompt 3, 12.3 | verified |
| ssp.max_weeks | 28 | weeks | 2000-01-01 | - | uk | https://www.legislation.gov.uk/ukpga/1992/4/section/155 (s 155(4): the entitlement limit is 28 times the weekly rate); https://www.gov.uk/employers-sick-pay | verified |
| smp.standard_weekly | 194.32 | GBP_per_week | 2026-04-05 | - | uk | https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2026-to-2027 ("The Statutory Maternity Pay (SMP) rate applies from 5 April 2026"); https://www.gov.uk/maternity-pay-leave/pay | verified |
| smp.standard_weekly | 187.18 | GBP_per_week | 2025-04-06 | 2026-04-04 | uk | https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2025-to-2026 ("These rates apply from 6 April 2025") | verified |
| family_pay.standard_weekly | 194.32 | GBP_per_week | 2026-04-06 | - | uk | https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2026-to-2027 (paternity, adoption, shared parental and parental bereavement pay; "All other rates apply from 6 April 2026") | verified |
| family_pay.standard_weekly | 187.18 | GBP_per_week | 2025-04-06 | 2026-04-05 | uk | https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2025-to-2026 ("These rates apply from 6 April 2025") | verified |
| family_pay.earnings_percentage | 90 | percent | 2000-01-01 | - | uk | https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2026-to-2027 (90% of the employee's average weekly earnings for each kind); https://www.gov.uk/maternity-pay-leave/pay | verified |
| smp.higher_rate_weeks | 6 | weeks | 2000-01-01 | - | uk | https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2026-to-2027 (maternity and adoption pay: the first 6 weeks at 90%); https://www.gov.uk/maternity-pay-leave/pay | verified |
| smp.total_weeks | 39 | weeks | 2007-04-01 | - | uk | https://www.gov.uk/maternity-pay-leave/pay ("paid for up to 39 weeks") | verified |
| holiday.accrual_percentage.irregular_hours | 12.07 | percent | 2024-04-01 | - | england | master prompt 12.3 (holiday reforms 2024) | master-prompt |
| holiday.accrual_percentage.irregular_hours | 12.07 | percent | 2024-04-01 | - | wales | master prompt 12.3 (holiday reforms 2024) | master-prompt |
| holiday.accrual_percentage.irregular_hours | 12.07 | percent | 2024-04-01 | - | scotland | master prompt 12.3 (holiday reforms 2024) | master-prompt |
| holiday.statutory_weeks | 5.6 | weeks | 2009-04-01 | - | uk | https://www.gov.uk/holiday-entitlement-rights | verified |
| holiday.statutory_max_days | 28 | days | 2009-04-01 | - | uk | https://www.gov.uk/holiday-entitlement-rights | verified |
| wtr.weekly_max_hours | 48 | hours | 1998-10-01 | - | uk | https://www.gov.uk/maximum-weekly-working-hours; master prompt 12.3 | verified |
| wtr.reference_period_weeks | 17 | weeks | 1998-10-01 | - | uk | https://www.gov.uk/maximum-weekly-working-hours | verified |
| wtr.daily_rest_hours | 11 | hours | 1998-10-01 | - | uk | https://www.gov.uk/rest-breaks-work; master prompt 12.3 | verified |
| wtr.break_minutes | 20 | minutes | 1998-10-01 | - | uk | https://www.gov.uk/rest-breaks-work; master prompt 12.3 | verified |
| wtr.break_threshold_hours | 6 | hours | 1998-10-01 | - | uk | https://www.gov.uk/rest-breaks-work; master prompt 12.3 | verified |
| wtr.weekly_rest_hours | 24 | hours | 1998-10-01 | - | uk | https://www.gov.uk/rest-breaks-work | verified |
| wtr.fortnightly_rest_hours | 48 | hours | 1998-10-01 | - | uk | https://www.gov.uk/rest-breaks-work | verified |
| wtr.night_work.average_max_hours | 8 | hours | 1998-10-01 | - | uk | https://www.gov.uk/night-working-hours; master prompt 12.3 | verified |
| wtr.night_work.reference_period_weeks | 17 | weeks | 1998-10-01 | - | uk | https://www.gov.uk/night-working-hours | verified |
| wtr.young_worker.daily_max_hours | 8 | hours | 1998-10-01 | - | uk | https://www.gov.uk/maximum-weekly-working-hours | verified |
| wtr.young_worker.weekly_max_hours | 40 | hours | 1998-10-01 | - | uk | https://www.gov.uk/maximum-weekly-working-hours | verified |
| wtr.young_worker.break_minutes | 30 | minutes | 1998-10-01 | - | uk | https://www.gov.uk/rest-breaks-work/young-workers | verified |
| wtr.young_worker.break_threshold_hours | 4.5 | hours | 1998-10-01 | - | uk | https://www.gov.uk/rest-breaks-work/young-workers | verified |
| wtr.young_worker.daily_rest_hours | 12 | hours | 1998-10-01 | - | uk | https://www.gov.uk/rest-breaks-work/young-workers | verified |
| wtr.young_worker.weekly_rest_hours | 48 | hours | 1998-10-01 | - | uk | https://www.gov.uk/rest-breaks-work/young-workers | verified |
| wtr.reference_period_weeks.special_case | 26 | weeks | 1998-10-01 | - | uk | https://www.legislation.gov.uk/uksi/1998/1833/regulation/4 (reg 4(5): 26 weeks for a worker within reg 21, such as care in residential institutions) | verified |
| wtr.reference_period_weeks.agreement_max | 52 | weeks | 1998-10-01 | - | uk | https://www.legislation.gov.uk/uksi/1998/1833/regulation/23 (reg 23(b): "a period not exceeding 52 weeks"); https://www.gov.uk/night-working-hours/hours-and-limits (night average up to 52 weeks by agreement) | verified |
| wtr.opt_out.default_notice_days | 7 | days | 1999-12-17 | - | uk | https://www.legislation.gov.uk/uksi/1998/1833/regulation/5 (reg 5(2)(b): not less than seven days' notice in writing unless the agreement provides otherwise) | verified |
| wtr.opt_out.max_notice_months | 3 | months | 1999-12-17 | - | uk | https://www.legislation.gov.uk/uksi/1998/1833/regulation/5 (reg 5(3): the notice period "shall not exceed three months") | verified |
| wtr.night_time.default_start_minute | 1380 | minute_of_day | 1998-10-01 | - | uk | https://www.legislation.gov.uk/uksi/1998/1833/regulation/2 ("night time": in default of a relevant agreement, 11 p.m. to 6 a.m.); https://www.gov.uk/night-working-hours | verified |
| wtr.night_time.default_end_minute | 360 | minute_of_day | 1998-10-01 | - | uk | https://www.legislation.gov.uk/uksi/1998/1833/regulation/2 ("night time": in default of a relevant agreement, 11 p.m. to 6 a.m.); https://www.gov.uk/night-working-hours | verified |
| wtr.night_time.min_hours | 7 | hours | 1998-10-01 | - | uk | https://www.legislation.gov.uk/uksi/1998/1833/regulation/2 ("night time" agreed: "not less than seven hours") | verified |
| wtr.night_time.core_start_minute | 0 | minute_of_day | 1998-10-01 | - | uk | https://www.legislation.gov.uk/uksi/1998/1833/regulation/2 ("night time" agreed must include the period between midnight and 5 a.m.) | verified |
| wtr.night_time.core_end_minute | 300 | minute_of_day | 1998-10-01 | - | uk | https://www.legislation.gov.uk/uksi/1998/1833/regulation/2 ("night time" agreed must include the period between midnight and 5 a.m.) | verified |
| wtr.night_worker.min_night_hours | 3 | hours | 1998-10-01 | - | uk | https://www.legislation.gov.uk/uksi/1998/1833/regulation/2 ("night worker": at least three hours of daily working time during night time, as a normal course); https://www.gov.uk/night-working-hours | verified |
| wtr.night_work.hazard_max_hours | 8 | hours | 1998-10-01 | - | uk | https://www.legislation.gov.uk/uksi/1998/1833/regulation/6 (reg 6(7): special hazards or heavy physical or mental strain, not more than eight hours in any 24-hour period with night work) | verified |
| wtr.young_worker.until_age_years | 18 | years | 1998-10-01 | - | uk | https://www.legislation.gov.uk/uksi/1998/1833/regulation/2 ("young worker": attained the age of 15 but not the age of 18) | verified |
| wtr.young_worker.restricted_start_minute | 1320 | minute_of_day | 2003-04-06 | - | uk | https://www.legislation.gov.uk/uksi/1998/1833/regulation/2 ("the restricted period": 10 p.m. to 6 a.m.); https://www.gov.uk/night-working-hours/young-workers | verified |
| wtr.young_worker.restricted_end_minute | 360 | minute_of_day | 2003-04-06 | - | uk | https://www.legislation.gov.uk/uksi/1998/1833/regulation/2 ("the restricted period": 10 p.m. to 6 a.m.); https://www.gov.uk/night-working-hours/young-workers | verified |
| wtr.young_worker.restricted_late_start_minute | 1380 | minute_of_day | 2003-04-06 | - | uk | https://www.legislation.gov.uk/uksi/1998/1833/regulation/2 ("the restricted period": 11 p.m. to 7 a.m. where the contract provides for work after 10 p.m.) | verified |
| wtr.young_worker.restricted_late_end_minute | 420 | minute_of_day | 2003-04-06 | - | uk | https://www.legislation.gov.uk/uksi/1998/1833/regulation/2 ("the restricted period": 11 p.m. to 7 a.m. where the contract provides for work after 10 p.m.) | verified |
| wtr.young_worker.weekly_rest_reduced_min_hours | 36 | hours | 2003-04-06 | - | uk | https://www.legislation.gov.uk/uksi/1998/1833/regulation/11 (reg 11(8)(b): reduced for technical or organisation reasons "but not to less than 36 consecutive hours") | verified |
| awr.qualifying_weeks | 12 | weeks | 2011-10-01 | - | uk | https://www.legislation.gov.uk/uksi/2010/93/regulation/7 (reg 7(2): 12 continuous calendar weeks in the same role with the same hirer); master prompt 12.3 | verified |
| awr.break_reset_weeks | 6 | weeks | 2011-10-01 | - | uk | https://www.legislation.gov.uk/uksi/2010/93/regulation/7 (reg 7(8)(a): a break for any reason of not more than six calendar weeks keeps continuity) | verified |
| awr.sickness_pause_max_weeks | 28 | weeks | 2011-10-01 | - | uk | https://www.legislation.gov.uk/uksi/2010/93/regulation/7 (reg 7(8)(b) and (9)(a): a break wholly for sickness or injury keeps continuity only if it is 28 calendar weeks or less) | verified |
| absence.bradford.window_weeks | 52 | weeks | 2000-01-01 | - | all | Tenant default: the Bradford factor has no statutory basis (phase-2.md, slice 6; H-583) | to-verify |
| auto_enrolment.earnings_trigger | 10000.00 | GBP_per_year | 2026-04-06 | - | uk | https://www.gov.uk/government/publications/review-of-the-automatic-enrolment-earnings-trigger-and-qualifying-earnings-band-for-202627/review-of-the-automatic-enrolment-earnings-trigger-and-qualifying-earnings-band-for-202627; master prompt 12.3 | verified |
| auto_enrolment.qualifying_earnings.lower | 6240.00 | GBP_per_year | 2026-04-06 | - | uk | https://www.gov.uk/government/publications/review-of-the-automatic-enrolment-earnings-trigger-and-qualifying-earnings-band-for-202627/review-of-the-automatic-enrolment-earnings-trigger-and-qualifying-earnings-band-for-202627 | verified |
| auto_enrolment.qualifying_earnings.upper | 50270.00 | GBP_per_year | 2026-04-06 | - | uk | https://www.gov.uk/government/publications/review-of-the-automatic-enrolment-earnings-trigger-and-qualifying-earnings-band-for-202627/review-of-the-automatic-enrolment-earnings-trigger-and-qualifying-earnings-band-for-202627 | verified |
| auto_enrolment.earnings_trigger.weekly | 192.00 | GBP_per_week | 2024-04-06 | - | uk | https://www.thepensionsregulator.gov.uk/en/employers/new-employers/im-an-employer-who-has-to-provide-a-pension/declare-your-compliance/ongoing-duties-for-employers/earnings-thresholds (the 2026-2027 table; the DWP review keeps the 2025-26 values for 2026-27) | verified |
| auto_enrolment.earnings_trigger.monthly | 833.00 | GBP_per_month | 2024-04-06 | - | uk | https://www.thepensionsregulator.gov.uk/en/employers/new-employers/im-an-employer-who-has-to-provide-a-pension/declare-your-compliance/ongoing-duties-for-employers/earnings-thresholds (the 2026-2027 table; the DWP review keeps the 2025-26 values for 2026-27) | verified |
| auto_enrolment.qualifying_earnings.lower.weekly | 120.00 | GBP_per_week | 2024-04-06 | - | uk | https://www.thepensionsregulator.gov.uk/en/employers/new-employers/im-an-employer-who-has-to-provide-a-pension/declare-your-compliance/ongoing-duties-for-employers/earnings-thresholds (the 2026-2027 table; the DWP review keeps the 2025-26 values for 2026-27) | verified |
| auto_enrolment.qualifying_earnings.lower.monthly | 520.00 | GBP_per_month | 2024-04-06 | - | uk | https://www.thepensionsregulator.gov.uk/en/employers/new-employers/im-an-employer-who-has-to-provide-a-pension/declare-your-compliance/ongoing-duties-for-employers/earnings-thresholds (the 2026-2027 table; the DWP review keeps the 2025-26 values for 2026-27) | verified |
| auto_enrolment.qualifying_earnings.upper.weekly | 967.00 | GBP_per_week | 2024-04-06 | - | uk | https://www.thepensionsregulator.gov.uk/en/employers/new-employers/im-an-employer-who-has-to-provide-a-pension/declare-your-compliance/ongoing-duties-for-employers/earnings-thresholds (the 2026-2027 table; the DWP review keeps the 2025-26 values for 2026-27) | verified |
| auto_enrolment.qualifying_earnings.upper.monthly | 4189.00 | GBP_per_month | 2024-04-06 | - | uk | https://www.thepensionsregulator.gov.uk/en/employers/new-employers/im-an-employer-who-has-to-provide-a-pension/declare-your-compliance/ongoing-duties-for-employers/earnings-thresholds (the 2026-2027 table; the DWP review keeps the 2025-26 values for 2026-27) | verified |
| auto_enrolment.eligible_min_age | 22 | years | 2012-10-01 | - | uk | https://www.legislation.gov.uk/ukpga/2008/30/section/3 (s 3(1)(a): aged at least 22, and (b) not reached pensionable age) | verified |
| auto_enrolment.min_age | 16 | years | 2012-10-01 | - | uk | https://www.legislation.gov.uk/ukpga/2008/30/section/1 (s 1(1)(b): a jobholder is aged at least 16 and under 75) | verified |
| auto_enrolment.max_age | 74 | years | 2012-10-01 | - | uk | https://www.legislation.gov.uk/ukpga/2008/30/section/1 (s 1(1)(b): under 75, so 74 is the highest age) | verified |
| sponsor.salary_floor.care_worker | 25000.00 | GBP_per_year | 2025-07-22 | - | uk | master prompt 12.1; shown as the lower going rate for SOC 6135 and 6136 at https://www.gov.uk/government/publications/skilled-worker-visa-going-rates-for-eligible-occupations/skilled-worker-visa-going-rates-for-eligible-occupation-codes | master-prompt |
| sponsor.salary_floor.care_worker_hourly | 12.82 | GBP_per_hour | 2025-07-22 | - | uk | https://www.gov.uk/government/publications/skilled-worker-visa-going-rates-for-eligible-occupations/skilled-worker-visa-going-rates-for-eligible-occupation-codes | to-verify |
| sponsor.change_report_working_days | 10 | working_days | 2000-01-01 | - | uk | master prompt 2, 12.1 | master-prompt |
| sponsor.switching_evidence_months | 3 | months | 2025-07-22 | - | uk | master prompt 12.1 ("3-month switching evidence") | to-verify |
| sponsor.counted_weekly_hours_max | 48 | hours | 2025-07-22 | - | uk | Home Office, Workers and Temporary Workers: guidance for sponsors, salary requirements (pay counted for at most 48 hours a week) | to-verify |
| sponsor.unauthorised_absence_working_days | 10 | working_days | 2000-01-01 | - | uk | Home Office, Workers and Temporary Workers: guidance for sponsors, reporting duties (a sponsored worker absent without permission for more than 10 consecutive working days is reported) | to-verify |
| sponsor.visa_expiry_warning_days | 90 | days | 2025-01-01 | - | uk | Harbour default: how far ahead a sponsored worker's visa expiry is flagged (no statutory figure) | to-verify |
| fnc.weekly.standard | 267.68 | GBP_per_week | 2026-04-01 | - | england | https://www.gov.uk/government/news/better-community-care-thanks-to-nursing-funding-boost; master prompt 14.1 | verified |
| fnc.weekly.standard | 254.06 | GBP_per_week | 2025-04-01 | 2026-03-31 | england | https://www.gov.uk/government/news/better-community-care-thanks-to-nursing-funding-boost | verified |
| fnc.weekly.higher | 368.24 | GBP_per_week | 2026-04-01 | - | england | https://www.gov.uk/government/news/better-community-care-thanks-to-nursing-funding-boost; master prompt 14.1 | verified |
| fnc.weekly.higher | 349.50 | GBP_per_week | 2025-04-01 | 2026-03-31 | england | https://www.gov.uk/government/news/better-community-care-thanks-to-nursing-funding-boost | verified |
| pea.weekly | 31.80 | GBP_per_week | 2026-04-01 | - | england | https://www.gov.uk/government/publications/social-care-charging-for-local-authorities-2026-to-2027/social-care-charging-for-care-and-support-2026-to-2027-local-authority-circular; master prompt 14.1 | verified |
| pea.weekly | 30.65 | GBP_per_week | 2025-04-01 | 2026-03-31 | england | https://www.gov.uk/government/publications/social-care-charging-for-local-authorities-2026-to-2027/social-care-charging-for-care-and-support-2026-to-2027-local-authority-circular | verified |
| capital.upper_limit | 23250.00 | GBP | 2026-04-01 | - | england | https://www.gov.uk/government/publications/social-care-charging-for-local-authorities-2026-to-2027/social-care-charging-for-care-and-support-2026-to-2027-local-authority-circular | verified |
| capital.lower_limit | 14250.00 | GBP | 2026-04-01 | - | england | https://www.gov.uk/government/publications/social-care-charging-for-local-authorities-2026-to-2027/social-care-charging-for-care-and-support-2026-to-2027-local-authority-circular | verified |
| charging.property_disregard_weeks | 12 | weeks | 2000-01-01 | - | england | master prompt 14.1 (12-week disregard) | master-prompt |
| dwp.disability_benefit_stop_after_days | 28 | days | 2000-01-01 | - | england | master prompt 14.1 (Attendance Allowance or PIP daily living stops after 28 days of LA or NHS funding) | master-prompt |
| opg.deputy_report.cycle_months | 12 | months | 2000-01-01 | - | england | master prompt 14.3 | master-prompt |
| opg.deputy_report.cycle_months | 12 | months | 2000-01-01 | - | wales | master prompt 14.3 | master-prompt |
| homecare.minimum_price.hourly | 34.42 | GBP_per_hour | 2026-04-01 | - | england | master prompt 14.4 (Homecare Association 2026/27, reported second-hand per section 21) | to-verify |
| cma.fees_after_death.default_days | 3 | days | 2000-01-01 | - | uk | master prompt 9.2, 14.1 (CMA care homes advice) | master-prompt |
| cma.fees_after_death.backstop_days | 10 | days | 2000-01-01 | - | uk | master prompt 14.1 (CMA care homes advice) | master-prompt |
| cma.fee_review_notice_days | 28 | days | 2000-01-01 | - | uk | master prompt 9.2 (CMA care homes advice) | master-prompt |
| cma.deposit_return_days | 28 | days | 2000-01-01 | - | uk | master prompt 9.2 (CMA care homes advice) | master-prompt |
| ico.breach.report_hours | 72 | hours | 2018-05-25 | - | uk | master prompt 5.1 (UK GDPR Art 33) | master-prompt |
| dsar.response_months | 1 | months | 2018-05-25 | - | uk | master prompt 5.1 (UK GDPR Art 12) | master-prompt |
| dsar.extension_months | 2 | months | 2018-05-25 | - | uk | master prompt 5.1 (extendable to three months in total) | master-prompt |
| dp_complaint.acknowledge_days | 30 | days | 2026-06-19 | - | uk | master prompt 5.1 (Data (Use and Access) Act 2025 complaints duty) | master-prompt |
| dp_complaint.acknowledge_target_working_days | 3 | working_days | 2026-06-19 | - | uk | docs/compliance/data-protection-complaints.md section 2 (tenant default target: aim for 3 working days; no statutory figure) | to-verify |
| dp_complaint.update_interval_months | 1 | months | 2026-06-19 | - | uk | docs/compliance/data-protection-complaints.md section 2 (keep the complainant informed at least monthly; tenant default, the Act says only "keep informed") | to-verify |
| dsar.due_soon_days | 7 | days | 2018-05-25 | - | uk | Harbour default for the "due soon" warning on the DSAR register (no statutory figure) | to-verify |
| import.undo_window_days | 7 | days | 2026-10-31 | - | all | Harbour default for undoing an import batch (phase-2.md slice 9, ADR-0092; no statutory figure) | to-verify |
| import.staging_expiry_days | 7 | days | 2026-10-31 | - | all | Harbour default for data minimisation: how long an uploaded import's staged rows are kept before they are deleted unless committed or discarded first (platform.md rule 19, ADR-0092; UK GDPR Art 5(1)(c) and (e); no statutory figure) | to-verify |
| reg14.absence_notice_days | 28 | days | 2000-01-01 | - | england | master prompt 11.2 (CQC Registration Regulations 2009 reg 14) | master-prompt |
| cqc.statement_of_purpose.revision_notice_days | 28 | days | 2010-04-01 | - | england | https://www.legislation.gov.uk/uksi/2009/3112/regulation/12 (reg 12(3): written details of any revision to the statement of purpose to the Commission within 28 days of the revision); master prompt 11.2 | verified |
| riddor.report_days | 10 | days | 2013-10-01 | - | england | https://www.hse.gov.uk/riddor/when-do-i-report.htm; master prompt 11.1 | verified |
| riddor.report_days | 10 | days | 2013-10-01 | - | wales | https://www.hse.gov.uk/riddor/when-do-i-report.htm; master prompt 11.1 | verified |
| riddor.report_days | 10 | days | 2013-10-01 | - | scotland | https://www.hse.gov.uk/riddor/when-do-i-report.htm; master prompt 11.1 | verified |
| riddor.over_7_day.report_days | 15 | days | 2013-10-01 | - | england | https://www.hse.gov.uk/riddor/when-do-i-report.htm; master prompt 11.1 | verified |
| riddor.over_7_day.report_days | 15 | days | 2013-10-01 | - | wales | https://www.hse.gov.uk/riddor/when-do-i-report.htm; master prompt 11.1 | verified |
| riddor.over_7_day.report_days | 15 | days | 2013-10-01 | - | scotland | https://www.hse.gov.uk/riddor/when-do-i-report.htm; master prompt 11.1 | verified |
| riddor.over_7_day.threshold_days | 7 | days | 2013-10-01 | - | england | https://www.hse.gov.uk/riddor/when-do-i-report.htm (over-seven-day incapacitation) | verified |
| riddor.over_7_day.threshold_days | 7 | days | 2013-10-01 | - | wales | https://www.hse.gov.uk/riddor/when-do-i-report.htm (over-seven-day incapacitation) | verified |
| riddor.over_7_day.threshold_days | 7 | days | 2013-10-01 | - | scotland | https://www.hse.gov.uk/riddor/when-do-i-report.htm (over-seven-day incapacitation) | verified |
| candour.written_notification.working_days | 10 | working_days | 2000-01-01 | - | england | Tenant-configurable target, ADR-0021; regulation 20 requires "as soon as reasonably practicable"; section 21 open item | to-verify |
| candour.close_blocked_days | 14 | days | 2000-01-01 | - | england | Harbour default (#120 review round 2, M4): an incident the duty of candour holds open (no candour record where Harbour found it may apply, the record open, or someone affected not told) for longer than this many days after it happened gets an urgent task for its Registered Manager, which the task engine escalates; tenant default | to-verify |
| safeguarding.referral_hours | 24 | hours | 2000-01-01 | - | all | Tenant target: Care Act 2014 s.42 sets no time; the local authority's procedures usually say the same day (phase-2.md slice 7; H-590) | to-verify |
| complaint.acknowledge_working_days | 3 | working_days | 2000-01-01 | - | all | Tenant target: Regulation 16 sets none for independent providers (phase-2.md decisions; H-590) | to-verify |
| complaint.response_working_days | 20 | working_days | 2000-01-01 | - | all | Tenant target, as above | to-verify |
| lgsco.time_limit_months | 12 | months | 2010-10-01 | - | england | Local Government Act 1974 s.34D(4) (a complaint to the Ombudsman within 12 months of the person knowing of the matter, unless the Ombudsman decides otherwise) | to-verify |
| whistleblowing.acknowledge_working_days | 5 | working_days | 2000-01-01 | - | all | Tenant target: no statutory figure (H-590) | to-verify |
| mortality_review.due_days | 28 | days | 2000-01-01 | - | all | Tenant target: no statutory figure for care providers (H-590) | to-verify |
| missing_person.police_call_minutes | 30 | minutes | 2000-01-01 | - | all | Tenant target: the tenant's missing person policy and risk assessment; call at once when they say so (H-591) | to-verify |
| herbert_protocol.review_months | 6 | months | 2000-01-01 | - | all | Tenant target: the Herbert Protocol forms ask for regular updates but set no interval (H-591) | to-verify |
| ahra.response_days | 40 | days | 1991-11-01 | - | uk | Access to Health Records Act 1990 s.3(5) (40 days) and the Northern Ireland Order 1993 | to-verify |
| ahra.recent_record_response_days | 21 | days | 1991-11-01 | - | uk | Access to Health Records Act 1990 s.3(5)(b) (21 days where the record was made in the 40 days before the application) | to-verify |
| ahra.recent_record_days | 40 | days | 1991-11-01 | - | uk | Access to Health Records Act 1990 s.3(5)(b) | to-verify |
| speak_up.reply_token_days | 180 | days | 2000-01-01 | - | all | Harbour default: how long an anonymous reporter's reply token opens their concern after it was raised; no statutory figure (ADR-0089; H-721) | to-verify |
| coroner.prevention_report_response_days | 56 | days | 2013-07-25 | - | england | Coroners (Investigations) Regulations 2013 reg 29(3) (a response to a prevention of future deaths report within 56 days) | to-verify |
| coroner.prevention_report_response_days | 56 | days | 2013-07-25 | - | wales | Coroners (Investigations) Regulations 2013 reg 29(3) (a response to a prevention of future deaths report within 56 days) | to-verify |
| candour.prolonged_harm_days | 28 | days | 2000-01-01 | - | england | https://www.legislation.gov.uk/uksi/2014/2936/regulation/20 (reg 20(7) "prolonged pain" and "prolonged psychological harm", and reg 20(9)(a)(ii): a continuous period of at least 28 days); master prompt 11.1 | verified |
| cqc.reg18.prolonged_harm_days | 28 | days | 2010-04-01 | - | england | https://www.legislation.gov.uk/uksi/2009/3112/regulation/18 (reg 18(5)(g): prolonged pain or psychological harm, and an impairment that is not temporary, mean a continuous period of at least 28 days) | verified |
| cqc.reg18.interruption_hours | 24 | hours | 2010-04-01 | - | england | https://www.legislation.gov.uk/uksi/2009/3112/regulation/18 (reg 18(2)(g)(ii) and (iv): utilities, fire alarms or safety devices out for longer than a continuous period of 24 hours) | verified |
| dols.urgent.days | 7 | days | 2009-04-01 | - | england | https://www.legislation.gov.uk/ukpga/2005/9/schedule/A1/paragraph/78 (para 78(2) "must not exceed 7 days"); master prompt 10.4 | verified |
| dols.urgent.days | 7 | days | 2009-04-01 | - | wales | https://www.legislation.gov.uk/ukpga/2005/9/schedule/A1/paragraph/78 (para 78(2) "must not exceed 7 days"); master prompt 10.4 | verified |
| dols.urgent.extension_days | 7 | days | 2009-04-01 | - | england | https://www.legislation.gov.uk/ukpga/2005/9/schedule/A1/paragraph/85 (para 85(3) "must not exceed 7 days"); master prompt 10.4 | verified |
| dols.urgent.extension_days | 7 | days | 2009-04-01 | - | wales | https://www.legislation.gov.uk/ukpga/2005/9/schedule/A1/paragraph/85 (para 85(3) "must not exceed 7 days"); master prompt 10.4 | verified |
| dols.urgent.max_extension_requests | 1 | count | 2009-04-01 | - | england | https://www.legislation.gov.uk/ukpga/2005/9/schedule/A1/paragraph/77 (para 77(4) "Only one request under sub-paragraph (3) may be made"); master prompt 10.4 | verified |
| dols.urgent.max_extension_requests | 1 | count | 2009-04-01 | - | wales | https://www.legislation.gov.uk/ukpga/2005/9/schedule/A1/paragraph/77 (para 77(4) "Only one request under sub-paragraph (3) may be made"); master prompt 10.4 | verified |
| dols.standard.max_months | 12 | months | 2009-04-01 | - | england | https://www.legislation.gov.uk/ukpga/2005/9/schedule/A1/paragraph/42 (para 42(2)(b) "1 year, or such shorter period as may be prescribed in regulations"; para 51(2)); master prompt 10.4 | verified |
| dols.standard.max_months | 12 | months | 2009-04-01 | - | wales | https://www.legislation.gov.uk/ukpga/2005/9/schedule/A1/paragraph/42 (para 42(2)(b) "1 year, or such shorter period as may be prescribed in regulations"; para 51(2)); master prompt 10.4 | verified |
| dols.expiry_reminder_days.first | 28 | days | 2000-01-01 | - | england | Harbour tenant default (care.md section 4 rule 11; HZ-020); no statutory figure | to-verify |
| dols.expiry_reminder_days.first | 28 | days | 2000-01-01 | - | wales | Harbour tenant default (care.md section 4 rule 11; HZ-020); no statutory figure | to-verify |
| dols.expiry_reminder_days.second | 7 | days | 2000-01-01 | - | england | Harbour tenant default (care.md section 4 rule 11; HZ-020); no statutory figure | to-verify |
| dols.expiry_reminder_days.second | 7 | days | 2000-01-01 | - | wales | Harbour tenant default (care.md section 4 rule 11; HZ-020); no statutory figure | to-verify |
| outbreak.ari_cases | 2 | count | 2000-01-01 | - | england | https://www.gov.uk/guidance/report-an-outbreak-of-acute-respiratory-infection-in-an-adult-social-care-setting; master prompt 11.1 | verified |
| outbreak.ari_window_days | 5 | days | 2000-01-01 | - | england | https://www.gov.uk/guidance/report-an-outbreak-of-acute-respiratory-infection-in-an-adult-social-care-setting ("symptoms that started within 5 days of each other"); master prompt 11.1 | verified |
| outbreak.flu_confirmed_cases | 1 | count | 2026-01-15 | - | england | https://www.gov.uk/guidance/report-an-outbreak-of-acute-respiratory-infection-in-an-adult-social-care-setting ("a single confirmed case of flu in your setting") | verified |
| outbreak.diarrhoea_vomiting_cases | 2 | count | 2000-01-01 | - | england | master prompt 11.1 (2 or more linked cases) | master-prompt |
| pressure_ulcer.decision_guide_hours | 48 | hours | 2024-01-16 | - | england | https://www.gov.uk/government/publications/pressure-ulcers-how-to-safeguard-adults/safeguarding-adults-protocol-pressure-ulcers-and-raising-a-safeguarding-concern ("completed immediately or within 48 hours of identifying the pressure ulcer of concern") | verified |
| falls.monitoring_hours | 24 | hours | 2000-01-01 | - | all | Hertfordshire Care Providers Association care home falls pathway, May 2026 ("Always monitor the person for 24 hours following a fall"), https://www.hcpa.info/wp-content/uploads/2026/05/Management-of-a-person-who-has-fallen-in-a-care-home.pdf; regional source; tenant default | to-verify |
| falls.head_injury_obs.phase_1_interval_minutes | 30 | minutes | 2000-01-01 | - | all | https://www.nice.org.uk/guidance/ng232/chapter/Recommendations (1.9.11 "half-hourly for 2 hours", written for people admitted to hospital); care home default for CSO review; tenant default | to-verify |
| falls.head_injury_obs.phase_1_hours | 2 | hours | 2000-01-01 | - | all | https://www.nice.org.uk/guidance/ng232/chapter/Recommendations (1.9.11 "half-hourly for 2 hours"); care home default for CSO review; tenant default | to-verify |
| falls.head_injury_obs.phase_2_interval_minutes | 60 | minutes | 2000-01-01 | - | all | https://www.nice.org.uk/guidance/ng232/chapter/Recommendations (1.9.11 "then 1 hourly for 4 hours"); care home default for CSO review; tenant default | to-verify |
| falls.head_injury_obs.phase_2_hours | 4 | hours | 2000-01-01 | - | all | https://www.nice.org.uk/guidance/ng232/chapter/Recommendations (1.9.11 "then 1 hourly for 4 hours"); care home default for CSO review; tenant default | to-verify |
| falls.head_injury_obs.phase_3_interval_minutes | 120 | minutes | 2000-01-01 | - | all | https://www.nice.org.uk/guidance/ng232/chapter/Recommendations (1.9.11 "then 2 hourly"), until falls.monitoring_hours; care home default for CSO review; tenant default | to-verify |
| capacity_tracker.window_start_day | 8 | day_of_month | 2022-07-31 | - | england | https://www.gov.uk/government/publications/adult-social-care-provider-information-provisions-formal-notice/formal-notice-of-a-mandate-for-all-adult-social-care-providers; master prompt 11.2 | verified |
| capacity_tracker.window_end_day | 14 | day_of_month | 2022-07-31 | - | england | https://www.gov.uk/government/publications/adult-social-care-provider-information-provisions-formal-notice/formal-notice-of-a-mandate-for-all-adult-social-care-providers; master prompt 11.2 | verified |
| asc_wds.funding_completeness_percentage | 90 | percent | 2000-01-01 | - | england | master prompt 12.3 (ASC-WDS funding data standard) | master-prompt |
| dspt.submission_deadline.month | 6 | month_of_year | 2000-01-01 | - | england | master prompt 11.2 (30 June deadline) | master-prompt |
| dspt.submission_deadline.day | 30 | day_of_month | 2000-01-01 | - | england | master prompt 11.2 (30 June deadline) | master-prompt |
| cqc.rating_scale.min | 1 | count | 2000-01-01 | - | england | master prompt 11.2 (self-rating 1 to 4); CQC ratings scale: 1 inadequate, 2 requires improvement, 3 good, 4 outstanding | master-prompt |
| cqc.rating_scale.max | 4 | count | 2000-01-01 | - | england | master prompt 11.2 (self-rating 1 to 4); CQC ratings scale: 1 inadequate, 2 requires improvement, 3 good, 4 outstanding | master-prompt |
| quality.indicator.bed_days_base | 1000 | count | 2000-01-01 | - | all | master prompt 11.2 (falls per 1,000 bed-days): the multiplier for bed-day rates on the quality dashboard | master-prompt |
| quality.audit.action_due_days | 28 | days | 2000-01-01 | - | all | Harbour policy default, not a statutory figure: an audit action's due date when the auditor does not choose one; tenant default | to-verify |
| policy.read_and_sign.reminder_days | 7 | days | 2000-01-01 | - | all | Harbour policy default, not a statutory figure: how long after publication or the last reminder an unsigned policy is reminded again; tenant default | to-verify |
| policy.review_due_soon_days | 30 | days | 2000-01-01 | - | all | Harbour policy default, not a statutory figure: how long before a policy's review date it shows as due soon; tenant default | to-verify |
| policy.review_interval_months.max | 36 | months | 2000-01-01 | - | all | Harbour policy default, not a statutory figure: the longest a policy may go before its review date (Reg 17 good governance sets no interval); tenant default | to-verify |
| quality.renewal_reminder_days | 60 | days | 2000-01-01 | - | all | Harbour policy default, not a statutory figure: how long before a DSPT deadline, certificate expiry or registration renewal it shows as due soon; tenant default | to-verify |
| cyber_essentials.certificate_valid_months | 12 | months | 2000-01-01 | - | uk | https://www.ncsc.gov.uk/cyberessentials/overview (a Cyber Essentials certificate is renewed every year) | to-verify |
| ico.registration.renewal_months | 12 | months | 2000-01-01 | - | uk | https://ico.org.uk/for-organisations/data-protection-fee/ (the data protection fee is paid every year, Data Protection (Charges and Information) Regulations 2018) | to-verify |
| nmc.revalidation.practice_hours | 450 | hours | 2016-04-01 | - | uk | master prompt 12.2 | master-prompt |
| nmc.revalidation.cpd_hours | 35 | hours | 2016-04-01 | - | uk | master prompt 12.2 | master-prompt |
| nmc.revalidation.cycle_years | 3 | years | 2016-04-01 | - | uk | NMC, How to revalidate with the NMC (https://www.nmc.org.uk/revalidation/) | to-verify |
| nmc.revalidation.participatory_cpd_hours | 20 | hours | 2016-04-01 | - | uk | NMC, How to revalidate with the NMC (of the CPD hours) | to-verify |
| nmc.revalidation.feedback_count | 5 | count | 2016-04-01 | - | uk | NMC, How to revalidate with the NMC (practice-related feedback) | to-verify |
| nmc.revalidation.reflective_accounts | 5 | count | 2016-04-01 | - | uk | NMC, How to revalidate with the NMC (written reflective accounts) | to-verify |
| training.default_refresh_years | 3 | years | 2000-01-01 | - | all | master prompt 12.2 (tenant may set sooner) | master-prompt |
| training.oliver_mcgowan.refresh_years | 3 | years | 2000-01-01 | - | england | master prompt 12.2 (Oliver McGowan Code of Practice 2025) | master-prompt |
| competence.medicines.refresh_months | 12 | months | 2000-01-01 | - | all | master prompt 10.2, 12.2 (annual medicines competence) | master-prompt |
| competence.default_refresh_months | 12 | months | 2000-01-01 | - | all | Harbour default for observed competences other than medicines (no statutory figure; tenant may set sooner; H-690) | to-verify |
| retention.staff_file.birthday_age | 75 | years | 2000-01-01 | - | all | NHS Records Management Code of Practice (staff records to the 75th birthday); retention.md staff_file.to_75th_birthday | master-prompt |
| supervision.per_year | 6 | count | 2000-01-01 | - | all | master prompt 12.2 (tenant policy example) | master-prompt |
| appraisal.per_year | 1 | count | 2000-01-01 | - | all | master prompt 12.2 (tenant policy example) | master-prompt |
| document_expiry.reminder_days.first | 90 | days | 2000-01-01 | - | all | master prompt 12 rules | master-prompt |
| document_expiry.reminder_days.second | 30 | days | 2000-01-01 | - | all | master prompt 12 rules | master-prompt |
| document_expiry.reminder_days.third | 7 | days | 2000-01-01 | - | all | master prompt 12 rules | master-prompt |
| dbs.update_service.check_interval_months | 12 | months | 2000-01-01 | - | all | Tenant default: no statutory interval for Update Service status checks (phase-2.md decisions, slice 4; H-570) | to-verify |
| access.agency.post_shift_hours | 2 | hours | 2000-01-01 | - | all | master prompt 4 (agency access expires at shift end plus 2 hours) | master-prompt |
| break_glass.weekly_repeat_threshold | 3 | count | 2000-01-01 | - | all | Harbour default for flagging repeated break-glass use in the weekly report (master prompt 4 requires the report but sets no number); tenant default | to-verify |
| family_involvement.interval_months | 6 | months | 2000-01-01 | - | all | Harbour default for the family involvement record (master prompt 9.2 names the record but sets no interval); tenant default | to-verify |
| people.return_checks_due_hours | 24 | hours | 2000-01-01 | - | all | Harbour default for the checks after a return from hospital (people.md rule 10): each check is a task due this many hours after the return, escalated by the task engine when overdue; no published figure; CSO to confirm (H-85); tenant default | to-verify |
| sharing.decision_max_months | 12 | months | 2000-01-01 | - | all | Harbour default: the longest a sharing decision may last before it is renewed at review, or less where the authority it rests on ends sooner (people.md rule 13; recommended answer to H-38, 31/10/2026; UK GDPR Art 5(1)(c) and (e); no statutory figure); tenant default | to-verify |
| exit.money_and_property_return_days | 28 | days | 2000-01-01 | - | all | Harbour default matching cma.deposit_return_days (master prompt 9.2); no statutory period for returning personal money and property; tenant default | to-verify |
| downtime_pack.valid_hours | 36 | hours | 2000-01-01 | - | all | Harbour policy default, not a statutory figure: a nightly downtime pack is in date for 36 hours from its information's time, longer than the nightly interval so one failed night does not leave a home with only an out-of-date pack (master prompt 13.4 "nightly"); tenant default; CSO to confirm (H-101) | to-verify |
| downtime_pack.requests_per_hour | 30 | count | 2000-01-01 | - | all | Harbour security policy default, not a statutory figure: a member opens, prints or builds downtime packs at most 30 times an hour, as each is a whole-home record (operations.md section 12; #45 review round 1); tenant default | to-verify |
| downtime.places_confirm_due_days | 1 | days | 2000-01-01 | - | all | Harbour policy default, not a statutory figure: the task to confirm where the paper MAR and PEEPs are kept is due at the end of the day this many days after it is raised, so it does not escalate the moment it appears (operations.md section 13; #47 review round 1; HZ-008); tenant default | to-verify |
| downtime.duplicate_match_minutes | 10 | minutes | 2000-01-01 | - | all | Harbour policy default, not a statutory figure: entries for the same person and kind within this many minutes of each other are listed as possible duplicates at outage reconciliation (master prompt 13.4 back-entry workflow); tenant default | to-verify |
| downtime.max_outage_hours | 168 | hours | 2000-01-01 | - | all | Harbour policy default, not a statutory figure: an outage may run at most this many hours from its start to its end (or to now while open), so a mistyped date cannot open a window of months over which paper records and their reconciliation are read (#51 review round 1); tenant default; CSO to confirm (H-215) | to-verify |
| downtime.back_entry_due_hours | 24 | hours | 2000-01-01 | - | all | Harbour policy default, not a statutory figure: paper records from an outage are entered within 24 hours of its closure (master prompt 13.4 back-entry workflow); tenant default | to-verify |
| evidence_pack.link_expiry_days.default | 7 | days | 2000-01-01 | - | all | Harbour policy default, not a statutory figure: an inspector evidence pack link lasts 7 days unless the sender chooses otherwise (master prompt 11.2 "time-limited link"); tenant default | to-verify |
| evidence_pack.code_valid_minutes | 10 | minutes | 2000-01-01 | - | all | Harbour security policy, not a statutory figure: a one-time code for opening an evidence pack link is valid for at most 10 minutes (ADR-0050; OWASP ASVS 5.0 out-of-band verifier lifetime) | to-verify |
| evidence_pack.link_expiry_days.max | 30 | days | 2000-01-01 | - | all | Harbour policy default, not a statutory figure: the longest an evidence pack link may last (data minimisation, UK GDPR Art 5(1)(c) and (e)); tenant default | to-verify |
| ecm.tolerance_minutes.high | 15 | minutes | 2000-01-01 | - | all | master prompt 13.2 (defaults 15, 30, 60 by client risk); tenant default | master-prompt |
| ecm.tolerance_minutes.medium | 30 | minutes | 2000-01-01 | - | all | master prompt 13.2 (defaults 15, 30, 60 by client risk); tenant default | master-prompt |
| ecm.tolerance_minutes.low | 60 | minutes | 2000-01-01 | - | all | master prompt 13.2 (defaults 15, 30, 60 by client risk); tenant default | master-prompt |
| notification.missed_visit_escalation_minutes | 10 | minutes | 2000-01-01 | - | all | master prompt 9.1, 19 Phase 4 gate | master-prompt |
| task.overdue_escalation_minutes | 30 | minutes | 2000-01-01 | - | all | Harbour default for the task engine (master prompt 9.1): an overdue task escalates once to the nurse in charge; tenant default | to-verify |
| statutory_notification.escalation_minutes | 60 | minutes | 2000-01-01 | - | all | Harbour default (safety.md rule 10, HZ-013): an overdue statutory notification alerts the holders of safety.notification.submit at once and escalates to the Nominated Individual (owner role) after this many minutes unless the tenant sets its own chain; tenant default | to-verify |
| homecare.min_planned_visit_minutes | 30 | minutes | 2000-01-01 | - | england | master prompt 13.2 (NICE NG21: shorter planned visits flagged) | master-prompt |
| enquiry.first_response_working_hours | 1 | working_hours | 2000-01-01 | - | all | master prompt 13.1; tenant default | master-prompt |
| care_note.late_entry_hours | 2 | hours | 2000-01-01 | - | all | master prompt 10.1 | master-prompt |
| sync.clock_drift_flag_minutes | 5 | minutes | 2000-01-01 | - | all | master prompt 10.3 | master-prompt |
| care_plan.initial_working_days | 7 | working_days | 2000-01-01 | - | england | master prompt 9.2 (tenant default from the EHCH framework) | master-prompt |
| care_plan.review_interval_months | 1 | months | 2000-01-01 | - | all | master prompt 9.2 (monthly and on change); tenant default | master-prompt |
| care_plan.task_window_before_minutes | 30 | minutes | 2000-01-01 | - | all | Harbour default for the rounds a care plan action generates (care.md rule 14): a round may be done from this many minutes before its time; no published figure; tenant default; CSO to confirm (H-150) | to-verify |
| care_plan.task_window_after_minutes | 60 | minutes | 2000-01-01 | - | all | Harbour default for the rounds a care plan action generates (care.md rule 14): a round is on time until this many minutes after its time, then overdue, and escalates after task.overdue_escalation_minutes more; no published figure; tenant default; CSO to confirm (H-150) | to-verify |
| la_review.first_min_weeks | 6 | weeks | 2000-01-01 | - | england | master prompt 9.2 (6 to 8 weeks after start) | master-prompt |
| la_review.first_max_weeks | 8 | weeks | 2000-01-01 | - | england | master prompt 9.2 (6 to 8 weeks after start) | master-prompt |
| la_review.interval_months | 12 | months | 2000-01-01 | - | england | master prompt 9.2 (then yearly) | master-prompt |
| must.care_home.screening_interval_months | 1 | months | 2000-01-01 | - | all | master prompt 10.1 (MUST monthly in care homes) | master-prompt |
| must.medium_risk.food_record_days | 3 | days | 2000-01-01 | - | all | master prompt 10.1 | master-prompt |
| weight.default_interval_months | 1 | months | 2000-01-01 | - | all | master prompt 10.1; tenant default | master-prompt |
| weight.at_risk_interval_weeks | 1 | weeks | 2000-01-01 | - | all | master prompt 10.1; tenant default | master-prompt |
| repositioning.interval_hours.at_risk | 6 | hours | 2000-01-01 | - | all | master prompt 10.1 (4- or 6-hourly defaults; NICE CG179); tenant default | master-prompt |
| repositioning.interval_hours.high_risk | 4 | hours | 2000-01-01 | - | all | master prompt 10.1 (4- or 6-hourly defaults; NICE CG179); tenant default | master-prompt |
| bowel.no_movement_prompt_days | 3 | days | 2026-10-01 | - | all | tenant default | to-verify |
| handover.day_shift_start_minute | 480 | minute_of_day | 2026-10-01 | - | all | Harbour default (12-hour day and night shifts, day from 08:00); tenant setting for the shift handover (care.md rule 8) | to-verify |
| handover.night_shift_start_minute | 1200 | minute_of_day | 2026-10-01 | - | all | Harbour default (12-hour day and night shifts, night from 20:00); tenant setting for the shift handover (care.md rule 8) | to-verify |
| handover.acknowledgement_grace_minutes | 60 | minutes | 2026-10-01 | - | all | Harbour default: the nurse in charge is alerted once when nobody on the incoming shift has acknowledged a handover this long after its shift ended (care.md rule 8, COMMS-006, HZ-018); no published figure; tenant default; CSO to confirm (H-153) | to-verify |
| comms.family_notifications.quiet_start_minute | 1260 | minute_of_day | 2000-01-01 | - | all | Harbour tenant default for family update notifications (comms.md section 4 rule 15): from 21:00 UK time they wait; no statutory figure | to-verify |
| comms.family_notifications.quiet_end_minute | 480 | minute_of_day | 2000-01-01 | - | all | Harbour tenant default for family update notifications (comms.md section 4 rule 15): waiting notifications go at 08:00 UK time; no statutory figure | to-verify |
| ld.annual_health_check.min_age_years | 14 | years | 2000-01-01 | - | england | master prompt 10.1 (annual health check from 14) | master-prompt |
| medicines.paracetamol.min_interval_hours | 4 | hours | 2000-01-01 | - | all | master prompt 10.2 (time-critical rules) | master-prompt |
| medicines.bisphosphonate.before_food_minutes | 30 | minutes | 2000-01-01 | - | all | master prompt 10.2 (time-critical rules) | master-prompt |
| medicines.review_interval_months | 12 | months | 2000-01-01 | - | all | master prompt 10.2 (annual medication review) | master-prompt |
| medicines.ordering_cycle_days | 28 | days | 2000-01-01 | - | all | master prompt 10.2 | master-prompt |
| medicines.fridge_min_celsius | 2 | celsius | 2000-01-01 | - | all | master prompt 10.2 | master-prompt |
| medicines.fridge_max_celsius | 8 | celsius | 2000-01-01 | - | all | master prompt 10.2 | master-prompt |
| medicines.room_max_celsius | 25 | celsius | 2000-01-01 | - | all | master prompt 10.2 | master-prompt |
| loler.examination_months | 6 | months | 1998-12-05 | - | uk | master prompt 13.4 (hoists, slings and passenger lifts) | master-prompt |
| gas_safety.check_months | 12 | months | 2000-01-01 | - | uk | master prompt 13.4 | master-prompt |
| electrical.fixed_inspection_years | 5 | years | 2000-01-01 | - | uk | master prompt 13.4 (about every 5 years) | master-prompt |
| legionella.sentinel_check_months | 1 | months | 2000-01-01 | - | uk | master prompt 13.4 (HSG274) | master-prompt |
| legionella.little_used_outlet_flush_days | 7 | days | 2000-01-01 | - | uk | master prompt 13.4 (HSG274) | master-prompt |
| legionella.shower_head_descale_months | 3 | months | 2000-01-01 | - | uk | master prompt 13.4 (HSG274) | master-prompt |
| tmv.service_months | 12 | months | 2000-01-01 | - | uk | master prompt 13.4 | master-prompt |
| water.hot_min_celsius | 50 | celsius | 2000-01-01 | - | uk | master prompt 13.4 (HSG274) | master-prompt |
| water.hot_reach_seconds | 60 | seconds | 2000-01-01 | - | uk | master prompt 13.4 (within 1 minute) | master-prompt |
| water.cold_max_celsius | 20 | celsius | 2000-01-01 | - | uk | master prompt 13.4 (HSG274) | master-prompt |
| water.cold_reach_seconds | 120 | seconds | 2000-01-01 | - | uk | master prompt 13.4 (within 2 minutes) | master-prompt |
| water.bath_max_celsius | 44 | celsius | 2000-01-01 | - | uk | master prompt 13.4 (HSG220) | master-prompt |
| window_restrictor.max_opening_mm | 100 | mm | 2000-01-01 | - | uk | master prompt 13.4 | master-prompt |
| fire.alarm_test_days | 7 | days | 2000-01-01 | - | uk | master prompt 13.4 (weekly) | master-prompt |
| fire.emergency_lighting_test_months | 1 | months | 2000-01-01 | - | uk | master prompt 13.4 (monthly) | master-prompt |
| fire.extinguisher_service_months | 12 | months | 2000-01-01 | - | uk | master prompt 13.4 (yearly) | master-prompt |
| bed_rail.gap_max_mm.between_bars | 120 | mm | 2000-01-01 | - | uk | https://www.gov.uk/guidance/bed-rails-management-and-safe-use; master prompt 10.1 | verified |
| bed_rail.gap_max_mm.between_bars_small_or_atypical | 60 | mm | 2000-01-01 | - | uk | https://www.gov.uk/guidance/bed-rails-management-and-safe-use; master prompt 10.1 | verified |
| bed_rail.gap_max_mm.rail_to_mattress | 120 | mm | 2000-01-01 | - | uk | https://www.gov.uk/guidance/bed-rails-management-and-safe-use (120 mm cone test) | verified |
| bed_rail.gap_max_mm.rail_end_to_headboard | 60 | mm | 2000-01-01 | - | uk | https://www.gov.uk/guidance/bed-rails-management-and-safe-use; master prompt 10.1 | verified |
| bed_rail.height_min_mm | 220 | mm | 2000-01-01 | - | uk | https://www.gov.uk/guidance/bed-rails-management-and-safe-use | verified |
| childrens.reg44.visit_interval_months | 1 | months | 2000-01-01 | - | england | master prompt 19 Phase 7 (Reg 44 monthly visits) | master-prompt |
| childrens.reg45.review_interval_months | 6 | months | 2000-01-01 | - | england | master prompt 19 Phase 7 (Reg 45 six-monthly reviews) | master-prompt |
| mobile.offline_window_days | 7 | days | 2000-01-01 | - | all | master prompt 22, ADR-0011; tenant default | master-prompt |
| mobile.held_entries_max_days | 7 | days | 2000-01-01 | - | all | Security review S2 of Care mode (care.md section 6); tenant default | to-verify |
| mobile.auto_lock_seconds.personal | 120 | seconds | 2000-01-01 | - | all | master prompt 5.3, 17.2 | master-prompt |
| mobile.auto_lock_seconds.shared | 30 | seconds | 2000-01-01 | - | all | master prompt 17.2, ADR-0011; tenant default | master-prompt |
| mobile.auto_lock_seconds.shared_max | 120 | seconds | 2000-01-01 | - | all | master prompt 17.2 (configurable from 30 seconds to 2 minutes) | master-prompt |
| session.idle_timeout_minutes | 30 | minutes | 2000-01-01 | - | all | Harbour default: a browser session unused for this long is signed out at its next request, for every role without its own row (master prompt 5.3; ASVS 5.0 V7.3; NIST SP 800-63B AAL2 asks for re-authentication after 30 minutes of inactivity); mobile sessions use mobile.auto_lock_seconds instead; policy value, not statutory; tenant default | to-verify |
| session.idle_timeout_minutes.owner | 15 | minutes | 2000-01-01 | - | all | Harbour default for the owner role, which reaches every record, setting and the full export (NIST SP 800-63B AAL3 asks for 15 minutes); policy value, not statutory; tenant default | to-verify |
| session.idle_timeout_minutes.group_executive | 15 | minutes | 2000-01-01 | - | all | Harbour default for the group executive role, which reads every location's records (NIST SP 800-63B AAL3 asks for 15 minutes); policy value, not statutory; tenant default | to-verify |
| session.idle_timeout_floor_minutes | 5 | minutes | 2000-01-01 | - | all | Harbour floor on every idle timeout figure, so no row or organisation setting signs browser sessions out in under 5 minutes (#40 review); policy value, not statutory | to-verify |
| session.idle_timeout_ceiling_minutes | 720 | minutes | 2000-01-01 | - | all | Harbour ceiling on every idle timeout figure: a session lasts 12 hours from its last refresh anyway (platform.md, Identity); policy value, not statutory | to-verify |
| account_deletion.confirmation_days | 30 | days | 2000-01-01 | - | all | master prompt 17.3 | master-prompt |
| invitation.expiry_hours | 72 | hours | 2000-01-01 | - | all | Harbour default: how long an invitation link to join an organisation works before it lapses (platform.md, Invitations); single use; no published figure; policy value, not statutory; tenant default | to-verify |
| invitation.expiry_hours_max | 168 | hours | 2000-01-01 | - | all | Harbour ceiling on the organisation's invitation.expiry_hours, so no organisation keeps an invitation link working for more than 7 days (#43 review); policy value, not statutory | to-verify |
| invitation.unlinked_sign_in_hours | 24 | hours | 2000-01-01 | - | all | Harbour default: a sign-in that no membership or operator record names, older than this, is deleted by the nightly sweep (left only if the process stopped between creating it and linking it; #43 review round 2); policy value, not statutory | to-verify |
| export.link_expiry_hours | 72 | hours | 2000-01-01 | - | all | Harbour default: how long a ready full tenant export can be downloaded before the file is deleted (master prompt 5.1 asks for delivery by expiring link but sets no period; platform-completions.md rule 12); policy value, not statutory; tenant default | to-verify |
| export.link_expiry_hours_max | 168 | hours | 2000-01-01 | - | all | Harbour ceiling on the tenant's export.link_expiry_hours setting, so no tenant can keep a full export downloadable for more than 7 days (platform-completions.md rule 12; security review); policy value, not statutory | to-verify |
| break_glass.search_max_per_day | 5 | count | 2000-01-01 | - | all | Harbour default: break-glass searches one user may run in any 24 hours before further searches are refused and the data protection lead is told (platform-completions.md rule 9; security review); policy value, not statutory; tenant default | to-verify |
| search.requests_per_minute | 30 | count | 2000-01-01 | - | all | Harbour default: searches one member may run in a minute before further searches are refused for a moment (platform-completions.md section 10s, part 2; #93 security review), so search cannot sweep the records a name at a time; policy value, not statutory; tenant default | to-verify |
| dpia.review_interval_months | 12 | months | 2000-01-01 | - | all | DPIA template section 8 ("at least annually"); UK GDPR Art 35(11) requires a review at least when the risk changes but sets no interval, https://www.legislation.gov.uk/eur/2016/679/article/35 (platform-completions.md rule 22); tenant default | to-verify |
| sub_processor.notice_days | 30 | days | 2000-01-01 | - | all | DPA template clause 6.2 (bracketed default, solicitor to confirm, H-32): notice before a new or replacement sub-processor, and the window for objecting (platform-completions.md rule 24); contractual, not statutory; tenant setting from the tenant's DPA | to-verify |
| benchmark.occupancy_percentage.low | 86 | percent | 2000-01-01 | - | uk | master prompt 13.1 (sector context, about 86 to 89%) | master-prompt |
| benchmark.occupancy_percentage.high | 89 | percent | 2000-01-01 | - | uk | master prompt 13.1 (sector context, about 86 to 89%) | master-prompt |
| benchmark.staff_cost_percentage_of_income | 55 | percent | 2000-01-01 | - | uk | master prompt 14.4 (target band around 55%) | master-prompt |
| benchmark.agency_cost_percentage_of_staff_cost | 3 | percent | 2000-01-01 | - | uk | master prompt 14.4 (sector 3%) | master-prompt |
| benchmark.weekly_fee.local_authority | 1100.00 | GBP_per_week | 2000-01-01 | - | uk | master prompt 14.4 (sector context, about 1,100) | master-prompt |
| benchmark.weekly_fee.self_pay | 1460.00 | GBP_per_week | 2000-01-01 | - | uk | master prompt 14.4 (sector context, about 1,460) | master-prompt |

## Notes on to-verify items

- `sharing.decision_max_months` (12): every decision to share a person's record with a family
  member, representative, professional or link ends within this many months of its start, and no
  later than the end date of the legal authority it rests on, and is renewed at review (H-38). A
  Harbour default with no statutory figure; a tenant may set a shorter period. The DPO confirms it
  at the testing phase.
- `dp_complaint.acknowledge_target_working_days` (3), `dp_complaint.update_interval_months` (1),
  `dsar.due_soon_days` (7) and `import.undo_window_days` (7): Harbour defaults with no statutory
  figure (Phase 2 slice 9). The Act sets only the 30-day acknowledgement and "keep informed"; the
  DSAR warning and the import undo window are product choices. A tenant may override each; the DPO
  confirms the defaults (H-610).
- `import.staging_expiry_days` (7): how long an uploaded import's staged rows (personal data in
  quarantine, never yet anyone's record) are kept before the nightly sweep deletes them, unless the
  batch is committed or discarded first, which deletes them at once (Phase 2 slice 26). A data
  minimisation default, not a statutory figure: long enough to correct a file over a working week,
  short enough that an abandoned upload does not linger. A tenant may shorten it; the DPO confirms
  it (H-681).
- `sponsor.salary_floor.care_worker_hourly` (12.82): the gov.uk going-rates page lists £25,000 a year
  (£12.82 an hour) as the lower going rate for occupation codes 6135 and 6136, but does not say which
  column applies to care workers, and the page shows no effective date (last updated 22 July 2025, used
  as `valid_from`). Confirm the applicable rate and its start date with the Home Office sponsor guidance.
- `sponsor.unauthorised_absence_working_days` (10) and `sponsor.visa_expiry_warning_days` (90, a Harbour
  default): confirm the absence reporting threshold against the current guidance for sponsors and the
  warning window with the organisation's HR lead before the sponsor module is used (H-900, H-902).
- `sponsor.switching_evidence_months` (3): section 12.1 asks for "3-month switching evidence" without
  defining it. It is read here as the evidence period for in-country switching into the care worker
  route. Confirm the rule and its start date before the sponsor module (Phase 2) uses it.
- `homecare.minimum_price.hourly` (34.42): stated in section 14.4 but flagged in section 21 as reported
  second-hand. The Homecare Association publishes it; it is not a gov.uk figure. Confirm against the
  Homecare Association 2026/27 publication. It is context for unit economics, not a statutory rate.
- `candour.close_blocked_days` (14): no statutory figure. How long an incident may stay open on the
  duty of candour before its Registered Manager is given an urgent task (safety.md section 5, part 5,
  review round 2; HZ-013). A tenant default for the CSO to confirm (H-480).
- `candour.written_notification.working_days` (10): regulation 20 says "as soon as reasonably
  practicable" and sets no number of days. 10 working days is a tenant-configurable target (ADR-0021),
  never presented as a statutory deadline. Brian to confirm the value to encode (Appendix open question).
- `dols.expiry_reminder_days.first` (28) and `.second` (7): when the DoLS register reminds the
  Registered Manager before an authorisation ends (care.md section 4 rule 11, HZ-020). No statutory
  figure exists; they are tenant defaults for the tenant's DoLS lead to confirm (human action H-64). A
  reminder that would fall before an authorisation starts (an urgent authorisation is shorter than
  28 days) fires when it starts.
- `statutory_notification.escalation_minutes` (60): how long an overdue statutory notification
  waits before the default escalation chain tells the Nominated Individual (the owner role), after
  the holders of `safety.notification.submit` were told at once (safety.md rule 10, HZ-013). No
  statutory figure exists; a tenant may replace the chain (`safety.notification.overdue`) or the
  figure. For the CSO and the tenant to confirm (human action H-69).
- `falls.monitoring_hours` (24) and `falls.head_injury_obs.*` (30 minutes for 2 hours, 60 minutes for
  4 hours, then 120 minutes): NICE NG232 recommendation 1.9.11 gives the observation frequency for
  people admitted to hospital with a head injury and a GCS score of 15; NICE gives no care home
  schedule. The 24-hour monitoring period comes from a regional care home pathway (Hertfordshire
  Care Providers Association, May 2026). Harbour uses them as defaults after a fall with a head
  injury or anticoagulant or antiplatelet treatment (safety.md rule 12) until the CSO confirms or
  replaces them (human action H-66). Each tenant's clinical lead may set its own.
- `bowel.no_movement_prompt_days` (3): the number of days without a recorded bowel movement before
  the bowel chart prompts staff (care.md section 4 rule 6 calls it the 3-day prompt). It is a tenant
  default, not a clinical threshold from a published source; the tenant's clinical lead confirms it
  or sets a different value.
- `handover.day_shift_start_minute` (480, 08:00) and `handover.night_shift_start_minute` (1200,
  20:00): when the default day and night shifts start, which sets the window each handover compiles
  from. A common care home pattern, not a published figure. A location whose staff start at another
  time, or work three shifts (early, late and night), must have its own pattern set before go-live
  (HZ-018); rotas (Phase 2) then define shifts per location.
- `handover.acknowledgement_grace_minutes` (60): how long after a shift ends the nurse in charge on
  duty is alerted, once, that nobody on the incoming shift has acknowledged its handover. Only an
  acknowledgement made at or after the shift's end that covers every item the reader can see counts
  ([care.md](care.md) rule 8). No published figure sets it; it is a Harbour default for the CSO to
  confirm or change (human action H-153), and each organisation may set its own.
- `care_plan.task_window_before_minutes` (30) and `care_plan.task_window_after_minutes` (60): the
  window around each round a care plan action generates ([care.md](care.md) rule 14). A round may be
  done from 30 minutes before its time and is on time until 60 minutes after; it is then overdue and
  escalates once after `task.overdue_escalation_minutes`. Each window is worked out from the real
  instants of the round and its neighbours, never from the clock face: where rounds come closer
  together than the window is long (hourly checks, or two times an hour apart that a clock change
  brings together), each side is cut to under half the real gap, so no instant is inside two rounds'
  windows and no window is ever nothing; rounds under 10 minutes apart are refused when the plan is
  written and merged where a clock change makes them one instant (HZ-004). No published figure sets them; they are Harbour defaults for the CSO to confirm or
  change (human action H-150), and each organisation may set its own.
- `break_glass.weekly_repeat_threshold` (3): the number of break-glass openings by one user in a week,
  or of different users opening one person's record in a week, at which the weekly report flags the
  pattern (master prompt section 4 asks for the report, not a number). It is a tenant default; the
  tenant's data protection lead confirms it (human action H-58).
- `family_involvement.interval_months` (6): how often the family involvement record falls due when
  the person wants their family or representative involved (master prompt section 9.2 names the
  record without an interval). The care plan review and the local authority review are separate
  clocks. Tenant default, confirmed by the Registered Manager (H-58).
- `people.return_checks_due_hours` (24): when each check after a return from hospital falls due
  (medicines against the discharge letter, allergies, resuscitation decisions, IDDSI levels, skin,
  belongings). No published figure sets it; a day is the Harbour default so the checks are done on
  the shift after the return, with the task engine escalating an overdue check. The CSO confirms
  or changes it (human action H-85).
- `comms.family_notifications.quiet_start_minute` (1260, 21:00) and `.quiet_end_minute` (480,
  08:00): family update notifications (email, SMS and push) found in this window wait until it ends
  (comms.md section 4 rule 15). They are never urgent, so nothing bypasses the window. Harbour
  default, not a published figure; the tenant confirms or changes it (human action H-107), and a
  family member may set a stricter window of their own.
- `exit.money_and_property_return_days` (28): the service level for returning personal money,
  property and keys after a discharge, transfer or death. No statute sets one; the default mirrors
  the CMA deposit-return period (`cma.deposit_return_days`) so the two clocks agree. Tenant default
  (H-58); the escalation goes to the Registered Manager, it is not a legal deadline.
- `mobile.held_entries_max_days` (7): how long a device holds entries that had not uploaded when the
  session ended, encrypted and with nothing else from the care record, for their owner to sign in
  again and send them, before the hold escalates to a manager (HZ-006, HZ-040; [care.md](care.md)
  section 6). The device shows a final warning naming the count during the last day, then says a
  manager must resolve the entries, with a local notification at each step. The server uses the
  same figure: the Registered Manager's task for a held device falls due at the hold's start plus
  this many days, and the task engine escalates it when overdue (clinical review round 4, H2).
  Nothing is deleted when it runs out (security review round 3, M3): the entries stay until their owner sends them or the
  owner or a manager deletes them with a recorded reason. One day until the device has read the
  figure; the seed refuses a value outside 1 to 31 days. No statute sets it: it balances losing
  care records against keeping personal data on a device whose session has ended. The default
  matches the offline window. Tenant default, to be confirmed by the DPO with the CSO, with whether
  clinical entries may ever be deleted automatically (H-124).
- `sync.clock_drift_flag_minutes` (5) is also the tolerance for a typed event time on the phone: a
  time later than the device clock by more than this is refused and never moved to an earlier day
  (HZ-010, clinical review round 3 H1). The device reads and caches it, and allows no tolerance
  until it has read the figure. `mobile.offline_window_days` is refused at seeding outside 1 to 31
  days, and the token route uses a one-day window with an alert when it meets a bad value
  (security review round 3, L3).
- `downtime_pack.valid_hours` (36), `downtime.back_entry_due_hours` (24) and
  `downtime.duplicate_match_minutes` (10): policy defaults for the downtime pack
  ([operations.md](operations.md) rules 2, 10 and 14). A pack is in date for this many hours from
  the time its information was read (the server's read time, or a kiosk's last sync). The figure is
  longer than the nightly interval, so one failed nightly job does not leave the home with only an
  out-of-date pack; after it, every page says in words that it is out of date, and during a
  declared outage every page says it is the latest available and that anything since is on paper
  (HZ-021). The CSO confirms the figure and the wording (H-101). Paper records from an outage are
  due within `downtime.back_entry_due_hours` of the outage's closure; overdue back-entry escalates
  to the Registered Manager. Entries for one person and kind within
  `downtime.duplicate_match_minutes` of each other are listed as possible duplicates. An outage
  runs at most `downtime.max_outage_hours` (168) from its start to its end, or to now while open;
  a longer one is refused on declaring, closing and correcting. No statute
  sets any of these figures; the tenant's business continuity lead confirms them (H-98).
- `downtime.places_confirm_due_days` (1): a policy default, not a statutory figure. The task asking
  the Registered Manager to confirm where the paper MAR and PEEPs are kept is due at the end of the
  UK day this many days after it is raised (H-201).
- `downtime_pack.requests_per_hour` (30): a security policy default, not a statutory figure. Each
  member opens, prints or builds downtime packs at most this many times an hour (a pack holds the
  whole home's records), counted per member in Postgres like the transfer pack limit; a pack is
  reused while nothing it was built from has changed ([operations.md](operations.md) section 12).
- `evidence_pack.link_expiry_days.default` (7) and `.max` (30): policy defaults for the time-limited
  link to an inspector evidence pack ([quality.md](quality.md) rule 7). The sender may choose a
  shorter or longer expiry up to the maximum; a tenant may lower the maximum. No statute or CQC
  guidance sets a period; the data protection lead confirms them (human action H-96).
- `evidence_pack.code_valid_minutes` (10): how long a one-time code for opening an evidence pack
  link stays valid ([quality.md](quality.md) rule 8, ADR-0050). A security policy value, not a
  tenant preference: a tenant may shorten it, never lengthen it past 10 minutes
  (`EVIDENCE_CODE_MAX_VALID_MINUTES`). Codes are 6 digits, single-use and stored hashed.

- `export.link_expiry_hours` (72): how long a ready full tenant export stays downloadable before
  the file is deleted (platform-completions.md rule 12). The master prompt asks for an expiring
  link without a period. The link alone never opens the file (the requester signs in again with
  step-up), so the period limits how long a copy sits in storage rather than how long a leaked
  link works. A policy value, not a statutory figure: the tenant may shorten or lengthen it, and a
  new export is always free. Confirmed by the tenant's data protection lead (H-118).
- `export.link_expiry_hours_max` (168): the ceiling on `export.link_expiry_hours`. A tenant may
  shorten the expiry or lengthen it up to 7 days, never beyond, so a full copy of every record
  cannot sit in storage for weeks. Harbour policy, confirmed by Brian with the DPO (H-118).
- `break_glass.search_max_per_day` (5): how many break-glass searches one user may run in any
  24 hours. Break-glass search exists to find one person in an emergency; more than a handful a
  day looks like browsing, so further searches are refused and the data protection lead is told.
  Tenant default, confirmed by the tenant's data protection lead (H-118).
- `search.requests_per_minute` (30): how many searches one member may run in a minute. A person
  looking for someone runs a few searches; dozens a minute looks like sweeping the records a name at
  a time, so further searches wait (429 with Retry-After). Tenant default, confirmed by the tenant's
  data protection lead (H-118).
- `dpia.review_interval_months` (12): the yearly re-review of a signed DPIA (platform-completions.md
  rule 22). UK GDPR Art 35(11) requires a review "at least when there is a change of the risk"
  and sets no interval; the yearly review comes from Harbour's DPIA template (section 8, "at least
  annually") and common ICO practice. Tenant default, confirmed by the DPO (H-118).
- `sub_processor.notice_days` (30): the notice Thapsus gives before a new or replacement
  sub-processor processes a tenant's data, which is also the window in which the tenant may object
  (DPA template clause 6.2, bracketed until the solicitor confirms it, H-32). It is contractual,
  so a tenant whose signed DPA says otherwise has its own value; it is never a statutory period.
- `session.idle_timeout_minutes` (30), `.owner` and `.group_executive` (15): how long a browser
  session may go unused before the next request signs it out (platform.md, Identity). **Not
  enforced** until the environment turns it on (`SESSION_IDLE_TIMEOUT`), which waits for HZ-111's
  controls and the CSO's and DPO's decision (H-353). Each role may have its own row
  (`session.idle_timeout_minutes.<role key>`); a member holding several roles gets the strictest,
  kept between `session.idle_timeout_floor_minutes` (5) and `session.idle_timeout_ceiling_minutes`
  (720); a missing or invalid figure takes the default, and with no valid default the timeout is
  not enforced. The figures follow NIST SP 800-63B (AAL2 and AAL3); no UK rule sets
  one. Mobile sessions are not timed out by the server: the device auto-lock covers them, and
  unsent entries must still upload after a shift without signal (HZ-110). Tenant default,
  confirmed by the tenant's data protection lead (H-350).
- `invitation.expiry_hours` (72) and `invitation.expiry_hours_max` (168): how long an invitation
  link works (platform.md, Invitations and MFA enrolment), and the ceiling on an organisation's own
  figure. Long enough to cover a weekend, short enough that a forwarded or old email is soon
  useless; the link is single use, a new invitation revokes the old one, and a lapsed one is
  swept nightly and its address cleared. Tenant default, confirmed by the tenant's data protection
  lead (H-355). `invitation.unlinked_sign_in_hours` (24) is how old an unlinked sign-in must be
  before the nightly sweep deletes it: long enough that an acceptance in progress is never caught.

- Quality Phase 2 (slice 8, [quality.md](quality.md) section 17): `quality.audit.action_due_days`
  (28), `policy.read_and_sign.reminder_days` (7), `policy.review_due_soon_days` (30),
  `policy.review_interval_months.max` (36) and `quality.renewal_reminder_days` (60) are Harbour
  defaults each tenant may change; no law sets them (H-603). `cyber_essentials.certificate_valid_months`
  (12) and `ico.registration.renewal_months` (12) are to be confirmed on the NCSC and ICO pages
  before a tenant relies on them (H-604).

## Other notes

- `ssp.*` rows from 6 April 2026: confirmed on legislation.gov.uk on 31 October 2026. The
  Employment Rights Act 2025 ss 10 and 11 (commenced 6 April 2026 by S.I. 2026/373) omitted the
  waiting days (Social Security Contributions and Benefits Act 1992 s 155(1)) and the lower
  earnings limit (Schedule 11 para 2(c)), made a period of incapacity one day or more
  (s 152(2)), and set the weekly rate as the lower of £123.25 (S.I. 2026/148) and 80% of normal
  weekly earnings (s 157(1)). `ssp.max_weeks` is the multiplier of the weekly rate in the
  entitlement limit (s 155(4)). Payments are rounded up to the next penny (SSP (General)
  Regulations 1982 reg 11). `pea.weekly` uses 1 April 2026: the circular applies it "for the
  financial year 2026 to 2027" without naming a day, and many councils apply it from the benefit uprating
  week. `capital.*` rows start at 1 April 2026 because only the 2026/27 circular was checked; the same
  values have applied for many years and earlier rows can be added if historical charging is imported.
- `sponsor.salary_floor.care_worker` uses the master prompt's figure; its `valid_from` comes from the
  going-rates page's last update (22 July 2025) and should be confirmed with the to-verify hourly row.
- Great Britain-only employment figures (`ssp.*` day-one rules, `holiday.accrual_percentage.*`,
  `riddor.*`) have no Northern Ireland row yet. Northern Ireland has its own legislation; the NI nation
  pack (Phase 7) adds the rows once confirmed.
- `capacity_tracker.window_end_day` (14): if the 14th falls on a weekend or public holiday, the window
  ends on the next working day (formal notice). The scheduler applies that rule; the table holds the day.
- `bed_rail.*`: MHRA gives these as "under" values (strictly less than the figure); `height_min_mm` is
  measured without mattress compression. The guidance warns not to rely on measurements alone.
- `ecm.tolerance_minutes.*`: section 13.2 gives defaults of 15, 30 and 60 minutes "per client risk"
  without mapping them to risk levels. Harbour maps the tightest window to the highest-risk clients
  (high 15, medium 30, low 60) so that a late visit to a high-risk person alarms soonest. Tenants can
  change each value per client.
- `repositioning.interval_hours.*`: the master prompt gives 4- and 6-hourly defaults; the mapping (6
  hours for people at risk, 4 hours for people at high risk) follows NICE CG179. Clinical review by the
  tenant's clinical lead sets the actual interval per person.
- Guaranteed-hours and short-notice cancellation payment figures (Employment Rights Act 2025, from 2027)
  and Fair Pay Agreement rates are not yet set; add rows when regulations are made.
- `dols.*` statutory rows were confirmed on legislation.gov.uk (Mental Capacity Act 2005 Schedule A1,
  paragraphs 42, 51, 77, 78 and 85) on 11 October 2026 and moved from `master-prompt` to `verified`.
  The Mental Capacity (Amendment) Act 2019 (Liberty Protection Safeguards) has not replaced
  Schedule A1. `dols.standard.max_months` stores "1 year" as 12 months; the end is computed in UK
  time, falling back to the last day of a shorter month, so it is never late.
- `cqc.reg18.*` and `candour.prolonged_harm_days`: the regulations define prolonged pain, prolonged
  psychological harm and an impairment that is not temporary as "a continuous period of at least 28
  days" (CQC (Registration) Regulations 2009 reg 18(5)(g); Regulated Activities Regulations 2014
  reg 20(7) and (9)(a)(ii)). The utility and safety-device interruptions in reg 18(2)(g) count only
  when "longer than" 24 continuous hours.
- `outbreak.ari_window_days` (5): UKHSA says "symptoms that started within 5 days of each other".
  Harbour reads this as onset dates at most 5 UK calendar days apart, and counts cases that could be
  linked by spread in the setting ("If in doubt, report as an outbreak"). `outbreak.flu_confirmed_cases`
  (1) is UKHSA's "a single confirmed case of flu in your setting". `outbreak.diarrhoea_vomiting_cases`
  stays `master-prompt`: no national UKHSA definition for adult social care was found, so linkage is a
  staff decision recorded on each case (human action H-65).
- `pressure_ulcer.decision_guide_hours` (48): DHSC, "Pressure ulcers: how to safeguard adults"
  (January 2024, updated June 2025), which replaced the 2018 protocol withdrawn on 26 June 2023.
- `cqc.statement_of_purpose.revision_notice_days` (28): CQC (Registration) Regulations 2009
  regulation 12(3), "The registered person must provide written details of any revision to the
  statement of purpose to the Commission within 28 days of any such revision", read on
  legislation.gov.uk on 11 October 2026 (no outstanding effects listed). `valid_from` is the
  regulations' commencement for the clock's purposes (1 April 2010, as the other `cqc.*` rows).
  England only; Wales, Scotland and Northern Ireland have their own regulators and rules (Phase 7
  nation packs).
- Working time rows added by Phase 2 slice 5 (`wtr.reference_period_weeks.special_case`,
  `.agreement_max`, `wtr.opt_out.*`, `wtr.night_time.*`, `wtr.night_worker.min_night_hours`,
  `wtr.night_work.hazard_max_hours`, `wtr.young_worker.until_age_years`,
  `wtr.young_worker.restricted_*` and `wtr.young_worker.weekly_rest_reduced_min_hours`) were read
  on legislation.gov.uk (Working Time Regulations 1998, regulations 2, 4, 5, 6, 11, 23, 27A; no
  outstanding effects listed) and the gov.uk night working pages on 31 October 2026, not on
  11 October. `valid_from` is the regulations' commencement (1 October 1998), the date regulation 5
  took its present form (17 December 1999), or the date the young worker rules were inserted
  (6 April 2003). The young-worker age was planned for slice 6; slice 5 adds it because the
  under-18 rules need it first. Northern Ireland has parallel figures in the Working Time
  Regulations (Northern Ireland) 2016, so the rows are `uk` like the earlier `wtr.*` rows. The
  figures are statutory, so `resolveWorkingTimeRates` ignores tenant overrides; what an employer
  may agree (night time, reference periods) is the tenant's working-time setting
  ([scheduling.md](scheduling.md) section 4). How the rules are read is for the employment law
  adviser to confirm (H-580).
- Pay rows added by Phase 2 slice 6 and checked on 31 October 2026: `smp.standard_weekly` and
  `family_pay.standard_weekly` (gov.uk "Rates and thresholds for employers" 2025 to 2026 and 2026 to
  2027: £187.18 from 6 April 2025; for 2026 to 2027 "The Statutory Maternity Pay (SMP) rate
  applies from 5 April 2026. All other rates apply from 6 April 2026", so maternity pay has its
  own row); `family_pay.earnings_percentage`, `smp.higher_rate_weeks` and `smp.total_weeks`
  (gov.uk); `awr.*` (Agency Workers Regulations 2010 reg 7 on legislation.gov.uk); the
  auto-enrolment age bands (Pensions Act 2008 ss 1 and 3). The per-period auto-enrolment
  thresholds were read in The Pensions Regulator's 2026-2027 table (the statutory regulator's own
  page, treated as an official source here); their `valid_from` of 6 April 2024 rests on the DWP
  reviews keeping the values, and only the 2026-27 table was read. Statutory family payments are
  rounded up to the next penny (SMP (General) Regulations 1986 reg 28 and the equivalents for the
  other kinds). `absence.bradford.window_weeks` is a tenant default with no statutory basis (H-583).
- Retention periods are not in this table; they live in `docs/specs/retention.md`.
