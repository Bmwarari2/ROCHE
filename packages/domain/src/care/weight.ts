/**
 * Weight chart frequency (care.md section 4 rule 6): every `weight.default_interval_months` months,
 * or every `weight.at_risk_interval_weeks` weeks while the latest MUST result is medium or high.
 * Both are tenant defaults from the rate table.
 */

import { addDaysToDate, addMonthsToDate, isIsoDate, type WeightInterval } from "./assessment";
import type { CareRates } from "./rates";

const DAYS_PER_WEEK = 7;

/** `latestMustBand` is null when the person has no MUST result yet. */
export function weightInterval(
  latestMustBand: "low" | "medium" | "high" | null,
  rates: Pick<CareRates, "weightDefaultIntervalMonths" | "weightAtRiskIntervalWeeks">,
): WeightInterval {
  if (latestMustBand === "medium" || latestMustBand === "high") {
    return { unit: "weeks", value: rates.weightAtRiskIntervalWeeks };
  }
  return { unit: "months", value: rates.weightDefaultIntervalMonths };
}

/** The date the next weight is due, from the date of the last one (yyyy-mm-dd). */
export function nextWeightDueOn(lastWeighedOn: string, interval: WeightInterval): string {
  if (!isIsoDate(lastWeighedOn)) throw new RangeError(`Not a date: ${lastWeighedOn}`);
  return interval.unit === "weeks"
    ? addDaysToDate(lastWeighedOn, interval.value * DAYS_PER_WEEK)
    : addMonthsToDate(lastWeighedOn, interval.value);
}
