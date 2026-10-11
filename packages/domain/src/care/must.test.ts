import { describe, expect, it } from "vitest";
import { tableCareRates } from "../../test/rate-table";
import { addMonthsToDate } from "./assessment";
import { calculateMust, MUST_TOOL_VERSION, type MustInput, type MustResult } from "./must";

/**
 * 'MUST' against the BAPEN flow chart, BMI chart and weight-loss tables (hazards HZ-012 and
 * HZ-014). Rate-table figures come from docs/specs/rates.md, never from literals here.
 */

const rates = tableCareRates();
const SCREENED_ON = "2026-10-11";

function measured(weightKg: number, heightM: number): MustInput["bmi"] {
  return {
    kind: "calculated",
    weightKg,
    heightM,
    weightMethod: "measured",
    heightMethod: "measured",
  };
}

function lost(previousWeightKg: number, currentWeightKg: number): MustInput["weightLoss"] {
  return { kind: "calculated", previousWeightKg, currentWeightKg };
}

const BASE: MustInput = {
  bmi: measured(70, 1.7),
  weightLoss: lost(70, 70),
  acuteDiseaseEffect: false,
  screenedOn: SCREENED_ON,
};

function screened(input: Partial<MustInput>, withRates = rates): MustResult {
  const outcome = calculateMust({ ...BASE, ...input }, withRates);
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.result;
}

const stepPoints = (result: MustResult, step: number) =>
  result.workings.find((w) => w.item.startsWith(`Step ${step}`))?.points;

