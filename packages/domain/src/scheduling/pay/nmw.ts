import { MINUTES_PER_HOUR, MONTHS_PER_YEAR } from "../intervals";
import { canonicalInput, formatPounds, type WorkingLine } from "./money";
import type { GrossPay } from "./pay-rules";
import type { PayRates } from "./rates";

/**
 * The National Minimum Wage check for one pay reference period (scheduling.md 4b rule 2; National
 * Minimum Wage Regulations 2015). The band is decided by age on the first day of the period; the
 * apprentice rate applies under the apprentice age limit, or above it within the first year. Pay
 * that counts is the pay for the period less premiums above the basic rate, less deductions for the
 * employer's own use, less accommodation charges above the offset; free accommodation adds the
 * offset. Hours that count are slice 5's `nmwMinutesIn` over the period (travel between visits,
 * time awake for work on a sleep-in; never home to the first visit or time asleep).
 */

export type NmwBand = "21_plus" | "18_to_20" | "under_18" | "apprentice";

export interface NmwInput {
  readonly dateOfBirth: string;
  readonly periodStart: string;
  /** When the apprenticeship started, for an apprentice; null otherwise. */
  readonly apprenticeshipStartedOn: string | null;
  /** Working time that counts for the minimum wage in the period, in minutes. */
  readonly minutesCounted: number;
  /** All pay for the period, in pence. */
  readonly payPence: number;
  /** Overtime and shift premiums above the basic rate: they never count. */
  readonly premiumPence: number;
  /** Deductions or payments for the employer's own use (a uniform the worker pays for). */
  readonly employerUseDeductionsPence: number;
  /**
   * Accommodation the employer provides: what it charges and for how many days. Free
   * accommodation (a charge of 0) adds the offset to pay; a charge up to the offset changes
   * nothing; a charge above it takes the excess off (gov.uk, accommodation offset).
   */
  readonly accommodation: { readonly chargePence: number; readonly days: number } | null;
}

export interface NmwResult {
  readonly band: NmwBand;
  readonly ratePence: number;
  readonly countedPayPence: number;
  /** What the hours counted must earn at the band's rate. */
  readonly requiredPence: number;
  readonly shortfallPence: number;
  readonly compliant: boolean;
  readonly working: readonly WorkingLine[];
  readonly canonicalInput: string;
}

/** Whole years of age on a date (a 29 February birthday is reached on 1 March in other years). */
export function ageOn(dateOfBirth: string, on: string): number {
  const [by, bm, bd] = dateOfBirth.split("-").map(Number) as [number, number, number];
  const [y, m, d] = on.split("-").map(Number) as [number, number, number];
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age--;
  return age;
}

function monthsBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  return (ty - fy) * MONTHS_PER_YEAR + (tm - fm) - (td < fd ? 1 : 0);
}

export function nmwBand(
  input: Pick<NmwInput, "dateOfBirth" | "periodStart" | "apprenticeshipStartedOn">,
  rates: PayRates,
): NmwBand {
  const age = ageOn(input.dateOfBirth, input.periodStart);
  if (input.apprenticeshipStartedOn) {
    const inFirstYear =
      monthsBetween(input.apprenticeshipStartedOn, input.periodStart) <
      rates.apprenticeFirstYearMonths;
    if (age < rates.apprenticeAgeLimit || inFirstYear) return "apprentice";
  }
  if (age >= rates.nmwAge21Plus) return "21_plus";
  if (age >= rates.nmwAge18To20) return "18_to_20";
  return "under_18";
}

const BAND_RATE: Record<NmwBand, keyof PayRates> = {
  "21_plus": "nmw21Plus",
  "18_to_20": "nmw18To20",
  under_18: "nmwUnder18",
  apprentice: "nmwApprentice",
};

export function nmwCheck(input: NmwInput, rates: PayRates): NmwResult {
  if (!Number.isInteger(input.minutesCounted) || input.minutesCounted < 0) {
    throw new RangeError("Minutes counted must be a whole number of zero or more.");
  }
  const band = nmwBand(input, rates);
  const ratePence = rates[BAND_RATE[band]] as number;
  const working: WorkingLine[] = [
    {
      step: `Band ${band.replace(/_/g, " ")}: ${formatPounds(ratePence)} an hour`,
      rateKey: `nmw.hourly.${band}`,
    },
    { step: "Pay for the period", pence: input.payPence },
    { step: "Less premiums above the basic rate", pence: -input.premiumPence },
    {
      step: "Less deductions for the employer's own use",
      pence: -input.employerUseDeductionsPence,
    },
  ];
  let accommodationEffect = 0;
  if (input.accommodation) {
    const allowed = rates.accommodationOffsetDaily * input.accommodation.days;
    const free = input.accommodation.chargePence === 0;
    accommodationEffect = free ? allowed : -Math.max(0, input.accommodation.chargePence - allowed);
    working.push({
      step: free
        ? `Plus the offset for free accommodation (${input.accommodation.days} days at ${formatPounds(rates.accommodationOffsetDaily)})`
        : `Less accommodation charged above the offset (${input.accommodation.days} days at ${formatPounds(rates.accommodationOffsetDaily)})`,
      pence: accommodationEffect,
      rateKey: "nmw.accommodation_offset.daily",
    });
  }
  const counted =
    input.payPence - input.premiumPence - input.employerUseDeductionsPence + accommodationEffect;
  // What the hours must earn, rounded up to the penny: never in the employer's favour.
  const required = Math.ceil((ratePence * input.minutesCounted) / MINUTES_PER_HOUR);
  const shortfall = Math.max(0, required - counted);
  working.push(
    { step: "Pay that counts", pence: counted },
    {
      step: `${input.minutesCounted} minutes at the band's rate (rounded up to the penny)`,
      pence: required,
    },
    { step: shortfall > 0 ? "Shortfall to pay" : "Meets the minimum wage", pence: shortfall },
  );
  return {
    band,
    ratePence,
    countedPayPence: counted,
    requiredPence: required,
    shortfallPence: shortfall,
    compliant: shortfall === 0,
    working,
    canonicalInput: canonicalInput({ input, ratePence }),
  };
}

/**
 * The pay the minimum wage check takes from gross pay: basic pay, premiums (taken out again by the
 * check) and sleep-in allowances, which are pay for the sleep-in. Mileage is an expense and an
 * on-call allowance for time at home is not pay for time work, so neither is counted (gov.uk
 * "Calculating the minimum wage"; H-529).
 */
export function nmwPayFromGross(gross: GrossPay): Pick<NmwInput, "payPence" | "premiumPence"> {
  return {
    payPence: gross.basicPence + gross.premiumPence + gross.sleepInPence,
    premiumPence: gross.premiumPence,
  };
}
