/**
 * The rate-table figures the care rules read (care.md section 4, rates.md). Nothing in the care
 * module holds one of these as a literal: callers resolve them once per request with
 * `resolveCareRates` (tenant override, then nation, then `uk`, then `all`) and pass them in.
 */

import { type RateNation, type RateRow, resolveRate } from "../platform/rates";

export const CARE_RATE_KEYS = {
  lateEntryHours: "care_note.late_entry_hours",
  clockDriftMinutes: "sync.clock_drift_flag_minutes",
  mustScreeningIntervalMonths: "must.care_home.screening_interval_months",
  mustMediumRiskFoodRecordDays: "must.medium_risk.food_record_days",
  weightDefaultIntervalMonths: "weight.default_interval_months",
  weightAtRiskIntervalWeeks: "weight.at_risk_interval_weeks",
  repositioningAtRiskHours: "repositioning.interval_hours.at_risk",
  repositioningHighRiskHours: "repositioning.interval_hours.high_risk",
  bowelNoMovementPromptDays: "bowel.no_movement_prompt_days",
} as const;

export type CareRateName = keyof typeof CARE_RATE_KEYS;

export type CareRates = { readonly [K in CareRateName]: number };

/** Resolves every care figure for a tenant location on a date; fails loudly if one is missing. */
export function resolveCareRates(
  rows: readonly RateRow[],
  nation: Exclude<RateNation, "uk" | "all">,
  on: string,
  tenantId: string | null,
): CareRates {
  const entries = (Object.keys(CARE_RATE_KEYS) as CareRateName[]).map(
    (name) => [name, resolveRate(rows, CARE_RATE_KEYS[name], nation, on, tenantId).value] as const,
  );
  return Object.fromEntries(entries) as CareRates;
}
