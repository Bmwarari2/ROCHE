import { describe, expect, it } from "vitest";
import { readRateTable } from "../../../test/rate-table";
import { percentOf } from "./money";
import { resolvePayRates } from "./rates";
import { sickPay } from "./ssp";

const rows = readRateTable();
const rates = resolvePayRates(rows, "england", "2026-10-31", null);
const weekly = rates.sspWeekly ?? 0;
const percent = rates.sspEarningsPercent ?? 0;
const low = 10_000; // average weekly earnings well under the weekly rate's equivalent
const high = 100_000;

describe("SSP from day one (scheduling.md 4b rule 4)", () => {
  it.each([
    ["low earnings: the earnings percentage", low, percentOf(low, percent)],
    ["high earnings: the weekly rate", high, weekly],
  ])("pays %s", (_, awe, expectedWeekly) => {
    const result = sickPay(
      {
        averageWeeklyEarningsPence: awe,
        qualifyingDaysPerWeek: 5,
        sickQualifyingDays: 5,
        daysAlreadyPaid: 0,
      },
      rates,
    );
    if (!result.applies) throw new Error("expected to apply");
    expect(result.weeklyPence).toBe(Math.min(percentOf(awe, percent), weekly));
    expect(result.weeklyPence).toBe(expectedWeekly);
    expect(result.daysPaid).toBe(5 - (rates.sspWaitingDays ?? 0));
  });

  it("pays from the first qualifying day (no waiting days from April 2026)", () => {
    expect(rates.sspWaitingDays).toBe(0);
    const result = sickPay(
      {
        averageWeeklyEarningsPence: high,
        qualifyingDaysPerWeek: 3,
        sickQualifyingDays: 1,
        daysAlreadyPaid: 0,
      },
      rates,
    );
    if (!result.applies) throw new Error("expected to apply");
    expect(result.payPence).toBe(Math.ceil(weekly / 3));
  });

  it("rounds the payment up to the next penny, once (SSP (General) Regulations 1982 reg 11)", () => {
    // 80% of 123.46 is 98.768: three days of a five-day week is 59.2608, paid as 59.27.
    const awe = 12_346;
    const result = sickPay(
      {
        averageWeeklyEarningsPence: awe,
        qualifyingDaysPerWeek: 5,
        sickQualifyingDays: 3,
        daysAlreadyPaid: 0,
      },
      rates,
    );
    if (!result.applies) throw new Error("expected to apply");
    expect(result.weeklyPence).toBe(Math.ceil((awe * percent) / 100));
    expect(result.payPence).toBe(Math.ceil((awe * percent * 3) / (100 * 5)));
  });

  it("stops at the maximum weeks of entitlement", () => {
    const entitlement = rates.sspMaxWeeks * 5;
    const result = sickPay(
      {
        averageWeeklyEarningsPence: high,
        qualifyingDaysPerWeek: 5,
        sickQualifyingDays: 10,
        daysAlreadyPaid: entitlement - 3,
      },
      rates,
    );
    if (!result.applies) throw new Error("expected to apply");
    expect(result.daysPaid).toBe(3);
    expect(result.daysLeft).toBe(0);
  });

  it("refuses qualifying days outside 1 to 7", () => {
    expect(() =>
      sickPay(
        {
          averageWeeklyEarningsPence: high,
          qualifyingDaysPerWeek: 0,
          sickQualifyingDays: 1,
          daysAlreadyPaid: 0,
        },
        rates,
      ),
    ).toThrow(RangeError);
  });

  it("does not apply where the nation has no rows (Northern Ireland)", () => {
    const ni = resolvePayRates(rows, "northern_ireland", "2026-10-31", null);
    expect(
      sickPay(
        {
          averageWeeklyEarningsPence: high,
          qualifyingDaysPerWeek: 5,
          sickQualifyingDays: 2,
          daysAlreadyPaid: 0,
        },
        ni,
      ),
    ).toEqual({ applies: false, reason: "no_rate_for_nation" });
  });
});
