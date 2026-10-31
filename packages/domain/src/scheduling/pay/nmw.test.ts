import { describe, expect, it } from "vitest";
import { readRateTable } from "../../../test/rate-table";
import { ageOn, type NmwInput, nmwBand, nmwCheck } from "./nmw";
import { resolvePayRates } from "./rates";

const rates = resolvePayRates(readRateTable(), "england", "2026-10-31", null);
const START = "2026-10-01";

const base: NmwInput = {
  dateOfBirth: "1990-05-05",
  periodStart: START,
  apprenticeshipStartedOn: null,
  minutesCounted: 60 * 100,
  payPence: rates.nmw21Plus * 100,
  premiumPence: 0,
  employerUseDeductionsPence: 0,
  accommodation: null,
};

describe("NMW band on the first day of the period (scheduling.md 4b rule 2)", () => {
  it.each([
    ["2005-10-01", null, "21_plus"],
    ["2005-10-02", null, "18_to_20"],
    ["2008-10-01", null, "18_to_20"],
    ["2008-10-02", null, "under_18"],
    ["2008-10-02", "2026-09-01", "apprentice"],
    ["1990-01-01", "2026-01-01", "apprentice"],
    ["1990-01-01", "2025-09-30", "21_plus"],
  ] as const)("born %s, apprentice from %s: %s", (dateOfBirth, apprenticeshipStartedOn, band) => {
    expect(nmwBand({ dateOfBirth, periodStart: START, apprenticeshipStartedOn }, rates)).toBe(band);
  });

  it("reaches a 29 February birthday on 1 March in other years", () => {
    expect(ageOn("2008-02-29", "2026-02-28")).toBe(17);
    expect(ageOn("2008-02-29", "2026-03-01")).toBe(18);
    expect(ageOn("2008-02-29", "2028-02-29")).toBe(20);
  });
});

describe("NMW per pay reference period", () => {
  it("is met exactly at the band's rate", () => {
    const result = nmwCheck(base, rates);
    expect(result).toMatchObject({ band: "21_plus", compliant: true, shortfallPence: 0 });
    expect(result.working.at(-1)?.step).toBe("Meets the minimum wage");
  });

  it.each<[string, Partial<NmwInput>, number]>([
    ["premiums do not count", { payPence: rates.nmw21Plus * 100 + 5_000, premiumPence: 5_000 }, 0],
    ["a uniform deduction takes pay below", { employerUseDeductionsPence: 1_000 }, 1_000],
    [
      "travel time added to the hours takes pay below",
      { minutesCounted: 60 * 101 },
      rates.nmw21Plus,
    ],
    [
      "accommodation within the offset does not count against pay",
      { accommodation: { chargePence: rates.accommodationOffsetDaily * 7, days: 7 } },
      0,
    ],
    [
      "accommodation above the offset does",
      { accommodation: { chargePence: rates.accommodationOffsetDaily * 7 + 700, days: 7 } },
      700,
    ],
  ])("%s", (_, change, shortfall) => {
    expect(nmwCheck({ ...base, ...change }, rates).shortfallPence).toBe(shortfall);
  });

  it("rounds what the hours must earn up to the penny, never in the employer's favour", () => {
    const result = nmwCheck({ ...base, minutesCounted: 1, payPence: 0 }, rates);
    expect(result.requiredPence).toBe(Math.ceil(rates.nmw21Plus / 60));
  });

  it("refuses minutes that are not whole", () => {
    expect(() => nmwCheck({ ...base, minutesCounted: 1.5 }, rates)).toThrow(RangeError);
  });
});
