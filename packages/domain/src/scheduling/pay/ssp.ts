import { DAYS_PER_WEEK } from "../intervals";
import {
  BASIS_POINTS_IN_WHOLE,
  basisPoints,
  canonicalInput,
  formatPounds,
  roundUpPence,
  type WorkingLine,
} from "./money";
import type { PayRates } from "./rates";

/**
 * Statutory Sick Pay (scheduling.md 4b rule 4; Social Security Contributions and Benefits Act 1992
 * ss 152 to 157 as amended by the Employment Rights Act 2025 from 6 April 2026, S.I. 2026/373).
 * From the first qualifying day after the waiting days (none from April 2026), at the lower of the
 * earnings percentage of normal weekly earnings and the weekly rate (s 157(1)), divided over the
 * qualifying days in the week (s 157(3)), up to the entitlement limit of the maximum weeks times
 * the weekly rate (s 155(4)). No lower earnings limit. The payment is the exact amount rounded up
 * to the next penny once (SSP (General) Regulations 1982 reg 11). Not applied where the nation has
 * no rows (H-529).
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
  if (!Number.isInteger(q) || q < 1 || q > DAYS_PER_WEEK) {
    throw new RangeError("Qualifying days a week must be 1 to 7.");
  }
  // The weekly rate exactly, in ten-thousandths of a penny: 80% of earnings may not be whole pence.
  const fromEarnings = input.averageWeeklyEarningsPence * basisPoints(sspEarningsPercent);
  const exactWeekly = Math.min(fromEarnings, sspWeekly * BASIS_POINTS_IN_WHOLE);
  const weekly = roundUpPence(exactWeekly, BASIS_POINTS_IN_WHOLE);
  const entitlement = rates.sspMaxWeeks * q;
  const waiting =
    input.daysAlreadyPaid > 0 ? 0 : Math.min(sspWaitingDays, input.sickQualifyingDays);
  const payable = Math.max(
    0,
    Math.min(input.sickQualifyingDays - waiting, entitlement - input.daysAlreadyPaid),
  );
  // The daily rate times the days, rounded up to the penny once for the payment (reg 11).
  const pay = roundUpPence(exactWeekly * payable, q * BASIS_POINTS_IN_WHOLE);
  const working: WorkingLine[] = [
    {
      step: `${sspEarningsPercent}% of average weekly earnings of ${formatPounds(input.averageWeeklyEarningsPence)} (rounded up to the penny)`,
      pence: roundUpPence(fromEarnings, BASIS_POINTS_IN_WHOLE),
      rateKey: "ssp.earnings_percentage",
    },
    { step: "The weekly rate", pence: sspWeekly, rateKey: "ssp.weekly" },
    { step: "SSP a week: the lower of the two", pence: weekly },
    {
      step: `${payable} qualifying days at ${q} days a week (waiting days ${waiting}; rounded up to the penny)`,
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
