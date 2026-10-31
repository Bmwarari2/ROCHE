import { canonicalInput, formatPounds, percentOf, type WorkingLine } from "./money";
import type { PayRates } from "./rates";

/**
 * Statutory family pay (scheduling.md 4b rule 5). Maternity and adoption pay: the first weeks at
 * the earnings percentage of average weekly earnings, then the lower of that and the standard
 * weekly rate. Paternity, shared parental and parental bereavement pay: the lower of the two every
 * week. Who qualifies (service, earnings) is recorded by HR, never decided here.
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
  const earnings = percentOf(averageWeeklyEarningsPence, rates.familyPayEarningsPercent);
  const standard = Math.min(earnings, rates.familyPayStandardWeekly);
  const higherWeeks = kind === "maternity" || kind === "adoption" ? rates.smpHigherRateWeeks : 0;
  const amounts = Array.from({ length: paidWeeks }, (_, i) =>
    i < higherWeeks ? earnings : standard,
  );
  const working: WorkingLine[] = [
    {
      step: `${rates.familyPayEarningsPercent}% of average weekly earnings of ${formatPounds(averageWeeklyEarningsPence)}`,
      pence: earnings,
      rateKey: "family_pay.earnings_percentage",
    },
    {
      step: "The standard weekly rate",
      pence: rates.familyPayStandardWeekly,
      rateKey: "family_pay.standard_weekly",
    },
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
