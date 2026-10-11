import { describe, expect, it } from "vitest";
import {
  calculateWaterlow,
  WATERLOW_TOOL_VERSION,
  type WaterlowInput,
  type WaterlowResult,
} from "./waterlow";

/**
 * Waterlow against the 2005 revised score card (hazard HZ-012). The baseline is a man aged 30 with
 * average build and no other risk: 2 points (sex 1, age 1).
 */

const BASE: WaterlowInput = {
  build: { kind: "calculated", weightKg: 88, heightM: 2 },
  skin: ["healthy"],
  sex: "male",
  ageYears: 30,
  malnutrition: { recentWeightLoss: "no", eatingPoorlyOrLackOfAppetite: false },
  continence: "complete_or_catheterised",
  mobility: "fully",
  tissueMalnutrition: [],
  neurologicalDeficit: [],
  majorSurgeryOrTrauma: { orthopaedicOrSpinal: false, timeOnTable: "not_applicable" },
  medication: [],
};

function scored(input: Partial<WaterlowInput>): WaterlowResult {
  const outcome = calculateWaterlow({ ...BASE, ...input });
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.result;
}

const pointsFor = (result: WaterlowResult, itemStart: string) =>
  result.workings.find((w) => w.item.startsWith(itemStart))?.points;

describe("hazard HZ-012 Waterlow totals and risk bands match the published scoring card", () => {
  it("scores the baseline 2 and stores the tool version", () => {
    const result = scored({});
    expect(result).toMatchObject({
      toolKey: "waterlow",
      toolVersion: WATERLOW_TOOL_VERSION,
      score: 2,
      band: "not_at_risk",
      bmi: 22,
    });
    expect(result.workings).toHaveLength(11);
  });

  // Height 2.00 m makes BMI a quarter of the weight.
  it.each([
    ["BMI 19.9 is below average", 79.6, 3],
    ["BMI 20.0 is average", 80, 0],
    ["BMI 24.9 is average", 99.6, 0],
    ["BMI 25.0 is above average", 100, 1],
    ["BMI 29.9 is above average", 119.6, 1],
    ["BMI 30.0 is obese", 120, 2],
  ] as const)("build: %s", (_name, weightKg, points) => {
    const result = scored({ build: { kind: "calculated", weightKg, heightM: 2 } });
    expect(pointsFor(result, "Build")).toBe(points);
  });

  it.each([
    ["average", 0],
    ["above_average", 1],
    ["obese", 2],
    ["below_average", 3],
  ] as const)("build chosen by the assessor: %s scores %i", (category, points) => {
    const result = scored({ build: { kind: "assessor_category", category } });
    expect(pointsFor(result, "Build")).toBe(points);
    expect(result.bmi).toBeNull();
  });

  it.each([
    [["healthy"], 0],
    [["tissue_paper"], 1],
    [["dry"], 1],
    [["oedematous"], 1],
    [["clammy_or_pyrexia"], 1],
    [["discoloured_grade_1"], 2],
    [["broken_or_spots_grade_2_to_4"], 3],
    [["tissue_paper", "dry", "oedematous"], 3],
    [["discoloured_grade_1", "broken_or_spots_grade_2_to_4"], 5],
  ] as const)("skin type %j scores %i (every selection counts)", (skin, points) => {
    expect(pointsFor(scored({ skin }), "Skin type")).toBe(points);
  });

  it.each([
    ["male", 1],
    ["female", 2],
  ] as const)("sex %s scores %i", (sex, points) => {
    expect(pointsFor(scored({ sex }), "Sex")).toBe(points);
  });

  it.each([
    [14, 1],
    [49, 1],
    [50, 2],
    [64, 2],
    [65, 3],
    [74, 3],
    [75, 4],
    [80, 4],
    [81, 5],
    [104, 5],
  ])("age %i scores %i", (ageYears, points) => {
    expect(pointsFor(scored({ ageYears }), "Age")).toBe(points);
  });

  it.each([
    ["no weight loss, eating well", "no", undefined, false, 0],
    ["no weight loss, eating poorly", "no", undefined, true, 1],
    ["unsure about weight loss", "unsure", undefined, false, 2],
    ["unsure and eating poorly", "unsure", undefined, true, 3],
    ["lost 0.5 to 5 kg", "yes", "0.5_to_5_kg", false, 1],
    ["lost 5 to 10 kg", "yes", "5_to_10_kg", false, 2],
    ["lost 10 to 15 kg", "yes", "10_to_15_kg", false, 3],
    ["lost over 15 kg", "yes", "over_15_kg", false, 4],
    ["lost an unsure amount", "yes", "unsure", false, 2],
    ["lost over 15 kg and eating poorly", "yes", "over_15_kg", true, 5],
  ] as const)(
    "malnutrition screening: %s scores %i",
    (_name, recentWeightLoss, weightLossAmount, eatingPoorlyOrLackOfAppetite, points) => {
      const result = scored({
        malnutrition: { recentWeightLoss, weightLossAmount, eatingPoorlyOrLackOfAppetite },
      });
      expect(pointsFor(result, "Malnutrition")).toBe(points);
      expect(result.malnutritionScore).toBe(points);
    },
  );

  it.each([
    ["complete_or_catheterised", 0],
    ["urinary_incontinence", 1],
    ["faecal_incontinence", 2],
    ["urinary_and_faecal_incontinence", 3],
  ] as const)("continence %s scores %i", (continence, points) => {
    expect(pointsFor(scored({ continence }), "Continence")).toBe(points);
  });

  it.each([
    ["fully", 0],
    ["restless_or_fidgety", 1],
    ["apathetic", 2],
    ["restricted", 3],
    ["bedbound", 4],
    ["chairbound", 5],
  ] as const)("mobility %s scores %i", (mobility, points) => {
    expect(pointsFor(scored({ mobility }), "Mobility")).toBe(points);
  });

  it.each([
    [[], 0],
    [["terminal_cachexia"], 8],
    [["multiple_organ_failure"], 8],
    [["single_organ_failure"], 5],
    [["peripheral_vascular_disease"], 5],
    [["anaemia"], 2],
    [["smoking"], 1],
    [["peripheral_vascular_disease", "anaemia", "smoking"], 8],
  ] as const)("tissue malnutrition %j scores %i", (tissueMalnutrition, points) => {
    expect(pointsFor(scored({ tissueMalnutrition }), "Special risks: tissue")).toBe(points);
  });

  it.each([
    ["none", [], 0],
    ["diabetes, MS or CVA at 4", [{ condition: "diabetes_ms_or_cva", points: 4 }], 4],
    ["motor or sensory at 5", [{ condition: "motor_or_sensory", points: 5 }], 5],
    ["paraplegia at 6", [{ condition: "paraplegia", points: 6 }], 6],
    [
      "two conditions are capped at 6",
      [
        { condition: "diabetes_ms_or_cva", points: 4 },
        { condition: "motor_or_sensory", points: 5 },
      ],
      6,
    ],
  ] as const)("neurological deficit: %s", (_name, neurologicalDeficit, points) => {
    expect(pointsFor(scored({ neurologicalDeficit }), "Special risks: neurological")).toBe(points);
  });

  it.each([
    [false, "not_applicable", 0],
    [true, "not_applicable", 5],
    [false, "over_2_hours", 5],
    [false, "over_6_hours", 8],
    [true, "over_6_hours", 13],
  ] as const)(
    "major surgery or trauma: orthopaedic %s, %s scores %i",
    (orthopaedicOrSpinal, timeOnTable, points) => {
      const result = scored({ majorSurgeryOrTrauma: { orthopaedicOrSpinal, timeOnTable } });
      expect(pointsFor(result, "Special risks: major")).toBe(points);
    },
  );

  it.each([
    [[], 0],
    [["cytotoxics"], 4],
    [["long_term_or_high_dose_steroids"], 4],
    [["cytotoxics", "long_term_or_high_dose_steroids", "anti_inflammatory"], 4],
  ] as const)("medication %j scores %i (maximum 4)", (medication, points) => {
    expect(pointsFor(scored({ medication }), "Special risks: medication")).toBe(points);
  });

  // Baseline 2; chairbound 5; continence; neurological deficit; medication 4.
  it.each([
    ["9 is not at risk", "faecal_incontinence", [], [], 9, "not_at_risk"],
    ["10 is at risk", "urinary_and_faecal_incontinence", [], [], 10, "at_risk"],
    ["14 is at risk", "urinary_and_faecal_incontinence", [], ["cytotoxics"], 14, "at_risk"],
    ["15 is high risk", "urinary_and_faecal_incontinence", [5], [], 15, "high_risk"],
    ["19 is high risk", "urinary_and_faecal_incontinence", [5], ["cytotoxics"], 19, "high_risk"],
    [
      "20 is very high risk",
      "urinary_and_faecal_incontinence",
      [6],
      ["cytotoxics"],
      20,
      "very_high_risk",
    ],
  ] as const)("band: %s", (_name, continence, neuro, medication, score, band) => {
    const result = scored({
      mobility: "chairbound",
      continence,
      neurologicalDeficit: neuro.map((points) => ({ condition: "paraplegia" as const, points })),
      medication,
    });
    expect(result.score).toBe(score);
    expect(result.band).toBe(band);
  });

  it("totals a full worked example and shows every category", () => {
    const result = scored({
      build: { kind: "calculated", weightKg: 52, heightM: 1.65 },
      skin: ["tissue_paper", "discoloured_grade_1"],
      sex: "female",
      ageYears: 82,
      malnutrition: { recentWeightLoss: "unsure", eatingPoorlyOrLackOfAppetite: true },
      continence: "urinary_incontinence",
      mobility: "chairbound",
      tissueMalnutrition: ["anaemia"],
      neurologicalDeficit: [{ condition: "diabetes_ms_or_cva", points: 4 }],
      medication: ["long_term_or_high_dose_steroids"],
    });
    expect(result.workings.map((w) => [w.item, w.value, w.points])).toEqual([
      ["Build and weight for height", "BMI 19.1: Below average (BMI under 20)", 3],
      ["Skin type", "Tissue paper; Discoloured grade 1", 3],
      ["Sex", "Female", 2],
      ["Age", "82 (81 or over)", 5],
      [
        "Malnutrition screening",
        "Unsure about recent weight loss; eating poorly or lack of appetite",
        3,
      ],
      ["Continence", "Urinary incontinence", 1],
      ["Mobility", "Chairbound, for example wheelchair", 5],
      ["Special risks: tissue malnutrition", "Anaemia (Hb under 8)", 2],
      ["Special risks: neurological deficit (maximum 6)", "Diabetes, MS, CVA 4", 4],
      [
        "Special risks: major surgery or trauma",
        "Not orthopaedic or spinal; Not on table in the past 48 hours",
        0,
      ],
      ["Special risks: medication (maximum 4)", "Long-term or high-dose steroids", 4],
    ]);
    expect(result.score).toBe(32);
    expect(result.band).toBe("very_high_risk");
  });
});

