import { describe, expect, it } from "vitest";
import { readRateTable } from "../../../test/rate-table";
import { familyPay } from "./family-pay";
import { percentOf } from "./money";
import { resolvePayRates } from "./rates";

const rates = resolvePayRates(readRateTable(), "england", "2026-10-31", null);
const high = 60_000;
const low = 15_000;
const ninety = (awe: number) => percentOf(awe, rates.familyPayEarningsPercent);

describe("statutory family pay (scheduling.md 4b rule 5)", () => {
  it("pays maternity at the earnings percentage first, then the lower of that and the standard rate", () => {
    const result = familyPay("maternity", high, rates.smpTotalWeeks, rates);
    expect(result.weeks).toHaveLength(rates.smpTotalWeeks);
    expect(result.weeks[0]).toBe(ninety(high));
    expect(result.weeks[rates.smpHigherRateWeeks - 1]).toBe(ninety(high));
    expect(result.weeks[rates.smpHigherRateWeeks]).toBe(
      Math.min(ninety(high), rates.familyPayStandardWeekly),
    );
    expect(result.totalPence).toBe(result.weeks.reduce((a, b) => a + b, 0));
  });

  it("never pays more than the earnings percentage to a low earner", () => {
    const result = familyPay("maternity", low, rates.smpTotalWeeks, rates);
    expect(new Set(result.weeks)).toEqual(new Set([ninety(low)]));
  });

  it.each(["paternity", "shared_parental", "parental_bereavement"] as const)(
    "pays %s at the lower of the two from the first week",
    (kind) => {
      const result = familyPay(kind, high, 2, rates);
      expect(result.weeks).toEqual([
        Math.min(ninety(high), rates.familyPayStandardWeekly),
        Math.min(ninety(high), rates.familyPayStandardWeekly),
      ]);
    },
  );

  it("pays adoption like maternity and caps both at the total weeks", () => {
    const result = familyPay("adoption", high, rates.smpTotalWeeks + 5, rates);
    expect(result.weeks).toHaveLength(rates.smpTotalWeeks);
    expect(result.weeks[0]).toBe(ninety(high));
    expect(result.working.some((w) => w.rateKey === "smp.total_weeks")).toBe(true);
  });

  it("rounds each week's payment up to the next penny (SMP (General) Regulations 1986 reg 28)", () => {
    // 90% of 150.01 is 135.009, paid as 135.01.
    const result = familyPay("paternity", 15_001, 1, rates);
    expect(result.weeks).toEqual([Math.ceil((15_001 * rates.familyPayEarningsPercent) / 100)]);
  });

  it("uses maternity pay's own rate, which starts a day before the others' (gov.uk, 2026 to 2027)", () => {
    const sunday = resolvePayRates(readRateTable(), "england", "2026-04-05", null);
    expect(sunday.smpStandardWeekly).toBe(rates.smpStandardWeekly);
    expect(sunday.familyPayStandardWeekly).toBeLessThan(sunday.smpStandardWeekly);
    const maternity = familyPay("maternity", high, sunday.smpHigherRateWeeks + 1, sunday);
    expect(maternity.weeks.at(-1)).toBe(sunday.smpStandardWeekly);
    expect(familyPay("paternity", high, 1, sunday).weeks).toEqual([sunday.familyPayStandardWeekly]);
  });

  it("refuses part weeks", () => {
    expect(() => familyPay("paternity", high, 1.5, rates)).toThrow(RangeError);
  });
});
