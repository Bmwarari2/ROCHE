import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import {
  checkIndicatorTarget,
  computeIndicator,
  dashboardIndicator,
  INDICATOR_SOURCES,
  type IndicatorDefinition,
  type IndicatorInput,
  type IndicatorTarget,
  indicatorMethod,
  indicatorResult,
  NO_DATA_REASONS,
  phase2Indicators,
  type QualityIndicatorKey,
  ragStatus,
  targetFor,
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

describe("the quality dashboard (quality.md 22.2 rules 38 to 41; slice 47)", () => {
  const options = { minGroupSize: rates.minGroupSize, built: true };
  const target: IndicatorTarget = { green: 5, amber: 10 };
  const overdue = byKey("overdue_reviews");

  it("reads the minimum group size and the incident review target from the rate table", () => {
    expect(rates.minGroupSize).toBeGreaterThan(1);
    expect(rates.incidentReviewTargetDays).toBeGreaterThan(0);
  });

  it("names a source for every indicator, and none for those Harbour does not record yet", () => {
    for (const definition of indicators) {
      expect(Object.hasOwn(INDICATOR_SOURCES, definition.key)).toBe(true);
    }
    expect(INDICATOR_SOURCES.falls).toBe("Incidents recorded as a fall");
    expect(
      indicators
        .filter((d) => INDICATOR_SOURCES[d.key as QualityIndicatorKey] === null)
        .map((d) => d.key),
    ).toEqual([
      "missed_visits",
      "training_compliance",
      "agency_hours",
      "complaints",
      "staff_turnover",
    ]);
  });

  it.each<[string, string, IndicatorInput, { built?: boolean }, string]>([
    [
      "hazard HZ-129 a source not built yet",
      "falls",
      full(0, 3000),
      { built: false },
      "source_not_built",
    ],
    [
      "hazard HZ-129 an unfinished period",
      "falls",
      { numerator: 0, denominator: 3000, coverage: 0.5 },
      {},
      "incomplete_data",
    ],
    ["hazard HZ-129 no bed-days", "falls", full(0, 0), {}, "no_denominator"],
    ["hazard HZ-129 one fall, a small number", "falls", full(1, 3000), {}, "small_number"],
    [
      "hazard HZ-129 a small denominator of records about people",
      "overdue_reviews",
      full(0, 2),
      {},
      "small_number",
    ],
  ])("rule 38 and 40: %s is never rated", (_name, key, input, over, reason) => {
    const result = dashboardIndicator(byKey(key), input, target, { ...options, ...over });
    expect(result.status).toBe("no_data");
    expect(result.reasonCode).toBe(reason);
    expect(result.reason).toBe(NO_DATA_REASONS[reason as keyof typeof NO_DATA_REASONS]);
  });

  it("rule 40 withholds a small count, its value and its status, and shows zero", () => {
    const one = dashboardIndicator(falls, full(1, 3000), target, options);
    expect(one).toMatchObject({ numerator: null, denominator: 3000, value: null, display: null });
    const none = dashboardIndicator(falls, full(0, 3000), target, options);
    expect(none).toMatchObject({ numerator: 0, denominator: 3000, value: 0, status: "green" });
    const enough = dashboardIndicator(falls, full(rates.minGroupSize, 3000), target, options);
    expect(enough.numerator).toBe(rates.minGroupSize);
    expect(enough.status).not.toBe("no_data");
  });

  it("rule 40 keeps a bed-days denominator, which counts no one", () => {
    const result = dashboardIndicator(falls, full(0, 3), target, options);
    expect(result).toMatchObject({ denominator: 3, value: 0, status: "green" });
  });

  it("rule 40 withholds a small denominator of records about people with its numerator", () => {
    const result = dashboardIndicator(overdue, full(0, 3), target, options);
    expect(result).toMatchObject({ numerator: null, denominator: null, value: null });
  });

  it("rule 39 keeps the working beside a rated value", () => {
    const result = dashboardIndicator(overdue, full(10, 40), { green: 10, amber: 20 }, options);
    expect(result).toMatchObject({
      numerator: 10,
      denominator: 40,
      value: 25,
      display: 25,
      status: "red",
      reasonCode: null,
      method: indicatorMethod(overdue),
    });
  });

  it("rule 41 shows a value without a target, unrated", () => {
    const result = dashboardIndicator(falls, full(6, 3000), null, options);
    expect(result).toMatchObject({
      numerator: 6,
      value: 2,
      status: "no_data",
      reasonCode: "no_target",
    });
  });

  it("rule 41 takes the location's own target over the organisation default", () => {
    const organisation = { green: 1, amber: 2 };
    const location = { green: 3, amber: 4 };
    expect(
      targetFor(
        "falls",
        [
          { locationId: null, indicatorKey: "falls", ...organisation },
          { locationId: "l1", indicatorKey: "falls", ...location },
        ],
        "l1",
      ),
    ).toEqual(location);
    expect(
      targetFor("falls", [{ locationId: null, indicatorKey: "falls", ...organisation }], "l1"),
    ).toEqual(organisation);
    expect(
      targetFor("falls", [{ locationId: "l2", indicatorKey: "falls", ...location }], "l1"),
    ).toBeNull();
  });
});
