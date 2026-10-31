import type { PayRates } from "./rates";

/**
 * Auto-enrolment flags for one pay reference period (scheduling.md 4b rule 7; Pensions Act 2008).
 * A flag tells the employer (and its payroll provider) what duty may apply; it never enrols anyone
 * itself. State pension age depends on date of birth and is an input.
 */

export type AeCategory =
  | "eligible_jobholder"
  | "non_eligible_jobholder"
  | "entitled_worker"
  | "outside_age_range";

export function autoEnrolmentCategory(
  input: {
    readonly age: number;
    readonly reachedStatePensionAge: boolean;
    readonly earningsPence: number;
    readonly period: "weekly" | "monthly";
  },
  rates: PayRates,
): AeCategory {
  if (input.age < rates.aeMinAge || input.age > rates.aeMaxAge) return "outside_age_range";
  const trigger = input.period === "weekly" ? rates.aeTriggerWeekly : rates.aeTriggerMonthly;
  const lower = input.period === "weekly" ? rates.aeLowerWeekly : rates.aeLowerMonthly;
  if (
    input.earningsPence > trigger &&
    input.age >= rates.aeEligibleMinAge &&
    !input.reachedStatePensionAge
  ) {
    return "eligible_jobholder";
  }
  if (input.earningsPence > lower) return "non_eligible_jobholder";
  return "entitled_worker";
}

/** Qualifying earnings for contributions: earnings between the lower and upper levels. */
export function qualifyingEarningsPence(
  earningsPence: number,
  period: "weekly" | "monthly",
  rates: PayRates,
): number {
  const lower = period === "weekly" ? rates.aeLowerWeekly : rates.aeLowerMonthly;
  const upper = period === "weekly" ? rates.aeUpperWeekly : rates.aeUpperMonthly;
  return Math.max(0, Math.min(earningsPence, upper) - lower);
}