describe("hazard HZ-012 MUST BMI, weight-loss and acute disease scores match the BAPEN worked examples", () => {
  // Height 2.00 m makes BMI a quarter of the weight, so each boundary is exact.
  it.each([
    ["BMI 20.1 scores 0", 80.4, 2.0, 20.1, 0],
    ["BMI 20.0 scores 1", 80.0, 2.0, 20.0, 1],
    ["BMI 18.5 scores 1", 74.0, 2.0, 18.5, 1],
    ["BMI 18.4 scores 2", 73.6, 2.0, 18.4, 2],
    ["60 kg at 1.80 m is BMI 18.52", 60, 1.8, 18.52, 1],
    ["51.2 kg at 1.60 m is BMI 20.00", 51.2, 1.6, 20.0, 1],
    ["70 kg at 1.70 m is BMI 24.22 (BAPEN chart: 24)", 70, 1.7, 24.22, 0],
    ["45 kg at 1.70 m is BMI 15.57 (BAPEN chart: 16)", 45, 1.7, 15.57, 2],
  ] as const)("step 1: %s", (_name, weightKg, heightM, bmi, points) => {
    const result = screened({ bmi: measured(weightKg, heightM) });
    expect(result.bmi).toBeCloseTo(bmi, 2);
    expect(stepPoints(result, 1)).toBe(points);
  });

  it.each([
    ["no change", 70, 70, 0, 0],
    ["weight gained", 68, 70, 0, 0],
    ["4.86% (3.4 kg from 70.0 kg)", 70, 66.6, 4.86, 0],
    ["exactly 5% (3.5 kg from 70.0 kg)", 70, 66.5, 5, 1],
    ["exactly 5% (3.0 kg from 60.0 kg)", 60, 57, 5, 1],
    ["exactly 10% (7.0 kg from 70.0 kg)", 70, 63, 10, 1],
    ["10.14% (7.1 kg from 70.0 kg)", 70, 62.9, 10.14, 2],
    // BAPEN weight-loss table, current weight 70 kg: under 3.7 kg 0; 3.7 to 7.8 kg 1; over 7.8 kg 2.
    ["table row 70 kg: 3.6 kg lost", 73.6, 70, 4.89, 0],
    ["table row 70 kg: 3.7 kg lost", 73.7, 70, 5.02, 1],
    ["table row 70 kg: 7.7 kg lost", 77.7, 70, 9.91, 1],
    ["table row 70 kg: 7.9 kg lost", 77.9, 70, 10.14, 2],
  ] as const)("step 2: %s", (_name, previous, current, percent, points) => {
    const result = screened({ weightLoss: lost(previous, current) });
    expect(result.weightLossPercent).toBe(percent);
    expect(stepPoints(result, 2)).toBe(points);
  });

  it.each([
    [false, 0],
    [true, 2],
  ])("step 3: acutely ill with no intake for more than 5 days (%s) scores %i", (acute, points) => {
    expect(stepPoints(screened({ acuteDiseaseEffect: acute }), 3)).toBe(points);
  });

  it.each([
    ["0 is low risk", {}, 0, "low"],
    ["1 is medium risk", { bmi: measured(80, 2) }, 1, "medium"],
    ["2 is high risk", { bmi: measured(70, 2) }, 2, "high"],
    [
      "6, the maximum, is high risk",
      { bmi: measured(70, 2), weightLoss: lost(80, 70), acuteDiseaseEffect: true },
      6,
      "high",
    ],
  ] as const)("step 4: %s", (_name, input, score, band) => {
    const result = screened(input);
    expect(result.score).toBe(score);
    expect(result.band).toBe(band);
    expect(result.toolKey).toBe("must");
    expect(result.toolVersion).toBe(MUST_TOOL_VERSION);
  });

  it("shows the workings with the methods used", () => {
    const result = screened({ bmi: measured(60, 1.8), weightLoss: lost(70, 66.5) });
    expect(result.workings).toEqual([
      {
        item: "Step 1: BMI score",
        value: "BMI 18.5 from 60.0 kg (measured) and 1.80 m (measured); exact BMI 18.5 to 20",
        points: 1,
      },
      {
        item: "Step 2: weight loss score",
        value: "3.5 kg lost from 70.0 kg: 5.00% (5 to 10%)",
        points: 1,
      },
      {
        item: "Step 3: acute disease effect score",
        value: "Not acutely ill with no intake for more than 5 days",
        points: 0,
      },
    ]);
    expect(result.assessorJudgement).toBe(false);
  });

  it("records obesity (BMI over 30) as BAPEN asks, without changing the score", () => {
    expect(screened({ bmi: measured(120.4, 2) })).toMatchObject({ obese: true, score: 0 });
    expect(screened({ bmi: measured(120.04, 2) })).toMatchObject({ obese: true, score: 0 });
    expect(screened({ bmi: measured(120, 2) })).toMatchObject({ obese: false, score: 0 });
  });

  it("accepts an estimated height and records the method", () => {
    const result = screened({
      bmi: {
        kind: "calculated",
        weightKg: 60,
        heightM: 1.8,
        weightMethod: "documented_or_reported",
        heightMethod: "ulna_length",
      },
    });
    expect(result.workings[0]?.value).toBe(
      "BMI 18.5 from 60.0 kg (documented or reported) and 1.80 m (estimated from ulna length); exact BMI 18.5 to 20",
    );
  });

  it.each([
    ["over_20", 0],
    ["18_5_to_20", 1],
    ["under_18_5", 2],
  ] as const)(
    "accepts an assessor-selected BMI category %s when weight or height cannot be measured",
    (category, points) => {
      const result = screened({
        bmi: { kind: "assessor_category", category, method: "mid_upper_arm_circumference" },
      });
      expect(stepPoints(result, 1)).toBe(points);
      expect(result.workings[0]?.value).toContain(
        "assessor's judgement from mid upper arm circumference",
      );
      expect(result).toMatchObject({ bmi: null, obese: null, assessorJudgement: true });
    },
  );

  it.each([
    ["under_5", 0],
    ["5_to_10", 1],
    ["over_10", 2],
  ] as const)("accepts a reported weight-loss category %s", (category, points) => {
    const result = screened({
      weightLoss: { kind: "assessor_category", category, method: "reported_weight_loss" },
    });
    expect(stepPoints(result, 2)).toBe(points);
    expect(result).toMatchObject({ weightLossPercent: null, assessorJudgement: true });
  });
});

describe("hazard HZ-012 MUST bands the exact BMI and rounds it only for display", () => {
  // Height 2.00 m makes BMI a quarter of the weight. Rounding before banding would score 18.45 to
  // 18.49 as 1 instead of 2, and 20.01 to 20.04 as 1 instead of 0: only the exact value is banded.
  it.each([
    ["18.45 scores 2 although it shows as 18.5", 73.8, "18.5", "under 18.5", 2],
    ["18.49 scores 2 although it shows as 18.5", 73.96, "18.5", "under 18.5", 2],
    ["18.5 scores 1", 74, "18.5", "18.5 to 20", 1],
    ["19.99 scores 1 although it shows as 20.0", 79.96, "20.0", "18.5 to 20", 1],
    ["20.0 scores 1", 80, "20.0", "18.5 to 20", 1],
    ["20.01 scores 0 although it shows as 20.0", 80.04, "20.0", "over 20", 0],
    ["20.05 scores 0 and shows as 20.1", 80.2, "20.1", "over 20", 0],
  ] as const)("BMI %s", (_name, weightKg, shown, band, points) => {
    const result = screened({ bmi: measured(weightKg, 2) });
    expect(result.bmi).toBeCloseTo(weightKg / 4, 6);
    expect(stepPoints(result, 1)).toBe(points);
    expect(result.workings[0]?.value).toBe(
      `BMI ${shown} from ${weightKg % 1 === 0 ? weightKg.toFixed(1) : weightKg} kg (measured) and 2.00 m (measured); exact BMI ${band}`,
    );
  });
});

