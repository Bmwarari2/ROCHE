/**
 * The rate-table figures the working time rules read (scheduling.md section 4, rates.md). Nothing
 * in the scheduling module holds one of these as a literal (`literals.test.ts` fails if one
 * appears): callers resolve them once per check with `resolveWorkingTimeRates` and pass them in.
 *
 * Every figure here is statutory (Working Time Regulations 1998), so a tenant row never loosens
 * it: the lookup ignores tenant overrides. What an employer may agree (night time, reference
 * periods, when weekly rest periods start) is the tenant's working-time setting, checked against
 * these figures, not a rate-table override.
 */

import { type RateNation, type RateRow, resolveRate } from "../platform/rates";

export const WORKING_TIME_RATE_KEYS = {
  weeklyMaxHours: "wtr.weekly_max_hours",
  referencePeriodWeeks: "wtr.reference_period_weeks",
  specialCaseReferencePeriodWeeks: "wtr.reference_period_weeks.special_case",
  agreementMaxReferencePeriodWeeks: "wtr.reference_period_weeks.agreement_max",
  optOutDefaultNoticeDays: "wtr.opt_out.default_notice_days",
  optOutMaxNoticeMonths: "wtr.opt_out.max_notice_months",
  dailyRestHours: "wtr.daily_rest_hours",
  weeklyRestHours: "wtr.weekly_rest_hours",
  fortnightlyRestHours: "wtr.fortnightly_rest_hours",
  breakMinutes: "wtr.break_minutes",
  breakThresholdHours: "wtr.break_threshold_hours",
  nightDefaultStartMinute: "wtr.night_time.default_start_minute",
  nightDefaultEndMinute: "wtr.night_time.default_end_minute",
  nightMinHours: "wtr.night_time.min_hours",
  nightCoreStartMinute: "wtr.night_time.core_start_minute",
  nightCoreEndMinute: "wtr.night_time.core_end_minute",
  nightWorkerMinNightHours: "wtr.night_worker.min_night_hours",
  nightAverageMaxHours: "wtr.night_work.average_max_hours",
  nightReferencePeriodWeeks: "wtr.night_work.reference_period_weeks",
  nightHazardMaxHours: "wtr.night_work.hazard_max_hours",
  youngUntilAgeYears: "wtr.young_worker.until_age_years",
  youngDailyMaxHours: "wtr.young_worker.daily_max_hours",
  youngWeeklyMaxHours: "wtr.young_worker.weekly_max_hours",
  youngBreakMinutes: "wtr.young_worker.break_minutes",
  youngBreakThresholdHours: "wtr.young_worker.break_threshold_hours",
  youngDailyRestHours: "wtr.young_worker.daily_rest_hours",
  youngWeeklyRestHours: "wtr.young_worker.weekly_rest_hours",
  youngWeeklyRestReducedMinHours: "wtr.young_worker.weekly_rest_reduced_min_hours",
  youngRestrictedStartMinute: "wtr.young_worker.restricted_start_minute",
  youngRestrictedEndMinute: "wtr.young_worker.restricted_end_minute",
  youngRestrictedLateStartMinute: "wtr.young_worker.restricted_late_start_minute",
  youngRestrictedLateEndMinute: "wtr.young_worker.restricted_late_end_minute",
} as const;

export type WorkingTimeRateName = keyof typeof WORKING_TIME_RATE_KEYS;

export type WorkingTimeRates = { readonly [K in WorkingTimeRateName]: number };

/**
 * Resolves every working time figure for a location's nation on a date (nation, then `uk`); fails
 * loudly with `RateNotFoundError` if one is missing rather than guessing.
 */
export function resolveWorkingTimeRates(
  rows: readonly RateRow[],
  nation: Exclude<RateNation, "uk" | "all">,
  on: string,
): WorkingTimeRates {
  const entries = (Object.keys(WORKING_TIME_RATE_KEYS) as WorkingTimeRateName[]).map(
    (name) =>
      [name, resolveRate(rows, WORKING_TIME_RATE_KEYS[name], nation, on, null).value] as const,
  );
  return Object.fromEntries(entries) as WorkingTimeRates;
}
