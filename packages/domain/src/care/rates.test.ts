import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { RateNotFoundError, type RateRow } from "../platform/rates";
import {
  addDaysToDate,
  addMonthsToDate,
  bmiValue,
  compareBmi,
  exactBmi,
  formatBmi,
  InputCheck,
  isIsoDate,
} from "./assessment";
import { BRADEN_TOOL_VERSION } from "./braden";
import { MUST_TOOL_VERSION } from "./must";
import { NEWS2_TOOL_VERSION } from "./news2";
import { CARE_RATE_KEYS, type CareRateName, resolveCareRates } from "./rates";
import { VALIDATED_TOOLS } from "./tools";
import { WATERLOW_TOOL_VERSION } from "./waterlow";

describe("care rates come from the rate table", () => {
  const rows = readRateTable();

  it("finds every care key in docs/specs/rates.md for each nation", () => {
    for (const nation of ["england", "wales", "scotland", "northern_ireland"] as const) {
      const rates = resolveCareRates(rows, nation, "2026-10-11", null);
      for (const name of Object.keys(CARE_RATE_KEYS) as CareRateName[]) {
        const row = rows.find((r) => r.key === CARE_RATE_KEYS[name] && r.validTo === null);
        expect(rates[name]).toBe(Number(row?.value));
        expect(rates[name]).toBeGreaterThan(0);
      }
    }
  });

  it("lets a tenant override win", () => {
    const override: RateRow = {
      key: CARE_RATE_KEYS.lateEntryHours,
      value: "4",
      unit: "hours",
      nation: "all",
      validFrom: "2026-01-01",
      validTo: null,
      tenantId: "tenant-a",
      verificationStatus: "tenant",
      source: "tenant policy",
    };
    expect(
      resolveCareRates([...rows, override], "england", "2026-10-11", "tenant-a").lateEntryHours,
    ).toBe(4);
  });

  it("fails loudly when a figure is missing rather than guessing", () => {
    const withoutBowel = rows.filter((r) => r.key !== CARE_RATE_KEYS.bowelNoMovementPromptDays);
    expect(() => resolveCareRates(withoutBowel, "england", "2026-10-11", null)).toThrow(
      RateNotFoundError,
    );
  });
});

describe("validated tool sources", () => {
  it("cite the publisher, edition and the version stored on every result", () => {
    expect(VALIDATED_TOOLS.news2.version).toBe(NEWS2_TOOL_VERSION);
    expect(VALIDATED_TOOLS.must.version).toBe(MUST_TOOL_VERSION);
    expect(VALIDATED_TOOLS.waterlow.version).toBe(WATERLOW_TOOL_VERSION);
    expect(VALIDATED_TOOLS.braden.version).toBe(BRADEN_TOOL_VERSION);
    for (const tool of Object.values(VALIDATED_TOOLS)) {
      expect(tool.url).toMatch(/^https:\/\//);
      expect(tool.publisher).not.toBe("");
    }
  });
});

describe("assessment helpers", () => {
  it.each([
    ["2026-10-11", true],
    ["2028-02-29", true],
    ["2026-02-29", false],
    ["2026-1-01", false],
    ["11/10/2026", false],
  ])("%s is a real date: %s", (value, valid) => {
    expect(isIsoDate(value)).toBe(valid);
  });

  it("adds days and months on the calendar", () => {
    expect(addDaysToDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(addMonthsToDate("2026-08-31", 1)).toBe("2026-09-30");
  });

  it.each([
    [60, 1.8, 185, 1, "18.5"],
    [51.2, 1.6, 200, 0, "20.0"],
    [80.04, 2, 200, 1, "20.0"],
    [80.2, 2, 200, 1, "20.1"],
    [73.96, 2, 185, -1, "18.5"],
    [74, 2, 185, 0, "18.5"],
  ])(
    "BMI of %s kg at %s m against %i tenths compares %i and shows %s",
    (weight, height, tenths, sign, shown) => {
      const bmi = exactBmi(weight, height);
      expect(compareBmi(bmi, tenths)).toBe(sign);
      expect(formatBmi(bmi)).toBe(shown);
      expect(bmiValue(bmi)).toBeCloseTo(weight / height ** 2, 9);
    },
  );

  it("checks decimal places and options", () => {
    const check = new InputCheck();
    expect(check.number("a", "A", 1.25, { min: 0, max: 2, decimals: 1 })).toBeUndefined();
    expect(check.number("b", "B", 1.5, { min: 0, max: 2 })).toBe(1.5);
    expect(check.options("c", "C", ["x", "y"], ["x", "y"])).toEqual(["x", "y"]);
    expect(check.options("d", "D", ["z"] as never, ["x"])).toBeUndefined();
    expect(check.issues.map((i) => i.message)).toEqual([
      "A must have no more than 1 decimal place.",
      "D has an option that is not published or is repeated.",
    ]);
    expect(check.failure()).toMatchObject({
      code: "invalid",
      message: "Score not calculated: 2 values need checking.",
    });
  });
});
