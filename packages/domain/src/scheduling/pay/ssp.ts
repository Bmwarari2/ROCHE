import { canonicalInput, formatPounds, percentOf, type WorkingLine } from "./money";
import type { PayRates } from "./rates";

/**
 * Statutory Sick Pay (scheduling.md 4b rule 4; Employment Rights Act 2025 changes from 6 April 2026).
 * From the first qualifying day after the waiting days (none from April 2026), at the lower of the
 * earnings percentage of average weekly earnings and the weekly rate, divided over the qualifying
 * days in the week, for at most the maximum weeks in a period of incapacity for work. No lower
 * earnings limit. Not applied where the nation has no rows (H-529).
 */

export type SspResult =
  | { readonly applies: false; readonly reason: "no_rate_for_nation" }
  | {
      readonly applies: true;
      readonly weeklyPence: number;
      readonly daysPaid: number;
      readonly payPence: number;
      /** Qualifying days of entitlement left after this spell. */
      readonly daysLeft: number;
      readonly working: readonly WorkingLine[];
      readonly canonicalInput: string;
    };

export function sickPay(
  input: {
    readonly averageWeeklyEarningsPence: number;
    /** Qualifying days in a week (the days the worker normally works). */
    readonly qualifyingDaysPerWeek: number;
    /** Qualifying days of sickness in this spell. */
    readonly sickQualifyingDays: number;
    /** Qualifying days already paid in this period of incapacity for work. */
    readonly daysAlreadyPaid: number;
  },
  rates: PayRates,
): SspResult {
  const { sspWeekly, sspEarningsPercent, sspWaitingDays } = rates;
  if (sspWeekly === null || sspEarningsPercent === null || sspWaitingDays === null) {
    return { applies: false, reason: "no_rate_for_nation" };
  }
  const q = input.qualifyingDaysPerWeek;
  if (!Number.isInteger(q) || q < 1 || q > 7) {
    throw new RangeError("Qualifying days a week must be 1 to 7.");
  }
  const fromEarnings = percentOf(input.averageWeeklyEarningsPence, sspEarningsPercent);
  const weekly = Math.min(fromEarnings, sspWeekly);
  const entitlement = rates.sspMaxWeeks * q;
  const waiting =
    input.daysAlreadyPaid > 0 ? 0 : Math.min(sspWaitingDays, input.sickQualifyingDays);
  const payable = Math.max(
    0,
    Math.min(input.sickQualifyingDays - waiting, entitlement - input.daysAlreadyPaid),
  );
  // Daily rate times days, rounded down to the penny once for the spell.
  const pay = Math.floor((weekly * payable) / q);
  const working: WorkingLine[] = [
    {
      step: `${sspEarningsPercent}% of average weekly earnings of ${formatPounds(input.averageWeeklyEarningsPence)}`,
      pence: fromEarnings,
      rateKey: "ssp.earnings_percentage",
    },
    { step: "The weekly rate", pence: sspWeekly, rateKey: "ssp.weekly" },
    { step: "SSP a week: the lower of the two", pence: weekly },
    {
      step: `${payable} qualifying days at ${q} days a week (waiting days ${waiting}; rounded down to the penny)`,
      pence: pay,
    },
  ];
  return {
    applies: true,
    weeklyPence: weekly,
    daysPaid: payable,
    payPence: pay,
    daysLeft: entitlement - input.daysAlreadyPaid - payable,
    working,
    canonicalInput: canonicalInput({ input, sspWeekly, sspEarningsPercent, sspWaitingDays }),
  };
}
