/**
 * The rate-table figures the people rules read (people.md section 4, rates.md). None of them is a
 * literal in this module: callers resolve them once per request with `resolvePeopleRates`
 * (tenant override, then nation, then `uk`, then `all`) and pass them in. The care plan and local
 * authority review figures are England rows until the nation packs add their own (Phase 7), so a
 * lookup for another nation fails loudly rather than guessing.
 */

import { type RateNation, type RateRow, resolveRate } from "../platform/rates";

export const PEOPLE_RATE_KEYS = {
  carePlanInitialWorkingDays: "care_plan.initial_working_days",
  carePlanReviewIntervalMonths: "care_plan.review_interval_months",
  laReviewFirstMinWeeks: "la_review.first_min_weeks",
  laReviewFirstMaxWeeks: "la_review.first_max_weeks",
  laReviewIntervalMonths: "la_review.interval_months",
  familyInvolvementIntervalMonths: "family_involvement.interval_months",
  exitReturnDays: "exit.money_and_property_return_days",
  depositReturnDays: "cma.deposit_return_days",
  breakGlassRepeatThreshold: "break_glass.weekly_repeat_threshold",
} as const;

export type PeopleRateName = keyof typeof PEOPLE_RATE_KEYS;

export type PeopleRates = { readonly [K in PeopleRateName]: number };

/** Resolves every people figure for a tenant location on a date; fails loudly if one is missing. */
export function resolvePeopleRates(
  rows: readonly RateRow[],
  nation: Exclude<RateNation, "uk" | "all">,
  on: string,
  tenantId: string | null,
): PeopleRates {
  const entries = (Object.keys(PEOPLE_RATE_KEYS) as PeopleRateName[]).map(
    (name) =>
      [name, resolveRate(rows, PEOPLE_RATE_KEYS[name], nation, on, tenantId).value] as const,
  );
  return Object.fromEntries(entries) as PeopleRates;
}
