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
- **unit**: `GBP_per_hour`, `GBP_per_day`, `GBP_per_week`, `GBP_per_year`, `GBP`, `percent`, `days`,
  `working_days`, `working_hours`, `hours`, `minutes`, `seconds`, `weeks`, `months`, `years`, `celsius`,
  `mm`, `count`, `day_of_month`, `month_of_year`.
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
| ssp.weekly | 123.25 | GBP_per_week | 2026-04-06 | - | england | https://www.gov.uk/statutory-sick-pay | verified |
| ssp.weekly | 123.25 | GBP_per_week | 2026-04-06 | - | wales | https://www.gov.uk/statutory-sick-pay | verified |
| ssp.weekly | 123.25 | GBP_per_week | 2026-04-06 | - | scotland | https://www.gov.uk/statutory-sick-pay | verified |
| ssp.earnings_percentage | 80 | percent | 2026-04-06 | - | england | https://www.gov.uk/employers-sick-pay; master prompt 12.3 | verified |
| ssp.earnings_percentage | 80 | percent | 2026-04-06 | - | wales | https://www.gov.uk/employers-sick-pay; master prompt 12.3 | verified |
| ssp.earnings_percentage | 80 | percent | 2026-04-06 | - | scotland | https://www.gov.uk/employers-sick-pay; master prompt 12.3 | verified |
| ssp.waiting_days | 0 | days | 2026-04-06 | - | england | master prompt 3, 12.3 (SSP from day one) | master-prompt |
| ssp.waiting_days | 0 | days | 2026-04-06 | - | wales | master prompt 3, 12.3 (SSP from day one) | master-prompt |
| ssp.waiting_days | 0 | days | 2026-04-06 | - | scotland | master prompt 3, 12.3 (SSP from day one) | master-prompt |
| ssp.max_weeks | 28 | weeks | 2000-01-01 | - | uk | https://www.gov.uk/employers-sick-pay | verified |
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
| awr.qualifying_weeks | 12 | weeks | 2011-10-01 | - | uk | master prompt 12.3 (AWR 2010) | master-prompt |
| auto_enrolment.earnings_trigger | 10000.00 | GBP_per_year | 2026-04-06 | - | uk | https://www.gov.uk/government/publications/review-of-the-automatic-enrolment-earnings-trigger-and-qualifying-earnings-band-for-202627/review-of-the-automatic-enrolment-earnings-trigger-and-qualifying-earnings-band-for-202627; master prompt 12.3 | verified |
| auto_enrolment.qualifying_earnings.lower | 6240.00 | GBP_per_year | 2026-04-06 | - | uk | https://www.gov.uk/government/publications/review-of-the-automatic-enrolment-earnings-trigger-and-qualifying-earnings-band-for-202627/review-of-the-automatic-enrolment-earnings-trigger-and-qualifying-earnings-band-for-202627 | verified |
| auto_enrolment.qualifying_earnings.upper | 50270.00 | GBP_per_year | 2026-04-06 | - | uk | https://www.gov.uk/government/publications/review-of-the-automatic-enrolment-earnings-trigger-and-qualifying-earnings-band-for-202627/review-of-the-automatic-enrolment-earnings-trigger-and-qualifying-earnings-band-for-202627 | verified |
| sponsor.salary_floor.care_worker | 25000.00 | GBP_per_year | 2025-07-22 | - | uk | master prompt 12.1; shown as the lower going rate for SOC 6135 and 6136 at https://www.gov.uk/government/publications/skilled-worker-visa-going-rates-for-eligible-occupations/skilled-worker-visa-going-rates-for-eligible-occupation-codes | master-prompt |
| sponsor.salary_floor.care_worker_hourly | 12.82 | GBP_per_hour | 2025-07-22 | - | uk | https://www.gov.uk/government/publications/skilled-worker-visa-going-rates-for-eligible-occupations/skilled-worker-visa-going-rates-for-eligible-occupation-codes | to-verify |
| sponsor.change_report_working_days | 10 | working_days | 2000-01-01 | - | uk | master prompt 2, 12.1 | master-prompt |
| sponsor.switching_evidence_months | 3 | months | 2025-07-22 | - | uk | master prompt 12.1 ("3-month switching evidence") | to-verify |
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
| reg14.absence_notice_days | 28 | days | 2000-01-01 | - | england | master prompt 11.2 (CQC Registration Regulations 2009 reg 14) | master-prompt |
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
| candour.prolonged_harm_days | 28 | days | 2000-01-01 | - | england | master prompt 11.1 (prolonged pain or psychological harm 28 days or more) | master-prompt |
| dols.urgent.days | 7 | days | 2009-04-01 | - | england | master prompt 10.4 | master-prompt |
| dols.urgent.days | 7 | days | 2009-04-01 | - | wales | master prompt 10.4 | master-prompt |
| dols.urgent.extension_days | 7 | days | 2009-04-01 | - | england | master prompt 10.4 (one 7-day extension) | master-prompt |
| dols.urgent.extension_days | 7 | days | 2009-04-01 | - | wales | master prompt 10.4 (one 7-day extension) | master-prompt |
| dols.standard.max_months | 12 | months | 2009-04-01 | - | england | master prompt 10.4 | master-prompt |
| dols.standard.max_months | 12 | months | 2009-04-01 | - | wales | master prompt 10.4 | master-prompt |
| outbreak.ari_cases | 2 | count | 2000-01-01 | - | england | https://www.gov.uk/guidance/report-an-outbreak-of-acute-respiratory-infection-in-an-adult-social-care-setting; master prompt 11.1 | verified |
| outbreak.ari_window_days | 5 | days | 2000-01-01 | - | england | https://www.gov.uk/guidance/report-an-outbreak-of-acute-respiratory-infection-in-an-adult-social-care-setting; master prompt 11.1 | verified |
| outbreak.diarrhoea_vomiting_cases | 2 | count | 2000-01-01 | - | england | master prompt 11.1 (2 or more linked cases) | master-prompt |
| capacity_tracker.window_start_day | 8 | day_of_month | 2022-07-31 | - | england | https://www.gov.uk/government/publications/adult-social-care-provider-information-provisions-formal-notice/formal-notice-of-a-mandate-for-all-adult-social-care-providers; master prompt 11.2 | verified |
| capacity_tracker.window_end_day | 14 | day_of_month | 2022-07-31 | - | england | https://www.gov.uk/government/publications/adult-social-care-provider-information-provisions-formal-notice/formal-notice-of-a-mandate-for-all-adult-social-care-providers; master prompt 11.2 | verified |
| asc_wds.funding_completeness_percentage | 90 | percent | 2000-01-01 | - | england | master prompt 12.3 (ASC-WDS funding data standard) | master-prompt |
| dspt.submission_deadline.month | 6 | month_of_year | 2000-01-01 | - | england | master prompt 11.2 (30 June deadline) | master-prompt |
| dspt.submission_deadline.day | 30 | day_of_month | 2000-01-01 | - | england | master prompt 11.2 (30 June deadline) | master-prompt |
| nmc.revalidation.practice_hours | 450 | hours | 2016-04-01 | - | uk | master prompt 12.2 | master-prompt |
| nmc.revalidation.cpd_hours | 35 | hours | 2016-04-01 | - | uk | master prompt 12.2 | master-prompt |
| training.default_refresh_years | 3 | years | 2000-01-01 | - | all | master prompt 12.2 (tenant may set sooner) | master-prompt |
| training.oliver_mcgowan.refresh_years | 3 | years | 2000-01-01 | - | england | master prompt 12.2 (Oliver McGowan Code of Practice 2025) | master-prompt |
| competence.medicines.refresh_months | 12 | months | 2000-01-01 | - | all | master prompt 10.2, 12.2 (annual medicines competence) | master-prompt |
| supervision.per_year | 6 | count | 2000-01-01 | - | all | master prompt 12.2 (tenant policy example) | master-prompt |
| appraisal.per_year | 1 | count | 2000-01-01 | - | all | master prompt 12.2 (tenant policy example) | master-prompt |
| document_expiry.reminder_days.first | 90 | days | 2000-01-01 | - | all | master prompt 12 rules | master-prompt |
| document_expiry.reminder_days.second | 30 | days | 2000-01-01 | - | all | master prompt 12 rules | master-prompt |
| document_expiry.reminder_days.third | 7 | days | 2000-01-01 | - | all | master prompt 12 rules | master-prompt |
| access.agency.post_shift_hours | 2 | hours | 2000-01-01 | - | all | master prompt 4 (agency access expires at shift end plus 2 hours) | master-prompt |
| ecm.tolerance_minutes.high | 15 | minutes | 2000-01-01 | - | all | master prompt 13.2 (defaults 15, 30, 60 by client risk); tenant default | master-prompt |
| ecm.tolerance_minutes.medium | 30 | minutes | 2000-01-01 | - | all | master prompt 13.2 (defaults 15, 30, 60 by client risk); tenant default | master-prompt |
| ecm.tolerance_minutes.low | 60 | minutes | 2000-01-01 | - | all | master prompt 13.2 (defaults 15, 30, 60 by client risk); tenant default | master-prompt |
| notification.missed_visit_escalation_minutes | 10 | minutes | 2000-01-01 | - | all | master prompt 9.1, 19 Phase 4 gate | master-prompt |
| task.overdue_escalation_minutes | 30 | minutes | 2000-01-01 | - | all | Harbour default for the task engine (master prompt 9.1): an overdue task escalates once to the nurse in charge; tenant default | to-verify |
| homecare.min_planned_visit_minutes | 30 | minutes | 2000-01-01 | - | england | master prompt 13.2 (NICE NG21: shorter planned visits flagged) | master-prompt |
| enquiry.first_response_working_hours | 1 | working_hours | 2000-01-01 | - | all | master prompt 13.1; tenant default | master-prompt |
| care_note.late_entry_hours | 2 | hours | 2000-01-01 | - | all | master prompt 10.1 | master-prompt |
| sync.clock_drift_flag_minutes | 5 | minutes | 2000-01-01 | - | all | master prompt 10.3 | master-prompt |
| care_plan.initial_working_days | 7 | working_days | 2000-01-01 | - | england | master prompt 9.2 (tenant default from the EHCH framework) | master-prompt |
| care_plan.review_interval_months | 1 | months | 2000-01-01 | - | all | master prompt 9.2 (monthly and on change); tenant default | master-prompt |
| la_review.first_min_weeks | 6 | weeks | 2000-01-01 | - | england | master prompt 9.2 (6 to 8 weeks after start) | master-prompt |
| la_review.first_max_weeks | 8 | weeks | 2000-01-01 | - | england | master prompt 9.2 (6 to 8 weeks after start) | master-prompt |
| la_review.interval_months | 12 | months | 2000-01-01 | - | england | master prompt 9.2 (then yearly) | master-prompt |
| must.care_home.screening_interval_months | 1 | months | 2000-01-01 | - | all | master prompt 10.1 (MUST monthly in care homes) | master-prompt |
| must.medium_risk.food_record_days | 3 | days | 2000-01-01 | - | all | master prompt 10.1 | master-prompt |
| weight.default_interval_months | 1 | months | 2000-01-01 | - | all | master prompt 10.1; tenant default | master-prompt |
| weight.at_risk_interval_weeks | 1 | weeks | 2000-01-01 | - | all | master prompt 10.1; tenant default | master-prompt |
| repositioning.interval_hours.at_risk | 6 | hours | 2000-01-01 | - | all | master prompt 10.1 (4- or 6-hourly defaults; NICE CG179); tenant default | master-prompt |
| repositioning.interval_hours.high_risk | 4 | hours | 2000-01-01 | - | all | master prompt 10.1 (4- or 6-hourly defaults; NICE CG179); tenant default | master-prompt |
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
| mobile.auto_lock_seconds.personal | 120 | seconds | 2000-01-01 | - | all | master prompt 5.3, 17.2 | master-prompt |
| mobile.auto_lock_seconds.shared | 30 | seconds | 2000-01-01 | - | all | master prompt 17.2, ADR-0011; tenant default | master-prompt |
| mobile.auto_lock_seconds.shared_max | 120 | seconds | 2000-01-01 | - | all | master prompt 17.2 (configurable from 30 seconds to 2 minutes) | master-prompt |
| account_deletion.confirmation_days | 30 | days | 2000-01-01 | - | all | master prompt 17.3 | master-prompt |
| benchmark.occupancy_percentage.low | 86 | percent | 2000-01-01 | - | uk | master prompt 13.1 (sector context, about 86 to 89%) | master-prompt |
| benchmark.occupancy_percentage.high | 89 | percent | 2000-01-01 | - | uk | master prompt 13.1 (sector context, about 86 to 89%) | master-prompt |
| benchmark.staff_cost_percentage_of_income | 55 | percent | 2000-01-01 | - | uk | master prompt 14.4 (target band around 55%) | master-prompt |
| benchmark.agency_cost_percentage_of_staff_cost | 3 | percent | 2000-01-01 | - | uk | master prompt 14.4 (sector 3%) | master-prompt |
| benchmark.weekly_fee.local_authority | 1100.00 | GBP_per_week | 2000-01-01 | - | uk | master prompt 14.4 (sector context, about 1,100) | master-prompt |
| benchmark.weekly_fee.self_pay | 1460.00 | GBP_per_week | 2000-01-01 | - | uk | master prompt 14.4 (sector context, about 1,460) | master-prompt |