describe("hazard HZ-014 Waterlow nutrition score over 2 raises a nutrition assessment task", () => {
  it.each([
    ["2", { recentWeightLoss: "unsure", eatingPoorlyOrLackOfAppetite: false }, false],
    ["3", { recentWeightLoss: "unsure", eatingPoorlyOrLackOfAppetite: true }, true],
    [
      "4",
      {
        recentWeightLoss: "yes",
        weightLossAmount: "over_15_kg",
        eatingPoorlyOrLackOfAppetite: false,
      },
      true,
    ],
  ] as const)("nutrition score %s", (_score, malnutrition, raised) => {
    const result = scored({ malnutrition });
    expect(
      result.triggers.some((t) => t.kind === "task" && t.task === "nutrition_assessment"),
    ).toBe(raised);
  });
});

describe("hazard HZ-012 Waterlow gives no total for missing or contradictory answers", () => {
  it.each([
    "build",
    "skin",
    "sex",
    "ageYears",
    "malnutrition",
    "continence",
    "mobility",
    "tissueMalnutrition",
    "neurologicalDeficit",
    "majorSurgeryOrTrauma",
    "medication",
  ] as const)("no total without %s", (item) => {
    expect(calculateWaterlow({ ...BASE, [item]: null })).toMatchObject({
      ok: false,
      code: "incomplete",
      issues: [{ item, problem: "missing" }],
    });
  });

  it.each([
    ["no skin type chosen", { skin: [] }, "skin", "incomplete"],
    [
      "weight loss without an amount",
      { malnutrition: { recentWeightLoss: "yes", eatingPoorlyOrLackOfAppetite: false } },
      "malnutrition.weightLossAmount",
      "incomplete",
    ],
    [
      "no appetite answer",
      { malnutrition: { recentWeightLoss: "no" } },
      "malnutrition.eatingPoorlyOrLackOfAppetite",
      "incomplete",
    ],
    [
      "no surgery answer",
      { majorSurgeryOrTrauma: { timeOnTable: "not_applicable" } },
      "majorSurgeryOrTrauma.orthopaedicOrSpinal",
      "incomplete",
    ],
    ["no weight", { build: { kind: "calculated", heightM: 1.7 } }, "build.weightKg", "incomplete"],
    ["healthy skin with dry skin", { skin: ["healthy", "dry"] }, "skin", "invalid"],
    ["a repeated skin type", { skin: ["dry", "dry"] }, "skin", "invalid"],
    [
      "an amount when no weight was lost",
      {
        malnutrition: {
          recentWeightLoss: "no",
          weightLossAmount: "5_to_10_kg",
          eatingPoorlyOrLackOfAppetite: false,
        },
      },
      "malnutrition.weightLossAmount",
      "invalid",
    ],
    ["age 13, below the card", { ageYears: 13 }, "ageYears", "invalid"],
    ["a fractional age", { ageYears: 80.5 }, "ageYears", "invalid"],
    [
      "a neurological score of 3",
      { neurologicalDeficit: [{ condition: "paraplegia", points: 3 }] },
      "neurologicalDeficit.0.points",
      "invalid",
    ],
    [
      "a neurological score of 7",
      { neurologicalDeficit: [{ condition: "paraplegia", points: 7 }] },
      "neurologicalDeficit.0.points",
      "invalid",
    ],
    [
      "a repeated neurological condition",
      {
        neurologicalDeficit: [
          { condition: "paraplegia", points: 4 },
          { condition: "paraplegia", points: 4 },
        ],
      },
      "neurologicalDeficit",
      "invalid",
    ],
    [
      "an unpublished build",
      { build: { kind: "assessor_category", category: "slim" as never } },
      "build.category",
      "invalid",
    ],
  ] as const)("%s", (_name, input, item, code) => {
    const outcome = calculateWaterlow({ ...BASE, ...(input as Partial<WaterlowInput>) });
    expect(outcome).toMatchObject({ ok: false, code, issues: [{ item }] });
  });
});