describe("hazard HZ-012 MUST gives no total for missing or impossible values", () => {
  it.each([
    ["no BMI", { bmi: null }, "bmi"],
    ["no weight-loss answer", { weightLoss: null }, "weightLoss"],
    ["no acute disease answer", { acuteDiseaseEffect: null }, "acuteDiseaseEffect"],
    [
      "no weight",
      {
        bmi: {
          kind: "calculated",
          heightM: 1.7,
          weightMethod: "measured",
          heightMethod: "measured",
        },
      },
      "bmi.weightKg",
    ],
    [
      "no earlier weight",
      { weightLoss: { kind: "calculated", currentWeightKg: 70 } },
      "weightLoss.previousWeightKg",
    ],
    [
      "no BMI category",
      { bmi: { kind: "assessor_category", method: "subjective_criteria" } },
      "bmi.category",
    ],
    [
      "no weight-loss category",
      { weightLoss: { kind: "assessor_category", method: "subjective_criteria" } },
      "weightLoss.category",
    ],
  ] as const)("%s is incomplete", (_name, input, item) => {
    const outcome = calculateMust({ ...BASE, ...(input as Partial<MustInput>) }, rates);
    expect(outcome).toMatchObject({
      ok: false,
      code: "incomplete",
      issues: [{ item, problem: "missing" }],
    });
  });

  it.each([
    ["a height in centimetres", { bmi: measured(70, 170) }, "bmi.heightM"],
    ["a weight of 0", { bmi: measured(0, 1.7) }, "bmi.weightKg"],
    ["an impossible current weight", { weightLoss: lost(70, 1000) }, "weightLoss.currentWeightKg"],
    ["a screening date that does not exist", { screenedOn: "2026-02-30" }, "screenedOn"],
    [
      "an unpublished BMI category",
      {
        bmi: {
          kind: "assessor_category",
          category: "thin" as never,
          method: "subjective_criteria",
        },
      },
      "bmi.category",
    ],
  ] as const)("%s is refused", (_name, input, item) => {
    const outcome = calculateMust({ ...BASE, ...(input as Partial<MustInput>) }, rates);
    expect(outcome).toMatchObject({ ok: false, code: "invalid", issues: [{ item }] });
  });
});

describe("hazard HZ-014 MUST medium and high risk schedule the food record and the dietitian referral", () => {
  it("low risk raises no task but sets the next screening and the usual weighing interval", () => {
    expect(screened({}).triggers).toEqual([
      {
        kind: "rescreen",
        toolKey: "must",
        dueOn: addMonthsToDate(SCREENED_ON, rates.mustScreeningIntervalMonths),
      },
      {
        kind: "weight_interval",
        interval: { unit: "months", value: rates.weightDefaultIntervalMonths },
      },
    ]);
  });

  it("medium risk raises a food and fluid record for the rate-table number of days", () => {
    const result = screened({ bmi: measured(80, 2) });
    expect(result.triggers).toContainEqual({
      kind: "task",
      task: "food_and_fluid_record",
      reason: "MUST medium risk: document dietary intake",
      forDays: rates.mustMediumRiskFoodRecordDays,
    });
    expect(result.triggers.some((t) => t.kind === "task" && t.task === "dietitian_referral")).toBe(
      false,
    );
    expect(result.triggers).toContainEqual({
      kind: "weight_interval",
      interval: { unit: "weeks", value: rates.weightAtRiskIntervalWeeks },
    });
  });

  it("high risk raises a dietitian referral task and weekly weighing", () => {
    const result = screened({ bmi: measured(70, 2) });
    expect(result.triggers).toContainEqual({
      kind: "task",
      task: "dietitian_referral",
      reason: "MUST high risk: refer to dietitian or follow local policy",
    });
    expect(result.triggers).toContainEqual({
      kind: "weight_interval",
      interval: { unit: "weeks", value: rates.weightAtRiskIntervalWeeks },
    });
  });

  it("follows a tenant's own figures from the rate table, not built-in ones", () => {
    const tenant = {
      ...rates,
      mustScreeningIntervalMonths: rates.mustScreeningIntervalMonths + 1,
      mustMediumRiskFoodRecordDays: rates.mustMediumRiskFoodRecordDays + 2,
    };
    const result = screened({ bmi: measured(80, 2) }, tenant);
    expect(result.nextScreeningDueOn).toBe(
      addMonthsToDate(SCREENED_ON, tenant.mustScreeningIntervalMonths),
    );
    expect(result.triggers).toContainEqual(
      expect.objectContaining({
        task: "food_and_fluid_record",
        forDays: tenant.mustMediumRiskFoodRecordDays,
      }),
    );
  });
});
