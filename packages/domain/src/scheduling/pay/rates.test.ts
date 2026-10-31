import { describe, expect, it } from "vitest";
import { readRateTable } from "../../../test/rate-table";
import { RateNotFoundError } from "../../platform/rates";
import { PAY_RATE_KEYS, resolvePayRates, toPence } from "./rates";

const rows = readRateTable();

describe("pay rates come from the rate table (ADR-0086)", () => {
  it("resolves every figure for England, Wales and Scotland, money in whole pence", () => {
    for (const nation of ["england", "wales", "scotland"] as const) {
      const rates = resolvePayRates(rows, nation, "2026-10-31", null);
      for (const name of Object.keys(PAY_RATE_KEYS) as (keyof typeof PAY_RATE_KEYS)[]) {
        const value = rates[name];
        expect(value, `${nation} ${name}`).not.toBeNull();
        if (name !== "sspWaitingDays") expect(value, name).toBeGreaterThan(0);
      }
      const nmw = rows.find((r) => r.key === "nmw.hourly.21_plus" && r.validTo === null);
      expect(rates.nmw21Plus).toBe(toPence(nmw?.value ?? "0"));
      expect(Number.isInteger(rates.nmw21Plus)).toBe(true);
    }
  });

  it("has no holiday accrual or SSP for Northern Ireland until its nation pack, never a guess", () => {
    const ni = resolvePayRates(rows, "northern_ireland", "2026-10-31", null);
    expect(ni.holidayAccrualPercent).toBeNull();
    expect(ni.sspWeekly).toBeNull();
    expect(ni.nmw21Plus).toBeGreaterThan(0);
  });

  it("uses the figure in force on the date: the earlier NMW before April 2026", () => {
    const before = resolvePayRates(rows, "england", "2026-03-31", null);
    const after = resolvePayRates(rows, "england", "2026-04-01", null);
    expect(before.nmw21Plus).toBeLessThan(after.nmw21Plus);
  });

  it("fails loudly when a figure every nation needs is missing", () => {
    const without = rows.filter((r) => r.key !== PAY_RATE_KEYS.awrQualifyingWeeks);
    expect(() => resolvePayRates(without, "england", "2026-10-31", null)).toThrow(
      RateNotFoundError,
    );
  });

  it("turns pounds into pence without floating-point drift", () => {
    expect(toPence("12.71")).toBe(1271);
    expect(toPence("0.29")).toBe(29);
    expect(toPence(194.32)).toBe(19432);
  });
});
