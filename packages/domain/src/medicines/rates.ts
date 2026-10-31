/**
 * The rate-table figures the medicines rules read (medicines.md section 4, rates.md). None of them
 * is a literal in this module: callers resolve them once per request with `resolveMedicinesRates`
 * (tenant override, then nation, then `uk`, then `all`) and pass them in. The dose windows, the PRN
 * outcome check, the stock-check interval and the override length are tenant defaults with no
 * published figure, marked to verify; the paracetamol and bisphosphonate figures apply only to
 * entries a person tagged at transcription (ADR-0082).
 */

import { type RateNation, type RateRow, resolveRate } from "../platform/rates";

export const MEDICINES_RATE_KEYS = {
  orderingCycleDays: "medicines.ordering_cycle_days",
  paracetamolMinIntervalHours: "medicines.paracetamol.min_interval_hours",
  bisphosphonateBeforeFoodMinutes: "medicines.bisphosphonate.before_food_minutes",
  doseEarlyMinutes: "medicines.dose_window.early_minutes",
  doseLateMinutes: "medicines.dose_window.late_minutes",
  timeCriticalEarlyMinutes: "medicines.time_critical.early_minutes",
  timeCriticalLateMinutes: "medicines.time_critical.late_minutes",
  prnOutcomeCheckMinutes: "medicines.prn.outcome_check_minutes",
  cdStockCheckIntervalDays: "medicines.cd.stock_check_interval_days",
  competenceRefreshMonths: "competence.medicines.refresh_months",
  competenceOverrideMaxHours: "medicines.competence_override.max_hours",
  clockDriftMinutes: "sync.clock_drift_flag_minutes",
} as const;

export type MedicinesRateName = keyof typeof MEDICINES_RATE_KEYS;

export type MedicinesRates = { readonly [K in MedicinesRateName]: number };

/** Resolves every medicines figure for a tenant location on a date; fails loudly if one is missing. */
export function resolveMedicinesRates(
  rows: readonly RateRow[],
  nation: Exclude<RateNation, "uk" | "all">,
  on: string,
  tenantId: string | null,
): MedicinesRates {
  const entries = (Object.keys(MEDICINES_RATE_KEYS) as MedicinesRateName[]).map(
    (name) =>
      [name, resolveRate(rows, MEDICINES_RATE_KEYS[name], nation, on, tenantId).value] as const,
  );
  return Object.fromEntries(entries) as MedicinesRates;
}
