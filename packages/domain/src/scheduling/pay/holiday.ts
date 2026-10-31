import {
  BASIS_POINTS_IN_WHOLE,
  basisPoints,
  canonicalInput,
  formatPounds,
  percentOf,
  type WorkingLine,
} from "./money";
import type { PayRates } from "./rates";

/**
 * Holiday for irregular-hours and part-year workers (scheduling.md 4b rule 3; Working Time
 * (Amendment) Regulations 2023, leave years from 1 April 2024). Accrual: the rate table's
 * percentage of hours worked in the pay period. Rolled-up holiday pay, if the tenant uses it: the
 * same percentage of the pay for the period, shown as its own payslip line, never folded into the
 * hourly rate. Not applied where the nation has no row (Northern Ireland, until its nation pack) or
 * for leave years starting before the reform.
 */

/** The first day a leave year may start for the reformed rules to apply (the regulations' date). */
export const IRREGULAR_HOURS_REFORM_FROM = "2024-04-01";

export type HolidayResult =
  | { readonly applies: false; readonly reason: "no_rate_for_nation" | "leave_year_before_reform" }
  | {
      readonly applies: true;
      readonly accruedMinutes: number;
      /** Rolled-up holiday pay for the period, or null when the tenant does not use it. */
      readonly rolledUpPence: number | null;
      readonly working: readonly WorkingLine[];
      readonly canonicalInput: string;
    };

export function irregularHoursHoliday(
  input: {
    readonly leaveYearStart: string;
    readonly minutesWorked: number;
    readonly payPence: number;
    readonly rolledUp: boolean;
  },
  rates: PayRates,
): HolidayResult {
  const percent = rates.holidayAccrualPercent;
  if (percent === null) return { applies: false, reason: "no_rate_for_nation" };
  if (input.leaveYearStart < IRREGULAR_HOURS_REFORM_FROM) {
    return { applies: false, reason: "leave_year_before_reform" };
  }
  // Minutes rounded down to the minute: accrual is shown in hours and minutes.
  const accruedMinutes = Math.floor(
    (input.minutesWorked * basisPoints(percent)) / BASIS_POINTS_IN_WHOLE,
  );
  const working: WorkingLine[] = [
    {
      step: `Holiday accrued: ${percent}% of ${input.minutesWorked} minutes worked (rounded down to the minute)`,
      rateKey: "holiday.accrual_percentage.irregular_hours",
    },
  ];
  let rolledUpPence: number | null = null;
  if (input.rolledUp) {
    rolledUpPence = percentOf(input.payPence, percent);
    working.push({
      step: `Rolled-up holiday pay: ${percent}% of ${formatPounds(input.payPence)}, shown as its own line on the payslip`,
      pence: rolledUpPence,
      rateKey: "holiday.accrual_percentage.irregular_hours",
    });
  }
  return {
    applies: true,
    accruedMinutes,
    rolledUpPence,
    working,
    canonicalInput: canonicalInput({ input, percent }),
  };
}
