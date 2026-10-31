import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import {
  checkIndicatorTarget,
  computeIndicator,
  type IndicatorDefinition,
  type IndicatorInput,
  type IndicatorTarget,
  indicatorMethod,
  indicatorResult,
  phase2Indicators,
  ragStatus,
} from "./quality-indicators";
import { resolveQualityPhase2Rates } from "./quality-rates";

const rates = resolveQualityPhase2Rates(readRateTable(), "england", "2026-10-31", null);
const indicators = phase2Indicators(rates);
const byKey = (key: string) => indicators.find((i) => i.key === key) as IndicatorDefinition;
const falls = byKey("falls");
const training = byKey("training_compliance");
const complaints = byKey("complaints");
const full = (numerator: number | null, denominator: number | null): IndicatorInput => ({
  numerator,
  denominator,
  coverage: 1,
});

describe("quality indicators (quality.md 17.3 rules 16 to 22; QUAL-005)", () => {
  it("rule 16 gives every indicator its method in words, the bed-days base from the rate table", () => {
    expect(falls.multiplier).toBe(rates.bedDaysBase);
    expect(indicatorMethod(falls)).toBe(
      `Falls: falls recorded ÷ occupied bed-days × ${rates.bedDaysBase.toLocaleString("en-GB")}.`,
    );
    expect(indicatorMethod(complaints)).toBe(
      "Complaints: complaints received ÷ 1 (a count for the period).",
    );
    expect(new Set(indicators.map((i) => i.key)).size).toBe(indicators.length);
  });

  it.each<[string, IndicatorInput, number | null]>([
    ["falls over bed-days", full(3, 1500), (3 / 1500) * rates.bedDaysBase],
    ["no denominator", full(3, 0), null],
    ["no numerator", full(null, 1500), null],
  ])("rule 17 computes %s", (_, input, value) => {
    expect(computeIndicator(falls, input)).toBe(value);
  });

  it.each<[string, IndicatorDefinition, IndicatorTarget, string[]]>([
    ["lower is better, green at or below amber", falls, { green: 2, amber: 4 }, []],
    ["lower is better, the wrong way round", falls, { green: 4, amber: 2 }, ["wrong_order"]],
    ["higher is better, green at or above amber", training, { green: 95, amber: 85 }, []],
    ["higher is better, the wrong way round", training, { green: 85, amber: 95 }, ["wrong_order"]],
    ["not a number", training, { green: Number.NaN, amber: 85 }, ["not_a_number"]],
  ])("rule 18 checks a target: %s", (_, definition, target, problems) => {
    expect(checkIndicatorTarget(definition, target)).toEqual(problems);
  });

  it.each<[IndicatorDefinition, number, IndicatorTarget, string]>([
    [falls, 1.5, { green: 2, amber: 4 }, "green"],
    [falls, 2, { green: 2, amber: 4 }, "green"],
    [falls, 3, { green: 2, amber: 4 }, "amber"],
    [falls, 4, { green: 2, amber: 4 }, "amber"],
    [falls, 4.1, { green: 2, amber: 4 }, "red"],
    [training, 96, { green: 95, amber: 85 }, "green"],
    [training, 85, { green: 95, amber: 85 }, "amber"],
    [training, 84.9, { green: 95, amber: 85 }, "red"],
  ])(
    "rule 19 bands %s at %d (boundaries count as the better band)",
    (definition, value, target, status) => {
      expect(ragStatus(definition, value, target)).toBe(status);
    },
  );

  it("rule 20 counts a result only when its data covers the whole period and every location", () => {
    const result = indicatorResult(
      falls,
      { numerator: 1, denominator: 1500, coverage: 0.9 },
      { green: 2, amber: 4 },
    );
    expect(result).toMatchObject({
      status: "no_data",
      reason: "Data incomplete for this period.",
      value: null,
    });
  });

  it("rules 17 and 19 rate a complete result against the tenant's target, rounding only for display", () => {
    const result = indicatorResult(falls, full(2, 1500), { green: 2, amber: 4 });
    expect(result.value).toBe((2 / 1500) * rates.bedDaysBase);
    expect(result.display).toBe(Math.round((2 / 1500) * rates.bedDaysBase * 10) / 10);
    expect(result.status).toBe("green");
    expect(result.method).toContain("occupied bed-days");
  });

  describe("rule 22 missing data is never shown as good (for HZ-129, slice 47)", () => {
    const target = { green: 2, amber: 4 };
    it.each<
      [string, IndicatorDefinition | undefined, IndicatorInput, IndicatorTarget | null, string]
    >([
      [
        "an unknown indicator",
        undefined,
        full(0, 1500),
        target,
        "Harbour does not know this indicator.",
      ],
      [
        "no value recorded",
        falls,
        full(null, 1500),
        target,
        "No data has been recorded for this period.",
      ],
      [
        "a zero denominator",
        falls,
        full(0, 0),
        target,
        "There is nothing to measure against for this period.",
      ],
      [
        "a missing denominator",
        falls,
        full(0, null),
        target,
        "There is nothing to measure against for this period.",
      ],
      [
        "incomplete coverage",
        falls,
        { numerator: 0, denominator: 1500, coverage: 0.5 },
        target,
        "Data incomplete for this period.",
      ],
      ["no target", falls, full(0, 1500), null, "No target has been set, so it is not rated."],
      [
        "an unusable target",
        falls,
        full(0, 1500),
        { green: 4, amber: 2 },
        "No target has been set, so it is not rated.",
      ],
      [
        "a value that is not a number",
        falls,
        full(Number.NaN, 1500),
        target,
        "No data has been recorded for this period.",
      ],
    ])("%s gives no data, never green", (_, definition, input, t, reason) => {
      const result = indicatorResult(definition, input, t);
      expect(result.status).toBe("no_data");
      expect(result.status).not.toBe("green");
      expect(result.reason).toBe(reason);
    });

    it("never invents a value of 0 for missing data", () => {
      expect(indicatorResult(falls, full(null, null), target).value).toBeNull();
      expect(indicatorResult(falls, full(0, 0), target).value).toBeNull();
    });

    it("shows a real value without a target, but never rates it", () => {
      const result = indicatorResult(falls, full(3, 1500), null);
      expect(result.value).toBe((3 / 1500) * rates.bedDaysBase);
      expect(result.status).toBe("no_data");
    });

    it("rates a genuine zero with full data green only when the target says zero is green", () => {
      expect(indicatorResult(complaints, full(0, 1), { green: 0, amber: 2 }).status).toBe("green");
      expect(indicatorResult(training, full(0, 40), { green: 95, amber: 85 }).status).toBe("red");
    });
  });
});
