/**
 * The rate-table figures the medicines record rules read (medicines.md section 4, rates.md). None
 * of them is a literal in this module: callers resolve them once per request with
 * `resolveMedicinesRates` (tenant override, then nation, then `uk`, then `all`) and pass them in.
 * Slice 3 adds the administration figures (minimum intervals, time-critical windows, competence).
 */

import { type RateNation, type RateRow, resolveRate } from "../platform/rates";

export const MEDICINES_RATE_KEYS = {
  orderingCycleDays: "medicines.ordering_cycle_days",
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
