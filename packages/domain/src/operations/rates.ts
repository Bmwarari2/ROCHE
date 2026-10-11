/**
 * The rate-table figures the downtime rules read (operations.md section 4, docs/specs/rates.md).
 * None of them is a literal in this module: callers resolve them once per request with
 * `resolveOperationsRates` (tenant override, then nation, then `uk`, then `all`) and pass them in.
 * The downtime figures are tenant defaults, not statutory figures; the late-entry and clock-drift
 * figures are the care record's own, so a back-entry is flagged late by the same rule as any note.
 */

import { type RateNation, type RateRow, resolveRate } from "../platform/rates";

export const OPERATIONS_RATE_KEYS = {
  downtimePackValidHours: "downtime_pack.valid_hours",
  backEntryDueHours: "downtime.back_entry_due_hours",
  lateEntryHours: "care_note.late_entry_hours",
  clockDriftMinutes: "sync.clock_drift_flag_minutes",
} as const;

export type OperationsRateName = keyof typeof OPERATIONS_RATE_KEYS;

export type OperationsRates = { readonly [K in OperationsRateName]: number };

/** Resolves every downtime figure for a tenant location on a date; fails loudly if one is missing. */
export function resolveOperationsRates(
  rows: readonly RateRow[],
  nation: Exclude<RateNation, "uk" | "all">,
  on: string,
  tenantId: string | null,
): OperationsRates {
  const entries = (Object.keys(OPERATIONS_RATE_KEYS) as OperationsRateName[]).map(
    (name) =>
      [name, resolveRate(rows, OPERATIONS_RATE_KEYS[name], nation, on, tenantId).value] as const,
  );
  return Object.fromEntries(entries) as OperationsRates;
}