## Notes on to-verify items

- `sponsor.salary_floor.care_worker_hourly` (12.82): the gov.uk going-rates page lists £25,000 a year
  (£12.82 an hour) as the lower going rate for occupation codes 6135 and 6136, but does not say which
  column applies to care workers, and the page shows no effective date (last updated 22 July 2025, used
  as `valid_from`). Confirm the applicable rate and its start date with the Home Office sponsor guidance.
- `sponsor.switching_evidence_months` (3): section 12.1 asks for "3-month switching evidence" without
  defining it. It is read here as the evidence period for in-country switching into the care worker
  route. Confirm the rule and its start date before the sponsor module (Phase 2) uses it.
- `homecare.minimum_price.hourly` (34.42): stated in section 14.4 but flagged in section 21 as reported
  second-hand. The Homecare Association publishes it; it is not a gov.uk figure. Confirm against the
  Homecare Association 2026/27 publication. It is context for unit economics, not a statutory rate.
- `candour.written_notification.working_days` (10): regulation 20 says "as soon as reasonably
  practicable" and sets no number of days. 10 working days is a tenant-configurable target (ADR-0021),
  never presented as a statutory deadline. Brian to confirm the value to encode (Appendix open question).

## Other notes

- Dates inferred rather than read from the source page: `ssp.*` rows use 6 April 2026 (the start of the
  2026/27 tax year, when the Employment Rights Act 2025 SSP changes take effect); the gov.uk SSP pages
  confirm the figures but not the date. `pea.weekly` uses 1 April 2026: the circular applies it "for the
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
- Retention periods are not in this table; they live in `docs/specs/retention.md`.
