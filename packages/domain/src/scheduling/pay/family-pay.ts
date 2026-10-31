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
 * Statutory family pay (scheduling.md 4b rule 5). Maternity and adoption pay: the first weeks at
 * the earnings percentage of average weekly earnings, then the lower of that and the standard
 * weekly rate. Paternity, shared parental and parental bereavement pay: the lower of the two every
 * week. Who qualifies (service, earnings) is recorded by HR, never decided here. Each week's
 * payment is the exact amount rounded up to the next penny, as the regulations for each pay say
 * (SMP (General) Regulations 1986 reg 28; S.I. 2002/2818; S.I. 2014/3051; S.I. 2020/233).
 * Maternity pay's standard rate has its own row: gov.uk gives it a different start date (5 April
 * 2026) from the other kinds (6 April 2026).
 */

export type FamilyPayKind =
  | "maternity"
  | "adoption"
  | "paternity"
  | "shared_parental"
  | "parental_bereavement";

export interface FamilyPayResult {
  readonly weeks: readonly number[];
  readonly totalPence: number;
  readonly working: readonly WorkingLine[];
  readonly canonicalInput: string;
}

export function familyPay(
  kind: FamilyPayKind,
  averageWeeklyEarningsPence: number,
  weeks: number,
  rates: PayRates,
): FamilyPayResult {
  if (!Number.isInteger(weeks) || weeks < 0) throw new RangeError("Weeks must be a whole number.");
  const maxWeeks = kind === "maternity" || kind === "adoption" ? rates.smpTotalWeeks : weeks;
  const paidWeeks = Math.min(weeks, maxWeeks);
  const standardRate =
    kind === "maternity" ? rates.smpStandardWeekly : rates.familyPayStandardWeekly;
  const standardKey = kind === "maternity" ? "smp.standard_weekly" : "family_pay.standard_weekly";
  // Exact amounts in ten-thousandths of a penny, rounded up only for the payment.
  const exactEarnings = averageWeeklyEarningsPence * basisPoints(rates.familyPayEarningsPercent);
  const earnings = roundUpPence(exactEarnings, BASIS_POINTS_IN_WHOLE);
  const standard = roundUpPence(
    Math.min(exactEarnings, standardRate * BASIS_POINTS_IN_WHOLE),
    BASIS_POINTS_IN_WHOLE,
  );
  const higherWeeks = kind === "maternity" || kind === "adoption" ? rates.smpHigherRateWeeks : 0;
  const amounts = Array.from({ length: paidWeeks }, (_, i) =>
    i < higherWeeks ? earnings : standard,
  );
  const working: WorkingLine[] = [
    {
      step: `${rates.familyPayEarningsPercent}% of average weekly earnings of ${formatPounds(averageWeeklyEarningsPence)} (rounded up to the penny)`,
      pence: earnings,
      rateKey: "family_pay.earnings_percentage",
    },
    { step: "The standard weekly rate", pence: standardRate, rateKey: standardKey },
  ];
  if (higherWeeks > 0) {
    working.push({
      step: `The first ${Math.min(higherWeeks, paidWeeks)} weeks at the earnings percentage`,
      rateKey: "smp.higher_rate_weeks",
    });
  }
  if (paidWeeks > higherWeeks) {
    working.push({
      step: `${paidWeeks - higherWeeks} weeks at the lower of the two`,
      pence: standard,
    });
  }
  if (weeks > paidWeeks) {
    working.push({ step: `At most ${maxWeeks} weeks are paid`, rateKey: "smp.total_weeks" });
  }
  const total = amounts.reduce((sum, a) => sum + a, 0);
  working.push({ step: "Total", pence: total });
  return {
    weeks: amounts,
    totalPence: total,
    working,
    canonicalInput: canonicalInput({ kind, averageWeeklyEarningsPence, weeks, earnings, standard }),
  };
}
